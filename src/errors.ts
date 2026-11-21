export interface PersonioErrorPayload {
  error?: string;
  error_human?: string;
  message?: string;
}

const SECRET_PATTERNS = [
  /authorization:\s*(bearer|token token=)\s*[^,\s}]+/gi,
  /(clientSecret|PERSONIO_CLIENT_SECRET|client_secret|access_token)["']?\s*[:=]\s*["']?[^"',\s}]+/gi,
];

export class PersonioHttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly payload?: PersonioErrorPayload | unknown;
  readonly retryAfter?: string;
  /** Personio's own id for the request, when a response header gives one as a UUID or hex id (see requestIdFrom). */
  readonly requestId?: string;

  constructor(input: {
    status: number;
    url: string;
    payload?: PersonioErrorPayload | unknown;
    retryAfter?: string;
    fallbackMessage?: string;
    requestId?: string;
  }) {
    super(formatPersonioHttpError(input));
    this.name = 'PersonioHttpError';
    this.status = input.status;
    this.url = redactSecrets(input.url);
    this.payload = input.payload;
    this.retryAfter = input.retryAfter;
    this.requestId = vendorRequestId(input.requestId);
  }
}

/**
 * Response headers that carry the vendor's own id for a request, most specific first. Personio documents no header of its own, so
 * this is the common list.
 */
export const REQUEST_ID_HEADERS: readonly string[] = [
  'x-request-id',
  'request-id',
  'x-correlation-id',
  'correlation-id',
  'x-ms-request-id',
  'x-amzn-requestid',
];

/**
 * A hex id: one run of hex digits, or groups of at least four hex digits joined by single hyphens (a UUID is one),
 * 8 to 64 characters in all. A name, a sentence or an e-mail address never fits.
 */
const REQUEST_ID_FORM = /^[0-9A-Fa-f]{4,}(?:-[0-9A-Fa-f]{4,})*$/;
/** Six digits and four more: the shape of a Danish personal number. An id that holds it is dropped. */
const PERSONAL_NUMBER_SHAPE = /\d{6}-?\d{4}/;

/**
 * The vendor's request id, only in the form such ids have (a UUID or a hex id of 8 to 64 characters), or
 * undefined. Anything else, and an id that holds the shape of a personal number, is dropped: the value comes from
 * the vendor and is kept only when it cannot be text.
 */
export function vendorRequestId(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const id = value.trim();
  return id.length >= 8 && id.length <= 64 && REQUEST_ID_FORM.test(id) && !PERSONAL_NUMBER_SHAPE.test(id) ? id : undefined;
}

/** The vendor's request id from the first of REQUEST_ID_HEADERS a response has in the right form, or undefined. */
export function requestIdFrom(headers: Headers, names: readonly string[] = REQUEST_ID_HEADERS): string | undefined {
  for (const name of names) {
    const id = vendorRequestId(headers.get(name));
    if (id !== undefined) return id;
  }
  return undefined;
}

/**
 * Metadata about a failed call, for a host that counts failures: the HTTP status Personio answered with and its
 * request id. Never the response body, the vendor's error code or message, or the input.
 */
export interface FailureMetadata {
  /** The HTTP status of Personio's answer (100-599). */
  httpStatus: number;
  /** The vendor's own id for the request, as a UUID or hex id only. */
  requestId?: string;
}

/** The failure metadata of an error: an HTTP error from Personio gives its status and request id (a failed token request, a refused
 * redirect and a v1 answer with `success: false` are HTTP errors from Personio too). */
export function failureMetadata(error: unknown): FailureMetadata | undefined {
  if (!(error instanceof PersonioHttpError)) return undefined;
  const status: unknown = error.status;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) return undefined;
  const requestId = vendorRequestId(error.requestId);
  return requestId === undefined ? { httpStatus: status } : { httpStatus: status, requestId };
}

export function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return redactSecrets(error.message);
  }

  return redactSecrets(String(error));
}

export function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce(
    (current, pattern) =>
      current.replace(pattern, match => {
        const separator = match.includes(':') ? ':' : '=';
        const key = match.split(separator)[0]?.trim() ?? 'secret';
        return `${key}${separator} [REDACTED]`;
      }),
    value,
  );
}

function formatPersonioHttpError(input: {
  status: number;
  url: string;
  payload?: PersonioErrorPayload | unknown;
  retryAfter?: string;
  fallbackMessage?: string;
}): string {
  const payload = isPersonioErrorPayload(input.payload) ? input.payload : undefined;
  const parts = [
    `Personio API request failed with HTTP ${input.status}`,
    payload?.error_human ?? payload?.error,
    payload?.message,
    // v2 answers in its own shape — {errors:[{title, detail}], personio_trace_id}
    // — and none of the v1 keys above are present in it. Unread, a v2 failure
    // collapsed to bare "HTTP 400" with nothing to act on, which is how a
    // create_person failure became undiagnosable (#78020).
    ...v2Problems(input.payload),
    input.retryAfter ? `retry-after=${input.retryAfter}s` : undefined,
    input.fallbackMessage,
  ].filter(Boolean);

  return redactSecrets(parts.join(' | '));
}

/** The `errors` array and trace id of a v2 problem response, as readable lines. */
function v2Problems(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const body = payload as { errors?: unknown; personio_trace_id?: unknown };
  const lines = Array.isArray(body.errors)
    ? body.errors
        .map(entry => {
          if (typeof entry !== 'object' || entry === null) return undefined;
          const e = entry as { title?: unknown; detail?: unknown; _meta?: { path?: unknown } };
          const where = typeof e._meta?.path === 'string' ? ` (${e._meta.path})` : '';
          const text = [e.title, e.detail].filter(v => typeof v === 'string' && v.length > 0).join(': ');
          return text ? `${text}${where}` : undefined;
        })
        .filter((line): line is string => line !== undefined)
    : [];
  if (typeof body.personio_trace_id === 'string' && lines.length > 0) {
    lines.push(`trace=${body.personio_trace_id}`);
  }
  return lines;
}

function isPersonioErrorPayload(value: unknown): value is PersonioErrorPayload {
  return typeof value === 'object' && value !== null;
}
