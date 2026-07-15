import type { PersonioClient } from './client.js';

/**
 * Legal-entity scoping for the HR profile. When PERSONIO_HR_LEGAL_ENTITY is
 * set to a legal entity id, the HR instance is confined to the people who
 * have an employment in that entity. Personio's /v2/persons has no
 * legal-entity filter, so we build a person-id allowlist by reading each
 * person's employments and caching it. "all" (or unset) = unscoped.
 */
export function hrLegalEntity(): string | undefined {
  const v = process.env.PERSONIO_HR_LEGAL_ENTITY?.trim();
  return !v || v.toLowerCase() === 'all' ? undefined : v;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

interface PersonsPage {
  _data?: Array<{ id?: string; employments?: Array<{ id?: string }> }>;
  _meta?: { links?: { next?: { href?: string } | string } };
}

interface EmploymentsResp {
  _data?: Array<{ legal_entity?: { id?: string } | null }>;
}

export class LegalEntityScope {
  private readonly client: PersonioClient;
  readonly entityId: string;
  private allow: Set<string> = new Set();
  private builtAt = 0;
  private building?: Promise<void>;

  constructor(client: PersonioClient, entityId: string) {
    this.client = client;
    this.entityId = entityId;
  }

  private async build(): Promise<void> {
    const allow = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 200; page += 1) {
      const resp = await this.client.get<PersonsPage>('/v2/persons', { limit: 50, cursor });
      const rows = resp._data ?? [];
      for (const person of rows) {
        if (!person.id) continue;
        const emps = await this.client.get<EmploymentsResp>(
          `/v2/persons/${encodeURIComponent(person.id)}/employments`,
        );
        const inEntity = (emps._data ?? []).some(e => e.legal_entity?.id === this.entityId);
        if (inEntity) allow.add(person.id);
      }
      const next = resp._meta?.links?.next;
      const href = typeof next === 'string' ? next : next?.href;
      if (!href) break;
      const url = new URL(href);
      cursor = url.searchParams.get('cursor') ?? undefined;
      if (!cursor) break;
    }
    this.allow = allow;
    this.builtAt = Date.now();
  }

  private async ensureFresh(): Promise<void> {
    if (Date.now() - this.builtAt < CACHE_TTL_MS && this.allow.size > 0) return;
    this.building ??= this.build().finally(() => {
      this.building = undefined;
    });
    await this.building;
  }

  async has(personId: string): Promise<boolean> {
    await this.ensureFresh();
    return this.allow.has(personId);
  }

  async ids(): Promise<Set<string>> {
    await this.ensureFresh();
    return new Set(this.allow);
  }

  /** Assert a person id is in this legal entity, else throw. */
  async assert(personId: string, what: string): Promise<void> {
    if (!(await this.has(personId))) {
      throw new Error(
        `${what}: person ${personId} is not in the legal entity this HR instance is scoped to. ` +
          'This instance can only administer employees of its own company.',
      );
    }
  }

  /** Filter a v2 list response's _data to persons in this entity, by a person-id extractor. */
  async filter<T>(rows: T[], personIdOf: (row: T) => string | undefined): Promise<T[]> {
    const ids = await this.ids();
    return rows.filter(r => {
      const pid = personIdOf(r);
      return pid !== undefined && ids.has(pid);
    });
  }
}
