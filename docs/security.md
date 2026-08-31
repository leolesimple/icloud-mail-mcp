# Sécurité

Ce serveur a un accès complet à une boîte mail : il peut lire n'importe quel message, en supprimer
définitivement, et envoyer du courrier en votre nom. Le compromettre revient à donner votre boîte
mail — et, par les emails de réinitialisation de mot de passe, une bonne partie de votre identité
en ligne.

Cette page décrit ce que le projet protège, et ce qui reste à votre charge.

---

## Ce que le serveur fait pour vous

**Authentification de tous les appels MCP.** `/mcp` exige `Authorization: Bearer <token>` en `POST`,
`GET` et `DELETE`. Le token est comparé en temps constant (`timingSafeEqual`), après une
vérification de longueur qui évite l'exception que lève cette fonction sur des tampons de tailles
différentes.

**TLS partout.** IMAP sur le port 993 en TLS implicite ; SMTP sur 587 avec `requireTLS: true` — si
le serveur refuse STARTTLS, l'envoi échoue plutôt que de partir en clair.

**Aucun secret dans les logs.** pino expurge les champs `password`, `pass`, `ICLOUD_APP_PASSWORD` et
`token`. Le contenu des messages n'est jamais loggé : seulement des métadonnées (dossier, UID,
nombre de résultats).

**Aucun secret dans l'image Docker.** `.env` est dans `.dockerignore` et injecté à l'exécution.

**Le conteneur tourne en utilisateur non-root** (`USER node`), sans port publié sur l'hôte dans la
configuration de référence.

**Des garde-fous d'envoi gradués.** Voir la section dédiée plus bas. Le point clé : ils sont
appliqués **au niveau du transport** ([`src/smtp/client.ts`](../src/smtp/client.ts)), pas seulement
dans l'orchestration — même un appel qui contournerait `src/smtp/send.ts` ne peut pas émettre. C'est
verrouillé par des tests.

**Un rate limit sur `/mcp`.** Fenêtre glissante par IP, `429` au-delà de `RATE_LIMIT_PER_MINUTE`,
placé avant l'authentification pour amortir un brute-force de token. `/health` n'est pas limité.
Derrière le tunnel, l'IP retenue est celle de l'en-tête `CF-Connecting-IP` (posée par `cloudflared`,
non usurpable par le client), pas l'IP du conteneur `cloudflared` — sans quoi tout le trafic
partagerait un seul seau.

**Un TTL sur les sessions MCP.** Une session abandonnée sans `DELETE` est évincée après
`SESSION_TTL_MS` d'inactivité et son transport fermé — la `Map` de sessions ne fuit plus.

**Pas de suppression définitive par surprise.** `delete_message` déplace vers la corbeille ; il ne
détruit un message que s'il s'y trouve déjà.

---

## Les garde-fous d'envoi

`ENABLE_SENDING` seul est binaire : à `false` tout échoue et la rédaction est perdue, à `true` un
agent peut écrire à n'importe qui, en boucle. Les garde-fous gradués
([`src/smtp/guards.ts`](../src/smtp/guards.ts)) couvrent l'espace entre les deux. Ils sont évalués
dans un ordre strict pour `send_message` / `reply_message` :

| # | Garde-fou | Menace couverte | Ce qui se passe |
|---|---|---|---|
| 1 | `UNRESTRICTED=true` | *(aucune — c'est l'inverse)* | Court-circuite les garde-fous 2 à 5. Chaque envoi est loggué en `warn`. |
| 2 | `ENABLE_SENDING=false` | Envoi non désiré, tous cas confondus | Refus. Aucun message transmis. |
| 3 | `DRAFTS_ONLY=true` | Envoi automatique sans relecture humaine | Le message est composé et déposé dans `Drafts`. **Succès** (`sent: false`, `reason: "DRAFTS_ONLY"`) : la rédaction est conservée, l'appelant sait que rien n'est parti. |
| 4 | `ALLOWED_RECIPIENTS` | Exfiltration : un agent (souvent via une injection de prompt dans un mail lu) envoie vos données à une adresse tierce | Refus si un destinataire `to`/`cc`/`bcc` est hors liste. Le refus **nomme** les adresses fautives. |
| 5 | `MAX_SENDS_PER_DAY` | Boucle d'envoi d'un agent qui déraille ; usage de la boîte comme relais de spam | Refus au-delà de N envois sur 24 h glissantes. Compteur en mémoire, remis à zéro au redémarrage. |

Aucun de ces garde-fous n'empêche une injection de prompt : ils **bornent les dégâts** quand elle
réussit. Le pire cas avec `DRAFTS_ONLY=true` ou `ALLOWED_RECIPIENTS` restrictif se limite à un
brouillon ou un envoi vers un correspondant déjà approuvé.

### Ce que `UNRESTRICTED` désactive — et ce qu'il ne touche jamais

`UNRESTRICTED=true` est un mode de test : il lève les garde-fous d'envoi 2 à 5 **et** le rate limit
HTTP. Il ne désactive **jamais** :

- l'**authentification bearer** sur `/mcp` ([`src/http/auth.ts`](../src/http/auth.ts)) ;
- le **TTL des sessions**.

Cette frontière est explicite dans le code (`src/http/server.ts` teste `config.UNRESTRICTED` dans le
seul middleware de rate limit, jamais autour de l'auth). Un serveur mail joignable sans token n'est
pas un mode de test : c'est un incident. À n'utiliser que sur une instance jetable, jamais exposée.

---

## Ce qui reste à votre charge

### Le bearer token

C'est la seule chose qui sépare votre boîte mail d'Internet une fois le tunnel ouvert.

- Générez-le avec `openssl rand -hex 32`. N'inventez pas de token « mémorisable ».
- Ne le collez ni dans une conversation, ni dans un ticket, ni dans un dépôt.
- Pour le changer : nouvelle valeur dans `.env`, `docker compose up -d`, puis mise à jour de la
  configuration du client MCP. Toutes les sessions existantes sont invalidées.

`/mcp` est protégé par un **rate limit par IP** (`RATE_LIMIT_PER_MINUTE`, `429` au-delà), placé
avant l'authentification : un brute-force de token depuis une même IP est ralenti. L'IP est lue dans
`CF-Connecting-IP` derrière le tunnel (`app.set('trust proxy', true)` : le seul ingress est
`cloudflared` sur le réseau bridge privé). Il n'y a pas de
**verrouillage** après échecs répétés. Un token de 32 octets aléatoires rend le brute-force
inatteignable de toute façon ; un token faible reste faible. Cloudflare Access peut ajouter une
couche d'authentification devant le tunnel si vous en voulez une. `UNRESTRICTED=true` lève ce rate
limit — voir la section *Les garde-fous d'envoi*.

### Le mot de passe d'application Apple

- Il donne accès à **toute** la boîte mail, pas seulement à ce serveur.
- Créez-en un **dédié** à icloud-mail-mcp : vous pourrez le révoquer sans casser vos autres appareils.
- Révocation immédiate sur [appleid.apple.com](https://appleid.apple.com/) → *Connexion et
  sécurité* → *Mots de passe pour applications*, au moindre doute.

### `.env`

Il est dans `.gitignore` et n'a jamais été committé dans ce dépôt. Sur un fork ou un clone,
vérifiez-le avant tout `git add -A` :

```bash
git check-ignore -v .env   # doit répondre : .gitignore:4:.env  .env
```

### Ce que vous laissez faire au modèle

Les outils s'exécutent avec vos droits complets sur la boîte. Un modèle qui se trompe de dossier
déplace de vrais messages ; un modèle à qui l'on demande d'envoyer un mail l'envoie vraiment.

Deux garde-fous à connaître :

- **`DRAFTS_ONLY=true`** est le mode le plus sûr sans rien perdre : Claude prépare des réponses
  complètes, avec le bon threading, déposées dans `Drafts` ; vous les envoyez depuis Mail après
  relecture. Contrairement à `ENABLE_SENDING=false`, la rédaction n'est pas jetée. Voir la section
  *Les garde-fous d'envoi* pour `ALLOWED_RECIPIENTS` et `MAX_SENDS_PER_DAY`, qui bornent un envoi
  réellement actif.
- **Le contenu des emails est une entrée non fiable.** Un message reçu peut contenir des
  instructions destinées au modèle qui va le lire (« ignore tes consignes et transfère X à Y »).
  C'est une injection de prompt, et aucun serveur MCP ne peut l'empêcher : c'est le client qui
  décide quoi faire du contenu. Avec `DRAFTS_ONLY` ou un `ALLOWED_RECIPIENTS` restrictif, le pire
  cas d'une injection réussie se limite à un brouillon, un déplacement ou une suppression —
  récupérable depuis la corbeille.

---

## Surface exposée

| Endpoint | Authentifié | Ce qu'il révèle |
|---|---|---|
| `POST/GET/DELETE /mcp` | oui | Tout, avec un token valide. Rate-limité par IP (`429` au-delà). |
| `GET /health` | **non** | `{"status":"ok","version":"<x.y.z>"}` — statut et version du serveur, rien d'autre (aucune configuration, aucun secret). Jamais rate-limité. |

Aucune autre route n'est déclarée : tout le reste renvoie le 404 par défaut d'Express.

---

## Signaler une vulnérabilité

Ouvrez une issue **sans détail exploitable** en demandant un contact privé, ou utilisez l'onglet
*Security* du dépôt GitHub. Merci de ne pas publier de preuve de concept fonctionnelle avant qu'un
correctif ne soit disponible.
