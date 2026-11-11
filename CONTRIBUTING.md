# Contributing

Thanks for your interest in this project. It is an MCP server for any IMAP/SMTP mailbox (it started
as an iCloud Mail server, and iCloud remains a supported provider). Contributions are welcome, under
the terms of the [PolyForm Shield 1.0.0 license](LICENSE). By submitting a contribution you agree
that it is licensed under the same terms.

## Workflow

1. **Open an issue first** (bug, feature or question), unless it's a typo or a small docs fix.
   Wait for a maintainer to confirm the direction before writing code.
2. Fork the repository and create a branch from the right base (see [Branches](#branches)), named
   `feat/…`, `fix/…` or `docs/…`.
3. Make your change, with tests.
4. Open a pull request against the same base branch that references the issue (`Closes #123`).

Protected branches accept pull requests only, and the required CI checks must pass. Pull requests
are merged with a regular merge commit, **not squashed**: every commit of your branch is kept in the
history, so keep your commits clean and meaningful (see [Commit messages](#commit-messages)).

## Branches

The move to a generic mail server is the 2.0.0 line, described in
[ADR 0001](docs/adr/0001-mcp-mail-generique.md).

| Branch | Purpose                                                             | Open your pull request here for… |
| ------ | ------------------------------------------------------------------- | -------------------------------- |
| `next` | The 2.x line: generic configuration, new features, breaking changes | Anything new                     |
| `main` | The latest stable release (the 1.x line until 2.0.0 ships)          | A fix for the current release    |

Prereleases of the 2.x line are published from `next` as `2.0.0-next.N`. When in doubt, target
`next` and say so in the issue.

Once 2.0.0 ships, `main` moves to the 2.x line and a `1.x` branch (created from `v1.0.0`) takes over
the maintenance of 1.x: bug fixes and security fixes only.

## Development setup

Node.js 26 or later is required. **No mailbox is needed**: the test suite never opens an IMAP or
SMTP connection, and `test/helpers/env.ts` provides the environment it needs, so you do not have to
create a `.env` to run it.

```bash
npm ci
npm run typecheck
npm run lint
npm test
```

To try the server against a real mailbox, copy `.env.example` to `.env` and fill in `MAIL_EMAIL`,
`MAIL_PASSWORD`, `MAIL_IMAP_HOST` and `MAIL_SMTP_HOST`. `.env` is ignored by git: never commit it.

Code layout, conventions and test helpers are described in [`docs/development.md`](docs/development.md)
(in French).

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/), checked by commitlint on every pull
request. Releases and the changelog are generated from them by semantic-release.

Because pull requests are not squashed, **each commit** of the branch is analysed: it must follow
the convention, and a breaking change must be declared in a commit message (the pull request
description is never read).

```
feat(find_messages): add a hasAttachment filter
fix(pool): release the connection when the callback throws
docs: fix a typo in the deployment guide
```

**Breaking changes need an explicit footer.** Add a `BREAKING CHANGE:` footer that says what
changed and what to do instead. It is the footer, not the header, that triggers a major release:

```
feat: remove the LEGACY_TOOLS option

BREAKING CHANGE: the 15 legacy tool names are no longer exposed. Use the tools
described in docs/tools.md.
```

**Do not put a `!` in the header** (`feat!:`): the commitlint check in CI rejects it ("type may
not be empty"), and the `BREAKING CHANGE:` footer is enough.

## Pull request checklist

- Tests added or updated, and `npm run typecheck && npm run lint && npm test` pass
- `docs/` updated if behavior or configuration changed, and `.env.example` too when a variable is
  added, renamed or removed
- No secrets, tokens or real mailbox content anywhere in the diff, tests and logs included
- Changes to sending, deletion or authentication explain their effect on the security model
  ([`docs/security.md`](docs/security.md))
- Nothing in the code or the docs assumes a specific provider, except where it is labelled as such
  (for example an iCloud-only note)

## Reporting security issues

Do not open a public issue. Follow [SECURITY.md](SECURITY.md).

## Code of conduct

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).
