# Security Policy

## Supported versions

Security fixes target the latest release.

## Reporting a vulnerability

Please report vulnerabilities privately through **Security → Report a vulnerability** on the
[GitHub repository](https://github.com/leolesimple/icloud-mail-mcp/security/advisories/new).

Include the affected version or commit, a minimal reproduction using synthetic messages, the expected
and observed behavior, and the impact. Never include tokens, app passwords or real mailbox content.

No response time is guaranteed. Use of the code remains subject to the [license](LICENSE).

## Recommendations for users

Use a dedicated Apple app password and keep `ENABLE_SENDING=false` until you have checked how the
server behaves. See [docs/security.md](docs/security.md) (in French) for the threat model.
