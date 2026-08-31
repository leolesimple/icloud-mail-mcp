# Changelog

Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/),
versionnage [SemVer](https://semver.org/lang/fr/).

## Procédure de release

1. Mettre à jour ce fichier : renommer `[Non publié]` en `[X.Y.Z] - AAAA-MM-JJ`.
2. Bumper `version` dans `package.json` (source unique, lue par `src/version.ts`
   et exposée sur `/health` + l'outil `whoami`).
3. Commit sur `main` via PR.
4. `git tag -a vX.Y.Z -m "vX.Y.Z"` puis `git push origin vX.Y.Z`.
5. Le workflow `release.yml` vérifie que le tag == `package.json`, rejoue
   tests + build, pousse `ghcr.io/leolesimple/icloud-mail-mcp:{X.Y.Z, X.Y, latest}`
   (linux/amd64) et crée la GitHub Release.

---

## [Non publié]

_Rien pour l'instant._

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

[Non publié]: https://github.com/leolesimple/icloud-mail-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/leolesimple/icloud-mail-mcp/releases/tag/v0.1.0
