# Déploiement

Le déploiement de référence : deux conteneurs sur un réseau bridge privé, **aucun port publié sur
l'hôte**, et un Cloudflare Tunnel qui expose le endpoint en HTTPS sans ouvrir de port sur votre
routeur.

```
Internet ──HTTPS──▶ Cloudflare ──tunnel sortant──▶ cloudflared ──http://icloud-mail-mcp:3000──▶ icloud-mail-mcp
                                                        └──── réseau bridge privé ────┘
```

L'intérêt : la machine hôte n'a aucun port entrant ouvert. `cloudflared` établit une connexion
*sortante* vers Cloudflare, et le trafic redescend par ce tunnel. Rien à configurer sur la box, pas
d'IP fixe, certificat TLS géré par Cloudflare.

---

## 1. Créer le tunnel

Dans le dashboard [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) :

1. **Networks → Tunnels → Create a tunnel**
2. Type **Cloudflared**, nommer le tunnel
3. Choisir l'environnement **Docker** et copier le token affiché (une longue chaîne)
4. Onglet **Public Hostname** → **Add a public hostname** :
   - *Subdomain* : `icloud-mail-mcp` (par exemple)
   - *Domain* : votre domaine
   - *Service* : **HTTP** → `icloud-mail-mcp:3000`

Le service pointe vers le **nom du conteneur**, pas vers `localhost` : les deux conteneurs partagent
le réseau `icloud-mail-mcp-net` du compose.

---

## 2. Préparer l'hôte

Le déploiement ne compile rien sur l'hôte : `docker-compose.yml` tire l'image publiée sur
`ghcr.io/leolesimple/icloud-mail-mcp` à chaque tag `v*`. Seuls le `docker-compose.yml` et le `.env`
sont nécessaires — cloner le dépôt reste le plus simple pour les récupérer.

```bash
git clone https://github.com/leolesimple/icloud-mail-mcp.git
cd icloud-mail-mcp
cp .env.example .env
```

Renseigner dans `.env` :

```bash
ICLOUD_EMAIL=vous@icloud.com
ICLOUD_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
MCP_BEARER_TOKEN=<openssl rand -hex 32>
TUNNEL_TOKEN=<le token copié à l'étape 1>
ICLOUD_MAIL_MCP_VERSION=0.1.0   # version à déployer ("latest" pour suivre le dernier tag)
ENABLE_SENDING=false            # à laisser à false pour la première mise en service
```

---

## 3. Lancer

```bash
docker compose up -d
```

`docker compose` tire l'image GHCR puis démarre les deux conteneurs. `cloudflared` attend que
`icloud-mail-mcp` soit *healthy* avant d'ouvrir le tunnel.

> Le paquet GHCR est privé par défaut à la première publication. Une fois : le rendre public
> (*Packages → icloud-mail-mcp → Package settings → Change visibility*), ou, pour le garder privé,
> `echo $TOKEN | docker login ghcr.io -u leolesimple --password-stdin` sur l'hôte avec un PAT
> `read:packages`.

Vérifier :

```bash
docker compose ps                          # les deux conteneurs "healthy"/"running"
docker compose logs -f icloud-mail-mcp     # "icloud-mail-mcp http server listening"
docker compose logs -f cloudflared         # "Registered tunnel connection"
```

Puis, depuis n'importe où :

```bash
curl https://icloud-mail-mcp.exemple.com/health
# {"status":"ok","version":"0.1.0"}
```

Le `/health` répond sans token — c'est voulu, le healthcheck Docker en a besoin. Il ne révèle que le
statut et la version du serveur (utile pour vérifier quelle image tourne après un déploiement),
jamais de configuration ni de secret.

### Ce que fait l'image

Le [`Dockerfile`](../Dockerfile) est multi-étages : dépendances de développement pour compiler le
TypeScript, dépendances de production seules dans l'image finale. Celle-ci ne contient ni le code
source, ni les outils de build, tourne en utilisateur `node` non-root, pose `NODE_ENV=production`,
et embarque un `HEALTHCHECK` qui interroge `/health`. L'image est construite pour `linux/amd64` par
[`.github/workflows/release.yml`](../.github/workflows/release.yml) et poussée sur GHCR taguée
`X.Y.Z` **et** `latest`.

`.env` **n'est pas copié dans l'image** (il est dans `.dockerignore`) : il est injecté à l'exécution
via `env_file`. L'image ne contient donc aucun secret.

### Tester en local (build depuis les sources)

`docker-compose.dev.yml` surcharge le service : build local au lieu du pull GHCR, et port publié
sur l'hôte.

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
curl http://localhost:3000/health
```

**À ne pas utiliser sur une machine exposée** : le port devient joignable hors du tunnel.

---

## Choisir le transport

`MCP_TRANSPORT` (défaut `http`) pilote la façon dont le serveur parle aux clients :

| Valeur | Usage |
|---|---|
| `http` | Serveur HTTP streamable — le déploiement de référence ci-dessus (Docker + tunnel). |
| `stdio` | Serveur JSON-RPC sur stdin/stdout, lancé directement par un client MCP local. Pas de port, pas de token. |
| `both` | Les deux en parallèle. |

> **En stdio, stdout porte le canal JSON-RPC.** Le serveur bascule alors automatiquement ses logs
> sur **stderr** (`pino.destination(2)`) : une seule ligne de log sur stdout casserait le cadrage
> des messages et rendrait le serveur muet, sans erreur visible. Rien à configurer, mais ne pas
> rediriger stderr vers stdout dans un wrapper.

L'arrêt propre (fermeture des sessions, du pool IMAP, du transport SMTP sur `SIGINT`/`SIGTERM`)
fonctionne à l'identique dans les trois modes.

---

## Brancher un client MCP

### Claude Code — HTTP (déploiement distant)

```bash
claude mcp add --transport http icloud-mail-mcp https://icloud-mail-mcp.exemple.com/mcp \
  --header "Authorization: Bearer <votre token>"
```

Vérifier avec `/mcp` dans une session Claude Code : le serveur doit apparaître connecté avec ses
outils.

### Claude Code — stdio (exécution locale)

Pour lancer le serveur en local, sans HTTP ni tunnel :

```bash
claude mcp add icloud-mail-mcp -- \
  env MCP_TRANSPORT=stdio \
      ICLOUD_EMAIL=vous@icloud.com ICLOUD_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx \
      MCP_BEARER_TOKEN=$(openssl rand -hex 16) \
  node /chemin/vers/icloud-mail-mcp/dist/index.js
```

(ou `npx tsx src/index.ts` en développement). Le client démarre le processus lui-même ; `PORT`
n'est pas utilisé et le `MCP_BEARER_TOKEN` ne sert pas à authentifier (aucune couche HTTP), mais la
validation de configuration l'exige toujours — n'importe quelle valeur d'au moins 16 caractères
convient.

### Claude Desktop / claude.ai

*Paramètres → Connecteurs → Ajouter un connecteur personnalisé*, avec l'URL
`https://icloud-mail-mcp.exemple.com/mcp`.

### MCP Inspector (débogage)

```bash
npx @modelcontextprotocol/inspector
# Transport : Streamable HTTP
# URL       : https://icloud-mail-mcp.exemple.com/mcp
# Header    : Authorization: Bearer <votre token>
```

L'Inspector permet d'appeler chaque outil à la main et de voir les réponses brutes — le moyen le plus
rapide de distinguer un problème de serveur d'un problème de modèle.

---

## Mise à jour

Bumper `ICLOUD_MAIL_MCP_VERSION` dans `.env` vers le nouveau tag, puis :

```bash
docker compose pull
docker compose up -d
```

Rien à compiler sur l'hôte, rien à `git pull` sauf si `docker-compose.yml` lui-même a changé.
Revenir en arrière = remettre l'ancienne valeur et rejouer les deux commandes. Vérifier la version
réellement en ligne : `curl https://icloud-mail-mcp.exemple.com/health`.

Les sessions MCP en cours sont perdues au redémarrage ; les clients en rouvrent une automatiquement
au prochain appel.

---

## Dépannage

| Symptôme | Piste |
|---|---|
| `Configuration invalide` au démarrage | Une variable manque ou est mal formée — le message liste précisément lesquelles. |
| `Authentification iCloud IMAP refusée` | Mot de passe principal utilisé à la place d'un mot de passe d'application, ou mot de passe révoqué. |
| `401` sur `/mcp`, `/health` OK | Token absent ou différent de `MCP_BEARER_TOKEN`. Vérifier le préfixe `Bearer ` et l'absence d'espace parasite. |
| `502` Cloudflare | Le conteneur `icloud-mail-mcp` est arrêté, ou le hostname public pointe vers le mauvais port/nom de service. |
| Erreurs IMAP intermittentes | Throttling iCloud. Baisser `IMAP_POOL_SIZE`, ou espacer les appels. |
| Le tunnel ne se connecte pas | `TUNNEL_TOKEN` invalide ou tunnel supprimé côté Cloudflare. |
| En stdio, le client MCP n'obtient jamais de réponse | Quelque chose écrit sur stdout du processus (wrapper qui fait `2>&1`, `console.log` ajouté, autre lib bavarde). stdout est réservé au JSON-RPC. |
