# Security Policy

## Reporting A Vulnerability

Report suspected vulnerabilities privately to <security@borgels.com>.

Do not include API keys, access tokens, personal data, accounting data, customer
data, or other secrets in public GitHub issues. Include a concise description,
affected package/version, reproduction steps, and impact where possible.

## Supported Versions

Security fixes are targeted at the latest `main` branch and the latest published
release, when one exists.

## Credential Handling

The MCP server reads provider credentials only from the server environment and
does not accept credentials as tool arguments. The embeddable gateway
(`mcp-server-personio/gateway`) takes them only from the host, as options to
`createPersonioGateway`, and reads no `PERSONIO_*` variable; it never returns
them, and redacts them from every result, error and audit record. If you believe credentials were
exposed, rotate them with the upstream provider immediately.
