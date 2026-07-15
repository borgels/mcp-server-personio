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
  const response = await client.get<PersonsResponse>('/v2/persons', { email, limit: 1 });
  const rows = response._data ?? response.data ?? [];
  const person = rows[0];
  if (!person) {
    throw new Error(
      `No Personio person found for ${email}. The employee must exist in Personio (with this email) before self-service tools work.`,
    );
  }

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
