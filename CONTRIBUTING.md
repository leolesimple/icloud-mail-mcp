# Contributing

Thanks for your interest in icloud-mail-mcp. Contributions are welcome, under the terms of the
[MIT license](LICENSE).

## Workflow

1. **Open an issue first** (bug, feature or question), unless it's a typo or a small docs fix.
   Wait for a maintainer to confirm the direction before writing code.
2. Fork the repository and create a branch from `main` (`feat/…`, `fix/…`, `docs/…`).
3. Make your change, with tests.
4. Open a pull request that references the issue (`Closes #123`).

`main` is protected: pull requests only, linear history, and the CI checks must pass. Pull requests
are squash-merged.

## Development setup

Node.js 24.15+ is required. No iCloud account is needed: the test suite never opens an IMAP or SMTP
connection.

```bash
npm ci
npm run typecheck
npm run lint
npm test
```

Code layout, conventions and test helpers are described in [`docs/development.md`](docs/development.md)
(in French).

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/), checked by commitlint on every pull
request. Releases and the changelog are generated from them by semantic-release.

```
feat(find_messages): add a hasAttachment filter
fix(pool): release the connection when the callback throws
docs: fix a typo in the deployment guide
```

## Pull request checklist

- Tests added or updated, and `npm run typecheck && npm run lint && npm test` pass
- `docs/` updated if behavior or configuration changed
- No secrets, tokens or real mailbox content anywhere in the diff, tests and logs included
- Changes to sending, deletion or authentication explain their effect on the security model
  ([`docs/security.md`](docs/security.md))

## Reporting security issues

Do not open a public issue. Follow [SECURITY.md](SECURITY.md).

## Code of conduct

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).
