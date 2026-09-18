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

  constructor(input: {
    status: number;
    url: string;
    payload?: PersonioErrorPayload | unknown;
    retryAfter?: string;
    fallbackMessage?: string;
  }) {
    super(formatPersonioHttpError(input));
    this.name = 'PersonioHttpError';
    this.status = input.status;
    this.url = redactSecrets(input.url);
    this.payload = input.payload;
    this.retryAfter = input.retryAfter;
  }
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
