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

WORKDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER="icloud-mail-mcp"
HEALTH_TIMEOUT=60 # secondes

# Version : argument direct, sinon dernier mot de $SSH_ORIGINAL_COMMAND (la
# clé CI est forcée sur ce script, le client ne passe que la version), sinon
# 'latest'.
if [[ -n "${1:-}" ]]; then
  version="$1"
elif [[ -n "${SSH_ORIGINAL_COMMAND:-}" ]]; then
  version="${SSH_ORIGINAL_COMMAND##* }"
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

echo "deploy: $CONTAINER -> $version"
if grep -q '^ICLOUD_MAIL_MCP_VERSION=' .env; then
  sed -i "s/^ICLOUD_MAIL_MCP_VERSION=.*/ICLOUD_MAIL_MCP_VERSION=$version/" .env
else
  printf '\nICLOUD_MAIL_MCP_VERSION=%s\n' "$version" >>.env
fi

docker compose pull
docker compose up -d

deadline=$((SECONDS + HEALTH_TIMEOUT))
while (( SECONDS < deadline )); do
  status="$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo missing)"
  case "$status" in
    healthy)
      running="$(docker inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "$CONTAINER" 2>/dev/null)"
      echo "deploy: OK — image ${running:-?} healthy"
      exit 0
      ;;
    unhealthy)
      echo "deploy: conteneur unhealthy" >&2
      docker compose logs --tail=50 "$CONTAINER" >&2
      exit 1
      ;;
  esac
  sleep 2
done

echo "deploy: pas healthy après ${HEALTH_TIMEOUT}s" >&2
docker compose logs --tail=50 "$CONTAINER" >&2
exit 1
