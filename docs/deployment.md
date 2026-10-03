# Déploiement

Le serveur ne publie **aucun port sur l'hôte**. Il est joint via un `cloudflared` qui établit une
connexion *sortante* vers Cloudflare et fait redescendre le trafic HTTPS par ce tunnel — rien à
ouvrir sur la box, pas d'IP fixe, certificat TLS géré par Cloudflare.

```
Internet ──HTTPS──▶ Cloudflare ──tunnel sortant──▶ cloudflared ──http://icloud-mail-mcp:3000──▶ icloud-mail-mcp
                                                        └──── réseau Docker partagé ────┘
```

Deux modèles :

- **Tunnel géré ailleurs (par défaut).** Un `cloudflared` tourne déjà dans une autre stack ; le
  serveur se rattache simplement à son réseau Docker. `docker-compose.yml` seul.
- **Autonome.** Aucun tunnel existant : ajouter `docker-compose.tunnel.yml`, qui embarque un
  `cloudflared` dédié.

Dans les deux cas, rien n'est compilé sur l'hôte : `docker-compose.yml` tire l'image publiée sur
`ghcr.io/leolesimple/icloud-mail-mcp` à chaque tag `v*`.

---

## 1. Le réseau et le hostname public

Le serveur et `cloudflared` doivent partager un réseau Docker. Son nom vit dans `.env`
(`TUNNEL_NETWORK`), pas dans le dépôt. Le créer s'il n'existe pas encore :

```bash
docker network create tunnel-net    # ou le nom de votre choix
```

Côté [Cloudflare Zero Trust](https://one.dash.cloudflare.com/), sur le tunnel qui dessert ce
réseau, **Public Hostname → Add a public hostname** :

- *Subdomain* / *Domain* : à votre convenance
- *Service* : **HTTP** → `icloud-mail-mcp:3000` (le **nom du conteneur**, résolu sur le réseau
  partagé — pas `localhost`)

Pour le modèle autonome, récupérer aussi le **token** du tunnel (environnement *Docker*).

---

## 2. Préparer l'hôte

Deux fichiers suffisent, dans un dossier vide — pas besoin de cloner le dépôt :

```bash
mkdir icloud-mail-mcp && cd icloud-mail-mcp
base=https://raw.githubusercontent.com/leolesimple/icloud-mail-mcp/main
curl -O  $base/docker-compose.yml
curl -O  $base/docker-compose.tunnel.yml   # seulement pour le modèle autonome
curl -o .env $base/.env.example
```

Renseigner dans `.env` :

```bash
ICLOUD_EMAIL=vous@icloud.com
ICLOUD_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
MCP_BEARER_TOKEN=<openssl rand -hex 32>
TUNNEL_NETWORK=tunnel-net              # le réseau de l'étape 1
ICLOUD_MAIL_MCP_VERSION=0.1.2          # version à déployer ("latest" pour suivre le dernier tag)
ENABLE_SENDING=false                   # à laisser à false pour la première mise en service
# TUNNEL_TOKEN=...                     # modèle autonome uniquement
```

`docker compose` lit ce `.env` **à la fois** pour les `${VARIABLES}` du compose et pour l'`env` du
conteneur (`env_file`). Un seul fichier.

---

## 3. Lancer

Tunnel géré ailleurs :

```bash
docker compose up -d
```

Autonome (cloudflared embarqué) :

```bash
docker compose -f docker-compose.yml -f docker-compose.tunnel.yml up -d
```

> Le paquet GHCR est privé par défaut à la première publication. Une fois : le rendre public
> (*Packages → icloud-mail-mcp → Package settings → Change visibility*), ou, pour le garder privé,
> `echo $TOKEN | docker login ghcr.io -u leolesimple --password-stdin` sur l'hôte avec un PAT
> `read:packages`.

Vérifier :

```bash
docker compose ps                          # "healthy"/"running"
docker compose logs -f icloud-mail-mcp     # "icloud-mail-mcp http server listening"
curl https://icloud-mail-mcp.exemple.com/health
# {"status":"ok","version":"0.1.2"}
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

`docker-compose.dev.yml` surcharge le service : build local au lieu du pull GHCR, port publié sur
l'hôte, et le réseau externe du tunnel remplacé par un bridge local (pas de `cloudflared` ni de
`TUNNEL_NETWORK` requis).

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

### Claude Desktop

`claude_desktop_config.json` :

```json
"icloud-mail-mcp": {
  "type": "http",
  "url": "https://icloud-mail-mcp.exemple.com/mcp",
  "headers": { "Authorization": "Bearer <votre token>" }
}
```

### claude.ai (web / mobile)

*Paramètres → Connecteurs → Ajouter un connecteur personnalisé* :

- **URL** : `https://icloud-mail-mcp.exemple.com/mcp`
- **Authentification** : le formulaire **interdit l'en-tête `Authorization`** et n'autorise qu'une
  liste de noms. Choisir **`x-api-key`**, valeur = **le token brut** (`MCP_BEARER_TOKEN`, *sans* le
  préfixe `Bearer `). Le serveur accepte les deux formes.
- Passer le jeton par **en-tête**, pas par l'URL (une URL avec secret finit dans des logs).

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

## Mise à jour et retour arrière

Bumper `ICLOUD_MAIL_MCP_VERSION` dans `.env` vers le tag voulu, puis :

```bash
docker compose pull && docker compose up -d
# modèle autonome : ajouter -f docker-compose.yml -f docker-compose.tunnel.yml aux deux commandes
```

Rien à compiler, rien à re-télécharger sauf si un `docker-compose*.yml` a changé (re-`curl` dans ce
cas). **Retour arrière** = remettre l'ancienne valeur et rejouer. Vérifier la version réellement en
ligne : `curl https://icloud-mail-mcp.exemple.com/health`.

Les sessions MCP en cours sont perdues au redémarrage ; les clients en rouvrent une automatiquement
au prochain appel.

---

## Déploiement continu (optionnel)

[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) déploie sur l'hôte :

- **automatiquement** à chaque GitHub Release publiée (le tag est déployé) ;
- **à la demande** via le bouton *Run workflow* de l'onglet *Actions* (choix de la version).

Il se connecte en SSH et exécute [`deploy/deploy.sh`](../deploy/deploy.sh) : écriture de la version
dans `.env`, `docker compose pull`, `up -d`, puis attente de `healthy` (échec sinon). Aucun runner
ni agent résident sur l'hôte. Mise en place et modèle de menace : [`deploy/README.md`](../deploy/README.md).

---

## Dépannage

| Symptôme | Piste |
|---|---|
| `Configuration invalide` au démarrage | Une variable manque ou est mal formée — le message liste précisément lesquelles. |
| `Authentification iCloud IMAP refusée` | Mot de passe principal utilisé à la place d'un mot de passe d'application, ou mot de passe révoqué. |
| `401` sur `/mcp`, `/health` OK | Token absent ou différent de `MCP_BEARER_TOKEN`. Vérifier le préfixe `Bearer ` et l'absence d'espace parasite. |
| `502` Cloudflare | Le conteneur `icloud-mail-mcp` est arrêté, hors du réseau `TUNNEL_NETWORK`, ou le hostname public pointe vers le mauvais nom/port de service. |
| `network <nom> declared as external, but could not be found` | Le réseau n'existe pas : `docker network create "<nom>"`, ou `TUNNEL_NETWORK` ne correspond pas au réseau du `cloudflared`. |
| `required variable TUNNEL_NETWORK is missing` | `TUNNEL_NETWORK` absent de `.env`. |
| Erreurs IMAP intermittentes | Throttling iCloud. Baisser `IMAP_POOL_SIZE`, ou espacer les appels. |
| Le tunnel ne se connecte pas (modèle autonome) | `TUNNEL_TOKEN` invalide ou tunnel supprimé côté Cloudflare. |
| En stdio, le client MCP n'obtient jamais de réponse | Quelque chose écrit sur stdout du processus (wrapper qui fait `2>&1`, `console.log` ajouté, autre lib bavarde). stdout est réservé au JSON-RPC. |
