# Développement

> Rappel : la [licence](../LICENSE) n'autorise pas la distribution de versions modifiées. Cette page
> décrit comment le projet est construit et testé — utile pour le lire, l'auditer avant de lui
> confier sa boîte mail, ou préparer une contribution à proposer en amont.

---

## Mise en route

```bash
npm install
npm run auth              # saisie des identifiants, vérification IMAP + SMTP, écriture de .env (chmod 600)
npm run dev               # serveur sur http://localhost:3000, rechargé par tsx
```

`npm run auth` remplace le `cp .env.example .env` manuel : il génère le
`MCP_BEARER_TOKEN`, vérifie réellement la connexion iCloud avant d'écrire quoi que
ce soit, et sauvegarde un `.env` existant en `.env.bak`. `npm run auth:check`
rejoue la seule vérification, sans écriture. `npm run verify:imap` reste
disponible pour un contrôle IMAP seul.

| Commande | Rôle |
|---|---|
| `npm run auth` | Mise en route : identifiants, vérification IMAP + SMTP, écriture de `.env` |
| `npm run auth:check` | Rejoue la vérification IMAP + SMTP sur le `.env` existant, sans écriture |
| `npm run dev` | Serveur HTTP MCP en TypeScript direct (tsx) |
| `npm run build` | Compile `src/` vers `dist/` |
| `npm start` | Lance le build compilé |
| `npm test` | Suite de tests complète |
| `npm run test:watch` | Tests en mode veille |
| `npm run typecheck` | TypeScript strict sur `src/` **et** `test/` |
| `npm run lint` | ESLint |
| `npm run format` | Prettier |
| `npm run verify:imap` | Connexion IMAP réelle + liste des dossiers |

Node **24+** est requis (`engines`), pour le runner de tests intégré et le support ESM natif.

---

## Structure

```
src/
  config.ts            Schéma zod de l'environnement, validé au démarrage
  logger.ts            pino, avec expurgation des secrets
  index.ts             Point d'entrée : écoute + arrêt propre
  http/
    server.ts          Express, routes /mcp et /health, sessions MCP
    auth.ts            Middleware bearer, comparaison en temps constant
  mcp/
    server.ts          Assemble le serveur MCP et enregistre les outils
    tools/             Un fichier par outil : schéma zod + appel métier
    tools/legacy/      Anciens outils, réexposés avec LEGACY_TOOLS=true
    overview.ts        Logique d'inbox_overview (injectable pour les tests)
    compose-plan.ts    Validation des combinaisons de compose_message (module pur)
  imap/
    pool.ts            Pool de connexions imapflow
    mailbox.ts         withMailbox : verrou de dossier toujours relâché
    messages.ts        Lecture : list, search, get + projections
    mutations.ts       Écriture : move, delete, flags
    drafts.ts          Brouillons : APPEND, remplacement, envoi
    threading.ts       En-têtes de réponse RFC 5322 (module pur)
    folders.ts         Listing et gestion des dossiers
    special-folders.ts Résolution des dossiers par flag (\Trash, \Drafts)
    errors.ts          Classification des erreurs IMAP
  smtp/
    client.ts          Transport nodemailer + coupe-circuit ENABLE_SENDING
    send.ts            sendNewMessage, sendReply
    errors.ts          Classification des erreurs SMTP
  dev/
    verify-imap.ts     Script de vérification manuelle
test/
  helpers/             Environnement de test, client IMAP factice
  *.test.ts            Suites (voir ci-dessous)
```

**Règle de dépendance** : `imap/` et `smtp/` ne connaissent pas MCP. Un fichier de `mcp/tools/`
déclare un schéma, appelle une fonction métier, sérialise le résultat — rien de plus. Toute logique
qui mérite un test appartient aux couches basses.

---

## Tests

```bash
npm test
```

**340 tests**, exécutés par le runner intégré de Node (`node:test`) via tsx. Aucune dépendance de
test supplémentaire, aucun framework à maintenir.

| Fichier | Ce qui est couvert |
|---|---|
| `config.test.ts` | Validation de l'environnement, valeurs par défaut, tous les cas de `ENABLE_SENDING` |
| `imap-errors.test.ts` | Classification IMAP : auth, réseau, commande, idempotence, priorités |
| `smtp-errors.test.ts` | Classification SMTP, conservation de la cause |
| `threading.test.ts` | Préfixe `Re:`, chaîne `References`, destinataires déduits, non-mutation |
| `messages.test.ts` | Projections d'enveloppe, flags, dates ISO, champs manquants |
| `pool.test.ts` | Réutilisation, taille max, file d'attente, purge des connexions mortes, retry, fermeture |
| `auth.test.ts` | Bearer valide, absent, tronqué, rallongé, mauvais schéma |
| `http.test.ts` | Serveur réel : `/health` + version, `401`, rate limit par `CF-Connecting-IP`, cycle de session MCP complet |
| `client-ip.test.ts` | Résolution de l'IP appelante (`CF-Connecting-IP`, `req.ip`, socket, `unknown`) |
| `sending-guard.test.ts` | `ENABLE_SENDING=false` bloque l'envoi avant toute connexion SMTP |

### Deux invariants tenus par la suite

**Aucun test ne touche le réseau ni une vraie boîte mail.** Le pool est testé avec un client
imapflow factice injecté par le constructeur (`test/helpers/fake-imap.ts`) ; les tests HTTP montent
un vrai serveur Express sur un port éphémère mais n'appellent jamais d'outil, donc n'ouvrent aucune
connexion IMAP ou SMTP.

**Aucun test ne peut envoyer d'email.** `test/helpers/env.ts` force `ENABLE_SENDING=false`, et
`sending-guard.test.ts` vérifie que cette configuration est bien active *et* qu'elle bloque
effectivement l'envoi. Le helper pose ses valeurs avec `??=` avant que `dotenv` ne s'exécute : un
`.env` réel présent sur la machine ne peut pas fuiter dans les tests.

### Écrire un test

Tout fichier de test qui charge, directement ou non, `src/config.ts` doit importer l'environnement
de test **en premier** — les modules ESM sont évalués dans l'ordre des imports :

```ts
import './helpers/env.js';        // toujours en première ligne
import { describe, it } from 'node:test';
```

Les imports pointent vers les fichiers sources en `.js` (résolution NodeNext), même en TypeScript.

---

## Intégration continue

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) rejoue `typecheck`, `lint`, `test` et
`build` sur Node 24, puis construit l'image Docker (`linux/amd64`, sans push) et vérifie qu'elle
démarre — à chaque push sur `main` et sur chaque pull request.

Le workflow n'a besoin d'**aucun secret** : la suite de tests n'ouvre aucune connexion IMAP ou SMTP
et force `ENABLE_SENDING=false`. Il n'y a donc pas de compte iCloud à configurer dans le dépôt, et
une pull request extérieure ne peut rien exfiltrer.

---

## Releases

Les versions sont publiées automatiquement par
[`semantic-release`](https://semantic-release.gitbook.io/) via
[`.github/workflows/release.yml`](../.github/workflows/release.yml), déclenché après chaque run
vert de `ci.yml` sur `main` (donc à chaque merge). Aucun tag manuel : semantic-release calcule le
bump à partir des commits mergés depuis le dernier tag, pose le tag `vX.Y.Z` et publie la GitHub
Release avec ses notes. Le job `docker` du même workflow pousse ensuite l'image sur GHCR taguée
`{X.Y.Z, X.Y, latest}`.

À chaque release, `@semantic-release/npm` (sans publication npm) bumpe `package.json` et
`package-lock.json`, et `@semantic-release/git` les commite directement sur `main`
(`chore(release): X.Y.Z [skip ci]`) avant de poser le tag sur ce commit. L'image construite depuis
le tag embarque donc la bonne version (`/health`, `inbox_overview`, initialize MCP). Ce push direct
passe outre le ruleset « Protect main » grâce au bypass accordé à l'intégration GitHub Actions ;
`[skip ci]` évite de relancer CI et Release sur ce commit. `CHANGELOG.md` n'est plus mis à jour :
les notes vivent dans les GitHub Releases.

Le calcul du bump dépend des commits en [Conventional Commits](https://www.conventionalcommits.org/fr/) :

- `fix: …` → patch
- `feat: …` → minor
- `feat!: …` ou pied `BREAKING CHANGE: …` → major
- `chore:`, `docs:`, `refactor:`, `test:`, `ci:`, … → pas de release

[`commitlint.yml`](../.github/workflows/commitlint.yml) vérifie ce format sur chaque commit d'une
pull request (config : [`commitlint.config.js`](../commitlint.config.js)). Un commit qui ne
respecte pas le format fait échouer ce check.

Pour tester localement sans rien publier : `npx semantic-release --dry-run --no-ci`.

---

## Conventions

- **TypeScript strict**, avec `noUncheckedIndexedAccess` : un accès par index renvoie
  `T | undefined` et doit être traité.
- **ESM uniquement** (`"type": "module"`), imports avec extension `.js`.
- **Prettier** fait foi sur le formatage ; `eslint-config-prettier` neutralise les règles de style
  d'ESLint.
- **Commentaires** : expliquer *pourquoi*, pas *quoi*. Les commentaires existants documentent des
  pièges réels (coercition zod de `"false"`, ordre de libération verrou/connexion, absence
  d'`instanceof` sur les erreurs imapflow) — c'est le registre attendu.
- Les messages d'erreur destinés à l'utilisateur sont en français ; les descriptions d'outils MCP,
  lues par le modèle, sont en anglais.

Avant de proposer un changement :

```bash
npm run typecheck && npm run lint && npm test
```
