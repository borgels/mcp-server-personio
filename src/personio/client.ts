import { PersonioHttpError } from '../errors.js';

export interface PersonioClientOptions {
  clientId?: string;
  clientSecret?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type QueryValue = string | number | boolean | null | undefined | ReadonlyArray<string | number>;

export interface RequestOptions {
  /** Send the Beta: true opt-in header (org-units, cost-centers, workplaces, recruiting reads). */
  beta?: boolean;
}

const TOKEN_SAFETY_MARGIN_MS = 60_000;
/** v1 papi- tokens are stable for 24h (rotation was retired in 2023). */
const V1_TOKEN_TTL_MS = 23 * 60 * 60 * 1000;

/**
 * Client for the Personio API. Primary surface is v2 (OAuth2 client
 * credentials against /v2/auth/token — form-urlencoded, NOT JSON); a v1
 * bearer token (POST /v1/auth) is kept alongside for the few endpoints
 * that remain v1-only (absence balances, recruiting document upload).
 *
 * Error quirks handled here: v1 responds HTTP 200 with {success: false}
 * on business errors; v2 uses RFC-7807 problem+json.
 */
export class PersonioClient {
  private readonly clientId?: string;
  private readonly clientSecret?: string;
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private v2Token?: string;
  private v2ExpiresAt = 0;
  private v1Token?: string;
  private v1ExpiresAt = 0;

  constructor(options: PersonioClientOptions = {}) {
    this.clientId = options.clientId ?? process.env.PERSONIO_CLIENT_ID;
    this.clientSecret = options.clientSecret ?? process.env.PERSONIO_CLIENT_SECRET;
    this.baseUrl = trimTrailingSlash(options.baseUrl ?? process.env.PERSONIO_BASE_URL ?? 'https://api.personio.de');
    assertSafeBaseUrl(this.baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? Number(process.env.PERSONIO_TIMEOUT_MS ?? 30_000);
  }

  async get<T>(path: string, query?: Record<string, QueryValue>, options?: RequestOptions): Promise<T> {
    return this.request<T>('GET', path, query, undefined, false, options);
  }

  async post<T>(path: string, body?: unknown, query?: Record<string, QueryValue>, options?: RequestOptions): Promise<T> {
    return this.request<T>('POST', path, query, body, false, options);
  }

  async patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, undefined, body);
  }

  async delete<T>(path: string, query?: Record<string, QueryValue>): Promise<T> {
    return this.request<T>('DELETE', path, query);
  }

  /** Binary download (v2 document download). Enforces a byte cap. */
  async getBinary(path: string, maxBytes: number): Promise<{ bytes: Uint8Array; contentType: string }> {
    const token = await this.getV2Token();
    const url = this.buildUrl(path);
    const response = await this.fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new PersonioHttpError({ status: response.status, url, payload: await readBody(response) });
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new Error(`Document is ${bytes.byteLength} bytes which exceeds the ${maxBytes} byte limit.`);
    }
    return { bytes, contentType: response.headers.get('content-type') ?? 'application/octet-stream' };
  }

  /** v1 multipart upload (document upload has no v2 equivalent). */
  async postMultipartV1<T>(
    path: string,
    fields: Record<string, string | number | undefined>,
    file: { fieldName: string; fileName: string; contentBase64: string; mimeType?: string },
  ): Promise<T> {
    const token = await this.getV1Token();
    const url = this.buildUrl(path.startsWith('/v1/') ? path : `/v1${path}`);
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        form.set(key, String(value));
      }
    }
    const bytes = Buffer.from(file.contentBase64, 'base64');
    form.set(
      file.fieldName,
      new Blob([bytes], { type: file.mimeType ?? 'application/octet-stream' }),
      file.fileName,
    );

    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      body: form,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const responseBody = await readBody(response);
    if (!response.ok || isV1Failure(responseBody)) {
      throw new PersonioHttpError({
        status: response.status,
        url,
        payload: responseBody,
        fallbackMessage: extractV1Error(responseBody),
      });
    }
    return responseBody as T;
  }

  buildUrl(path: string, query?: Record<string, QueryValue>): string {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(`${this.baseUrl}${normalizedPath}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === '') {
        continue;
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          url.searchParams.append(key, String(item));
        }
        continue;
      }
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private requireCredentials(): { clientId: string; clientSecret: string } {
    if (!this.clientId || !this.clientSecret) {
      throw new Error('Missing PERSONIO_CLIENT_ID / PERSONIO_CLIENT_SECRET. Set them in the MCP server environment.');
    }
    return { clientId: this.clientId, clientSecret: this.clientSecret };
  }

  private async getV2Token(): Promise<string> {
    if (this.v2Token && Date.now() < this.v2ExpiresAt - TOKEN_SAFETY_MARGIN_MS) {
      return this.v2Token;
    }
    const { clientId, clientSecret } = this.requireCredentials();
    const url = `${this.baseUrl}/v2/auth/token`;
    const response = await this.fetchImpl(url, {
      method: 'POST',
      // Personio's auth endpoints require form encoding, not JSON.
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = (await readBody(response)) as { access_token?: string; expires_in?: number } | null;
    if (!response.ok || !body?.access_token) {
      throw new PersonioHttpError({
        status: response.status,
        url,
        payload: body,
        fallbackMessage: 'Failed to obtain Personio v2 access token.',
      });
    }
    this.v2Token = body.access_token;
    this.v2ExpiresAt = Date.now() + (body.expires_in ?? 3600) * 1000;
    return this.v2Token;
  }

  private async getV1Token(): Promise<string> {
    if (this.v1Token && Date.now() < this.v1ExpiresAt - TOKEN_SAFETY_MARGIN_MS) {
      return this.v1Token;
    }
    const { clientId, clientSecret } = this.requireCredentials();
    const url = `${this.baseUrl}/v1/auth`;
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = (await readBody(response)) as { success?: boolean; data?: { token?: string } } | null;
    const token = body?.data?.token;
    if (!response.ok || body?.success === false || !token) {
      throw new PersonioHttpError({
        status: response.status,
        url,
        payload: body,
        fallbackMessage: 'Failed to obtain Personio v1 token.',
      });
    }
    this.v1Token = token;
    this.v1ExpiresAt = Date.now() + V1_TOKEN_TTL_MS;
    return token;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    query?: Record<string, QueryValue>,
    body?: unknown,
    isRetry = false,
    options?: RequestOptions,
  ): Promise<T> {
    const isV1 = path.startsWith('/v1/') || path.startsWith('/company/');
    const token = isV1 ? await this.getV1Token() : await this.getV2Token();
    const url = this.buildUrl(isV1 && path.startsWith('/company/') ? `/v1${path}` : path, query);

    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      // Several newer v2 resources (org-units, cost-centers, workplaces,
      // recruiting reads) are only served with the Beta opt-in header.
      ...(options?.beta ? { Beta: 'true' } : {}),
    };
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(this.timeoutMs) };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const response = await this.fetchImpl(url, init);

    if (response.status === 401 && !isRetry) {
      if (isV1) {
        this.v1Token = undefined;
      } else {
        this.v2Token = undefined;
      }
      return this.request<T>(method, path, query, body, true);
    }

    const responseBody = await readBody(response);

    if (!response.ok) {
      throw new PersonioHttpError({
        status: response.status,
        url,
        payload: responseBody,
        retryAfter: response.headers.get('retry-after') ?? undefined,
        fallbackMessage: typeof responseBody === 'string' ? responseBody : undefined,
      });
    }

    // v1 quirk: business failures can arrive as HTTP 200 + success:false.
    if (isV1 && isV1Failure(responseBody)) {
      throw new PersonioHttpError({
        status: response.status,
        url,
        payload: responseBody,
        fallbackMessage: extractV1Error(responseBody),
      });
    }

    return responseBody as T;
  }
}

function isV1Failure(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as { success?: boolean }).success === false;
}

function extractV1Error(value: unknown): string {
  const error = (value as { error?: { message?: string; code?: number } }).error;
  return error?.message ?? 'Personio v1 request failed (success: false).';
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function trimTrailingSlash(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') {
    end -= 1;
  }
  return value.slice(0, end);
}

function assertSafeBaseUrl(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`PERSONIO_BASE_URL is not a valid URL: ${baseUrl}`);
  }
  if (parsed.protocol === 'https:') {
    return;
  }
  if (parsed.protocol === 'http:' && isLocalHost(parsed.hostname)) {
    return;
  }
  throw new Error(
    `Refusing to send Personio credentials over ${parsed.protocol}//. Use https:// (loopback http:// is allowed for local mocks).`,
  );
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}
