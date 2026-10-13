/**
 * Encode a caller-supplied value as a single URL path segment. Rejects values
 * that could change which resource the request addresses once the URL is
 * normalised (empty, dot segments, separators, query/fragment markers, and
 * their percent-encoded forms) instead of relying on encodeURIComponent alone.
 */
export function pathParam(value: string | number, name = 'id'): string {
  const raw = String(value);
  const lowered = raw.toLowerCase();
  if (
    raw.trim() === '' ||
    raw === '.' ||
    raw === '..' ||
    /[/\\?#]/.test(raw) ||
    /%(2e|2f|5c|3f|23)/.test(lowered) ||
    /[\u0000-\u001f\u007f]/.test(raw)
  ) {
    throw new Error(`Invalid ${name}: must be a single identifier without path separators or dot segments.`);
  }
  return encodeURIComponent(raw);
}
