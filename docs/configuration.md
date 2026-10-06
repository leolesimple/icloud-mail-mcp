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

## Transport MCP

| Variable | Défaut | Description |
|---|---|---|
| `MCP_TRANSPORT` | `http` | `http`, `stdio` ou `both`. Voir [deployment.md](deployment.md#choisir-le-transport). |
| `MAX_BODY_CHARS` | `20000` | Plafond par défaut, en caractères, du corps renvoyé par `read_message`. Surchargeable par appel via `maxBodyChars`. |

En `stdio`, stdout porte le canal JSON-RPC : le serveur bascule automatiquement ses logs sur stderr.

---

## Serveur HTTP

| Variable | Défaut | Description |
|---|---|---|
| `PORT` | `3000` | Port d'écoute. En Docker, port interne au réseau du compose : le conteneur ne l'expose pas à l'hôte. Ignoré si `MCP_TRANSPORT=stdio`. |
| `MCP_BEARER_TOKEN` | **requis** | Token attendu sur `/mcp`, en `Authorization: Bearer <token>` ou `X-Api-Key: <token>` (jeton brut, pour les connecteurs claude.ai). 16 caractères minimum. Toujours requis, même en `stdio` (où il ne sert pas). |
| `RATE_LIMIT_PER_MINUTE` | `120` | Requêtes `/mcp` autorisées par IP et par minute (fenêtre glissante). Au-delà : `429`. `/health` n'est jamais limité. |
| `SESSION_TTL_MS` | `1800000` | Inactivité (en ms) au-delà de laquelle une session MCP est évincée et son transport fermé. 30 min par défaut. |
| `PUBLIC_BASE_URL` | `''` (vide) | URL publique HTTPS du serveur, sans slash final (ex. `https://mail-mcp.exemple.com`). Renseigne `icons`/`websiteUrl` dans les métadonnées `Implementation` du protocole MCP, pour les clients qui les affichent, et sert de base aux liens de téléchargement (`get_attachment`, `get_attachments`, `export_message`, `format: "url"`) et de dépôt (`create_upload_link`). Vide = ces champs ne sont pas envoyés, le format `url` et `create_upload_link` sont refusés. |

Générer le token avec :

```bash
openssl rand -hex 32
```

C'est la seule chose qui sépare votre boîte mail d'Internet une fois le tunnel ouvert. Un token
deviné donne un accès complet en lecture, suppression et envoi.

`RATE_LIMIT_PER_MINUTE` est volontairement généreux : un seul Claude n'en approche jamais. Le
descendre est utile si le tunnel est exposé plus largement. `SESSION_TTL_MS` borne la mémoire du
serveur — une session qu'un client abandonne sans `DELETE` est nettoyée automatiquement.

---

## Garde-fous d'envoi

`compose_message` (`deliver: "send"`) et `send_draft` passent par une décision graduée
([`src/smtp/guards.ts`](../src/smtp/guards.ts)), évaluée dans cet ordre :

| Variable | Défaut | Effet |
|---|---|---|
| `UNRESTRICTED` | `false` | `true` **désactive** les garde-fous 2 à 5 ci-dessous **et** le rate limit HTTP. Chaque envoi est alors précédé d'un log `warn`. Ne désactive jamais l'authentification bearer ni le TTL des sessions. |
| `ENABLE_SENDING` | `true` | `false` : aucun message n'est transmis, l'outil renvoie une erreur explicite. Coupe-circuit historique. |
| `DRAFTS_ONLY` | `false` | `true` : au lieu d'envoyer, le message est **composé et déposé dans `Drafts`** (threading compris). L'outil renvoie un **succès** : `{ sent: false, draft: { folder, uid }, reason: "DRAFTS_ONLY" }`. Contrairement à `ENABLE_SENDING=false`, la rédaction n'est jamais perdue. |
| `ALLOWED_RECIPIENTS` | `''` (vide) | Liste blanche de destinataires, séparés par des virgules. Vide = aucune restriction. Un envoi dont un destinataire (`to`, `cc` **ou** `bcc`) n'est pas couvert est refusé, et le message d'erreur **nomme les adresses fautives**. |
| `MAX_SENDS_PER_DAY` | `0` (illimité) | Nombre maximum d'envois réussis sur une fenêtre glissante de 24 h. Au-delà : refus. |

### `ALLOWED_RECIPIENTS` — format

Deux formes acceptées, mélangeables :

- **adresse exacte** : `alice@example.com` — insensible à la casse ;
- **domaine entier** : `@example.com` — couvre `*@example.com`, mais **pas** les sous-domaines
  (`bob@mail.example.com` reste hors liste).

```
ALLOWED_RECIPIENTS=alice@example.com, @mon-entreprise.com
```

### `MAX_SENDS_PER_DAY` — persistance du compteur

Le compteur garde les horodatages des envois réussis des dernières 24 h. Où il vit dépend de
`QUOTA_STATE_PATH` :

- **vide (défaut)** : en mémoire seule. Un redémarrage du serveur le remet à zéro, ce qui suffit à
  borner une boucle d'envoi au sein d'une exécution, pas un process relancé entre-temps. C'est le
  comportement en dev et en tests ;
- **chemin de fichier** : l'état est rechargé au démarrage (les envois de plus de 24 h sont ignorés)
  et réécrit à chaque envoi, de façon atomique (fichier temporaire puis `rename`). Le dossier parent
  est créé au besoin. Un fichier absent vaut un compteur vide ; un fichier illisible ou corrompu est
  signalé par un log `warn` et le compteur repart de zéro : le serveur ne plante jamais pour ça.
  Un échec d'écriture est lui aussi loggué en `warn`, le compteur restant tenu en mémoire.

Le `docker-compose.yml` fixe `QUOTA_STATE_PATH=/app/data/send-quota.json` sur le volume nommé
`icloud-mail-mcp-data` : en production, le plafond survit aux redémarrages et aux mises à jour de
l'image. Supprimer le volume (ou le fichier) remet le compteur à zéro.

### Interrupteurs booléens

`ENABLE_SENDING`, `DRAFTS_ONLY` et `UNRESTRICTED` partagent le même parseur (`envBool`). Reconnus
comme « faux » : `false`, `0`, `no` (insensible à la casse, espaces ignorés). Toute autre valeur non
vide vaut « vrai ».

> Le schéma n'utilise volontairement pas `z.coerce.boolean()` : en zod, la chaîne `"false"` est une
> chaîne non vide, donc coercée à `true`. L'interrupteur aurait été silencieusement inopérant. C'est
> verrouillé par des tests dédiés (`test/config.test.ts`, `test/sending-guard.test.ts`).

**Recommandation** : démarrer en `DRAFTS_ONLY=true` (ou `ENABLE_SENDING=false`), observer comment
Claude se comporte sur votre boîte, puis ouvrir progressivement — d'abord `ALLOWED_RECIPIENTS` sur
vos correspondants habituels, avec un `MAX_SENDS_PER_DAY` bas. `DRAFTS_ONLY` permet déjà un
aller-retour complet : Claude rédige, vous envoyez depuis Mail après relecture.

---

## Garde-fous d'envoi

Toutes optionnelles. Vides ou absentes, elles laissent le comportement historique inchangé.

| Variable | Défaut | Description |
|---|---|---|
| `ATTACHMENT_MAX_BYTES` | `5242880` | Taille maximale d'une pièce jointe, en octets (5 Mio). |
| `ALLOWED_RECIPIENTS` | `''` | Liste d'adresses ou de domaines séparés par des virgules. Vide = aucun filtrage. Exposée aussi normalisée en tableau (`ALLOWED_RECIPIENTS_LIST` : trim, minuscules, entrées vides retirées). |
| `MAX_SENDS_PER_DAY` | `0` | Nombre maximal d'envois par jour glissant. `0` = illimité. |
| `QUOTA_STATE_PATH` | `''` | Fichier où persister le compteur de `MAX_SENDS_PER_DAY`. Vide = mémoire seule, remis à zéro au redémarrage. Fixé à `/app/data/send-quota.json` par `docker-compose.yml`. |
| `DRAFTS_ONLY` | `false` | `true` force tout envoi à passer par un brouillon : aucun mail n'est émis. Même grammaire booléenne que `ENABLE_SENDING`. |
| `UNRESTRICTED` | `false` | `true` lève tous les garde-fous d'envoi ci-dessus. À n'utiliser qu'en connaissance de cause. |
| `MAX_BODY_CHARS` | `20000` | Longueur maximale d'un corps de message (texte ou HTML) accepté par les outils. |

Les clés booléennes (`DRAFTS_ONLY`, `UNRESTRICTED`) suivent la même règle que `ENABLE_SENDING` :
`false`, `0`, `no` (insensible à la casse, espaces ignorés) valent faux, toute autre valeur vaut vrai.

---

## Jetons de confirmation

| Variable | Défaut | Description |
|---|---|---|
| `CONFIRM_SECRET` | `''` (vide) | Secret HMAC des jetons de confirmation des opérations destructives. Au moins 32 caractères, sinon le démarrage échoue. Vide ou absent : un secret aléatoire est tiré au démarrage. |

Les jetons durent 2 minutes : les perdre au redémarrage est sans conséquence, d'où un secret
optionnel. Le fixer n'a d'intérêt que pour garder les jetons valides à travers un redémarrage
rapide. Générez-le avec `openssl rand -hex 32` ; ne réutilisez ni `MCP_BEARER_TOKEN` ni le mot de
passe d'application. Il n'apparaît dans aucun log (expurgé par pino) ni dans aucune réponse d'outil.
Voir [`security.md`](security.md#confirmation-des-opérations-destructives).

---

## Liens de téléchargement

| Variable | Défaut | Description |
|---|---|---|
| `DOWNLOAD_URL_SECRET` | `''` (vide) | Secret HMAC des liens de téléchargement signés (`get_attachment`, `get_attachments`, `export_message`, `format: "url"`, servis par `GET /download/<jeton>`) et des liens de dépôt (`create_upload_link`, `POST /upload/<jeton>`). Au moins 32 caractères, sinon le démarrage échoue. Vide ou absent : un secret aléatoire est tiré au démarrage. |

Même logique que `CONFIRM_SECRET` : un lien dure 15 minutes, le perdre au redémarrage est sans
gravité, d'où un secret optionnel. Générez-le avec `openssl rand -hex 32`, distinct de
`MCP_BEARER_TOKEN` et de `CONFIRM_SECRET`. Il est expurgé des logs. Le format `url` exige aussi
`PUBLIC_BASE_URL`. Voir [`security.md`](security.md#liens-de-téléchargement).

---

## Dépôts de fichiers

| Variable | Défaut | Description |
|---|---|---|
| `UPLOAD_MAX_FILES` | `20` | Nombre maximal de fichiers déposés (`create_upload_link`, `POST /upload/<jeton>`) conservés à la fois. Au-delà, un dépôt est refusé (`507`). |
| `UPLOAD_MAX_TOTAL_BYTES` | `52428800` | Octets cumulés maximaux des fichiers déposés (50 Mio). Le flux d'un dépôt est coupé dès que la place restante est franchie (`507`). |

Chaque fichier reste en outre borné par `ATTACHMENT_MAX_BYTES`. Les dépôts sont gardés **en
mémoire** 1 h (ou jusqu'à l'envoi du mail qui les attache) et **ne survivent pas à un
redémarrage**. Ces deux plafonds bornent la RAM qu'ils peuvent occuper. Voir
[`security.md`](security.md#dépôt-de-fichiers).

---

## Protocole MCP et sessions

| Variable | Défaut | Description |
|---|---|---|
| `MCP_TRANSPORT` | `http` | Transport exposé par le serveur : `http`, `stdio` ou `both`. Une autre valeur fait échouer le démarrage. |
| `RATE_LIMIT_PER_MINUTE` | `120` | Plafond d'appels d'outils par minute et par session. |
| `SESSION_TTL_MS` | `1800000` | Durée de vie d'une session inactive, en millisecondes (30 min). |

---

## Attente de nouveaux messages (IDLE)

| Variable | Défaut | Description |
|---|---|---|
| `ENABLE_IDLE_WATCH` | `false` | `true` enregistre l'outil `wait_for_new_message` |

**Off par défaut, volontairement.** `wait_for_new_message` ouvre une connexion IMAP dédiée hors du
pool et attend l'événement `exists` d'iCloud. Cette version n'a **pas de reconnexion** : si la
connexion iCloud saute pendant l'attente (coupure réseau, throttling, timeout serveur), l'outil ne
le détecte pas et se contente d'expirer avec `timedOut: true` — un nouveau message arrivé
entre-temps est manqué **sans le moindre signal**. Tant que la version avec reconnexion n'est pas
faite ([#20](https://github.com/leolesimple/icloud-mail-mcp/issues/20)), l'outil n'est exposé que si vous
l'activez explicitement, en connaissance de cause.

Reconnus comme « activé » : toute valeur autre que `false`, `0`, `no` (casse et espaces ignorés).

---

## Compatibilité des outils

| Variable | Défaut | Description |
|---|---|---|
| `LEGACY_TOOLS` | `false` | `true` réenregistre les anciens outils en plus des nouveaux |

Les 17 outils historiques ont été regroupés en 8 outils organisés par intention (voir
[docs/tools.md](tools.md)). Avec `LEGACY_TOOLS=true`, les 15 anciens noms qui ont disparu
(`list_messages`, `search_messages`, `get_message`, `get_thread`, `send_message`, `reply_message`,
`forward_message`, `save_draft`, `update_draft`, `move_message`, `delete_message`, `flag_message`,
`list_folders`, `manage_folder`, `whoami`) sont exposés **en plus** des nouveaux, avec leurs
contrats d'origine et une description qui commence par « Deprecated: use … ». `get_attachment` et
`send_draft` gardent leur nom et ne sont donc pas dupliqués.

Prévu pour une version de transition : le temps de mettre à jour un client ou un prompt qui cite
les anciens noms. La variable disparaîtra avec eux.

Reconnus comme « activé » : toute valeur autre que `false`, `0`, `no` (casse et espaces ignorés).

---

## Logs

| Variable | Défaut | Description |
|---|---|---|
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` |

Logs JSON structurés (pino), sur **stdout** en transport `http`, sur **stderr** dès que `stdio` est
actif (stdout y est réservé au JSON-RPC). Les champs `password`, `pass`,
`ICLOUD_APP_PASSWORD` et `token` sont expurgés automatiquement, et le contenu des mails n'est jamais
loggé — seulement des métadonnées (dossier, UID, nombre de résultats).

En `debug`, les événements de cycle de vie du pool IMAP deviennent visibles ; utile pour diagnostiquer
un throttling iCloud.

---

## Déploiement (docker-compose)

| Variable | Requis | Description |
|---|---|---|
| `ICLOUD_MAIL_MCP_VERSION` | non (`latest`) | Tag de l'image GHCR tirée par `docker-compose.yml` |
| `TUNNEL_NETWORK` | oui | Nom du réseau Docker partagé avec le `cloudflared` qui gère le tunnel. Le réseau doit déjà exister. |
| `TUNNEL_TOKEN` | modèle autonome | Token du tunnel Cloudflare, utilisé uniquement par le `cloudflared` embarqué de `docker-compose.tunnel.yml` |

L'application elle-même ne lit aucune de ces variables. Voir [deployment.md](deployment.md).
