// Acting as the person (src/act-as.ts): the self tools work on the one person the host gives as actAs, found by the
// work email, and never fall back to anyone else.
import { describe, expect, it, vi } from 'vitest';
import { ACT_AS_TEXTS, createPersonioGateway, personioToolCatalog, type GatewayToolResult } from '../src/gateway.js';

const CLIENT_ID = 'Kx4mPq8vRt2nWz6y';
// Built at run time, so a scanner does not take a test value for a real credential.
const SECRET = ['Zq7pX2vK', '9mWb4TnR', '8yLc3HdJ', '6fGs1QeU'].join('');
const EMAIL = 'jane.doe@example.com';
const SELF_TOOLS = ['get_my_profile', 'list_my_absences', 'list_my_attendances', 'create_my_absence', 'create_my_attendance'];

interface Sent {
  url: string;
  method: string;
  body?: string;
}

type Persons = Array<Record<string, unknown>>;

const JANE: Record<string, unknown> = { id: '42', first_name: 'Jane', last_name: 'Doe', email: 'Jane.Doe@Example.com', status: 'ACTIVE' };

function gateway(persons: Persons, options: { sent?: Sent[]; audit?: Array<Record<string, unknown>> } = {}) {
  const sent = options.sent ?? [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith('/v2/auth/token')) {
      return new Response(JSON.stringify({ access_token: 'tok-abcdefghijklmnop', expires_in: 3600 }), { status: 200 });
    }
    sent.push({ url, method: init.method ?? 'GET', body: typeof init.body === 'string' ? init.body : undefined });
    const path = new URL(url).pathname;
    if (path === '/v2/persons') return new Response(JSON.stringify({ _data: persons }));
    if (path === '/v2/persons/42') return new Response(JSON.stringify({ _data: JANE }));
    if (path === '/v2/persons/42/employments') return new Response(JSON.stringify({ _data: [{ id: 'e1', status: 'ACTIVE', salary: 1 }] }));
    if (init.method === 'POST') return new Response(JSON.stringify({ _data: { id: 'p1', person: { id: '42' }, comment: 'secret' } }), { status: 201 });
    return new Response(JSON.stringify({ _data: [{ id: 'a1', person: { id: '42' }, absence_type: { id: '7', name: 'Sick' }, comment: 'x' }] }));
  }) as unknown as typeof fetch;
  return createPersonioGateway({
    clientId: CLIENT_ID,
    clientSecret: SECRET,
    fetchImpl,
    policy: { enableWrites: true, audit: record => void options.audit?.push({ ...record }) },
  });
}

const refused = (result: GatewayToolResult) => result.actAsRefused;

describe('catalog', () => {
  it('marks exactly the self tools, and none of them takes a person', () => {
    expect(personioToolCatalog.filter(entry => entry.self).map(entry => entry.name)).toEqual(SELF_TOOLS);
    for (const entry of personioToolCatalog) {
      const properties = (entry.inputSchema.properties ?? {}) as Record<string, unknown>;
      if (entry.self) {
        expect(Object.keys(properties)).not.toContain('personId');
        expect(entry.inputSchema.additionalProperties).toBe(false);
        expect(entry.upstream).toContainEqual({ method: 'GET', path: '/v2/persons' });
      }
    }
  });
});

describe('the person', () => {
  it('is found by the work email, case-insensitively, and only their data is read', async () => {
    const sent: Sent[] = [];
    const gw = gateway([JANE], { sent });
    const result = await gw.callTool('list_my_absences', { from: '2026-08-01' }, { actAs: { email: 'JANE.DOE@example.com ' } });
    expect(result.isError).toBeUndefined();
    expect(sent[0]?.url).toContain('/v2/persons?');
    expect(new URL(sent[0]!.url).searchParams.get('email')).toBe(EMAIL);
    expect(new URL(sent[0]!.url).searchParams.get('limit')).toBe('2');
    expect(new URL(sent[1]!.url).searchParams.get('person.id')).toBe('42');
    // The allowlist is unchanged: no absence type, no comment.
    expect(JSON.stringify(result.structuredContent)).not.toMatch(/Sick|absence_type|comment/);
  });

  it('refuses with no_user when no person, two persons or only an inactive one has the address, and sends nothing more', async () => {
    const cases: Persons[] = [
      [],
      [JANE, { ...JANE, id: '43' }],
      [{ ...JANE, status: 'INACTIVE' }],
      [{ ...JANE, email: 'someone.else@example.com' }],
      [{ ...JANE, id: undefined }],
    ];
    for (const persons of cases) {
      const sent: Sent[] = [];
      const result = await gateway(persons, { sent }).callTool(
        'create_my_absence',
        { absenceTypeId: '7', startDate: '2026-08-03' },
        { actAs: { email: EMAIL } },
      );
      expect(result.isError).toBe(true);
      expect(refused(result)).toBe('no_user');
      expect(result.content[0]?.text).toBe(ACT_AS_TEXTS.no_user);
      expect(sent.map(s => s.method)).toEqual(['GET']);
    }
  });

  it('refuses a self tool without actAs, and any call with a malformed actAs, with invalid and nothing sent', async () => {
    for (const tool of SELF_TOOLS) {
      const sent: Sent[] = [];
      const result = await gateway([JANE], { sent }).callTool(tool, {});
      expect(refused(result), tool).toBe('invalid');
      expect(sent).toEqual([]);
    }
    for (const actAs of [null, 'jane', { email: 'not-an-email' }, { email: EMAIL, name: 3 }, []]) {
      const sent: Sent[] = [];
      const result = await gateway([JANE], { sent }).callTool('list_persons', {}, { actAs: actAs as never });
      expect(refused(result)).toBe('invalid');
      expect(sent).toEqual([]);
    }
  });

  it('refuses a person id in a self tool input', async () => {
    for (const tool of ['list_my_absences', 'list_my_attendances', 'create_my_absence', 'create_my_attendance', 'get_my_profile']) {
      const sent: Sent[] = [];
      const result = await gateway([JANE], { sent }).callTool(tool, { personId: '99' }, { actAs: { email: EMAIL } });
      expect(result.isError, tool).toBe(true);
      expect(sent, tool).toEqual([]);
    }
  });

  it('creates an absence for the resolved person, without skip_approval', async () => {
    const sent: Sent[] = [];
    const result = await gateway([JANE], { sent }).callTool(
      'create_my_absence',
      { absenceTypeId: '7', startDate: '2026-08-03', endDate: '2026-08-04' },
      { actAs: { email: EMAIL } },
    );
    expect(result.isError).toBeUndefined();
    const post = sent.find(s => s.method === 'POST');
    expect(post?.url).toMatch(/\/v2\/absence-periods$/);
    const body = JSON.parse(post!.body!) as Record<string, unknown>;
    expect(body.person).toEqual({ id: '42' });
    expect(body).not.toHaveProperty('skip_approval');
    expect(JSON.stringify(result.structuredContent)).not.toContain('secret');
  });

  it('records attendance for the resolved person, and reads only their own attendances and profile', async () => {
    const sent: Sent[] = [];
    const gw = gateway([JANE], { sent });
    const created = await gw.callTool(
      'create_my_attendance',
      { type: 'WORK', start: '2026-08-03T08:00', end: '2026-08-03T16:00' },
      { actAs: { email: EMAIL } },
    );
    expect(created.isError).toBeUndefined();
    const post = sent.find(s => s.method === 'POST');
    expect(JSON.parse(post!.body!)).toMatchObject({ person: { id: '42' }, type: 'WORK' });
    expect(JSON.parse(post!.body!)).not.toHaveProperty('skip_approval');

    sent.length = 0;
    await gw.callTool('list_my_attendances', {}, { actAs: { email: EMAIL } });
    expect(new URL(sent[1]!.url).searchParams.get('person.id')).toBe('42');

    sent.length = 0;
    const profile = await gw.callTool('get_my_profile', {}, { actAs: { email: EMAIL } });
    expect(sent.map(s => new URL(s.url).pathname)).toEqual(['/v2/persons', '/v2/persons/42', '/v2/persons/42/employments']);
    expect(JSON.stringify(profile.structuredContent)).not.toContain('salary');
  });

  it('never writes the email to the audit or to a text of ours', async () => {
    const audit: Array<Record<string, unknown>> = [];
    const gw = gateway([JANE], { audit });
    await gw.callTool('create_my_absence', { absenceTypeId: '7', startDate: '2026-08-03' }, { actAs: { email: EMAIL } });
    const none = await gateway([], { audit }).callTool('list_my_absences', {}, { actAs: { email: EMAIL } });
    expect(JSON.stringify(audit).toLowerCase()).not.toContain('jane');
    expect(audit.some(record => record.action === 'refused' && record.reason === 'no_user')).toBe(true);
    expect(JSON.stringify(none).toLowerCase()).not.toContain('jane');
  });

  it('leaves the company-wide tools as they were: actAs is ignored', async () => {
    const sent: Sent[] = [];
    const result = await gateway([JANE], { sent }).callTool('list_absences', { personId: '99' }, { actAs: { email: EMAIL } });
    expect(result.isError).toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(new URL(sent[0]!.url).searchParams.get('person.id')).toBe('99');
  });

  it('keeps actAsRefused only on an error result', async () => {
    const result = await gateway([JANE]).callTool('get_my_profile', {}, { actAs: { email: EMAIL } });
    expect(result).not.toHaveProperty('actAsRefused');
  });
});
