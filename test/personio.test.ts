import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PersonioClient } from '../src/personio/client.js';
import { createServer } from '../src/server.js';
import { checkToolPolicy } from '../src/personio/policy.js';
import { createAbsence, createAttendance, listCompensations } from '../src/personio/resources.js';
import { resolvePerson } from '../src/personio/identity.js';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

interface Recorded {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

function makeClient(
  record: Recorded[],
  responder?: (url: string) => unknown,
): PersonioClient {
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/v2/auth/token')) {
      expect(init?.headers).toMatchObject({ 'Content-Type': 'application/x-www-form-urlencoded' });
      return new Response(JSON.stringify({ access_token: 'v2tok', expires_in: 86400 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/v1/auth')) {
      return new Response(JSON.stringify({ success: true, data: { token: 'papi-v1tok' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    record.push({
      url,
      method: init?.method,
      headers: init?.headers as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    return new Response(JSON.stringify(responder ? responder(url) : { _data: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  return new PersonioClient({ clientId: 'id', clientSecret: 'secret', fetchImpl });
}

describe('client auth routing', () => {
  it('uses the v2 token for v2 paths and the v1 token for /company paths', async () => {
    const record: Recorded[] = [];
    const client = makeClient(record, url => (url.includes('/v1/') ? { success: true, data: [] } : { _data: [] }));

    await client.get('/v2/persons');
    await client.get('/company/employees/attributes');

    expect(record[0]?.headers?.Authorization).toBe('Bearer v2tok');
    expect(record[1]?.url).toContain('/v1/company/employees/attributes');
    expect(record[1]?.headers?.Authorization).toBe('Bearer papi-v1tok');
  });

  it('throws on v1 HTTP 200 + success:false envelopes', async () => {
    const record: Recorded[] = [];
    const client = makeClient(record, () => ({ success: false, error: { message: 'forbidden.http.exception' } }));
    await expect(client.get('/company/employees')).rejects.toThrow('forbidden');
  });

  it('sends the Beta header only when asked', async () => {
    const record: Recorded[] = [];
    const client = makeClient(record);
    await client.get('/v2/org-units', { type: 'department' }, { beta: true });
    await client.get('/v2/persons');
    expect(record[0]?.headers?.Beta).toBe('true');
    expect(record[1]?.headers?.Beta).toBeUndefined();
  });
});

describe('approval-workflow guarantee', () => {
  it('never sends skip_approval on absence or attendance creation', async () => {
    const record: Recorded[] = [];
    const client = makeClient(record, () => ({ id: 'x' }));

    await createAbsence(client, { personId: '1', absenceTypeId: '2', startDate: '2026-08-01', endDate: '2026-08-05' });
    await createAttendance(client, {
      personId: '1',
      type: 'WORK',
      start: '2026-07-15T08:00:00Z',
      end: '2026-07-15T12:00:00Z',
    });

    for (const call of record) {
      expect(call.url).not.toContain('skip_approval');
      expect(call.body ?? '').not.toContain('skip_approval');
    }
  });

  it('refuses projects on BREAK periods', async () => {
    const client = makeClient([]);
    await expect(
      createAttendance(client, { personId: '1', type: 'BREAK', start: 'a', end: 'b', projectId: '7' }),
    ).rejects.toThrow('WORK');
  });
});

describe('profiles and policy', () => {
  it('employee profile exposes only self-service tools; hr gets the full set', async () => {
    process.env.PERSONIO_PROFILE = 'employee';
    const s1 = createServer({ client: makeClient([]), onBehalfOf: 'me@example.com' });
    const [ct1, st1] = InMemoryTransport.createLinkedPair();
    const c1 = new Client({ name: 't', version: '0' });
    await Promise.all([s1.connect(st1), c1.connect(ct1)]);
    const employeeTools = (await c1.listTools()).tools.map(t => t.name);

    expect(employeeTools).toContain('personio_request_absence');
    expect(employeeTools).toContain('personio_get_my_profile');
    expect(employeeTools).not.toContain('personio_list_persons');
    expect(employeeTools).not.toContain('personio_list_compensations');

    process.env.PERSONIO_PROFILE = 'hr';
    const s2 = createServer({ client: makeClient([]) });
    const [ct2, st2] = InMemoryTransport.createLinkedPair();
    const c2 = new Client({ name: 't', version: '0' });
    await Promise.all([s2.connect(st2), c2.connect(ct2)]);
    const hrTools = (await c2.listTools()).tools.map(t => t.name);

    expect(hrTools).toContain('personio_list_persons');
    expect(hrTools).toContain('personio_list_compensations');
    expect(hrTools).not.toContain('personio_get_my_profile');
  });

  it('gates HR write tools on PERSONIO_ENABLE_WRITES but not employee self-service', () => {
    process.env.PERSONIO_PROFILE = 'hr';
    delete process.env.PERSONIO_ENABLE_WRITES;
    expect(checkToolPolicy('personio_update_person')).toMatchObject({ allowed: false });
    expect(checkToolPolicy('personio_list_persons')).toMatchObject({ allowed: true });

    process.env.PERSONIO_ENABLE_WRITES = 'true';
    expect(checkToolPolicy('personio_update_person')).toMatchObject({ allowed: true });

    process.env.PERSONIO_PROFILE = 'employee';
    delete process.env.PERSONIO_ENABLE_WRITES;
    expect(checkToolPolicy('personio_request_absence')).toMatchObject({ allowed: true });
    expect(checkToolPolicy('personio_update_person')).toMatchObject({ allowed: false });
  });
});

describe('identity scoping', () => {
  it('resolves email to person id and fails closed for unknown emails', async () => {
    const record: Recorded[] = [];
    const found = makeClient(record, () => ({ _data: [{ id: 'p42', first_name: 'Test', last_name: 'Person' }] }));
    const person = await resolvePerson(found, 'test@example.com');
    expect(person.personId).toBe('p42');
    expect(record[0]?.url).toContain('email=test%40example.com');

    const missing = makeClient([], () => ({ _data: [] }));
    await expect(resolvePerson(missing, 'unknown@example.com')).rejects.toThrow('No Personio person');
  });

  it('employee tools are pinned to the resolved person id', async () => {
    process.env.PERSONIO_PROFILE = 'employee';
    const record: Recorded[] = [];
    const client = makeClient(record, url =>
      url.includes('/v2/persons?')
        ? { _data: [{ id: 'p42', first_name: 'Me', last_name: 'Self' }] }
        : { _data: [] },
    );
    const server = createServer({ client, onBehalfOf: 'me@example.com' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: 't', version: '0' });
    await Promise.all([server.connect(st), mcp.connect(ct)]);

    await mcp.callTool({ name: 'personio_get_my_attendances', arguments: {} });
    const attendanceCall = record.find(r => r.url.includes('/v2/attendance-periods'));
    expect(attendanceCall?.url).toContain('person.id=p42');
  });

  it('employee tools fail without a forwarded identity', async () => {
    process.env.PERSONIO_PROFILE = 'employee';
    const server = createServer({ client: makeClient([]) });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: 't', version: '0' });
    await Promise.all([server.connect(st), mcp.connect(ct)]);

    const result = await mcp.callTool({ name: 'personio_get_my_profile', arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]?.text).toContain('X-MCP-User');
  });
});

describe('compensation guardrails', () => {
  it('requires a date window for entries', async () => {
    const client = makeClient([]);
    await expect(listCompensations(client, { scope: 'entries' })).rejects.toThrow('startDate');
  });
});

describe('legal-entity HR scoping', () => {
  function scopedClient(personsByEntity: Record<string, string>): PersonioClient {
    // personsByEntity: personId -> legalEntityId
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v2/auth/token')) {
        return new Response(JSON.stringify({ access_token: 'v2', expires_in: 86400 }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      const empMatch = url.match(/\/v2\/persons\/([^/]+)\/employments/);
      if (empMatch) {
        const pid = empMatch[1];
        return new Response(JSON.stringify({ _data: [{ id: `e-${pid}`, legal_entity: { id: personsByEntity[pid] } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/v2/persons')) {
        return new Response(JSON.stringify({ _data: Object.keys(personsByEntity).map(id => ({ id, employments: [{ id: `e-${id}` }] })) }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/v2/absence-periods')) {
        return new Response(JSON.stringify({ _data: [{ id: 'a1', person: { id: 'p1' } }, { id: 'a2', person: { id: 'p2' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ _data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    return new PersonioClient({ clientId: 'i', clientSecret: 's', fetchImpl });
  }

  it('drops cross-entity leak tools and confines person-addressed tools when scoped', async () => {
    process.env.PERSONIO_PROFILE = 'hr';
    process.env.PERSONIO_HR_LEGAL_ENTITY = '816055'; // Spitze
    const client = scopedClient({ p1: '816055', p2: '816056' }); // p1 Spitze, p2 Borgels

    const server = createServer({ client });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: 't', version: '0' });
    await Promise.all([server.connect(st), mcp.connect(ct)]);

    const tools = (await mcp.listTools()).tools.map(t => t.name);
    expect(tools).not.toContain('personio_get_custom_report');
    expect(tools).not.toContain('personio_list_recruiting');
    expect(tools).toContain('personio_get_person');

    // p1 (Spitze) allowed
    const ok = await mcp.callTool({ name: 'personio_get_person', arguments: { personId: 'p1' } });
    expect(ok.isError).toBeFalsy();
    // p2 (Borgels) rejected
    const bad = await mcp.callTool({ name: 'personio_get_person', arguments: { personId: 'p2' } });
    expect(bad.isError).toBe(true);
    expect((bad.content as Array<{ text: string }>)[0]?.text).toContain('legal entity');

    // list_absences without personId filters to Spitze persons only (p1)
    const abs = await mcp.callTool({ name: 'personio_list_absences', arguments: {} });
    const absData = JSON.parse((abs.content as Array<{ text: string }>)[0].text);
    expect(absData._data.map((r: { id: string }) => r.id)).toEqual(['a1']);
  });

  it('unscoped (all) HR keeps the full tool set', async () => {
    process.env.PERSONIO_PROFILE = 'hr';
    process.env.PERSONIO_HR_LEGAL_ENTITY = 'all';
    const server = createServer({ client: scopedClient({ p1: '816055' }) });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: 't', version: '0' });
    await Promise.all([server.connect(st), mcp.connect(ct)]);
    const tools = (await mcp.listTools()).tools.map(t => t.name);
    expect(tools).toContain('personio_get_custom_report');
    expect(tools).toContain('personio_list_recruiting');
  });
});
