#!/usr/bin/env bash
# Run in an environment with npm network access, sockets, Docker and Gitleaks.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
command -v gitleaks >/dev/null || { echo 'Install Gitleaks first (CI pins a verified release).' >&2; exit 1; }
docker info >/dev/null
npm ci --ignore-scripts
npm audit
npm run typecheck
npm run lint
npm test
npm run build
gitleaks git --redact --log-opts='--all' --exit-code=1 .
# Also scan uncommitted changes in this worktree.
for scan_path in src test docs .github deploy vendor; do
  gitleaks dir --redact --exit-code=1 "$scan_path"
done

docker build -t icloud-mail-mcp:security-check .
docker run --rm icloud-mail-mcp:security-check node --input-type=module -e "import('/app/dist/version.js').then(m => process.exit(m.serverVersion ? 0 : 1))"
git diff --check
