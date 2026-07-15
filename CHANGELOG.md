# Changelog

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
