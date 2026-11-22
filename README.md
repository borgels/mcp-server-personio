# mcp-server-personio

MCP server for the [Personio](https://developer.personio.de/) HR API with two profiles and per-user scoping.

This is an independent, unofficial project. It is not developed, endorsed or supported by Personio.

## Profiles

One image, selected by `PERSONIO_PROFILE`:

- **`employee`** — self-service, hard-scoped to the requesting user: `personio_get_my_profile`, `personio_get_my_absences` (+ balances), `personio_request_absence`, `personio_get_my_attendances`, `personio_record_attendance` (WORK/BREAK periods, project tagging), `personio_get_my_documents` (incl. e-signature status + download), `personio_list_absence_types`, `personio_list_projects`, `personio_whoami`. The gateway forwards the verified user email (`X-MCP-User`, honored when `PERSONIO_TRUST_FORWARDED_USER=true`); the server resolves it to a person id and pins every call to it — Personio has no on-behalf-of mechanism, so this scoping is enforced here. Unknown emails fail closed.
- **`hr`** — the HR workbench: persons + employments (list/get/update), absences and attendances for anyone (list/create/delete), projects (full CRUD + members), compensation entries/types/jobs/salary bands (**read-only** — API-created compensation can never be corrected, so creation is deliberately not exposed), documents (list/download/upload), org data (legal entities, departments, teams, cost centers, workplaces), custom reports, recruiting reads (applications/candidates/jobs/categories), and an attribute-whitelist diagnostic. Write tools additionally require `PERSONIO_ENABLE_WRITES=true`.

## Guarantees

- **`skip_approval` is never sent** — absence/attendance writes always enter Personio's normal approval workflow (the v2 default; v1's silent-bypass default is one reason this server is v2-first).
- No delete-person tool. Employee-profile tools never accept foreign person ids.
- **Legal-entity scope** (`PERSONIO_HR_LEGAL_ENTITY=<id>`, HR profile): every person-addressed tool is confined to employees of that entity. Tools addressed by another id resolve the owning person first and fail closed when it cannot be determined: absence/attendance periods are fetched to read their person, `balanceForEmail` is resolved to a person, `personio_upload_document`'s v1 `employeeId` is mapped to a person via its email, project membership changes check `personId`, and `personio_manage_document` requires `ownerId` (verified against the owner-filtered document list) on a scoped instance.
- Email lookups require exactly one person whose email matches case-insensitively; ambiguous or non-matching results fail closed.
- Caller-supplied ids used in URL paths are rejected if empty, `.`/`..`, or contain `/`, `\`, `?`, `#` or their percent-encoded forms.
- HTTP transport: `MCP_HTTP_TOKEN` is compared in constant time and is required on any non-loopback bind. With `PERSONIO_TRUST_FORWARDED_USER=true` the HTTP server **refuses to start unless `MCP_HTTP_TOKEN` is set** (also on loopback), since the forwarded `X-MCP-User` header would otherwise be accepted from any caller.
- Upstream requests never follow redirects, so the client secret and bearer tokens are only sent to `PERSONIO_BASE_URL`.
- Only credential-whitelisted attributes are returned by Personio — `personio_list_attributes` shows what your credential can see (missing attributes are omitted silently, not errored).

## Not possible via Personio's public API

Performance, surveys, whistleblowing, onboarding checklists, workflow automations (beyond outbound webhooks), e-signature initiation, and approving pending absence requests have **no public API** — those remain in the Personio UI.

## Auth

One client_id/client_secret pair (Settings → Integrations → API credentials) drives both API generations: OAuth2 client-credentials against `/v2/auth/token` (form-encoded) for v2, and the stable 24h `papi-` token from `/v1/auth` for the two v1-only flows (absence balances, document upload).

## Install

```bash
npx mcp-server-personio
```

Runs the stdio server from npm. Configure it with the environment variables in `.env.example`. Over stdio the `employee` profile acts as `PERSONIO_DEFAULT_USER` (your Personio email); without it, its self-service tools refuse.

## Run

```bash
npm install
npm run dev          # stdio
npm run dev:http     # streamable HTTP on :3000/mcp (stateless)
npm test
```

Docker images: `ghcr.io/borgels/mcp-server-personio` (published from `main` after CI passes, and from `v*` tags). The container binds `0.0.0.0`, so it needs `MCP_HTTP_TOKEN` (at least 32 characters).

### HTTP transport settings

The HTTP transport serves `POST /mcp` (stateless Streamable HTTP) and an
unauthenticated `GET /healthz`. It binds to `127.0.0.1` unless told otherwise.

| Variable | Default | Meaning |
|---|---|---|
| `MCP_HTTP_HOST` / `HOST` | `127.0.0.1` | Bind address. |
| `PORT` | `3000` | Listen port (1-65535). |
| `MCP_HTTP_TOKEN` | – | Bearer token for `/mcp`: at least 32 printable ASCII characters, e.g. `openssl rand -hex 32`. **Required** on a non-loopback bind and with `MCP_ALLOW_ANY_ORIGIN=true`; the server refuses to start otherwise. |
| `MCP_HTTP_ALLOW_UNAUTHENTICATED` | `false` | Start without a token where one would be required. Only for setups where access is restricted by other means; logs a warning. |
| `MCP_ALLOWED_ORIGINS` | – | Comma-separated browser origins allowed to call `/mcp`. Default: localhost origins. Requests without an `Origin` header (server-to-server) are not affected. |
| `MCP_ALLOW_ANY_ORIGIN` | `false` | Allow any browser origin. Requires `MCP_HTTP_TOKEN`. |
| `MCP_ALLOWED_HOSTS` | – | Comma-separated host names accepted in the `Host` header. Default: on a loopback bind only `localhost`, `127.0.0.1`, `[::1]` and the bind address; no check on other binds. |
| `MCP_MAX_BODY_BYTES` | `10485760` | Request body limit; larger requests get 413. |
| `MCP_AUTH_FAILURE_LIMIT` | `20` | Failed authentication attempts per client address within the window before further failures get 429. `0` disables. Requests with a valid token are never throttled. |
| `MCP_AUTH_FAILURE_WINDOW_MS` | `60000` | Window for `MCP_AUTH_FAILURE_LIMIT`. |

Invalid values (a non-numeric `PORT`, a misspelt boolean) stop the server at
startup with a message naming the variable. Rejected requests get a JSON error
(401 with `WWW-Authenticate: Bearer`, 400 for invalid JSON, 413 for oversized
bodies) and one log line on stderr. The server shuts down gracefully on
SIGTERM/SIGINT.

## Embedding (`./gateway`)

For a host that does its own per-user authorization (one instance per
Personio company, several in one process), the package exports
`mcp-server-personio/gateway`, in the shape of mcp-server-template:

```ts
import { createPersonioGateway, personioToolCatalog } from 'mcp-server-personio/gateway';

const gateway = createPersonioGateway({
  clientId,            // required; never read from the environment
  clientSecret,        // required; admitted only if it shares no text with our own texts
  policy: { enableWrites: true, disabledTools: [], audit: record => log(record) },
});
await gateway.callTool('list_absences', { from: '2026-08-01', to: '2026-08-31' }, { requestId });
```

- A gateway instance reads no `PERSONIO_*` variable. Without `policy`,
  writes are off and nothing is audited. With an `audit` sink, a write
  runs only if its start record was accepted (a sink that throws refuses
  the write). Without one, the instance writes no audit records: a host
  that turns writes on without a sink keeps its own record of the change
  before it calls the tool.
- `personioToolCatalog` is deeply frozen: every tool with its risk level,
  JSON Schema, the upstream requests it may make (`upstream`), `broad`
  (false for all) and `self` (true for the self tools, see below).
- The gateway has its own, curated tool table (`src/gateway/tools.ts`):
  company structure, a headcount without names, absence types, projects,
  persons and employments, absence and attendance periods, and two writes
  (create an absence period, record an attendance period), both through
  Personio's normal approval workflow.
- Answers are built from allowlists of standard fields. A person's custom
  attributes (where national id numbers, bank details, salary and birth
  dates live) are never returned, whatever the API credential whitelists;
  nor are the type and comment of an absence or the comment of an
  attendance. There are no compensation, document, recruiting, report or
  delete tools, and no change to a person or an employment.
- Errors carry the HTTP status and our own text, never Personio's response
  body. When Personio answered with an HTTP error (a refused token request or
  redirect, or a v1 answer with `success: false`, included), the error result
  also has `failure: { httpStatus, requestId? }`: the status, and Personio's
  request id from a response header (`REQUEST_ID_HEADERS` in
  `src/errors.ts`) only when it is a hex id of 8 to 64 characters (one run of
  hex digits, or groups of four or more joined by single hyphens, as in a
  UUID) and does not hold the shape of a personal number. A host can count
  failures from it without reading their text. Never the response body,
  Personio's error code, message or trace id. Every output is redacted with the instance's own credentials and
  withheld whole if it would still hold a piece of one.

### Acting as the person (`actAs`)

A host that has verified who the person is (signed in, email confirmed) can
pass `actAs: { email, name? }` in the call context:

```ts
await gateway.callTool('create_my_absence', { absenceTypeId: '7', startDate: '2026-08-03' }, { requestId, actAs: { email } });
```

- The self tools (catalog `self: true`) work only on that person:
  `get_my_profile`, `list_my_absences`, `list_my_attendances`,
  `create_my_absence` and `create_my_attendance`. Their input never names a
  person (`personId` is refused), so they cannot read or change anyone
  else's data. The same allowlists apply as for the company-wide tools: no
  custom attributes, no absence type or comment.
- The person is found with `GET /v2/persons?email=…`: exactly one person
  whose work email matches case-insensitively and who is not `INACTIVE`.
  None, several or an inactive one: nothing more is sent, and the error
  result has `actAsRefused: 'no_user'`. A self tool without `actAs`, or any
  call with a malformed `actAs`, has `actAsRefused: 'invalid'`. There is no
  fallback to another person or to the company-wide tools.
- The writes enter Personio's normal approval workflow, as the company-wide
  ones do; Personio records them through the API credential, on the person.
- The company-wide tools ignore `actAs`.
- The email is only sent to Personio as the filter that finds the person.
  It is never written to the audit and never put in a text of ours
  (`ACT_AS_TEXTS` are fixed).
- The API credential needs read access to persons (with the email
  attribute) and write access to absence and attendance periods, as for the
  company-wide tools.

## Security model

- The server calls Personio with one shared API credential (the client id and
  secret in its environment). In the `hr` profile everyone who can call the
  server acts with that credential's rights.
- The `employee` profile scopes every call to the user named in `X-MCP-User`.
  That header is only honoured with `PERSONIO_TRUST_FORWARDED_USER=true`,
  which requires `MCP_HTTP_TOKEN`: the identity-aware gateway in front of the
  server authenticates users, sets the header itself and is the only caller
  holding the token. Per-user authorization belongs in that gateway.
- `MCP_HTTP_TOKEN` decides who may call the server at all. It does not tell
  users apart.
- Tool access is not data access. Disabling or hiding tools limits what a
  client can call, but the API credential decides what data the server can
  reach. Limit its attribute whitelist and scopes in Personio.
- The HTTP server does not terminate TLS. Run it behind a reverse proxy that
  does, or keep it on a private network.

## License

The code is source-available under the [Functional Source License, Version 1.1, ALv2 Future License](LICENSE) (FSL-1.1-ALv2).

In plain words:

- **Allowed:** reading the code, running it, changing it, using it inside your own organisation (also commercially), using it for non-commercial education and research, and contributing changes back.
- **Not allowed:** making it, or something built from it, available to others as a commercial product or service that competes with it, for example a hosted service with the same functionality.
- **Becomes Apache-2.0:** each version is also licensed under the Apache License 2.0 from two years after it is released.
- **Earlier versions:** versions released before 0.5.0 were licensed under Apache-2.0 and remain so.

The terms in [LICENSE](LICENSE) are what apply; this summary does not replace them. See also [NOTICE](NOTICE).
