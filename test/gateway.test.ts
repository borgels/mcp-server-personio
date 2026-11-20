// The embeddable gateway (src/gateway.ts): explicit credentials, key admission, host policy, the curated tool table,
// allowlisted answers and errors in our own words.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPersonioGateway,
  errorText,
  personioGatewayTools,
  personioToolCatalog,
  type GatewayToolResult,
} from '../src/gateway.js';
import { PersonioHttpError } from '../src/errors.js';
import { nextCursor, pick } from '../src/gateway/tools.js';

const CLIENT_ID = 'Kx4mPq8vRt2nWz6y';
// Built at run time, so a scanner does not take a test value for a real credential.
const SECRET = ['Zq7pX2vK', '9mWb4TnR', '8yLc3HdJ', '6fGs1QeU'].join('');

interface Sent {
  url: string;
  method: string;
  body?: string;
}

function fakeFetch(answer: (url: string, init: RequestInit) => { status?: number; body: unknown }, sent: Sent[] = []) {
  return vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith('/v2/auth/token')) {
      return new Response(JSON.stringify({ access_token: 'tok-abcdefghijklmnop', expires_in: 3600 }), { status: 200 });
    }
    sent.push({ url, method: init.method ?? 'GET', body: typeof init.body === 'string' ? init.body : undefined });
    const { status = 200, body } = answer(url, init);
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

function gateway(answer: Parameters<typeof fakeFetch>[0], options: { writes?: boolean; sent?: Sent[]; audit?: (r: unknown) => void } = {}) {
  return createPersonioGateway({
    clientId: CLIENT_ID,
    clientSecret: SECRET,
    fetchImpl: fakeFetch(answer, options.sent),
    policy: { enableWrites: options.writes ?? false, ...(options.audit ? { audit: options.audit } : {}) },
  });
}

const data = (result: GatewayToolResult) => result.structuredContent as Record<string, unknown>;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('catalog', () => {
  it('is frozen, has no broad, destructive or confirming tool, and leaves out the sensitive surfaces', () => {
    expect(Object.isFrozen(personioToolCatalog)).toBe(true);
    expect(Object.isFrozen(personioToolCatalog[0]?.inputSchema)).toBe(true);
    const names = personioToolCatalog.map(entry => entry.name);
    expect(names).toEqual([
      'check_connection',
      'headcount',
      'list_org_units',
      'list_absence_types',
      'list_projects',
      'list_persons',
      'get_person',
      'list_absences',
      'list_attendances',
      'create_absence',
      'create_attendance',
    ]);
    for (const entry of personioToolCatalog) {
      expect(entry.broad).toBe(false);
      expect(entry.requiresConfirmation).toBe(false);
      expect(['read', 'write']).toContain(entry.riskLevel);
      expect(entry.enabledByDefault).toBe(entry.riskLevel === 'read');
      expect(entry.upstream.length).toBeGreaterThan(0);
      for (const op of entry.upstream) expect(['GET', 'POST']).toContain(op.method);
    }
    const all = JSON.stringify(personioToolCatalog).toLowerCase();
    for (const word of ['compensation', 'document', 'recruit', 'report', 'custom_attribute', 'delete']) {
      expect(all).not.toContain(word);
    }
    expect(personioGatewayTools.map(tool => tool.name)).toEqual(names);
  });
});

describe('credentials and key admission', () => {
  it('requires both credentials and reads none from the environment', () => {
    vi.stubEnv('PERSONIO_CLIENT_ID', CLIENT_ID);
    vi.stubEnv('PERSONIO_CLIENT_SECRET', SECRET);
    expect(() => createPersonioGateway({} as never)).toThrow(/clientSecret/);
    expect(() => createPersonioGateway({ clientSecret: SECRET } as never)).toThrow(/clientId/);
  });

  it('refuses a short secret, or one that shares text with our own texts, without quoting it', () => {
    for (const secret of ['short-secret', `Zq7p${'Personio API request failed'}`]) {
      let message = '';
      try {
        createPersonioGateway({ clientId: CLIENT_ID, clientSecret: secret });
      } catch (error) {
        message = `${(error as Error).name} ${(error as Error).message} ${(error as Error).stack}`;
      }
      expect(message).toMatch(/refused/);
      expect(message).not.toContain(secret);
      expect(message).not.toContain(secret.slice(0, 8));
    }
  });

  it('sends the credentials only to the token address of the base URL', async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      seen.push(`${init.method} ${String(input)} ${String(init.body ?? '')}`);
      if (String(input).endsWith('/v2/auth/token')) return new Response(JSON.stringify({ access_token: 'tok-abcdefghijklmnop' }));
      return new Response(JSON.stringify({ _data: [] }));
    }) as unknown as typeof fetch;
    const gw = createPersonioGateway({ clientId: CLIENT_ID, clientSecret: SECRET, fetchImpl });
    await gw.callTool('check_connection', {});
    expect(seen[0]).toContain('POST https://api.personio.de/v2/auth/token');
    expect(seen[0]).toContain(SECRET);
    expect(seen.slice(1).join('\n')).not.toContain(SECRET);
    expect(seen[1]).toMatch(/^GET https:\/\/api\.personio\.de\/v2\/persons\?limit=1/);
  });
});

describe('policy', () => {
  it('keeps writes off without the host policy and with enableWrites false', async () => {
    const sent: Sent[] = [];
    const gw = gateway(() => ({ body: {} }), { sent });
    const result = await gw.callTool('create_absence', { personId: '42', absenceTypeId: '7', startDate: '2026-08-03' });
    expect(result.isError).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it('leaves out disabled tools and refuses unknown names in the policy', async () => {
    const gw = createPersonioGateway({ clientId: CLIENT_ID, clientSecret: SECRET, policy: { disabledTools: ['personio_headcount'] } });
    expect(gw.tools.map(t => t.name)).not.toContain('headcount');
    expect((await gw.callTool('headcount', {})).isError).toBe(true);
    expect(() => createPersonioGateway({ clientId: CLIENT_ID, clientSecret: SECRET, policy: { disabledTools: ['nope'] } })).toThrow(
      /not a known tool/,
    );
  });

  it('sends a write only after its audit record was accepted', async () => {
    const sent: Sent[] = [];
    const gw = gateway(() => ({ body: {} }), {
      writes: true,
      sent,
      audit: () => {
        throw new Error('disk full');
      },
    });
    const result = await gw.callTool('create_absence', { personId: '42', absenceTypeId: '7', startDate: '2026-08-03' });
    expect(result.isError).toBe(true);
    expect(sent).toHaveLength(0);
  });
});

describe('answers', () => {
  it('gives a person only standard fields, never custom attributes', async () => {
    const gw = gateway(url =>
      url.includes('/employments')
        ? {
            body: {
              _data: [
                {
                  id: 'e1',
                  position: { title: 'Bogholder', salary: 1 },
                  supervisor: { id: '9', name: 'Chef' },
                  termination: { reason: 'privat' },
                  org_units: [{ id: 'd1', type: 'department', name: 'Økonomi', secret: 'x' }],
                  employment_start_date: '2024-01-01',
                },
              ],
            },
          }
        : {
            body: {
              _data: {
                id: '42',
                first_name: 'Anna',
                last_name: 'Jensen',
                email: 'anna@example.com',
                gender: 'female',
                custom_attributes: [{ id: 'cpr', value: '010190-1234' }, { id: 'iban', value: 'DK5000400440116243' }],
                salary: 50000,
              },
            },
          },
    );
    const result = await gw.callTool('get_person', { personId: '42' });
    expect(result.isError).toBeUndefined();
    expect(data(result)).toEqual({
      person: { id: '42', first_name: 'Anna', last_name: 'Jensen', email: 'anna@example.com' },
      employments: [
        {
          id: 'e1',
          position: { title: 'Bogholder' },
          supervisor: { id: '9' },
          org_units: [{ id: 'd1', type: 'department', name: 'Økonomi' }],
          employment_start_date: '2024-01-01',
        },
      ],
    });
    const text = result.content[0]?.text ?? '';
    for (const word of ['010190', 'DK50', 'female', 'privat', '50000']) expect(text).not.toContain(word);
  });

  it('leaves the type and comment out of absences and returns the next cursor', async () => {
    const gw = gateway(() => ({
      body: {
        _data: [
          {
            id: 'a1',
            person: { id: '42', first_name: 'Anna' },
            absence_type: { id: '3', name: 'Sygdom' },
            comment: 'influenza',
            starts_from: { date: '2026-08-03', type: 'FIRST_HALF' },
            ends_at: { date: '2026-08-04' },
          },
        ],
        _meta: { links: { next: { href: 'https://api.personio.de/v2/absence-periods?cursor=abc123&limit=100' } } },
      },
    }));
    const result = await gw.callTool('list_absences', { startsAfter: '2026-08-01' });
    expect(data(result)).toEqual({
      items: [
        { id: 'a1', person: { id: '42' }, starts_from: { date: '2026-08-03', type: 'FIRST_HALF' }, ends_at: { date: '2026-08-04' } },
      ],
      nextCursor: 'abc123',
    });
    expect(JSON.stringify(result)).not.toMatch(/Sygdom|influenza/);
  });

  it('counts persons by status across pages without names', async () => {
    let page = 0;
    const gw = gateway(() => {
      page += 1;
      return page === 1
        ? { body: { _data: [{ status: 'ACTIVE', first_name: 'A' }, { status: 'INACTIVE' }], _meta: { links: { next: '/v2/persons?cursor=p2' } } } }
        : { body: { _data: [{ status: 'ACTIVE' }] } };
    });
    const result = await gw.callTool('headcount', {});
    expect(data(result)).toEqual({ total: 3, byStatus: { active: 2, inactive: 1 }, complete: true });
  });

  it('creates an absence without skip_approval or comment', async () => {
    const sent: Sent[] = [];
    const gw = gateway(() => ({ body: { _data: { id: 'a9', person: { id: '42' }, starts_from: { date: '2026-08-03' } } } }), {
      writes: true,
      sent,
    });
    const result = await gw.callTool('create_absence', {
      personId: '42',
      absenceTypeId: '7',
      startDate: '2026-08-03',
      endDate: '2026-08-14',
    });
    expect(result.isError).toBeUndefined();
    expect(sent[0]?.method).toBe('POST');
    expect(JSON.parse(sent[0]?.body ?? '{}')).toEqual({
      person: { id: '42' },
      absence_type: { id: '7' },
      starts_from: { date: '2026-08-03' },
      ends_at: { date: '2026-08-14' },
    });
    expect(await gw.callTool('create_absence', { personId: '42', absenceTypeId: '7', startDate: '2026-08-03', comment: 'x' })).toMatchObject({
      isError: true,
    });
  });

  it('refuses an attendance longer than a day or a project on a break before sending', async () => {
    const sent: Sent[] = [];
    const gw = gateway(() => ({ body: {} }), { writes: true, sent });
    const long = await gw.callTool('create_attendance', {
      personId: '42',
      type: 'WORK',
      start: '2026-08-03T08:00:00Z',
      end: '2026-08-04T09:00:00Z',
    });
    const brk = await gw.callTool('create_attendance', {
      personId: '42',
      type: 'BREAK',
      start: '2026-08-03T12:00:00Z',
      end: '2026-08-03T12:30:00Z',
      projectId: '5',
    });
    expect(long.isError).toBe(true);
    expect(brk.isError).toBe(true);
    expect(sent).toHaveLength(0);
  });
});

describe('errors', () => {
  it('gives the status and our own text, never Personio’s body', async () => {
    const gw = gateway(() => ({ status: 404, body: { errors: [{ title: 'Person Anna Jensen not found', detail: 'secret detail' }] } }));
    const result = await gw.callTool('get_person', { personId: '42' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^Personio API request failed with HTTP 404/);
    expect(JSON.stringify(result)).not.toMatch(/Anna|secret detail/);
  });

  it('says when Personio refused the credentials', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_client' }), { status: 401 })) as unknown as typeof fetch;
    const gw = createPersonioGateway({ clientId: CLIENT_ID, clientSecret: SECRET, fetchImpl });
    const result = await gw.callTool('check_connection', {});
    expect(result.content[0]?.text).toBe('Personio refused the API credentials (HTTP 401).');
  });

  it('says a failed write without a 4xx answer may have been made', () => {
    const error = new PersonioHttpError({ status: 502, url: 'https://api.personio.de/v2/absence-periods' });
    expect(errorText(error, true)).toMatch(/may have been made/);
    expect(errorText(new PersonioHttpError({ status: 400, url: 'https://api.personio.de/v2/absence-periods' }), true)).not.toMatch(
      /may have been made/,
    );
  });

  it('withholds an answer that echoes the secret', async () => {
    const gw = gateway(() => ({ body: { _data: [{ id: '1', name: SECRET }] } }));
    const result = await gw.callTool('list_projects', {});
    expect(JSON.stringify(result)).not.toContain(SECRET.slice(0, 6));
  });
});

describe('helpers', () => {
  it('picks only named primitive fields', () => {
    expect(pick({ a: 1, b: { c: 2 }, d: 'x' }, { a: true, b: true })).toEqual({ a: 1 });
    expect(pick('x', { a: true })).toBeUndefined();
  });

  it('reads the cursor from a link or an object', () => {
    expect(nextCursor({ _meta: { links: { next: '/v2/x?cursor=q1' } } })).toBe('q1');
    expect(nextCursor({ _meta: { links: { next: { href: 'https://h/v2/x?cursor=q2' } } } })).toBe('q2');
    expect(nextCursor({})).toBeUndefined();
  });
});
