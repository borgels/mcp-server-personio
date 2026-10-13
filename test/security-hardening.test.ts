import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PersonioClient } from '../src/personio/client.js';
import { createServer } from '../src/server.js';
import { resolvePerson } from '../src/personio/identity.js';
import { pathParam } from '../src/personio/path.js';
import { getAbsenceBalance, getPerson, listDocuments } from '../src/personio/resources.js';
import { assertAuthorized, assertSafeHttpStartup, tokenMatches } from '../src/transports/http-helpers.js';

const originalEnv = { ...process.env };
afterEach(() => {
  process.env = { ...originalEnv };
});

interface Call {
  url: string;
  method: string;
}

/** Fake Personio: p1/p2 in entity A (816055), p9 in entity B. */
function fakeClient(calls: Call[], extra: (url: URL, method: string) => unknown = () => undefined): PersonioClient {
  const entityOf: Record<string, string> = { p1: '816055', p2: '816055', p9: '816099' };
  const emails: Record<string, string> = { p1: 'one@a.example', p2: 'two@a.example', p9: 'nine@b.example' };
  const legacy: Record<string, number> = { p1: 101, p2: 102, p9: 109 };
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    if (url.pathname.endsWith('/v2/auth/token')) return json({ access_token: 'v2', expires_in: 86400 });
    if (url.pathname.endsWith('/v1/auth')) return json({ success: true, data: { token: 'papi' } });
    calls.push({ url: url.toString(), method });
    const custom = extra(url, method);
    if (custom !== undefined) return json(custom);
    const emp = url.pathname.match(/\/v2\/persons\/([^/]+)\/employments$/);
    if (emp) return json({ _data: [{ id: `e-${emp[1]}`, legal_entity: { id: entityOf[emp[1] ?? ''] } }] });
    if (url.pathname.endsWith('/v2/persons')) {
      const email = url.searchParams.get('email');
      const ids = Object.keys(entityOf).filter(id => !email || emails[id] === email.toLowerCase());
      return json({ _data: ids.map(id => ({ id, email: emails[id], legacy_id: legacy[id] })) });
    }
    const v1 = url.pathname.match(/\/v1\/company\/employees\/(\d+)$/);
    if (v1) {
      const id = Object.keys(legacy).find(k => legacy[k] === Number(v1[1]));
      return json({
        success: true,
        data: { attributes: { id: { value: Number(v1[1]) }, email: { value: id ? emails[id] : undefined } } },
      });
    }
    if (url.pathname.endsWith('/v1/company/employees')) {
      const email = url.searchParams.get('email');
      const ids = Object.keys(emails).filter(id => emails[id] === email);
      return json({
        success: true,
        data: ids.map(id => ({ attributes: { id: { value: legacy[id] }, email: { value: emails[id] } } })),
      });
    }
    const abs = url.pathname.match(/\/v2\/absence-periods\/([^/]+)$/);
    if (abs && method === 'GET') return json({ _data: { id: abs[1], person: { id: abs[1] === 'absB' ? 'p9' : 'p1' } } });
    const att = url.pathname.match(/\/v2\/attendance-periods\/([^/]+)$/);
    if (att && method === 'GET') return json({ _data: { id: att[1], person: { id: att[1] === 'attB' ? 'p9' : 'p1' } } });
    if (url.pathname.endsWith('/v2/document-management/documents')) {
      const owner = url.searchParams.get('owner_id');
      return json({
        _data: owner === 'p9' ? [{ id: 'docB', owner: { id: 'p9' } }] : [{ id: 'docA', owner: { id: owner } }],
      });
    }
    return json({ _data: [], success: true, data: {} });
  }) as unknown as typeof fetch;
  return new PersonioClient({ clientId: 'i', clientSecret: 's', fetchImpl });
}

async function connect(client: PersonioClient) {
  const server = createServer({ client });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(st), mcp.connect(ct)]);
  return mcp;
}

function scopedEnv() {
  process.env.PERSONIO_PROFILE = 'hr';
  process.env.PERSONIO_ENABLE_WRITES = 'true';
  process.env.PERSONIO_HR_LEGAL_ENTITY = '816055';
}

const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]?.text ?? '';
const mutations = (calls: Call[]) => calls.filter(c => c.method !== 'GET');

describe('legal-entity scope on id-addressed HR tools', () => {
  it('refuses absence balances for an out-of-scope email', async () => {
    scopedEnv();
    const calls: Call[] = [];
    const mcp = await connect(fakeClient(calls));
    const bad = await mcp.callTool({ name: 'personio_list_absences', arguments: { balanceForEmail: 'nine@b.example' } });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain('legal entity');
    expect(calls.some(c => c.url.includes('/absences/balance'))).toBe(false);
    const ok = await mcp.callTool({ name: 'personio_list_absences', arguments: { balanceForEmail: 'one@a.example' } });
    expect(ok.isError).toBeFalsy();
  });

  it('refuses update/delete of an out-of-scope absence period', async () => {
    scopedEnv();
    const calls: Call[] = [];
    const mcp = await connect(fakeClient(calls));
    for (const action of ['delete', 'update'] as const) {
      const bad = await mcp.callTool({
        name: 'personio_manage_absence',
        arguments: { action, absencePeriodId: 'absB', patch: {} },
      });
      expect(bad.isError).toBe(true);
    }
    expect(mutations(calls)).toHaveLength(0);
    const ok = await mcp.callTool({ name: 'personio_manage_absence', arguments: { action: 'delete', absencePeriodId: 'absA' } });
    expect(ok.isError).toBeFalsy();
    expect(mutations(calls).map(c => c.method)).toEqual(['DELETE']);
  });

  it('fails closed when an absence period owner cannot be determined', async () => {
    scopedEnv();
    const calls: Call[] = [];
    const mcp = await connect(
      fakeClient(calls, (url, method) =>
        url.pathname.includes('/absence-periods/') && method === 'GET' ? { _data: {} } : undefined,
      ),
    );
    const res = await mcp.callTool({ name: 'personio_manage_absence', arguments: { action: 'delete', absencePeriodId: 'x' } });
    expect(res.isError).toBe(true);
    expect(mutations(calls)).toHaveLength(0);
  });

  it('refuses update/delete of an out-of-scope attendance period', async () => {
    scopedEnv();
    const calls: Call[] = [];
    const mcp = await connect(fakeClient(calls));
    for (const action of ['delete', 'update'] as const) {
      const bad = await mcp.callTool({
        name: 'personio_manage_attendance',
        arguments: { action, attendancePeriodId: 'attB', patch: {} },
      });
      expect(bad.isError).toBe(true);
    }
    expect(mutations(calls)).toHaveLength(0);
    const ok = await mcp.callTool({
      name: 'personio_manage_attendance',
      arguments: { action: 'update', attendancePeriodId: 'attA', patch: { comment: 'x' } },
    });
    expect(ok.isError).toBeFalsy();
  });

  it('refuses document upload for an out-of-scope or unknown v1 employee', async () => {
    scopedEnv();
    const calls: Call[] = [];
    const mcp = await connect(fakeClient(calls));
    const args = { categoryId: 1, title: 't', fileName: 'f.txt', contentBase64: 'eA==' };
    const bad = await mcp.callTool({ name: 'personio_upload_document', arguments: { ...args, employeeId: 109 } });
    expect(bad.isError).toBe(true);
    const unknown = await mcp.callTool({ name: 'personio_upload_document', arguments: { ...args, employeeId: 555 } });
    expect(unknown.isError).toBe(true);
    expect(mutations(calls)).toHaveLength(0);
  });

  it('requires and verifies the document owner for manage_document', async () => {
    scopedEnv();
    const calls: Call[] = [];
    const mcp = await connect(fakeClient(calls));
    const noOwner = await mcp.callTool({ name: 'personio_manage_document', arguments: { action: 'delete', documentId: 'docB' } });
    expect(noOwner.isError).toBe(true);
    const outOfScope = await mcp.callTool({
      name: 'personio_manage_document',
      arguments: { action: 'delete', documentId: 'docB', ownerId: 'p9' },
    });
    expect(outOfScope.isError).toBe(true);
    const mismatched = await mcp.callTool({
      name: 'personio_manage_document',
      arguments: { action: 'delete', documentId: 'docB', ownerId: 'p1' },
    });
    expect(mismatched.isError).toBe(true);
    expect(mutations(calls)).toHaveLength(0);
    const ok = await mcp.callTool({
      name: 'personio_manage_document',
      arguments: { action: 'delete', documentId: 'docA', ownerId: 'p1' },
    });
    expect(ok.isError).toBeFalsy();
  });

  it('refuses project membership changes for out-of-scope persons', async () => {
    scopedEnv();
    const calls: Call[] = [];
    const mcp = await connect(fakeClient(calls));
    const bad = await mcp.callTool({
      name: 'personio_manage_project',
      arguments: { action: 'add-member', projectId: '7', personId: 'p9' },
    });
    expect(bad.isError).toBe(true);
    expect(mutations(calls)).toHaveLength(0);
    const ok = await mcp.callTool({
      name: 'personio_manage_project',
      arguments: { action: 'remove-member', projectId: '7', personId: 'p2' },
    });
    expect(ok.isError).toBeFalsy();
  });
});

describe('exact identity matching', () => {
  it('rejects a person row whose email does not match', async () => {
    const client = fakeClient([], url =>
      url.pathname.endsWith('/v2/persons') ? { _data: [{ id: 'p9', email: 'other@x.example' }] } : undefined,
    );
    await expect(resolvePerson(client, 'me@x.example')).rejects.toThrow('No Personio person');
  });

  it('rejects ambiguous person lookups', async () => {
    const client = fakeClient([], url =>
      url.pathname.endsWith('/v2/persons')
        ? { _data: [{ id: 'a', email: 'me@x.example' }, { id: 'b', email: 'ME@x.example' }] }
        : undefined,
    );
    await expect(resolvePerson(client, 'me@x.example')).rejects.toThrow('more than one');
  });

  it('accepts a case-insensitive exact match', async () => {
    const client = fakeClient([], url =>
      url.pathname.endsWith('/v2/persons') ? { _data: [{ id: 'a', email: 'Me@X.example' }] } : undefined,
    );
    await expect(resolvePerson(client, 'me@x.example')).resolves.toMatchObject({ personId: 'a' });
  });

  it('absence balance requires exactly one matching v1 employee', async () => {
    const calls: Call[] = [];
    const client = fakeClient(calls, url =>
      url.pathname.endsWith('/v1/company/employees')
        ? { success: true, data: [{ attributes: { id: { value: 5 }, email: { value: 'someone@else.example' } } }] }
        : undefined,
    );
    await expect(getAbsenceBalance(client, 'me@x.example')).rejects.toThrow();
    expect(calls.some(c => c.url.includes('/balance'))).toBe(false);
  });
});

describe('document ownership proof', () => {
  it('does not accept a listed document row without an owner', async () => {
    const calls: Call[] = [];
    const client = fakeClient(calls, url =>
      url.pathname.endsWith('/v2/document-management/documents') ? { _data: [{ id: '111' }] } : undefined,
    );
    await expect(listDocuments(client, { ownerId: 'A', documentId: '111', download: true })).rejects.toThrow(
      'not found',
    );
    expect(calls.some(c => c.url.includes('/download'))).toBe(false);
  });
});

describe('path parameter guard', () => {
  it.each(['', ' ', '.', '..', 'a/b', 'a\\b', 'a?x=1', 'a#b', '%2e%2e', '%2F', 'x%2fy', '%5c'])('rejects %j', value => {
    expect(() => pathParam(value)).toThrow('Invalid');
  });

  it('accepts ordinary ids', () => {
    expect(pathParam('abc-123_X')).toBe('abc-123_X');
    expect(pathParam(42)).toBe('42');
  });

  it('is applied before requests are sent', async () => {
    const calls: Call[] = [];
    await expect(getPerson(fakeClient(calls), { personId: '..' })).rejects.toThrow('Invalid personId');
    expect(calls).toHaveLength(0);
  });
});

describe('HTTP transport hardening', () => {
  const req = (authorization?: string) => ({ headers: { authorization } }) as unknown as IncomingMessage;
  const config = { host: '127.0.0.1', port: 0, maxBodyBytes: 1, httpToken: 'sekret' };

  it('compares bearer tokens correctly', () => {
    expect(() => assertAuthorized(req('Bearer sekret'), config)).not.toThrow();
    expect(() => assertAuthorized(req('Bearer sekreT'), config)).toThrow('Unauthorized');
    expect(() => assertAuthorized(req('Bearer sekret-longer'), config)).toThrow('Unauthorized');
    expect(() => assertAuthorized(req(undefined), config)).toThrow('Unauthorized');
    expect(tokenMatches(undefined, 'x')).toBe(false);
  });

  it('refuses to start when forwarded users are trusted without a token', () => {
    expect(() => assertSafeHttpStartup({ PERSONIO_TRUST_FORWARDED_USER: 'true' })).toThrow('MCP_HTTP_TOKEN');
    expect(() => assertSafeHttpStartup({ PERSONIO_TRUST_FORWARDED_USER: 'true', MCP_HTTP_TOKEN: '' })).toThrow();
    expect(() => assertSafeHttpStartup({ PERSONIO_TRUST_FORWARDED_USER: 'true', MCP_HTTP_TOKEN: 't' })).not.toThrow();
    expect(() => assertSafeHttpStartup({ PERSONIO_TRUST_FORWARDED_USER: 'false' })).not.toThrow();
  });
});
