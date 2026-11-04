# Security Policy

## Supported versions

| Version | Supported                        |
| ------- | -------------------------------- |
| 1.x     | Yes: security and critical fixes |
| < 1.0   | No: please upgrade               |

Security fixes target the latest 1.x release. New features land on the next major version.

## Reporting a vulnerability

Please report vulnerabilities privately through **Security → Report a vulnerability** on the
[GitHub repository](https://github.com/leolesimple/icloud-mail-mcp/security/advisories/new).

Include the affected version or commit, a minimal reproduction using synthetic messages, the expected
and observed behavior, and the impact. Never include tokens, app passwords or real mailbox content.

No response time is guaranteed.

## Recommendations for users

Use a dedicated Apple app password and keep `ENABLE_SENDING=false` until you have checked how the
server behaves. See [docs/security.md](docs/security.md) (in French) for the threat model.
