# mcp-server-personio

MCP server for the [Personio](https://developer.personio.de/) HR API with two profiles and per-user scoping.

## Profiles

One image, selected by `PERSONIO_PROFILE`:

- **`employee`** — self-service, hard-scoped to the requesting user: `personio_get_my_profile`, `personio_get_my_absences` (+ balances), `personio_request_absence`, `personio_get_my_attendances`, `personio_record_attendance` (WORK/BREAK periods, project tagging), `personio_get_my_documents` (incl. e-signature status + download), `personio_list_absence_types`, `personio_list_projects`, `personio_whoami`. The gateway forwards the verified user email (`X-MCP-User`, honored when `PERSONIO_TRUST_FORWARDED_USER=true`); the server resolves it to a person id and pins every call to it — Personio has no on-behalf-of mechanism, so this scoping is enforced here. Unknown emails fail closed.
- **`hr`** — the HR workbench: persons + employments (list/get/update), absences and attendances for anyone (list/create/delete), projects (full CRUD + members), compensation entries/types/jobs/salary bands (**read-only** — API-created compensation can never be corrected, so creation is deliberately not exposed), documents (list/download/upload), org data (legal entities, departments, teams, cost centers, workplaces), custom reports, recruiting reads (applications/candidates/jobs/categories), and an attribute-whitelist diagnostic. Write tools additionally require `PERSONIO_ENABLE_WRITES=true`.

## Guarantees

- **`skip_approval` is never sent** — absence/attendance writes always enter Personio's normal approval workflow (the v2 default; v1's silent-bypass default is one reason this server is v2-first).
- No delete-person tool. Employee-profile tools never accept foreign person ids.
- Only credential-whitelisted attributes are returned by Personio — `personio_list_attributes` shows what your credential can see (missing attributes are omitted silently, not errored).

## Not possible via Personio's public API

Performance, surveys, whistleblowing, onboarding checklists, workflow automations (beyond outbound webhooks), e-signature initiation, and approving pending absence requests have **no public API** — those remain in the Personio UI.

## Auth

One client_id/client_secret pair (Settings → Integrations → API credentials) drives both API generations: OAuth2 client-credentials against `/v2/auth/token` (form-encoded) for v2, and the stable 24h `papi-` token from `/v1/auth` for the two v1-only flows (absence balances, document upload).

## Run

```bash
npm install
npm run dev          # stdio
npm run dev:http     # streamable HTTP on :3000/mcp (stateless)
npm test
```

Docker images: `ghcr.io/borgels/mcp-server-personio` (published on push to `main`).
