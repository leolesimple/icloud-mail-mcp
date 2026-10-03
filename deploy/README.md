# Déploiement continu

Le workflow [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) se connecte en SSH à
l'hôte et y lance [`deploy.sh`](deploy.sh). Deux déclencheurs : une **release publiée** (déploie ce
tag) et le **bouton *Run workflow*** de l'onglet *Actions* (choix de la version).

Aucun runner, aucun agent résident sur l'hôte : `sshd` suffit.

## Mise en place (sur l'hôte)

Le dossier de déploiement contient `docker-compose.yml` + `.env` (voir [deployment.md](../docs/deployment.md)).
On y ajoute une copie de ce dossier `deploy/` :

```bash
cd /opt/icloud-mail-mcp                 # le dossier avec docker-compose.yml + .env
mkdir -p deploy
curl -o deploy/deploy.sh https://raw.githubusercontent.com/leolesimple/icloud-mail-mcp/main/deploy/deploy.sh
chmod +x deploy/deploy.sh
```

Générer une **paire de clés dédiée** au déploiement (pas de passphrase) :

```bash
ssh-keygen -t ed25519 -f ~/.ssh/icloud-mail-mcp-deploy -N "" -C "deploy:icloud-mail-mcp"
```

Ajouter la **clé publique** à `~/.ssh/authorized_keys`, **forcée sur `deploy.sh`** — une clé fuitée
ne peut alors rien faire d'autre que déclencher un déploiement :

```
command="/opt/icloud-mail-mcp/deploy/deploy.sh",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 AAAA... deploy:icloud-mail-mcp
```

Le compte SSH doit pouvoir parler à Docker (`docker compose` dans `deploy.sh`) — membre du groupe
`docker`, ou un `sudo` sans mot de passe ciblé.

## Secrets GitHub (repo → Settings → Secrets and variables → Actions)

| Secret | Valeur |
|---|---|
| `DEPLOY_SSH_KEY` | la **clé privée** `~/.ssh/icloud-mail-mcp-deploy` (contenu complet) |
| `DEPLOY_HOST` | hôte SSH (IP ou nom) |
| `DEPLOY_PORT` | port SSH (par défaut `22`) |
| `DEPLOY_USER` | compte SSH |
| `DEPLOY_KNOWN_HOSTS` | *(recommandé)* sortie de `ssh-keyscan -p <port> <hôte>` — sinon le workflow fait du TOFU sur la clé hôte |

## Test

Onglet *Actions* → *Deploy* → *Run workflow* → version `latest` → *Run*. Le job doit finir vert
(`deploy.sh` échoue si le conteneur ne devient pas `healthy`). Vérifier ensuite :
`curl https://<hostname>/health`.

## Modèle de menace

- `workflow_dispatch` et `release` ne sont **pas** déclenchables depuis un fork ; les secrets ne
  sont jamais exposés à une PR de fork. Seul un compte avec write access lance le déploiement.
- La clé de déploiement est **forcée** sur `deploy.sh` : pas de shell, pas de forwarding.
- `deploy.sh` **valide** la version (`^(latest|X.Y.Z)$`) avant de toucher à `.env`.
- Le pire cas d'une clé privée fuitée : un tiers peut faire (re)déployer une version **déjà publiée**
  sur GHCR. Il ne peut pas exécuter de commande arbitraire ni lire `.env`.
- Retour arrière : *Run workflow* avec l'ancienne version, ou à la main
  (`deploy.sh <version>` sur l'hôte).
