# Changelog

## Unreleased

## 0.3.0

Embeddable gateway in the shape of mcp-server-template (#39).

- New export `mcp-server-personio/gateway`: `createPersonioGateway({ clientId,
  clientSecret, baseUrl?, fetchImpl?, timeoutMs?, policy? })`. Credentials are
  required and never read from the environment; no `PERSONIO_*` variable is
  read by a gateway instance.
- Key admission against a generated corpus of our own texts
  (`scripts/fixed-corpus.mjs`), sealed errors and a sink check on every output.
- Host policy per instance: `enableWrites`, `disabledTools`, `audit` (with a
  sink, a write runs only if its start record was accepted; without one,
  nothing is audited and the host keeps its own record).
- Deeply frozen `personioToolCatalog` with `upstream` and `broad`.
- A curated, company-wide tool table: answers from allowlists of standard
  fields only (no custom attributes; no absence type or comment), no
  compensation, document, recruiting, report or delete tools. Writes: create an
  absence period, record an attendance period; both through the approval
  workflow.
- Errors in our own words with the HTTP status; Personio's bodies are never
  passed on.
- The build now writes `dist/transports/stdio.js` and `dist/transports/http.js`
  (and `dist/gateway.js`); `main`, `bin` and the Dockerfile point there.

- Published to npm and the MCP Registry from tagged releases.
- stdio: `PERSONIO_DEFAULT_USER` sets the employee the `employee` profile acts as.

## 0.2.0

HTTP transport, upstream client and supply chain.

- HTTP transport fails closed: it refuses to start on a non-loopback bind, or
  with `MCP_ALLOW_ANY_ORIGIN=true`, unless `MCP_HTTP_TOKEN` is set.
  `MCP_HTTP_ALLOW_UNAUTHENTICATED=true` is an explicit escape hatch.
- `MCP_HTTP_TOKEN` must be at least 32 printable ASCII characters without
  whitespace.
- Failed authentication is limited per client address (429 with
  `Retry-After`; `MCP_AUTH_FAILURE_LIMIT`, `MCP_AUTH_FAILURE_WINDOW_MS`).
  Requests with a valid token are never throttled.
- `Host` header check on loopback binds (`MCP_ALLOWED_HOSTS` to override).
- 401 responses carry `WWW-Authenticate: Bearer`; invalid JSON gets 400
  instead of 500; oversized bodies get 413 before they are read.
- `GET /healthz` (unauthenticated) and graceful shutdown on SIGTERM/SIGINT.
- `PORT`, `MCP_MAX_BODY_BYTES` and boolean flags are validated at startup.
- CI runs on pull requests and before every image publish; images are only
  published from `main` and `v*` tags, with SBOM and provenance attestations.
  GitHub Actions are pinned to commit SHAs.
- Dependency updates; `npm audit --omit=dev` is clean.
- Upstream requests no longer follow redirects, so the client secret (sent
  in the body of the token requests) and bearer tokens are never resent to a
  redirect target; a redirect is reported as an error. Upstream error bodies
  are read up to 64 KB, and the document download cap is enforced while
  streaming.
- `PERSONIO_TIMEOUT_MS` is validated (1-600000) instead of becoming `NaN`.
- The server reports the package version.

### Upgrade notes

- A deployment that binds a non-loopback address (for example `0.0.0.0` in a
  container) now needs `MCP_HTTP_TOKEN` of at least 32 characters, or the
  server exits at startup. A 64-character hex token (`openssl rand -hex 32`)
  works unchanged.
- Shorter tokens, tokens with whitespace or a trailing newline, and
  non-numeric or out-of-range numeric settings are rejected at startup.
- New optional variables: `MCP_HTTP_ALLOW_UNAUTHENTICATED`,
  `MCP_ALLOWED_HOSTS`, `MCP_AUTH_FAILURE_LIMIT`, `MCP_AUTH_FAILURE_WINDOW_MS`.
- `PERSONIO_TIMEOUT_MS` must be an integer between 1 and 600000.
- `PERSONIO_TRUST_FORWARDED_USER` and `X-MCP-User` behave as before.

Also in this release:


Security hardening.

- HR legal-entity scope is now enforced on id-addressed tools (absence and
  attendance update/delete, absence balances by email, document upload and
  update/delete, project membership). The owning person is resolved first
  and the call fails closed when it cannot be determined.
  `personio_manage_document` takes `ownerId`, required on scoped instances.
- Email-to-person lookups require exactly one case-insensitive match.
- Document ownership proof requires a matching `owner.id` on the row.
- Path parameters reject empty values, dot segments and separators.
- HTTP: constant-time token comparison; refuse to start with
  `PERSONIO_TRUST_FORWARDED_USER=true` and no `MCP_HTTP_TOKEN`.

## 0.1.0

Initial release.

- Two profiles from one image (PERSONIO_PROFILE): "employee" — self-service
  hard-scoped to the requesting user (profile, absences + balances, absence
  requests, time tracking, documents); "hr" — company-wide persons/
  employments, absences, attendances, projects (CRUD), compensation +
  jobs/salary bands (read-only), documents (list/download/upload),
  org data, custom reports, recruiting reads, attribute-whitelist
  diagnostic.
- Identity: gateway-forwarded email resolved to a Personio person id;
  every employee tool is pinned to it server-side (Personio has no
  on-behalf-of). Unknown emails fail closed.
- Approval-workflow guarantee: skip_approval is never sent — absence and
  attendance writes always enter Personio's approval flow (v2 default).
- Built on API v2 (v1 attendances are deprecated Aug 2026); v1 is used
  only where no v2 exists: absence balances and document upload.
- No delete-person tool; compensation is read-only (API-created entries
  can never be corrected).
