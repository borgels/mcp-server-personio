// Failure metadata on gateway error results: Personio's HTTP status and its request id (a UUID or hex id only), for
// a host that counts failures without reading their text. Never the body, the vendor's code or message.
import { describe, expect, it } from 'vitest';
import { failureMetadata, PersonioHttpError, requestIdFrom, vendorRequestId } from '../src/errors.js';
import { createPersonioGateway } from '../src/gateway.js';

const CLIENT_ID = 'Kx4mPq8vRt2nWz6y';
// Built at run time, so a scanner does not take a test value for a real credential.
const SECRET = ['Zq7pX2vK', '9mWb4TnR', '8yLc3HdJ', '6fGs1QeU'].join('');
const UUID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';
const BODY = {
  success: false,
  error: { code: 0, message: 'Customer Jane Doe not found' },
  errors: [{ title: 'E_NOPE', detail: 'Customer Jane Doe not found' }],
  personio_trace_id: 'trace-jane-doe',
};
const TOKEN_URL = 'https://api.personio.de/v2/auth/token';

interface Answer {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

/** A gateway whose token request gets `token` (default: a token) and every other request gets `answer`. */
function gatewayAnswering(answer: Answer, options: { token?: Answer; clientSecret?: string } = {}) {
  const fetchImpl = (async (input: string | URL | Request) => {
    const { status, headers = {}, body = BODY } =
      String(input) === TOKEN_URL
        ? (options.token ?? { status: 200, body: { access_token: 'tok-abcdefghijklmnop', expires_in: 3600 } })
        : answer;
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  }) as typeof fetch;
  return createPersonioGateway({ clientId: CLIENT_ID, clientSecret: options.clientSecret ?? SECRET, fetchImpl });
}

describe('vendorRequestId', () => {
  it('keeps a UUID and a hex id', () => {
    expect(vendorRequestId(UUID)).toBe(UUID);
    expect(vendorRequestId(` ${UUID} `)).toBe(UUID);
    expect(vendorRequestId('a1b2c3d4e5f60718')).toBe('a1b2c3d4e5f60718');
    expect(vendorRequestId('ABCDEF12-3456')).toBe('ABCDEF12-3456');
    expect(vendorRequestId('f'.repeat(64))).toBe('f'.repeat(64));
  });

  it('drops anything that could be text, and the shape of a personal number', () => {
    for (const value of [
      undefined,
      null,
      '',
      'abc123',
      'Jane Doe',
      'jane@example.com',
      'req_8f3a9c2d1e',
      'deadbeef deadbeef',
      '0101901234',
      'ab-010190-1234-cd',
      'f'.repeat(65),
      '-abcdef12',
      'abcdef12-',
      'a-------',
      'abc--def',
      'abcd--ef12',
      'abcdef12-ab',
      'abcdef1',
      'abcdef12-'.repeat(8),
    ]) {
      expect(vendorRequestId(value)).toBeUndefined();
    }
  });

  it('reads the first header that has an id in the right form', () => {
    expect(requestIdFrom(new Headers({ 'x-request-id': 'not an id', 'request-id': UUID }))).toBe(UUID);
    expect(requestIdFrom(new Headers({ 'x-correlation-id': 'deadbeefcafe' }))).toBe('deadbeefcafe');
    expect(requestIdFrom(new Headers({ 'x-vendor-id': UUID }))).toBeUndefined();
    expect(requestIdFrom(new Headers({ 'x-vendor-id': UUID }), ['x-vendor-id'])).toBe(UUID);
  });

  it('gives metadata for an HTTP error only', () => {
    const url = 'https://api.personio.de/v2/persons';
    expect(failureMetadata(new PersonioHttpError({ status: 404, url, requestId: UUID }))).toEqual({
      httpStatus: 404,
      requestId: UUID,
    });
    expect(failureMetadata(new PersonioHttpError({ status: 500, url, requestId: 'Jane Doe' }))).toEqual({ httpStatus: 500 });
    expect(failureMetadata(new Error('boom'))).toBeUndefined();
    expect(failureMetadata('boom')).toBeUndefined();
  });
});

describe('gateway error results', () => {
  it('carry the HTTP status and the request id, never the body', async () => {
    const result = await gatewayAnswering({ status: 404, headers: { 'x-request-id': UUID } }).callTool('get_person', {
      personId: '42',
    });
    expect(result.isError).toBe(true);
    expect(result.failure).toEqual({ httpStatus: 404, requestId: UUID });
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('Jane Doe');
    expect(serialised).not.toContain('E_NOPE');
    expect(serialised).not.toContain('trace-jane-doe');
  });

  it('carry the status and request id of a refused token request', async () => {
    const result = await gatewayAnswering(
      { status: 200, body: { data: [] } },
      { token: { status: 401, headers: { 'request-id': UUID } } },
    ).callTool('check_connection', {});
    expect(result.isError).toBe(true);
    expect(result.failure).toEqual({ httpStatus: 401, requestId: UUID });
    expect(JSON.stringify(result)).not.toContain('Jane Doe');
  });

  it('carry the status and request id of a refused redirect', async () => {
    const result = await gatewayAnswering({
      status: 307,
      headers: { 'x-request-id': UUID, location: 'https://elsewhere.example.test/' },
    }).callTool('check_connection', {});
    expect(result.isError).toBe(true);
    expect(result.failure).toEqual({ httpStatus: 307, requestId: UUID });
    expect(JSON.stringify(result)).not.toContain('elsewhere');
  });

  it('carry the status alone when the request id is not in the form of one', async () => {
    const result = await gatewayAnswering({ status: 422, headers: { 'x-request-id': 'Jane Doe <jane@example.com>' } }).callTool(
      'get_person',
      { personId: '42' },
    );
    expect(result.failure).toEqual({ httpStatus: 422 });
    expect(JSON.stringify(result)).not.toContain('jane@example.com');
  });

  it('drop a request id that holds a piece of the key', async () => {
    // The key's own hex-looking piece as the id: redaction changes it, and the changed value is no id.
    const result = await gatewayAnswering(
      { status: 500, headers: { 'x-request-id': 'deadbeef00112233' } },
      { clientSecret: 'deadbeef00112233-Kq9Zx-W' },
    ).callTool('get_person', { personId: '42' });
    expect(result.failure).toEqual({ httpStatus: 500 });
    expect(JSON.stringify(result)).not.toContain('deadbeef0011');
  });

  it('have no metadata when the cause is not Personio', async () => {
    const gw = gatewayAnswering({ status: 200, headers: { 'x-request-id': UUID }, body: { data: [] } });
    expect((await gw.callTool('get_person', {})).failure).toBeUndefined();
    expect((await gw.callTool('no_such_tool', {})).failure).toBeUndefined();
    const offline = createPersonioGateway({
      clientId: CLIENT_ID,
      clientSecret: SECRET,
      fetchImpl: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    const result = await offline.callTool('check_connection', {});
    expect(result.isError).toBe(true);
    expect(result.failure).toBeUndefined();
  });

  it('are absent on a successful result', async () => {
    const result = await gatewayAnswering({ status: 200, headers: { 'x-request-id': UUID }, body: { data: [] } }).callTool(
      'check_connection',
      {},
    );
    expect(result.isError).toBeUndefined();
    expect(result.failure).toBeUndefined();
  });
});
