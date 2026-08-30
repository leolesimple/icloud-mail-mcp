# mail-mcp

[![CI](https://github.com/leolesimple/mail-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/leolesimple/mail-mcp/actions/workflows/ci.yml)

Serveur [MCP](https://modelcontextprotocol.io) qui expose un compte **iCloud Mail** (IMAP/SMTP) sous
forme d'outils utilisables par Claude : lire, chercher, trier, répondre et archiver des mails depuis
une conversation.

Il tourne chez vous, en Docker, derrière un Cloudflare Tunnel et un bearer token. Aucune donnée ne
transite par un service tiers : Claude parle directement à votre instance, qui parle directement à
iCloud.

```
Claude  ──HTTPS+Bearer──▶  Cloudflare Tunnel  ──▶  mail-mcp  ──IMAP/SMTP+TLS──▶  iCloud
```

> **Licence — à lire avant de cloner.** Ce projet **n'est pas open source**. Vous pouvez le
> télécharger, l'installer et l'utiliser librement, y compris dans votre entreprise. L'usage
> commercial et les versions modifiées ne sont pas autorisés sans accord écrit.
> Voir [LICENSE](LICENSE).

---

## Sommaire

- [Ce que ça fait](#ce-que-ça-fait)
- [Prérequis](#prérequis)
- [Démarrage rapide](#démarrage-rapide)
- [Brancher Claude dessus](#brancher-claude-dessus)
- [Sécurité](#sécurité)
- [Limitations connues](#limitations-connues)
- [Documentation](#documentation)

---

## Ce que ça fait

Dix outils MCP, décrits en détail dans [`docs/tools.md`](docs/tools.md) :

| Outil | Ce qu'il fait |
|---|---|
| `list_folders` | Liste les dossiers IMAP, avec leur rôle spécial (`\Trash`, `\Drafts`…) |
| `list_messages` | Liste un dossier, du plus récent au plus ancien — filtres : non lus, plage de dates, expéditeur |
| `search_messages` | Recherche côté serveur IMAP : sujet, corps, expéditeur, destinataire |
| `get_message` | Contenu complet d'un message : en-têtes, corps texte et HTML, métadonnées des pièces jointes |
| `send_message` | Envoie un nouveau message |
| `reply_message` | Répond à un message avec un threading correct (`In-Reply-To`, `References`, sujet `Re:`) |
| `save_draft` | Enregistre un brouillon dans Drafts sans rien envoyer — peut hériter du threading d'un message |
| `move_message` | Déplace un message d'un dossier à un autre |
| `delete_message` | Envoie à la corbeille ; supprime définitivement si le message y est déjà |
| `flag_message` | Marque lu / non lu, favori / non favori |

Concrètement, une fois branché, on peut demander à Claude :

> « Résume-moi les mails non lus de la semaine, archive les newsletters et prépare un brouillon de
> réponse à celui de la banque. »

### Ce qui rend le serveur utilisable en pratique

- **Pool de connexions IMAP** — iCloud limite agressivement les connexions simultanées. Les
  connexions sont ouvertes une fois, réutilisées entre les appels, purgées quand elles meurent, et
  la demande en trop attend son tour au lieu de se faire jeter. Voir
  [`docs/architecture.md`](docs/architecture.md).
- **Erreurs lisibles** — un mot de passe principal Apple utilisé à la place d'un mot de passe
  d'application donne un message qui le dit, pas une stack trace IMAP.
- **Coupe-circuit d'envoi** — `ENABLE_SENDING=false` désactive `send_message` et `reply_message`
  sans toucher au reste. Utile pour laisser Claude trier une boîte sans jamais pouvoir écrire à
  quelqu'un.
- **Logs structurés** (pino) sans mot de passe ni contenu de mail.
- **107 tests** qui ne touchent ni le réseau ni une vraie boîte mail.

---

## Prérequis

- **Node.js 24+** (ou Docker, qui s'en occupe)
- **Un compte iCloud avec l'authentification à deux facteurs activée**
- **Un mot de passe d'application Apple** — le mot de passe principal du compte ne fonctionne pas
  en IMAP/SMTP :
  1. [appleid.apple.com](https://appleid.apple.com/) → se connecter
  2. **Connexion et sécurité** → **Mots de passe pour applications** → **Générer un mot de passe**
  3. Nommer (« mail-mcp ») et copier le mot de passe au format `xxxx-xxxx-xxxx-xxxx`

---

## Démarrage rapide

```bash
git clone https://github.com/leolesimple/mail-mcp.git
cd mail-mcp
npm install
npm run auth
```

`npm run auth` demande l'adresse iCloud et le mot de passe d'application (saisie
masquée), génère le `MCP_BEARER_TOKEN`, **vérifie pour de vrai les connexions IMAP
et SMTP**, puis écrit `.env` en `chmod 600` — rien n'est écrit si une vérification
échoue, et un `.env` existant est sauvegardé en `.env.bak` avant tout écrasement.
Le fichier généré démarre avec `ENABLE_SENDING=false`.

```bash
npm run auth:check     # rejoue la vérification IMAP + SMTP sur le .env existant, sans rien écrire
```

Puis démarrer :

```bash
npm run dev            # http://localhost:3000/mcp
```

Le endpoint MCP est `POST|GET|DELETE /mcp`, protégé par
`Authorization: Bearer <MCP_BEARER_TOKEN>`. `GET /health` reste ouvert (healthcheck Docker).

Pour l'inspecter à la main :

```bash
npx @modelcontextprotocol/inspector
# Transport : Streamable HTTP
# URL       : http://localhost:3000/mcp
# Header    : Authorization: Bearer <votre token>
```

Pour le déploiement Docker + Cloudflare Tunnel, voir [`docs/deployment.md`](docs/deployment.md).

---

## Brancher Claude dessus

**Claude Code** :

```bash
claude mcp add --transport http mail-mcp https://mail-mcp.exemple.com/mcp \
  --header "Authorization: Bearer <votre token>"
```

**Claude Desktop / claude.ai** : *Paramètres → Connecteurs → Ajouter un connecteur personnalisé*,
en donnant l'URL `https://mail-mcp.exemple.com/mcp`.

Détails et dépannage dans [`docs/deployment.md`](docs/deployment.md#brancher-un-client-mcp).

---

## Sécurité

Ce serveur peut lire, déplacer, supprimer et envoyer des mails. Les points à ne pas rater :

- **N'exposez jamais le endpoint sans le bearer token.** Le token est comparé en temps constant
  (`timingSafeEqual`), mais un token faible reste un token faible : `openssl rand -hex 32`.
- **`.env` ne doit jamais être committé.** Il est dans `.gitignore` ; vérifiez-le avant tout
  `git add -A` sur un fork.
- **Le mot de passe d'application Apple donne accès à toute la boîte mail.** Il se révoque en un
  clic sur appleid.apple.com si le serveur est compromis.
- **Commencez avec `ENABLE_SENDING=false`.** Vous rallumerez l'envoi quand vous aurez vu comment
  Claude se comporte sur votre boîte.
- **Le healthcheck `/health` n'est pas authentifié** — il ne révèle que `{"status":"ok"}`.

Détail complet dans [`docs/security.md`](docs/security.md).

---

## Limitations connues

- **Pièces jointes plafonnées à `ATTACHMENT_MAX_BYTES` (5 Mo par défaut).** `get_attachment`
  récupère le binaire d'une pièce jointe et `send_message` / `reply_message` / `forward_message` /
  `save_draft` permettent d'en joindre, mais au-delà de cette limite (cumul compris) l'outil refuse
  explicitement plutôt que de tronquer.
- **iCloud uniquement en pratique.** Le code est du IMAP/SMTP standard et les hôtes sont
  configurables, mais rien d'autre n'est testé.

---

## Documentation

| Document | Contenu |
|---|---|
| [`docs/tools.md`](docs/tools.md) | Référence des dix outils : paramètres, retours, exemples |
| [`docs/configuration.md`](docs/configuration.md) | Toutes les variables d'environnement |
| [`docs/deployment.md`](docs/deployment.md) | Docker, Cloudflare Tunnel, branchement des clients MCP |
| [`docs/architecture.md`](docs/architecture.md) | Découpage en couches, pool IMAP, gestion des erreurs et des sessions |
| [`docs/security.md`](docs/security.md) | Modèle de menace et bonnes pratiques |
| [`docs/development.md`](docs/development.md) | Structure du code, tests, conventions |

---

## Licence

Copyright © 2026 Léo Lesimple. Tous droits réservés.

Usage personnel et interne autorisé et gratuit. Usage commercial et œuvres dérivées interdits sans
accord écrit préalable. Voir [LICENSE](LICENSE) pour le texte qui fait foi.

Ce n'est **pas** une licence open source au sens de l'OSI : GitHub permet techniquement de forker
un dépôt public, mais publier ou utiliser une version modifiée de ce code n'est pas autorisé par
cette licence. Pour un usage sortant de ce cadre, ouvrez une issue pour en discuter.
