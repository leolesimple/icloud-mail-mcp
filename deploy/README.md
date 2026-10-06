# Déploiement continu

Le workflow [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) se connecte en SSH à
l'hôte et y lance [`deploy.sh`](deploy.sh). Deux déclencheurs : un **appel explicite depuis Release après publication de l’image GHCR** et le **bouton _Run workflow_** de l'onglet _Actions_ (choix de la version).

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

| Secret               | Valeur                                                                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEPLOY_SSH_KEY`     | la **clé privée** `~/.ssh/icloud-mail-mcp-deploy` (contenu complet)                                                                                                                         |
| `DEPLOY_HOST`        | hôte SSH (IP ou nom)                                                                                                                                                                        |
| `DEPLOY_PORT`        | port SSH (par défaut `22`)                                                                                                                                                                  |
| `DEPLOY_USER`        | compte SSH                                                                                                                                                                                  |
| `DEPLOY_KNOWN_HOSTS` | **obligatoire** : entrée known_hosts dont la clé a été vérifiée par un canal indépendant (console de l’hôte / administrateur de confiance) ; aucune acceptation automatique de nouvelle clé |

Pour construire l’entrée `known_hosts`, récupérer `/etc/ssh/ssh_host_ed25519_key.pub` depuis la console de l’hôte et vérifier son empreinte avec `ssh-keygen -lf` sur ce canal de confiance. Préfixer la clé publique par le nom exact utilisé dans `DEPLOY_HOST` (ou `[hôte]:port` pour un port différent de 22). Ne pas faire confiance à une sortie réseau `ssh-keyscan` non vérifiée.

## Test

Onglet _Actions_ → _Deploy_ → _Run workflow_ → version `latest` → _Run_. Le job doit finir vert
(`deploy.sh` échoue si le conteneur ne devient pas `healthy`). Vérifier ensuite :
`curl https://<hostname>/health`.

## Modèle de menace

- `workflow_dispatch` et l’appel depuis `Release` ne sont **pas** déclenchables depuis une PR de fork ; les secrets ne
  sont jamais exposés à une PR de fork. Seul un compte avec write access lance le déploiement.
- La clé de déploiement est **forcée** sur `deploy.sh` : pas de shell, pas de forwarding.
- `deploy.sh` **valide** la version (`^(latest|X.Y.Z)$`) et la commande SSH entière. Il nécessite `flock` pour sérialiser les déploiements sur l’hôte. La version est persistée atomiquement dans `.env` uniquement après un état `healthy`.
- Le workflow impose `StrictHostKeyChecking=yes` et ne publie pas automatiquement les logs du conteneur. Un échec conserve la version précédente dans `.env` ; pour restaurer le conteneur, relancer explicitement cette version.
- Le pire cas d'une clé privée fuitée : un tiers peut faire (re)déployer une version **déjà publiée**
  sur GHCR. Il ne peut pas exécuter de commande arbitraire ni lire `.env`.
- Retour arrière : _Run workflow_ avec l'ancienne version, ou à la main
  (`deploy.sh <version>` sur l'hôte).
