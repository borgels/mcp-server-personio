import type { PersonioClient } from './client.js';

export interface ResolvedPerson {
  personId: string;
  email: string;
  /** v1 numeric employee id — needed for the few v1-only endpoints (balances). */
  legacyEmployeeId?: number;
  name?: string;
}

interface PersonsResponse {
  _data?: Array<Record<string, unknown>>;
  data?: Array<Record<string, unknown>>;
}

/**
 * Resolve the gateway-verified email to a Personio person. Personio has no
 * on-behalf-of mechanism, so every employee-profile tool is pinned to this
 * person server-side. Unknown emails fail closed with a clear message.
 */
export async function resolvePerson(client: PersonioClient, email: string): Promise<ResolvedPerson> {
  // Ask for two rows so an ambiguous lookup is detectable, and only accept a
  // row whose email actually matches (case-insensitively) — never "the first
  // row the filter returned".
  const response = await client.get<PersonsResponse>('/v2/persons', { email, limit: 2 });
  const rows = response._data ?? response.data ?? [];
  const wanted = email.trim().toLowerCase();
  const matches = rows.filter(row => emailOf(row) === wanted);
  if (matches.length === 0) {
    throw new Error(
      `No Personio person found for ${email}. The employee must exist in Personio (with this email) before self-service tools work.`,
    );
  }
  if (matches.length > 1 || rows.length > 1) {
    throw new Error(`Personio returned more than one person for ${email}; refusing to guess which one is meant.`);
  }
  const person = matches[0] as Record<string, unknown>;

  const personId = String(person.id ?? '');
  if (!personId) {
    throw new Error(`Personio returned a person without an id for ${email}.`);
  }

  const legacyRaw = (person as { legacy_id?: number | string }).legacy_id;
  const first = (person as { first_name?: string }).first_name ?? '';
  const last = (person as { last_name?: string }).last_name ?? '';

  return {
    personId,
    email,
    legacyEmployeeId: legacyRaw === undefined ? undefined : Number(legacyRaw),
    name: `${first} ${last}`.trim() || undefined,
  };
}

function emailOf(row: Record<string, unknown>): string | undefined {
  const raw = row.email;
  const value =
    typeof raw === 'string' ? raw : typeof (raw as { value?: unknown })?.value === 'string' ? (raw as { value: string }).value : undefined;
  return value?.trim().toLowerCase();
}
