# icloud-mail-mcp

English | [Français](README.fr.md)

[![CI](https://github.com/leolesimple/icloud-mail-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/leolesimple/icloud-mail-mcp/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/leolesimple/icloud-mail-mcp)](https://github.com/leolesimple/icloud-mail-mcp/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A524.15-339933)](package.json)

An [MCP](https://modelcontextprotocol.io) server that exposes an **iCloud Mail** account (IMAP/SMTP)
as tools Claude can use: read, search, sort, reply to and archive email from a conversation.

It is self-hosted in Docker, behind a Cloudflare Tunnel and a bearer token. For now, this is the only documented way to expose it ([#70](https://github.com/leolesimple/icloud-mail-mcp/issues/70)). Returned data
is visible to the AI client and its provider. With the tunnel, Cloudflare also relays the HTTPS
traffic, and iCloud hosts the mailbox. The MCP instance itself stays under your control.

```
Claude  --HTTPS+Bearer-->  Cloudflare Tunnel  -->  icloud-mail-mcp  --IMAP/SMTP+TLS-->  iCloud
```

## Features

Ten MCP tools, grouped by intent, documented in [`docs/tools.md`](docs/tools.md) (French):

| Tool                | What it does                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `inbox_overview`    | Call first: account, unread and latest INBOX mail, per-folder counts, active guardrails. Never returns a secret                             |
| `find_messages`     | List a folder or search server-side (subject, body, sender, recipient, dates, unread, flagged), across one or several folders, with cursors |
| `read_message`      | Full message content (body truncation on demand, attachment metadata), optionally its whole thread                                          |
| `get_attachment`    | Binary content of one attachment, targeted by index                                                                                         |
| `get_attachments`   | Up to 25 attachments in one call, fetched progressively by IMAP part; one failure doesn't fail the batch                                    |
| `export_message`    | Raw message as EML (`message/rfc822`), as base64 or a signed link                                                                           |
| `compose_message`   | New message, reply (all), or forward; sent or saved as a draft, with correct threading and attachments                                      |
| `send_draft`        | Sends an existing draft, then removes it from Drafts                                                                                        |
| `organize_messages` | Move, trash, mark read/unread, flag, mark answered or junk, up to 200 messages in a single IMAP command                                     |
| `manage_folders`    | List, create, rename or delete a folder; refused on system folders                                                                          |

On `initialize`, the server also sends the client usage instructions: FR/EN domain keywords (mail,
courriel, inbox, unread, draft…), the recommended tool order, and a warning that email content is
untrusted.

An optional `wait_for_new_message` tool sits behind `ENABLE_IDLE_WATCH` (off by default). The former
tool names (`list_messages`, `get_message`, `send_message`, `whoami`…) remain available with
`LEGACY_TOOLS=true`; see the [mapping table](docs/tools.md#correspondance-avec-les-anciens-outils).

Example prompt:

> "Summarize this week's unread mail, archive the newsletters and draft a reply to the one from my bank."

## Quick start

Requirements:

- **Node.js 24.22+** (or Docker)
- **An iCloud account with two-factor authentication**
- **An Apple app-specific password**; your main password doesn't work over IMAP/SMTP. Generate one at
  [appleid.apple.com](https://appleid.apple.com/) → Sign-In and Security → App-Specific Passwords.

```bash
git clone https://github.com/leolesimple/icloud-mail-mcp.git
cd icloud-mail-mcp
npm install
npm run auth      # prompts for credentials, verifies IMAP + SMTP, then writes .env (chmod 600)
npm run dev       # http://localhost:3000/mcp
```

Nothing is written if verification fails, and an existing `.env` is backed up to `.env.bak`. The
generated file starts with `ENABLE_SENDING=false`. `npm run auth:check` replays the verification
without writing anything.

The MCP endpoint is `POST|GET|DELETE /mcp`, protected by `MCP_BEARER_TOKEN`
(`Authorization: Bearer <token>` or `X-Api-Key: <token>`). `GET /health` stays open for Docker
healthchecks. To poke at it manually:

```bash
npx @modelcontextprotocol/inspector
# Transport: Streamable HTTP · URL: http://localhost:3000/mcp · Header: Authorization: Bearer <token>
```

## Deployment (Docker / GHCR)

Each release publishes an image to `ghcr.io/leolesimple/icloud-mail-mcp` (`linux/amd64`). No build or clone is needed on the host; two files in an empty folder are enough:

```bash
mkdir icloud-mail-mcp && cd icloud-mail-mcp
base=https://raw.githubusercontent.com/leolesimple/icloud-mail-mcp/main

curl -O  $base/docker-compose.yml
curl -O  $base/docker-compose.tunnel.yml   # only if you don't already run cloudflared
curl -o .env $base/.env.example            # then fill it in

docker compose up -d
curl https://<your-hostname>/health        # {"status":"ok","version":"…"}
```

Minimum `.env`:

```bash
ICLOUD_EMAIL=you@icloud.com
ICLOUD_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
MCP_BEARER_TOKEN=<openssl rand -hex 32>
TUNNEL_NETWORK=<Docker network shared with cloudflared>   # required
ICLOUD_MAIL_MCP_VERSION=latest                            # or a pinned version, e.g. 0.2.3
```

Full details (tunnel setup, public hostname, troubleshooting, stdio transport) are in
[`docs/deployment.md`](docs/deployment.md).

## Connecting Claude

**Claude Code**

```bash
claude mcp add --transport http icloud-mail-mcp https://icloud-mail-mcp.example.com/mcp \
  --header "Authorization: Bearer <your token>"
```

**Claude Desktop**: add an `"type": "http"` server to `claude_desktop_config.json` with
`"headers": { "Authorization": "Bearer <token>" }`.

**claude.ai (web / mobile)**: _Settings → Connectors → Add custom connector_ with the URL
`https://icloud-mail-mcp.example.com/mcp`. The form rejects an `Authorization` header: pick
**`x-api-key`** with the raw token (the server accepts both).

## Security

This server can read, move, delete and send email. The essentials:

- **Never expose the endpoint without the bearer token.** Generate it with `openssl rand -hex 32`.
- **Never commit `.env`.** It's in `.gitignore`; double-check before any `git add -A` on a fork.
- **An Apple app password grants access to the whole mailbox.** Revoke it in one click at
  appleid.apple.com if the server is compromised.
- **Sending is disabled by default (`ENABLE_SENDING=false`).** Enable it only after checking how Claude
  behaves on your mailbox.
- **`/health` is unauthenticated** and only reveals status and version.

Threat model and details: [`docs/security.md`](docs/security.md). To report a vulnerability, see
[`SECURITY.md`](SECURITY.md).

## Known limitations

- **Attachments are capped at `ATTACHMENT_MAX_BYTES`** (5 MB by default, cumulative). Beyond it, the
  tool refuses explicitly instead of truncating.
- **MIME source is capped at `MAX_MESSAGE_BYTES`** (25 MiB by default). Reads are cut off during
  download, even if the server announces a wrong size.
- **Server-side confirmation before send, trash and folder deletion.** Without MCP elicitation, the
  token requires a second call but doesn't prove a human agreed. `compose_message` creates a draft
  by default.
- **iCloud only, in practice.** The code is standard IMAP/SMTP and hosts are configurable, but
  nothing else is tested.

## Documentation

The detailed docs are written in French.

| Document                                         | Contents                                          |
| ------------------------------------------------ | ------------------------------------------------- |
| [`docs/tools.md`](docs/tools.md)                 | Tool reference: parameters, returns, examples     |
| [`docs/configuration.md`](docs/configuration.md) | Every environment variable                        |
| [`docs/deployment.md`](docs/deployment.md)       | Docker, Cloudflare Tunnel, connecting MCP clients |
| [`docs/architecture.md`](docs/architecture.md)   | Layering, IMAP pool, error and session handling   |
| [`docs/security.md`](docs/security.md)           | Threat model and best practices                   |
| [`docs/development.md`](docs/development.md)     | Code layout, tests, conventions                   |
| [`CHANGELOG.md`](CHANGELOG.md)                   | Release history                                   |

## Contributing

Contributions are welcome. Open an issue first, then a pull request that references it. See
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

[MIT](LICENSE) © 2026 Léo Lesimple
