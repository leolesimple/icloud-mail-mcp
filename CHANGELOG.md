# Changelog

## [0.2.2](https://github.com/leolesimple/icloud-mail-mcp/compare/v0.2.1...v0.2.2) (2026-10-06)


### Bug Fixes

* **find_messages:** vérifie from, to et subject localement, la recherche FROM d'iCloud rate des messages ([#64](https://github.com/leolesimple/icloud-mail-mcp/issues/64)) ([00df15b](https://github.com/leolesimple/icloud-mail-mcp/commit/00df15b27eb70fcda2d6c8082dd78c54322cae2e))

## [0.2.1] - 2026-10-06

Retour d'usage réel dans Claude Desktop : PDF illisibles, sessions perdues après
un redéploiement, quota remis à zéro au redémarrage.

### Ajouté

- **`get_attachment` : paramètre `format`** (`auto` par défaut, `text_base64`,
  `url`). Claude Desktop refusait les blocs `resource` `application/pdf` (« not
  currently supported ») : les PDF étaient illisibles. En `auto`, les images
  restent des blocs image et tout le reste est renvoyé en bloc texte JSON
  `{ filename, contentType, size, contentBase64 }` ; `text_base64` force ce JSON,
  images comprises.
- **Liens de téléchargement signés** (`format: "url"`) servis par
  `GET /download/:token` : HMAC-SHA256, valables 15 minutes, à usage unique.
  Tout refus répond le même `404`, le jeton n'est jamais loggé, un `HEAD` est
  refusé pour ne pas consommer le lien. Secret `DOWNLOAD_URL_SECRET` optionnel ;
  exige `PUBLIC_BASE_URL`.
- **`get_attachments`** : jusqu'à 25 pièces jointes en un appel, avec un résultat
  `ok` / `error` par élément (un élément en échec ne fait pas échouer le lot).
  Chaque message n'est téléchargé et parsé qu'une fois.
- **`export_message`** : le message brut au format EML (`message/rfc822`), dans
  les mêmes formats que `get_attachment`.
- **`find_messages`** :
  - `folders: "*"` cherche dans tous les dossiers sauf corbeille et indésirables
    (`includeTrash` pour les inclure) ;
  - `hasAttachment` / `attachmentType` (ex. `"application/pdf"`, ou un préfixe
    `"image/"`) filtrent sur le BODYSTRUCTURE, avant la limite, avec une
    pagination exacte ;
  - `fields` ne renvoie que les champs demandés (`uid` toujours présent) ;
  - avec un filtre pièces jointes, chaque message liste ses `attachments`, avec
    un drapeau `inline` pour les images intégrées au HTML (logos, signatures).
- **`read_message`** : chaque pièce jointe porte aussi le drapeau `inline`.
- **Log par requête `/mcp`** : méthode(s) JSON-RPC, session (connue ou non de ce
  process), statut, durée et `pid`, pour diagnostiquer une double instance.

### Corrigé

- **Sessions perdues après un redémarrage.** Une session inconnue recevait un
  `400 « no valid session ID provided »` : le client bouclait sur l'erreur sans
  jamais se réinitialiser. Le serveur répond désormais `404`, comme l'exige la
  spec MCP, et un `initialize` qui porte encore un ancien identifiant ouvre une
  session neuve.
- **Quota d'envoi remis à zéro au redémarrage.** `MAX_SENDS_PER_DAY` est
  persisté dans le fichier `QUOTA_STATE_PATH` (fenêtre glissante de 24 h,
  écriture atomique ; un fichier corrompu est ignoré sans crash).

### Déploiement

- `docker-compose.yml` monte un volume `icloud-mail-mcp-data` sur `/app/data` et
  fixe `QUOTA_STATE_PATH=/app/data/send-quota.json` : à reporter dans le compose
  de l'hôte avant le `up`.

## [0.2.0] - 2026-10-05

### Modifié — rupture

- **17 outils regroupés en 8, par intention** (#59) : `inbox_overview`,
  `find_messages`, `read_message`, `get_attachment`, `compose_message`,
  `send_draft`, `organize_messages`, `manage_folders`. Les anciens noms
  (`list_folders`, `whoami`, `get_message`, `send_message`…) ne sont plus
  exposés ; `LEGACY_TOOLS=true` les réactive le temps de migrer. Table de
  correspondance dans `docs/tools.md`. Le serveur envoie aussi des consignes
  au client à l'`initialize` (mots-clés FR/EN, `inbox_overview` en premier,
  contenu des mails non fiable).

### Ajouté

- **Mécanisme de jetons de confirmation** pour les opérations destructives
  (#60) : elicitation MCP si le client la supporte, sinon aller-retour avec un
  jeton HMAC à usage unique (`CONFIRM_SECRET`). Pas encore branché sur les
  outils.

### Corrigé

- `send_draft` perdait les pièces jointes du brouillon à l'envoi.
- `inbox_overview` : nombre de non lus faux quand `STATUS` ne le fournit pas.
- **Version affichée** : `/health`, `inbox_overview` et l'`initialize` MCP
  renvoyaient `0.1.4`, `package.json` n'étant plus mis à jour depuis
  semantic-release. Le numéro est désormais commité à chaque release (#61).

## [0.1.5] - 2026-10-03

### Modifié

- **imapflow 2** (#55) et `list_folders` adapté : un `STATUS` refusé par le
  serveur renvoie `false` au lieu de lever une erreur. Montées de version de
  nodemailer 10, dotenv 18 et des dépendances mineures.
- **Releases automatiques** (#58) : semantic-release publie tag, GitHub Release
  et image GHCR à chaque merge sur `main`, à partir des Conventional Commits
  (vérifiés par commitlint).

## [0.1.4] - 2026-09-18

### Ajouté

- **Favicon/webclip.** Le serveur ne servait aucune icône : les connecteurs MCP
  distants (Claude Desktop, claude.ai) retombaient sur le favicon du domaine
  parent faute de mieux. Ajout de `favicon.ico`, `apple-touch-icon.png`, des
  icônes du manifest et d'une page racine (`/`) avec les balises `<link>`
  associées, servis sans authentification (comme `/health`).

## [0.1.3] - 2026-09-18

### Corrigé

- **`list_folders` : validation de sortie cassée sur certains comptes.** Quand
  le serveur IMAP ne rapporte l'état d'abonnement d'un dossier ni via `LSUB`
  ni via `LIST RETURN (SUBSCRIBED)`, imapflow laisse `subscribed` absent.
  L'outil le recopiait tel quel, ce que le schéma de sortie (booléen requis)
  rejetait. Absent = abonné par défaut (comportement documenté d'imapflow).
- **`search_messages` multi-dossiers : un dossier invalide faisait échouer tout
  le lot.** `folders: [...]` abandonnait toute la recherche, sans résultats des
  autres dossiers et avec un message d'erreur générique ("Command failed") qui
  masquait la vraie raison. Un dossier en échec (ex. nom inexistant) est
  désormais écarté et signalé dans un champ `errors` de la réponse ; les autres
  dossiers sont recherchés normalement. Les erreurs de classification IMAP
  reprennent aussi le texte renvoyé par le serveur (`responseText` d'imapflow)
  au lieu du message générique.

## [0.1.2] - 2026-08-31

### Ajouté

- **Auth par `X-Api-Key`.** `/mcp` accepte le token en `X-Api-Key: <token>`
  (jeton brut) en plus de `Authorization: Bearer <token>`. Les connecteurs
  personnalisés de claude.ai interdisent l'en-tête `Authorization` et n'ouvrent
  qu'une liste blanche de noms d'en-têtes, dont `x-api-key`. Même token, même
  accès. `docs/deployment.md` détaille le branchement claude.ai / Claude Desktop.

## [0.1.1] - 2026-08-31

### Modifié

- **Déploiement : tunnel externalisable.** `docker-compose.yml` ne contient plus
  que le serveur, rattaché à un réseau Docker externe dont le nom vit dans `.env`
  (`TUNNEL_NETWORK`) — pour un `cloudflared` géré par une autre stack. Le
  `cloudflared` embarqué passe dans `docker-compose.tunnel.yml` (déploiement
  autonome, opt-in). `docs/deployment.md` réécrit : installation en 2 fichiers
  `curl`, sans `git clone`.

## [0.1.0] - 2026-08-31

Première version publiée. Serveur MCP exposant un compte iCloud Mail
(IMAP/SMTP) sous forme d'outils pour Claude.

### Ajouté

- **17 outils MCP** : `list_folders`, `list_messages`, `search_messages`,
  `get_message`, `get_attachment`, `get_thread`, `send_message`,
  `reply_message`, `forward_message`, `save_draft`, `update_draft`,
  `send_draft`, `move_message`, `delete_message`, `flag_message`,
  `manage_folder`, `whoami`. Un 18ᵉ, `wait_for_new_message`, derrière
  `ENABLE_IDLE_WATCH` (OFF par défaut, pas de reconnexion — voir #20).
- Opérations de masse : `uid` unique ou jusqu'à 200 `uids` par commande IMAP.
- **Garde-fous d'envoi gradués** : `ENABLE_SENDING`, `DRAFTS_ONLY`, allowlist
  de destinataires, quota journalier, `UNRESTRICTED`. Appliqués au niveau du
  transport SMTP, verrouillés par des tests.
- Deux transports MCP : HTTP streamable et stdio (`MCP_TRANSPORT`).
- Resources (`mail://folders`, `mail://folder/{path}/message/{uid}`) et prompts
  MCP.
- HTTP : bearer token, rate limit à fenêtre glissante, TTL des sessions,
  `/health` non authentifié renvoyant statut + version.
- `npm run auth` : vérifie IMAP et SMTP pour de vrai avant d'écrire `.env`.
- Déploiement de référence : image Docker (`node` non-root, multi-étages,
  HEALTHCHECK) + Cloudflare Tunnel, aucun port publié sur l'hôte.
- Logs structurés pino, sans secret ni contenu de mail. 340 tests hors réseau.

### Infrastructure de release (préparation 0.1.0)

- Renommage `mail-mcp` → `icloud-mail-mcp` (l'id du serveur MCP reste
  `icloud-mail`).
- Déploiement par image publiée : `docker-compose.yml` tire
  `ghcr.io/leolesimple/icloud-mail-mcp` au tag `ICLOUD_MAIL_MCP_VERSION` ;
  `docker-compose.dev.yml` pour le build local.
- CI : job de build de l'image Docker. `release.yml` : tag `v*` → image GHCR
  (linux/amd64) + GitHub Release.
- IP cliente résolue via `CF-Connecting-IP` derrière le tunnel (le rate limit
  par IP ne s'effondre plus en un seul seau).
- Dependabot sur npm et GitHub Actions.

[Non publié]: https://github.com/leolesimple/icloud-mail-mcp/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/leolesimple/icloud-mail-mcp/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/leolesimple/icloud-mail-mcp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/leolesimple/icloud-mail-mcp/releases/tag/v0.1.0

---

Les entrées jusqu'à la 0.2.1 sont rédigées à la main. Les suivantes sont
générées par [semantic-release](https://semantic-release.gitbook.io/) à partir
des commits [Conventional Commits](https://www.conventionalcommits.org/fr/)
mergés sur `main` ; détails du pipeline dans
[`docs/development.md`](docs/development.md#releases).
