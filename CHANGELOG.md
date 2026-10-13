# Changelog

## Unreleased

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
