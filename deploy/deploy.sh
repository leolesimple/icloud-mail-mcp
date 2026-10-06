#!/usr/bin/env bash
#
# Déploie icloud-mail-mcp sur l'hôte : écrit la version voulue dans .env, tire
# l'image GHCR, redémarre, attend que le conteneur soit `healthy`.
#
# Deux usages :
#
#   ./deploy.sh 0.1.2          # à la main (ou 'latest')
#
#   command="/opt/icloud-mail-mcp/deploy/deploy.sh",no-port-forwarding,no-pty,no-agent-forwarding,no-X11-forwarding ssh-ed25519 AAAA... deploy
#     dans ~/.ssh/authorized_keys : la clé de déploiement CI ne peut lancer QUE
#     ce script. La version demandée arrive alors dans $SSH_ORIGINAL_COMMAND.
#
# Le dossier de déploiement (docker-compose.yml + .env) est le PARENT de ce
# script — adapter WORKDIR si l'arborescence diffère.
set -euo pipefail
umask 077

WORKDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER="icloud-mail-mcp"
HEALTH_TIMEOUT=60 # secondes

# Version : argument direct, sinon valeur exacte de $SSH_ORIGINAL_COMMAND (la
# clé CI est forcée sur ce script, le client ne passe que la version), sinon
# 'latest'.
if [[ -n "${1:-}" ]]; then
  version="$1"
elif [[ -n "${SSH_ORIGINAL_COMMAND:-}" ]]; then
  version="$SSH_ORIGINAL_COMMAND"
else
  version="latest"
fi
version="${version#v}"
if [[ ! "$version" =~ ^(latest|[0-9]+\.[0-9]+\.[0-9]+)$ ]]; then
  echo "deploy: version invalide : '$version'" >&2
  exit 2
fi

cd "$WORKDIR"
[[ -f .env && -f docker-compose.yml ]] || {
  echo "deploy: .env ou docker-compose.yml absent dans $WORKDIR" >&2
  exit 1
}

# Serialize deployments on the host too (manual and forced-command SSH runs).
command -v flock >/dev/null || { echo "deploy: flock requis" >&2; exit 1; }
exec 9>.deploy.lock
flock -n 9 || { echo "deploy: un déploiement est déjà en cours" >&2; exit 1; }

echo "deploy: $CONTAINER -> $version"
# Shell environment overrides Compose interpolation without persisting a failed version.
export ICLOUD_MAIL_MCP_VERSION="$version"
docker compose pull icloud-mail-mcp
docker compose up -d --no-deps icloud-mail-mcp

persist_version() {
  local temp_file
  temp_file="$(mktemp .env.deploy.XXXXXX)"
  if ! awk -v version="$version" '
    BEGIN { found=0 }
    /^ICLOUD_MAIL_MCP_VERSION=/ { if (!found) print "ICLOUD_MAIL_MCP_VERSION=" version; found=1; next }
    { print }
    END { if (!found) print "ICLOUD_MAIL_MCP_VERSION=" version }
  ' .env > "$temp_file"; then rm -f "$temp_file"; return 1; fi
  chmod --reference=.env "$temp_file"
  mv "$temp_file" .env
}

deadline=$((SECONDS + HEALTH_TIMEOUT))
while (( SECONDS < deadline )); do
  status="$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo missing)"
  case "$status" in
    healthy)
      running="$(docker inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "$CONTAINER" 2>/dev/null)"
      persist_version
      echo "deploy: OK — image ${running:-?} healthy"
      exit 0
      ;;
    unhealthy)
      echo "deploy: conteneur unhealthy" >&2
      echo "deploy: consulter les logs sur l’hôte et relancer la version précédente pour rollback" >&2
      exit 1
      ;;
  esac
  sleep 2
done

echo "deploy: pas healthy après ${HEALTH_TIMEOUT}s" >&2
echo "deploy: consulter les logs sur l’hôte et relancer la version précédente pour rollback" >&2
exit 1
