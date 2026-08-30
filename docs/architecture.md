# Architecture

## Vue d'ensemble

```
                    HTTPS + Bearer
   Claude  ─────────────────────────▶  Cloudflare Tunnel
                                              │
                                              ▼
   ┌──────────────────────────────────────────────────────┐
   │  src/http/         Express, auth bearer, sessions MCP │
   ├──────────────────────────────────────────────────────┤
   │  src/mcp/          Serveur MCP + 10 outils (schémas)  │
   ├──────────────────────────────────────────────────────┤
   │  src/imap/         Pool, messages, mutations, drafts  │
   │  src/smtp/         Transport nodemailer, envoi        │
   └──────────────────────────────────────────────────────┘
                                              │
                                    IMAP 993 / SMTP 587 (TLS)
                                              ▼
                                          iCloud
```

La règle de dépendance est stricte : **les couches basses ne connaissent jamais MCP**. `src/imap/`
et `src/smtp/` manipulent des types métier (`MessageSummary`, `SendResult`) et ignorent tout du
protocole. Les fichiers de `src/mcp/tools/` ne font que trois choses : déclarer un schéma zod,
appeler une fonction métier, sérialiser le résultat.

---

## Couche HTTP — [`src/http/`](../src/http/)

Un serveur Express avec trois routes :

| Route | Auth | Rôle |
|---|---|---|
| `POST /mcp` | bearer | Requêtes JSON-RPC, dont `initialize` qui ouvre une session |
| `GET /mcp` | bearer | Flux SSE de notifications serveur → client |
| `DELETE /mcp` | bearer | Fermeture explicite d'une session |
| `GET /health` | **aucune** | Healthcheck Docker, renvoie `{"status":"ok"}` |

### Authentification

[`auth.ts`](../src/http/auth.ts) compare le token avec `timingSafeEqual`, après vérification de
l'égalité des longueurs — `timingSafeEqual` lève une exception sur des tampons de tailles
différentes, ce qui est en soi une fuite d'information à éviter. Un échec renvoie une erreur au
format JSON-RPC (code `-32001`), et non une page d'erreur HTML, pour rester exploitable par un
client MCP.

### Sessions

Chaque `initialize` crée un `StreamableHTTPServerTransport` avec un identifiant de session aléatoire
(`randomUUID`) et **une instance de serveur MCP dédiée**, mémorisés dans une `Map`. Les requêtes
suivantes sont routées par l'en-tête `mcp-session-id`.

Une requête authentifiée qui n'est ni un `initialize` ni une session connue reçoit un `400` : le
serveur ne crée jamais de session implicite.

> **Limitation connue** : la `Map` de sessions n'a ni TTL ni éviction. Un client qui disparaît sans
> envoyer de `DELETE` laisse son entrée en mémoire jusqu'au redémarrage. Sans conséquence à l'échelle
> d'un usage personnel, mais c'est la première chose à corriger pour un usage multi-utilisateurs.

---

## Pool de connexions IMAP — [`src/imap/pool.ts`](../src/imap/pool.ts)

C'est la pièce la plus subtile du projet, et elle existe pour une seule raison : **iCloud limite
sévèrement les connexions IMAP** et bloque temporairement les comptes qui en ouvrent trop. Ouvrir
une connexion par appel d'outil ferait tomber le compte en quelques minutes d'usage normal.

Le pool maintient au plus `IMAP_POOL_SIZE` connexions, ouvertes à la demande puis réutilisées :

- **`acquire()`** renvoie une connexion libre, en ouvre une si le pool n'est pas plein, sinon met
  la demande en file d'attente. Les demandes en attente sont servies dans l'ordre d'arrivée.
- **`release()`** rend la connexion et sert immédiatement le premier waiter. Si la connexion est
  devenue inutilisable entre-temps, elle est retirée du pool au lieu d'être recyclée.
- **`withConnection(fn)`** encadre les deux et **libère même si `fn` lève** — c'est la seule forme
  utilisée par le reste du code.
- Les événements `error` et `close` d'une connexion la retirent du pool immédiatement, sans attendre
  qu'un appel échoue dessus.
- Les entrées mortes restées inactives (fermées côté serveur sans notification) sont purgées à la
  demande suivante.
- Une connexion qui échoue pour une **raison réseau** est retentée une fois après 750 ms. Un échec
  d'**authentification** n'est jamais retenté : le mot de passe ne va pas devenir correct.

Un compteur `reserved` empêche deux demandes concurrentes de dépasser la taille max pendant
l'ouverture d'une connexion — le point de synchronisation le plus facile à rater dans un pool
asynchrone, et il est décrémenté même si la connexion échoue.

### `withMailbox`

[`mailbox.ts`](../src/imap/mailbox.ts) est le second garde-fou : il prend une connexion, pose un
verrou sur le dossier, exécute le travail, puis **libère toujours le verrou avant la connexion**,
même en cas d'erreur. Un verrou de boîte non libéré fige toutes les opérations suivantes sur cette
connexion.

Les lectures (`list_messages`, `search_messages`, `get_message`) passent en `readOnly: true` : le
dossier est ouvert avec `EXAMINE` plutôt que `SELECT`, ce qui évite que le serveur marque les
messages comme lus au passage.

---

## Gestion des erreurs

Les erreurs des bibliothèques IMAP et SMTP sont des objets opaques avec des codes hétérogènes.
Chaque couche les traduit en trois familles, ce qui suffit à savoir quoi faire :

| Famille | IMAP | SMTP | Ce que ça veut dire |
|---|---|---|---|
| Authentification | `ImapAuthError` | `SmtpAuthError` | Identifiants faux — action humaine requise, ne pas retenter |
| Réseau | `ImapNetworkError` | `SmtpNetworkError` | Transitoire — un retry a du sens |
| Commande / message | `ImapCommandError` | `SmtpMessageError` | La requête est en cause (dossier inexistant, destinataire refusé) |

`classifyImapError` reconnaît l'échec d'authentification via la propriété `authenticationFailed`
posée par imapflow — sa classe d'erreur interne n'est pas exportée, donc `instanceof` est impossible.
Les deux classificateurs sont **idempotents** : ré-classer une erreur déjà classée la renvoie telle
quelle, ce qui permet de les appeler à plusieurs niveaux sans empiler les messages.

Le message produit vise l'utilisateur, pas la machine. L'erreur d'authentification IMAP rappelle
qu'un mot de passe d'application est nécessaire — c'est de loin la cause la plus fréquente.

---

## Threading des réponses — [`src/imap/threading.ts`](../src/imap/threading.ts)

Répondre correctement à un mail demande plus que préfixer « Re: ». Il faut reconstruire les en-têtes
RFC 5322 qui rattachent la réponse au fil :

- `In-Reply-To` : le `Message-ID` du message auquel on répond ;
- `References` : la chaîne complète du fil, terminée par ce même `Message-ID`, sans doublon.

Sans ça, la réponse apparaît comme un message isolé dans le client du destinataire.

Cette logique est isolée dans un module pur, sans dépendance réseau, **partagé par `sendReply`
(SMTP) et `saveDraft` (IMAP APPEND)**. C'est ce qui garantit qu'un brouillon préparé par Claude et
envoyé plus tard depuis Mail.app atterrit dans le même fil qu'une réponse envoyée directement.

---

## Cycle de vie

Au démarrage : validation de la configuration → écoute HTTP. Aucune connexion IMAP ou SMTP n'est
ouverte tant qu'un outil n'est pas appelé.

Sur `SIGINT`/`SIGTERM` ([`index.ts`](../src/index.ts)) : arrêt de l'écoute, fermeture des sessions
MCP, `LOGOUT` propre de chaque connexion IMAP, fermeture du pool SMTP. Un `LOGOUT` propre évite de
laisser des connexions fantômes côté iCloud, qui compteraient contre la limite du compte au
redémarrage suivant.
