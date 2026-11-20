import { z } from 'zod/v4';
import type { PersonioClient, QueryValue } from '../personio/client.js';
import { pathParam } from '../personio/path.js';

/**
 * The gateway's tool table (src/gateway.ts): a curated, company-wide HR
 * surface for an embedding host that grants tools per role.
 *
 * What it never gives, whatever the API credential is allowed to read:
 *
 * - custom attributes of a person (where national id numbers, bank details,
 *   salary, birth dates and the like live in Personio). Every answer is built
 *   from an allowlist of standard fields; anything else Personio sends is
 *   dropped, unknown fields included;
 * - the type and comment of an absence period (an absence type can be a
 *   health matter), and the comment of an attendance period;
 * - compensations, documents, recruiting and custom reports;
 * - any delete, and any change to a person or an employment.
 *
 * The two writes create an absence period or an attendance period. Neither
 * sends skip_approval, so both enter Personio's normal approval workflow.
 */

export type GatewayToolRisk = 'read' | 'write';

/** One upstream request a tool may make (method and path template relative to the base URL). */
export interface UpstreamOperation {
  method: 'GET' | 'POST';
  path: string;
}

export interface GatewayTool {
  /** Name without a prefix ("list_persons"). */
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly risk: GatewayToolRisk;
  readonly inputSchema: z.ZodObject;
  readonly upstream: readonly UpstreamOperation[];
  /** Our own one-line summary, the first text of a successful result. */
  readonly summary: string;
  run(client: PersonioClient, input: Record<string, unknown>): Promise<unknown>;
}

/** A refusal in our own words, raised by a tool before anything is sent. Its message is passed on. */
export class GatewayInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GatewayInputError';
  }
}

const TOKEN: UpstreamOperation = { method: 'POST', path: '/v2/auth/token' };

const id = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, 'an id of letters, digits, - or _');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
/** A local date and time as Personio takes it: no timezone offset (the period's own timezone applies). */
const localDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/, 'local date and time, YYYY-MM-DDTHH:MM[:SS], without a timezone');

/** The start of a day, as Personio's date_time fields and filters take it. */
const dayStart = (day: string) => `${day}T00:00:00`;
const dayEnd = (day: string) => `${day}T23:59:59`;
const withSeconds = (value: string) => (value.length === 16 ? `${value}:00` : value);
const half = z.enum(['FIRST_HALF', 'SECOND_HALF']);
const cursor = z.string().trim().min(1).max(2000).regex(/^[\x21-\x7e]+$/, 'printable');

// --- Allowlists: the only fields an answer can carry ---

/** true: a primitive field; an object: a nested object picked the same way; [spec]: each element of a list. */
type Spec = { readonly [key: string]: true | Spec | readonly [Spec] };

const REF: Spec = { id: true };
const NAMED_REF: Spec = { id: true, name: true };

const PERSON: Spec = {
  id: true,
  first_name: true,
  last_name: true,
  preferred_name: true,
  email: true,
  status: true,
  created_at: true,
  updated_at: true,
};

const EMPLOYMENT: Spec = {
  id: true,
  status: true,
  type: true,
  employment_start_date: true,
  start_date: true,
  employment_end_date: true,
  end_date: true,
  contract_end_date: true,
  probation_end_date: true,
  weekly_working_hours: true,
  full_time_weekly_working_hours: true,
  position: { title: true },
  supervisor: REF,
  legal_entity: NAMED_REF,
  office: NAMED_REF,
  org_units: [{ id: true, type: true, name: true }],
  cost_centers: [{ id: true, name: true, weight: true }],
  created_at: true,
  updated_at: true,
};

const ABSENCE: Spec = {
  id: true,
  person: REF,
  starts_from: { date_time: true, type: true },
  ends_at: { date_time: true, type: true },
  timezone_id: true,
  approval: { status: true },
  created_at: true,
  updated_at: true,
};

const ATTENDANCE: Spec = {
  id: true,
  person: REF,
  type: true,
  start: { date_time: true },
  end: { date_time: true },
  duration: true,
  attribution_date: true,
  approval: { status: true },
  project: REF,
  created_at: true,
  updated_at: true,
};

const ABSENCE_TYPE: Spec = { id: true, name: true, category: true, unit: true };
const PROJECT: Spec = { id: true, name: true, active: true, status: true };
const ORG_UNIT: Spec = { id: true, name: true, type: true, status: true, parent: REF };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPrimitive(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/** The fields of `value` that `spec` names, and nothing else. Undefined when `value` is not an object. */
export function pick(value: unknown, spec: Spec): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, rule] of Object.entries(spec)) {
    if (!Object.hasOwn(value, key)) continue;
    const entry = value[key];
    if (rule === true) {
      if (isPrimitive(entry)) out[key] = entry;
    } else if (Array.isArray(rule)) {
      if (Array.isArray(entry)) {
        out[key] = entry.map(item => pick(item, rule[0] as Spec)).filter(item => item !== undefined);
      }
    } else if (entry === null) {
      out[key] = null;
    } else {
      const nested = pick(entry, rule as Spec);
      if (nested !== undefined) out[key] = nested;
    }
  }
  return out;
}

/** The rows of a v2 list (`_data`), or of a single answer, each picked by `spec`. */
function rowsOf(body: unknown, spec: Spec): Array<Record<string, unknown>> {
  const data = isRecord(body) ? body._data : undefined;
  const list = Array.isArray(data) ? data : data === undefined ? [] : [data];
  return list.map(row => pick(row, spec)).filter((row): row is Record<string, unknown> => row !== undefined);
}

/** The cursor of the next page, from `_meta.links.next` (a link or an object with `href`). */
export function nextCursor(body: unknown): string | undefined {
  const meta = isRecord(body) && isRecord(body._meta) ? body._meta : undefined;
  const links = meta && isRecord(meta.links) ? meta.links : undefined;
  const next = links?.next;
  const href = typeof next === 'string' ? next : isRecord(next) && typeof next.href === 'string' ? next.href : undefined;
  if (!href) return undefined;
  try {
    const value = new URL(href, 'https://placeholder.invalid').searchParams.get('cursor');
    return value && /^[\x21-\x7e]{1,2000}$/.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function listResult(body: unknown, spec: Spec): { items: Array<Record<string, unknown>>; nextCursor?: string } {
  const items = rowsOf(body, spec);
  const next = nextCursor(body);
  return next ? { items, nextCursor: next } : { items };
}

function single(body: unknown, spec: Spec): Record<string, unknown> | null {
  const data = isRecord(body) && Object.hasOwn(body, '_data') ? body._data : body;
  return pick(Array.isArray(data) ? data[0] : data, spec) ?? null;
}

function pageQuery(input: Record<string, unknown>, cap: number, fallback: number): Record<string, QueryValue> {
  const limit = typeof input.limit === 'number' ? Math.min(input.limit, cap) : fallback;
  return { limit, cursor: typeof input.cursor === 'string' ? input.cursor : undefined };
}

const pageShape = (cap: number) => ({
  limit: z.number().int().min(1).max(cap).optional(),
  cursor: cursor.optional(),
});

/** Most pages of employments get_person reads (50 each). */
const EMPLOYMENT_MAX_PAGES = 5;

/** Most pages headcount reads (50 persons each): 2,000 persons. */
const HEADCOUNT_MAX_PAGES = 40;

const ORG_KINDS = {
  legal_entities: { path: '/v2/legal-entities', beta: false, type: undefined },
  departments: { path: '/v2/org-units', beta: true, type: 'department' },
  teams: { path: '/v2/org-units', beta: true, type: 'team' },
  cost_centers: { path: '/v2/cost-centers', beta: true, type: undefined },
  workplaces: { path: '/v2/workplaces', beta: true, type: undefined },
} as const;

export const GATEWAY_TOOLS: readonly GatewayTool[] = [
  {
    name: 'check_connection',
    title: 'Check Personio connection',
    description: 'Checks that the API credentials work by reading one person. Returns only whether the connection works.',
    risk: 'read',
    inputSchema: z.object({}).strict(),
    upstream: [TOKEN, { method: 'GET', path: '/v2/persons' }],
    summary: 'Personio accepted the API credentials.',
    async run(client) {
      await client.get('/v2/persons', { limit: 1 });
      return { connected: true };
    },
  },
  {
    name: 'headcount',
    title: 'Headcount',
    description: 'Counts the persons in Personio by status (active, inactive), without names. Reads at most 2,000 persons.',
    risk: 'read',
    inputSchema: z.object({}).strict(),
    upstream: [TOKEN, { method: 'GET', path: '/v2/persons' }],
    summary: 'Headcount from Personio, without names.',
    async run(client) {
      const counts: Record<string, number> = {};
      let total = 0;
      let next: string | undefined;
      let complete = false;
      for (let page = 0; page < HEADCOUNT_MAX_PAGES; page += 1) {
        const body = await client.get('/v2/persons', { limit: 50, cursor: next });
        const data = isRecord(body) && Array.isArray(body._data) ? body._data : [];
        for (const row of data) {
          const status = isRecord(row) && typeof row.status === 'string' ? row.status.toLowerCase() : 'unknown';
          const key = /^[a-z_]{1,32}$/.test(status) ? status : 'unknown';
          counts[key] = (counts[key] ?? 0) + 1;
          total += 1;
        }
        next = nextCursor(body);
        if (!next || data.length === 0) {
          complete = true;
          break;
        }
      }
      return { total, byStatus: counts, complete };
    },
  },
  {
    name: 'list_org_units',
    title: 'List organisation',
    description:
      'The company structure: legal entities, departments, teams, cost centers or workplaces (kind), with id, name and type.',
    risk: 'read',
    inputSchema: z
      .object({
        kind: z.enum(['legal_entities', 'departments', 'teams', 'cost_centers', 'workplaces']),
        ...pageShape(100),
      })
      .strict(),
    upstream: [
      TOKEN,
      { method: 'GET', path: '/v2/legal-entities' },
      { method: 'GET', path: '/v2/org-units' },
      { method: 'GET', path: '/v2/cost-centers' },
      { method: 'GET', path: '/v2/workplaces' },
    ],
    summary: 'Organisation from Personio.',
    async run(client, input) {
      const kind = ORG_KINDS[input.kind as keyof typeof ORG_KINDS];
      const query: Record<string, QueryValue> = { ...pageQuery(input, 100, 50), type: kind.type };
      return listResult(await client.get(kind.path, query, { beta: kind.beta }), ORG_UNIT);
    },
  },
  {
    name: 'list_absence_types',
    title: 'List absence types',
    description: 'The absence types set up in Personio (vacation and the like), with id, name, category and unit.',
    risk: 'read',
    inputSchema: z.object({ ...pageShape(100) }).strict(),
    upstream: [TOKEN, { method: 'GET', path: '/v2/absence-types' }],
    summary: 'Absence types from Personio.',
    async run(client, input) {
      return listResult(await client.get('/v2/absence-types', pageQuery(input, 100, 100)), ABSENCE_TYPE);
    },
  },
  {
    name: 'list_projects',
    title: 'List projects',
    description: 'The time tracking projects in Personio, with id, name and whether they are active.',
    risk: 'read',
    inputSchema: z.object({ ...pageShape(100) }).strict(),
    upstream: [TOKEN, { method: 'GET', path: '/v2/projects' }],
    summary: 'Projects from Personio.',
    async run(client, input) {
      return listResult(await client.get('/v2/projects', pageQuery(input, 100, 100)), PROJECT);
    },
  },
  {
    name: 'list_persons',
    title: 'List persons',
    description:
      'Persons in Personio with standard fields only: id, names, work email, status and dates. Filters: status, firstName, lastName, email.',
    risk: 'read',
    inputSchema: z
      .object({
        status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
        firstName: z.string().trim().min(1).max(100).optional(),
        lastName: z.string().trim().min(1).max(100).optional(),
        email: z.email().max(254).optional(),
        ...pageShape(50),
      })
      .strict(),
    upstream: [TOKEN, { method: 'GET', path: '/v2/persons' }],
    summary: 'Persons from Personio (standard fields only).',
    async run(client, input) {
      const body = await client.get('/v2/persons', {
        ...pageQuery(input, 50, 50),
        status: input.status as string | undefined,
        first_name: input.firstName as string | undefined,
        last_name: input.lastName as string | undefined,
        email: input.email as string | undefined,
      });
      return listResult(body, PERSON);
    },
  },
  {
    name: 'get_person',
    title: 'Get person',
    description:
      'One person with standard fields and employments: position, status, dates, weekly hours, supervisor, legal entity, office, departments and teams.',
    risk: 'read',
    inputSchema: z.object({ personId: id }).strict(),
    upstream: [
      TOKEN,
      { method: 'GET', path: '/v2/persons/{personId}' },
      { method: 'GET', path: '/v2/persons/{personId}/employments' },
    ],
    summary: 'Person from Personio (standard fields only).',
    async run(client, input) {
      const personId = pathParam(input.personId as string, 'personId');
      const person = single(await client.get(`/v2/persons/${personId}`), PERSON);
      // Every page of employments, up to EMPLOYMENT_MAX_PAGES; complete says whether all were read.
      const employments: Array<Record<string, unknown>> = [];
      let next: string | undefined;
      let complete = false;
      for (let page = 0; page < EMPLOYMENT_MAX_PAGES; page += 1) {
        const body = await client.get(`/v2/persons/${personId}/employments`, { limit: 50, cursor: next });
        employments.push(...rowsOf(body, EMPLOYMENT));
        next = nextCursor(body);
        if (!next) {
          complete = true;
          break;
        }
      }
      return { person, employments, employmentsComplete: complete };
    },
  },
  {
    name: 'list_absences',
    title: 'List absences',
    description:
      'Absence periods: person, start, end (half days included), timezone and approval status. The absence type and the comment are left out. Filter by personId and by a date range (from, to): periods that overlap it.',
    risk: 'read',
    inputSchema: z
      .object({
        personId: id.optional(),
        from: date.optional(),
        to: date.optional(),
        ...pageShape(100),
      })
      .strict(),
    upstream: [TOKEN, { method: 'GET', path: '/v2/absence-periods' }],
    summary: 'Absence periods from Personio (without type or comment).',
    async run(client, input) {
      const body = await client.get('/v2/absence-periods', {
        ...pageQuery(input, 100, 100),
        'person.id': input.personId as string | undefined,
        // A period overlaps [from, to] when it ends on or after from and starts on or before to. Personio documents these
        // filters with a UTC instant (…Z), unlike the attendance filters.
        'ends_at.date_time.gte': typeof input.from === 'string' ? `${dayStart(input.from)}Z` : undefined,
        'starts_from.date_time.lte': typeof input.to === 'string' ? `${dayEnd(input.to)}Z` : undefined,
      });
      return listResult(body, ABSENCE);
    },
  },
  {
    name: 'list_attendances',
    title: 'List attendances',
    description:
      'Recorded work and break periods: person, type, start, end, duration, project and approval status. The comment is left out. Filter by personId and by the days they start on (from, to).',
    risk: 'read',
    inputSchema: z
      .object({
        personId: id.optional(),
        from: date.optional(),
        to: date.optional(),
        ...pageShape(100),
      })
      .strict(),
    upstream: [TOKEN, { method: 'GET', path: '/v2/attendance-periods' }],
    summary: 'Attendance periods from Personio (without comment).',
    async run(client, input) {
      const body = await client.get('/v2/attendance-periods', {
        ...pageQuery(input, 100, 100),
        'person.id': input.personId as string | undefined,
        'start.date_time.gte': typeof input.from === 'string' ? dayStart(input.from) : undefined,
        'start.date_time.lte': typeof input.to === 'string' ? dayEnd(input.to) : undefined,
      });
      return listResult(body, ATTENDANCE);
    },
  },
  {
    name: 'create_absence',
    title: 'Create absence',
    description:
      'Creates an absence period for a person (absence type, start, end, half days). It enters Personio’s normal approval workflow; approval cannot be skipped.',
    risk: 'write',
    inputSchema: z
      .object({
        personId: id,
        absenceTypeId: id,
        startDate: date,
        startHalf: half.optional(),
        endDate: date.optional(),
        endHalf: half.optional(),
      })
      .strict(),
    upstream: [TOKEN, { method: 'POST', path: '/v2/absence-periods' }],
    summary: 'Personio created the absence period; it follows Personio’s approval workflow.',
    async run(client, input) {
      if (typeof input.endDate === 'string' && input.endDate < (input.startDate as string)) {
        throw new GatewayInputError('endDate is before startDate. Nothing was sent to Personio.');
      }
      if (input.endHalf !== undefined && input.endDate === undefined) {
        throw new GatewayInputError('endHalf needs endDate. Nothing was sent to Personio.');
      }
      // skip_approval is never sent: Personio's default (false) puts the period through its approval workflow.
      const body = await client.post('/v2/absence-periods', {
        person: { id: input.personId },
        absence_type: { id: input.absenceTypeId },
        starts_from: { date_time: dayStart(input.startDate as string), ...(input.startHalf ? { type: input.startHalf } : {}) },
        ...(input.endDate
          ? { ends_at: { date_time: dayStart(input.endDate as string), ...(input.endHalf ? { type: input.endHalf } : {}) } }
          : {}),
      });
      return { created: single(body, ABSENCE) };
    },
  },
  {
    name: 'create_attendance',
    title: 'Create attendance',
    description:
      'Records a work or break period for a person (start and end as local date and time without a timezone, at most 24 hours, project for work only). It enters Personio’s normal approval workflow.',
    risk: 'write',
    inputSchema: z
      .object({
        personId: id,
        type: z.enum(['WORK', 'BREAK']),
        start: localDateTime,
        end: localDateTime,
        projectId: id.optional(),
      })
      .strict(),
    upstream: [TOKEN, { method: 'POST', path: '/v2/attendance-periods' }],
    summary: 'Personio recorded the attendance period; it follows Personio’s approval workflow.',
    async run(client, input) {
      // Wall-clock times: read as if in UTC, so the host's own timezone (and its daylight saving) plays no part.
      const start = Date.parse(`${withSeconds(input.start as string)}Z`);
      const end = Date.parse(`${withSeconds(input.end as string)}Z`);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 24 * 60 * 60 * 1000) {
        throw new GatewayInputError('The period must end after it starts and last at most 24 hours. Nothing was sent to Personio.');
      }
      if (input.projectId !== undefined && input.type === 'BREAK') {
        throw new GatewayInputError('A project can only be set on a WORK period. Nothing was sent to Personio.');
      }
      // skip_approval is never sent.
      const body = await client.post('/v2/attendance-periods', {
        person: { id: input.personId },
        type: input.type,
        start: { date_time: withSeconds(input.start as string) },
        end: { date_time: withSeconds(input.end as string) },
        ...(input.projectId ? { project: { id: input.projectId } } : {}),
      });
      return { created: single(body, ATTENDANCE) };
    },
  },
];

export function findGatewayTool(name: string): GatewayTool | undefined {
  const wanted = name.trim().toLowerCase().replace(/^personio_/, '');
  return GATEWAY_TOOLS.find(tool => tool.name === wanted);
}
