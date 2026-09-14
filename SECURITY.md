# Security Policy

## Reporting a Vulnerability

Please report security issues privately through GitHub Security Advisories for this repository. If private reporting is not available, contact the maintainers through the repository owner before opening a public issue.

Include:

- affected version or commit (prefer a release tag such as `v2.x.y`)
- reproduction steps
- expected impact
- any suggested mitigation

Do not include live credentials, tokens, private financial data, or production hostnames in reports.

## Security Assumptions

- Secrets are provided at runtime through the deployment platform secret store (or local `.dev.vars`), never committed to git.
- Passkeys / WebAuthn protect the single-owner app surface; treat `SETUP_TOKEN` / session secrets as high-value.
- MCP and OAuth surfaces require valid credentials; health/public metadata endpoints must not leak secrets.
- Logs must not include `Authorization` headers, cookies, passwords, tokens, or secret values.
- Public forks should rotate all secrets, use their own Cloudflare bindings, and review rate limits before internet exposure.
