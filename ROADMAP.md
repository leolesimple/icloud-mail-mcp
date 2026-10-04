# Roadmap

Évolutions prévues du serveur MCP iCloud Mail, découpées en lots. Chaque lot
correspond à une branche, mergée par PR avec ses tests et la mise à jour de
`docs/`.

Les worktrees sont créés avec la CLI Orca pour qu'Orca les affiche :

```bash
orca worktree create --repo name:icloud-mail-mcp --name feat/<lot> --base-branch main --no-parent
```

Orca les place sous `~/orca/workspaces/icloud-mail-mcp/feat-<lot>` et nomme la
branche `leolesimple/feat-<lot>`. Lancer ensuite `npm ci` dans le worktree.

## Lot 1 — Visibilité et regroupement des tools (en cours)

Branche `leolesimple/feat-tool-surface`. Changement cassant (`feat!:`, version majeure).

- `instructions` à l'initialize, avec mots-clés FR/EN (mail, courriel, boîte de
  réception, inbox, non lus, unread, brouillon, draft, iCloud Mail), consigne
  d'appeler `inbox_overview` en premier et avertissement sur le contenu non fiable.
- `inbox_overview` remplace `whoami` : non lus INBOX, derniers mails, compteurs
  par dossier, compte, garde-fous actifs.
- Passage de 17 à 8 tools : `inbox_overview`, `find_messages`, `read_message`,
  `get_attachment`, `compose_message`, `send_draft`, `organize_messages`,
  `manage_folders`.
- Descriptions réécrites avec les synonymes FR et EN.
- `LEGACY_TOOLS=true` réenregistre les anciens noms pendant une version.

Les lots suivants ne touchent pas `src/mcp/tools/` tant que le lot 1 n'est pas
mergé : ils livrent d'abord leur logique, puis la branchent sur les nouveaux
tools après rebase.

## Ordre de merge

`tool-surface` → `confirm-tokens` → `content-safety` → `imap-features` →
`sender-signature` → `imap-resilience` → `carddav`

`imap-resilience` peut passer à tout moment (aucun branchement côté tools).

## Lot 2 — Jetons de confirmation

Branche `feat/confirm-tokens`. Prérequis des lots 3 (vidage) et 5 (envoi).

- Nouveau module `src/confirm.ts` : jetons HMAC à TTL court (2 min), liés à
  l'opération, au dossier et à son UIDVALIDITY.
- Aide à l'elicitation MCP quand le client la supporte, repli sur le jeton en
  deux temps sinon.
- Secret dans `config.ts`.

## Lot 3 — Fonctionnalités IMAP

Branche `feat/imap-features`.

- Résolveur de dossiers spéciaux `archive` / `junk` / `trash` / `sent` /
  `drafts` : flag special-use, puis noms iCloud connus (`Archive`, `Junk`,
  `Deleted Messages`), avec cache.
- `sinceUid` pour le polling (`UID n+1:*`, filtré côté client car `*` renvoie
  toujours le dernier message) et `uidValidity` dans la réponse.
- Filtre `hasAttachment` : pré-filtre `HEADER Content-Type multipart/mixed`,
  vérification par `bodyStructure`, pagination qui remplit la page.
- Curseur opaque pour la recherche multi-dossiers (`{ dossier: beforeUid }`).
- Vidage de corbeille / spam, restreint à `\Trash` et `\Junk`, derrière un jeton
  de confirmation.

Branchement : `find_messages` (`sinceUid`, `hasAttachment`),
`organize_messages` (`archive`, `spam`, `trash`), `manage_folders` (`empty`).

## Lot 4 — Contenu et sécurité de lecture

Branche `feat/content-safety`. Dépendance : `sanitize-html`.

- `bodyFormat: text | clean_html | raw_html` ; `clean_html` retire scripts,
  styles, pixels de tracking, images distantes et éléments cachés.
- Contenu des mails marqué non fiable : encadrement
  `<untrusted_email_content>` dans le texte, `contentTrust: "untrusted"` dans le
  structuré, retrait des caractères invisibles. Un test vérifie qu'aucun chemin
  de lecture n'y échappe.
- Champ `unsubscribe: { mailto?, url?, oneClick }` parsé depuis
  `List-Unsubscribe` / `List-Unsubscribe-Post` (extraction seulement, pas
  d'exécution).
- `get_attachment` : mode `metadata` par défaut ; au-delà d'un seuil,
  `resource_link` vers `mail://…/attachments/i` plutôt que du base64 ; URL
  signée temporaire si `PUBLIC_BASE_URL` est défini.
- `threadKey` dans les résumés de messages.

Branchement : `read_message`, `get_attachment`, `find_messages`.

## Lot 5 — Expéditeur, signature et mode d'envoi

Branche `feat/sender-signature`.

- `SENDER_ADDRESSES` (alias, Hide My Email, domaine perso) : `from` validé contre
  cette liste avant SMTP. En réponse, défaut sur l'adresse qui a reçu le mail
  d'origine si elle est dans la liste.
- `SEND_MODE=draft_first | confirm | direct`, défaut `draft_first` :
  `compose_message` crée un brouillon et renvoie un aperçu, seul `send_draft`
  envoie. `DRAFTS_ONLY` devient un alias.
- Expunge définitif derrière un jeton de confirmation (le déplacement vers la
  corbeille reste direct).
- Signature : `SIGNATURE_TEXT` / `SIGNATURE_HTML` (ou `SIGNATURES_JSON` par
  expéditeur), ajoutée dans `composeRaw`, désactivable par `signature: false`.

Branchement : `compose_message`, `organize_messages` (expunge), liste des
expéditeurs dans `inbox_overview`.

## Lot 6 — Robustesse IMAP

Branche `feat/imap-resilience`.

- Un rejeu automatique sur `ImapNetworkError` dans le pool, avec backoff
  exponentiel.
- Reconnexion IDLE dans `idle.ts`, pour pouvoir activer `ENABLE_IDLE_WATCH` par
  défaut.
- Rate limit global en plus de celui par session.

## Lot 7 — Contacts CardDAV

Branche `feat/carddav`. Dépendance : `tsdav`.

- Client CardDAV sur `contacts.icloud.com` (même mot de passe d'application),
  cache de 10 minutes.
- Tool `find_contacts` ; `compose_message` résout un nom en adresse, ou demande
  lequel en cas d'ambiguïté.

## Points de vigilance

- `src/config.ts`, `.env.example`, `docs/configuration.md` : chaque lot ajoute
  ses variables dans un bloc commenté séparé, sans modifier les lignes
  existantes.
- `package.json` / `package-lock.json` (lots 4 et 7) : au rebase, garder la
  version de `main` et relancer `npm install <paquet>`.
- Plusieurs serveurs de dev en parallèle : un `PORT` distinct par worktree, et
  pas plus de 2 ou 3 à la fois (limite de connexions IMAP iCloud sur un même
  compte).
