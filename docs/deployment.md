# Déploiement

Le déploiement de référence : deux conteneurs sur un réseau bridge privé, **aucun port publié sur
l'hôte**, et un Cloudflare Tunnel qui expose le endpoint en HTTPS sans ouvrir de port sur votre
routeur.

```
Internet ──HTTPS──▶ Cloudflare ──tunnel sortant──▶ cloudflared ──http://mail-mcp:3000──▶ mail-mcp
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
   - *Subdomain* : `mail-mcp` (par exemple)
   - *Domain* : votre domaine
   - *Service* : **HTTP** → `mail-mcp:3000`

Le service pointe vers le **nom du conteneur**, pas vers `localhost` : les deux conteneurs partagent
le réseau `mail-mcp-net` du compose.

---

## 2. Préparer l'hôte

```bash
git clone https://github.com/leolesimple/mail-mcp.git
cd mail-mcp
cp .env.example .env
```

Renseigner dans `.env` :

```bash
ICLOUD_EMAIL=vous@icloud.com
ICLOUD_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
MCP_BEARER_TOKEN=<openssl rand -hex 32>
TUNNEL_TOKEN=<le token copié à l'étape 1>
ENABLE_SENDING=false      # à laisser à false pour la première mise en service
```

---

## 3. Lancer

```bash
docker compose up -d --build
```

Vérifier :

```bash
docker compose ps                    # les deux conteneurs doivent être "healthy"/"running"
docker compose logs -f mail-mcp      # "mail-mcp http server listening"
docker compose logs -f cloudflared   # "Registered tunnel connection"
```

Puis, depuis n'importe où :

```bash
curl https://mail-mcp.exemple.com/health
# {"status":"ok"}
```

Le `/health` répond sans token — c'est voulu, le healthcheck Docker en a besoin. Il ne révèle rien
d'autre que le fait que le service tourne.

### Ce que fait l'image

Le [`Dockerfile`](../Dockerfile) est multi-étages : dépendances de développement pour compiler le
TypeScript, dépendances de production seules dans l'image finale. Celle-ci ne contient ni le code
source, ni les outils de build, tourne en utilisateur `node` non-root, et embarque un `HEALTHCHECK`
qui interroge `/health`.

`.env` **n'est pas copié dans l'image** (il est dans `.dockerignore`) : il est injecté à l'exécution
via `env_file`. L'image ne contient donc aucun secret et peut être reconstruite sans risque.

### Tester en local sans tunnel

Décommenter la section `ports:` du service `mail-mcp` dans `docker-compose.yml`, puis viser
`http://localhost:3000/mcp`. **À ne pas laisser en place sur une machine exposée.**

---

## Brancher un client MCP

### Claude Code

```bash
claude mcp add --transport http mail-mcp https://mail-mcp.exemple.com/mcp \
  --header "Authorization: Bearer <votre token>"
```

Vérifier avec `/mcp` dans une session Claude Code : le serveur doit apparaître connecté avec ses
dix outils.

### Claude Desktop / claude.ai

*Paramètres → Connecteurs → Ajouter un connecteur personnalisé*, avec l'URL
`https://mail-mcp.exemple.com/mcp`.

### MCP Inspector (débogage)

```bash
npx @modelcontextprotocol/inspector
# Transport : Streamable HTTP
# URL       : https://mail-mcp.exemple.com/mcp
# Header    : Authorization: Bearer <votre token>
```

L'Inspector permet d'appeler chaque outil à la main et de voir les réponses brutes — le moyen le plus
rapide de distinguer un problème de serveur d'un problème de modèle.

---

## Mise à jour

```bash
git pull
docker compose up -d --build
```

Les sessions MCP en cours sont perdues au redémarrage ; les clients en rouvrent une automatiquement
au prochain appel.

---

## Dépannage

| Symptôme | Piste |
|---|---|
| `Configuration invalide` au démarrage | Une variable manque ou est mal formée — le message liste précisément lesquelles. |
| `Authentification iCloud IMAP refusée` | Mot de passe principal utilisé à la place d'un mot de passe d'application, ou mot de passe révoqué. |
| `401` sur `/mcp`, `/health` OK | Token absent ou différent de `MCP_BEARER_TOKEN`. Vérifier le préfixe `Bearer ` et l'absence d'espace parasite. |
| `502` Cloudflare | Le conteneur `mail-mcp` est arrêté, ou le hostname public pointe vers le mauvais port/nom de service. |
| Erreurs IMAP intermittentes | Throttling iCloud. Baisser `IMAP_POOL_SIZE`, ou espacer les appels. |
| Le tunnel ne se connecte pas | `TUNNEL_TOKEN` invalide ou tunnel supprimé côté Cloudflare. |
