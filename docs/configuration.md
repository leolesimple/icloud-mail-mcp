# Configuration

Toute la configuration passe par des variables d'environnement, lues au démarrage depuis `.env`
(via `dotenv`) ou depuis l'environnement du conteneur.

**La configuration est validée au démarrage** ([`src/config.ts`](../src/config.ts), schéma zod). Une
variable manquante ou invalide fait échouer le lancement avec la liste des problèmes, plutôt que de
laisser le serveur démarrer et échouer au premier appel :

```
Configuration invalide (voir .env / .env.example) :
  - ICLOUD_EMAIL: ICLOUD_EMAIL doit être une adresse email valide
  - MCP_BEARER_TOKEN: MCP_BEARER_TOKEN doit faire au moins 16 caractères
```

---

## Identifiants iCloud

| Variable | Requis | Défaut | Description |
|---|---|---|---|
| `ICLOUD_EMAIL` | **oui** | — | Adresse Apple ID complète. Sert d'identifiant IMAP et SMTP, et d'expéditeur de tous les messages. |
| `ICLOUD_APP_PASSWORD` | **oui** | — | Mot de passe d'application au format `xxxx-xxxx-xxxx-xxxx`. **Pas** le mot de passe principal du compte Apple. |

Le mot de passe d'application se génère sur [appleid.apple.com](https://appleid.apple.com/) →
**Connexion et sécurité** → **Mots de passe pour applications**. Il nécessite l'authentification à
deux facteurs sur le compte, et se révoque indépendamment du mot de passe principal.

Si vous utilisez le mauvais mot de passe, l'erreur au démarrage le dit explicitement.

---

## Connexion IMAP

| Variable | Défaut | Description |
|---|---|---|
| `IMAP_HOST` | `imap.mail.me.com` | Serveur IMAP |
| `IMAP_PORT` | `993` | Port IMAP (TLS implicite) |
| `IMAP_POOL_SIZE` | `2` | Connexions IMAP maintenues ouvertes et réutilisées |

**`IMAP_POOL_SIZE` mérite un mot.** iCloud limite le nombre de connexions IMAP simultanées par
compte et bloque temporairement les comptes trop bavards. Le pool ouvre au plus ce nombre de
connexions et les recycle entre les appels d'outils ; les demandes supplémentaires attendent leur
tour au lieu d'ouvrir une connexion de plus.

`2` convient à un usage par un seul Claude. Monter à `3` ou `4` n'accélère que si plusieurs
conversations tapent en parallèle, et augmente le risque de throttling. Ne pas monter plus haut.

---

## Connexion SMTP

| Variable | Défaut | Description |
|---|---|---|
| `SMTP_HOST` | `smtp.mail.me.com` | Serveur SMTP |
| `SMTP_PORT` | `587` | Port SMTP (STARTTLS obligatoire) |
| `SMTP_POOL_SIZE` | `2` | Connexions SMTP simultanées maximum (pool nodemailer) |

Le port 587 utilise STARTTLS, pas TLS implicite. Le transport est configuré avec `requireTLS: true` :
si le serveur refuse de passer en TLS, l'envoi échoue au lieu de partir en clair.

---

## Serveur HTTP

| Variable | Défaut | Description |
|---|---|---|
| `PORT` | `3000` | Port d'écoute. En Docker, port interne au réseau du compose : le conteneur ne l'expose pas à l'hôte. |
| `MCP_BEARER_TOKEN` | **requis** | Token attendu dans `Authorization: Bearer <token>` sur `/mcp`. 16 caractères minimum. |

Générer le token avec :

```bash
openssl rand -hex 32
```

C'est la seule chose qui sépare votre boîte mail d'Internet une fois le tunnel ouvert. Un token
deviné donne un accès complet en lecture, suppression et envoi.

---

## Coupe-circuit d'envoi

| Variable | Défaut | Description |
|---|---|---|
| `ENABLE_SENDING` | `true` | `false` désactive `send_message` et `reply_message` |

À `false`, ces deux outils renvoient une erreur claire et **aucun mail ne part**. Le reste — lecture,
recherche, déplacement, flags, brouillons — continue de fonctionner normalement.

Reconnus comme « désactivé » : `false`, `0`, `no` (insensible à la casse, espaces ignorés). Toute
autre valeur laisse l'envoi actif.

> Le schéma n'utilise volontairement pas `z.coerce.boolean()` : en zod, la chaîne `"false"` est une
> chaîne non vide, donc coercée à `true`. Le coupe-circuit aurait été silencieusement inopérant.
> C'est verrouillé par des tests dédiés (`test/config.test.ts`, `test/sending-guard.test.ts`).

**Recommandation** : démarrer à `false`, observer comment Claude se comporte sur votre boîte, et ne
passer à `true` qu'ensuite. `save_draft` permet déjà un aller-retour complet — Claude rédige, vous
envoyez depuis Mail.

---

## Logs

| Variable | Défaut | Description |
|---|---|---|
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` |

Logs JSON structurés (pino) sur la sortie standard. Les champs `password`, `pass`,
`ICLOUD_APP_PASSWORD` et `token` sont expurgés automatiquement, et le contenu des mails n'est jamais
loggé — seulement des métadonnées (dossier, UID, nombre de résultats).

En `debug`, les événements de cycle de vie du pool IMAP deviennent visibles ; utile pour diagnostiquer
un throttling iCloud.

---

## Cloudflare Tunnel

| Variable | Requis | Description |
|---|---|---|
| `TUNNEL_TOKEN` | pour le déploiement | Token du tunnel, utilisé uniquement par le service `cloudflared` du `docker-compose.yml` |

L'application elle-même ne lit jamais cette variable. Voir [deployment.md](deployment.md).
