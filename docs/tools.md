# Référence des outils

Les douze outils exposés par le serveur MCP. Les descriptions transmises à Claude sont en anglais
(c'est ce que le modèle lit) ; cette page en donne la version détaillée.

Conventions communes :

- **`folder`** est un chemin IMAP tel que renvoyé par `list_folders` : `INBOX`, `Archive`,
  `Sent Messages`, `Deleted Messages`… Les chemins iCloud contiennent des espaces et sont sensibles
  à la casse.
- **`uid`** est l'identifiant IMAP d'un message *dans un dossier donné*. Un message qui change de
  dossier change d'UID : toujours re-lister après un `move_message`.
- Tous les outils renvoient du JSON dans un bloc de texte, sauf `get_attachment` (bloc `image` ou
  `resource`).
- Une erreur IMAP/SMTP remonte classifiée, avec un message explicite (voir
  [architecture.md](architecture.md#gestion-des-erreurs)).

---

## Lecture

### `list_folders`

Liste tous les dossiers IMAP du compte. Aucun paramètre.

À appeler en premier quand on ne connaît pas les noms exacts des dossiers, notamment pour trouver
l'archive et la corbeille via leur `specialUse`.

```jsonc
[
  {
    "path": "INBOX",
    "name": "INBOX",
    "delimiter": "/",
    "parentPath": "",
    "flags": ["\\HasNoChildren"],
    "subscribed": true
  },
  {
    "path": "Deleted Messages",
    "name": "Deleted Messages",
    "delimiter": "/",
    "parentPath": "",
    "specialUse": "\\Trash",   // rôle standard, indépendant du nom affiché
    "flags": ["\\HasNoChildren", "\\Trash"],
    "subscribed": true
  }
]
```

---

### `list_messages`

Liste les messages d'un dossier, **du plus récent au plus ancien**.

| Paramètre | Type | Défaut | Description |
|---|---|---|---|
| `folder` | string | `INBOX` | Dossier à lister |
| `unreadOnly` | boolean | — | Ne renvoyer que les messages non lus |
| `since` | string ISO 8601 | — | Messages reçus à partir de cette date (incluse) |
| `before` | string ISO 8601 | — | Messages reçus avant cette date (exclue) |
| `from` | string | — | Filtre sur l'expéditeur (correspondance partielle, côté serveur) |
| `limit` | number | `50` | Nombre max de messages (200 maximum) |

`since` et `before` acceptent une date seule (`2026-07-01`) ou un instant complet
(`2026-07-01T08:00:00Z`).

Le filtrage est fait par le serveur IMAP, pas en local : demander les non-lus d'un dossier de
50 000 messages reste rapide.

```jsonc
[
  {
    "uid": 10432,
    "subject": "Votre facture de juillet",
    "from": [{ "name": "Compta", "address": "compta@exemple.fr" }],
    "to": [{ "name": "Vous", "address": "vous@icloud.com" }],
    "date": "2026-07-14T09:30:00.000Z",   // toujours normalisée en UTC
    "seen": false,
    "flagged": false,
    "size": 24815
  }
]
```

Le corps des messages n'est pas chargé : c'est un résumé d'enveloppe, volontairement léger. Pour
lire un message, enchaîner sur `get_message` avec son `uid`.

---

### `search_messages`

Recherche IMAP native. Les critères fournis sont **combinés en ET**.

| Paramètre | Type | Défaut | Description |
|---|---|---|---|
| `folder` | string | `INBOX` | Dossier où chercher |
| `subject` | string | — | Sous-chaîne dans le sujet |
| `body` | string | — | Sous-chaîne dans le corps |
| `from` | string | — | Sous-chaîne dans l'expéditeur |
| `to` | string | — | Sous-chaîne dans le destinataire |
| `limit` | number | `50` | Nombre max de résultats (200 maximum) |

Retour identique à `list_messages`, trié du plus récent au plus ancien.

La recherche porte sur **un seul dossier à la fois** : il n'y a pas de recherche multi-dossiers en
IMAP standard. Pour chercher partout, itérer sur `list_folders`.

---

### `get_message`

Contenu complet d'un message.

| Paramètre | Type | Défaut | Description |
|---|---|---|---|
| `folder` | string | `INBOX` | Dossier contenant le message |
| `uid` | number | *(requis)* | UID IMAP du message |

```jsonc
{
  "uid": 10432,
  "subject": "Votre facture de juillet",
  "from": [{ "name": "Compta", "address": "compta@exemple.fr" }],
  "to": [{ "name": "Vous", "address": "vous@icloud.com" }],
  "cc": [],
  "date": "2026-07-14T09:30:00.000Z",
  "seen": true,
  "flagged": false,
  "size": 24815,
  "messageId": "<abc123@exemple.fr>",     // sert au threading des réponses
  "references": ["<message-precedent@exemple.fr>"],
  "text": "Bonjour,\n\nVeuillez trouver…",
  "html": "<html>…</html>",                // `false` si le message n'a pas de partie HTML
  "attachments": [
    { "index": 0, "filename": "facture.pdf", "contentType": "application/pdf", "size": 18234 }
  ]
}
```

**Le contenu binaire des pièces jointes n'est pas renvoyé ici**, seulement leurs métadonnées.
Chaque pièce jointe porte un `index` stable : le passer à [`get_attachment`](#get_attachment) pour
récupérer le binaire.

Lire un message le marque comme lu du côté iCloud uniquement si le serveur le décide : le dossier
est ouvert en lecture seule, donc en pratique le flag `\Seen` n'est pas posé. Utiliser
`flag_message` pour le faire explicitement.

---

### `get_attachment`

Contenu binaire d'**une** pièce jointe, ciblée par l'`index` renvoyé par `get_message`.

| Paramètre | Type | Défaut | Description |
|---|---|---|---|
| `folder` | string | `INBOX` | Dossier contenant le message |
| `uid` | number | *(requis)* | UID IMAP du message |
| `index` | number | *(requis)* | Index de la pièce jointe (tel que renvoyé par `get_message`) |

Le retour n'est pas du JSON mais un bloc de contenu MCP :

- une **image** → bloc `image` (`data` en base64 + `mimeType`) ;
- tout autre type → bloc `resource` (`blob` en base64 + `mimeType` + `uri`
  `mail://<dossier>/<uid>/attachments/<index>`).

Au-delà de `ATTACHMENT_MAX_BYTES` (5 Mo par défaut), l'outil **refuse** en indiquant la taille
réelle et la limite — jamais de troncature silencieuse d'un binaire.

---

## Écriture

### `send_message`

Envoie un nouveau message via le SMTP iCloud.

| Paramètre | Type | Défaut | Description |
|---|---|---|---|
| `to` | string[] | *(requis)* | Destinataires, au moins un |
| `cc` | string[] | — | Copie |
| `bcc` | string[] | — | Copie cachée |
| `subject` | string | *(requis)* | Sujet |
| `text` | string | — | Corps en texte brut |
| `html` | string | — | Corps en HTML |
| `attachments` | object[] | — | Pièces jointes : `{ filename, contentType?, contentBase64 }` |

`text` et/ou `html` : au moins l'un des deux est obligatoire. L'expéditeur est toujours
`ICLOUD_EMAIL` — il n'est pas paramétrable, iCloud refuserait l'envoi.

Le contenu de chaque pièce jointe est fourni encodé en **base64** dans `contentBase64`. Le cumul
est refusé au-delà de `ATTACHMENT_MAX_BYTES` (5 Mo par défaut).

```jsonc
{
  "messageId": "<f4c1…@icloud.com>",
  "accepted": ["destinataire@exemple.fr"],
  "rejected": [],                           // adresses refusées par le serveur
  "savedToSent": true                       // copie archivée dans « Sent Messages »
}
```

Une copie du message est archivée dans le dossier `\Sent` (repli `Sent Messages`), marquée lue.
Si cet APPEND échoue, l'envoi reste un **succès** et `savedToSent` vaut `false` — le mail est bien
parti, seule la copie manque.

Refuse avec une erreur explicite si `ENABLE_SENDING=false`.

---

### `reply_message`

Répond à un message existant, avec un threading correct.

| Paramètre | Type | Défaut | Description |
|---|---|---|---|
| `folder` | string | `INBOX` | Dossier du message d'origine |
| `uid` | number | *(requis)* | UID du message auquel répondre |
| `to` | string[] | expéditeur d'origine | Destinataires |
| `cc` | string[] | — | Copie ; l'emporte sur le `cc` déduit par `replyAll` |
| `bcc` | string[] | — | Copie cachée |
| `text` | string | — | Corps en texte brut |
| `html` | string | — | Corps en HTML |
| `replyAll` | boolean | `false` | Répondre aussi aux autres destinataires d'origine (en `cc`) |
| `attachments` | object[] | — | Pièces jointes : `{ filename, contentType?, contentBase64 }` |

Ce qui est déduit automatiquement du message d'origine :

- **le sujet** — préfixé `Re: `, sauf s'il l'est déjà (`RE:`, `re:` reconnus) ;
- **le destinataire** — l'expéditeur d'origine, si `to` n'est pas fourni ;
- **`In-Reply-To`** — le `Message-ID` du message d'origine ;
- **`References`** — la chaîne du message d'origine, complétée de son `Message-ID`, sans doublon.

Avec `replyAll`, `to` reçoit aussi les destinataires `To` d'origine et `cc` les `Cc` d'origine ;
l'adresse du compte est retirée des deux, avec dédoublonnage insensible à la casse. Un `cc`
explicite fourni par l'appelant remplace ce `cc` déduit.

C'est ce qui fait que la réponse s'affiche dans le bon fil chez le destinataire, et pas comme un
message isolé. Refuse si `ENABLE_SENDING=false`.

```jsonc
{
  "messageId": "<f4c1…@icloud.com>",
  "accepted": ["alice@exemple.fr"],
  "rejected": [],
  "savedToSent": true,                      // copie archivée dans « Sent Messages »
  "markedAnswered": true                    // message d'origine marqué \Answered
}
```

`savedToSent` et `markedAnswered` sont **non bloquants** : s'ils échouent, l'envoi reste un succès
et le champ vaut `false`.

---

### `forward_message`

Transfère un message existant à de nouveaux destinataires. Le message d'origine est joint
**verbatim** en `message/rfc822` (en-têtes et pièces jointes préservés), et non recopié en texte.

| Paramètre | Type | Défaut | Description |
|---|---|---|---|
| `folder` | string | `INBOX` | Dossier du message à transférer |
| `uid` | number | *(requis)* | UID du message à transférer |
| `to` | string[] | *(requis)* | Destinataires, au moins un |
| `cc` | string[] | — | Copie |
| `bcc` | string[] | — | Copie cachée |
| `text` | string | — | Note ajoutée en corps du message de transfert |
| `html` | string | — | Note en HTML |
| `attachments` | object[] | — | Pièces jointes **supplémentaires** : `{ filename, contentType?, contentBase64 }` |

Le sujet est préfixé `Fwd: ` de façon idempotente (`FWD:`, `fwd:` reconnus). Comme `send_message`,
une copie est archivée dans « Sent Messages » (`savedToSent`). Refuse si `ENABLE_SENDING=false`.

---

### `save_draft`

Compose un message et l'enregistre dans le dossier Drafts via `IMAP APPEND`, **sans rien envoyer**.

| Paramètre | Type | Défaut | Description |
|---|---|---|---|
| `to` | string[] | — | Requis, sauf si `replyFolder`/`replyUid` sont fournis |
| `cc` | string[] | — | Copie |
| `bcc` | string[] | — | Copie cachée |
| `subject` | string | — | Requis, sauf si `replyFolder`/`replyUid` sont fournis |
| `text` | string | — | Corps en texte brut |
| `html` | string | — | Corps en HTML |
| `replyFolder` | string | — | Dossier du message auquel ce brouillon répond |
| `replyUid` | number | — | UID de ce message |
| `attachments` | object[] | — | Pièces jointes : `{ filename, contentType?, contentBase64 }` |

`replyFolder` et `replyUid` vont toujours ensemble. Fournis, ils appliquent au brouillon exactement
le même threading que `reply_message` : le brouillon envoyé plus tard depuis Mail.app atterrira
dans le bon fil.

**`save_draft` n'est jamais bloqué par `ENABLE_SENDING`** : il n'utilise que l'IMAP, jamais le SMTP.
C'est le mode de travail recommandé — Claude prépare, vous relisez et envoyez depuis votre client
mail habituel.

```jsonc
{ "folder": "Drafts", "uid": 87 }
```

---

## Organisation

### `move_message`

| Paramètre | Type | Défaut | Description |
|---|---|---|---|
| `folder` | string | *(requis)* | Dossier source |
| `uid` | number | *(requis)* | UID dans le dossier source |
| `destination` | string | *(requis)* | Dossier de destination |

```jsonc
{ "uid": 10432, "from": "INBOX", "to": "Archive", "newUid": 553 }
```

`newUid` est l'UID du message dans son nouveau dossier, quand le serveur le communique
(`UIDPLUS`). L'ancien UID n'est plus valable.

---

### `delete_message`

| Paramètre | Type | Défaut | Description |
|---|---|---|---|
| `folder` | string | *(requis)* | Dossier contenant le message |
| `uid` | number | *(requis)* | UID du message |

Suit la convention iCloud, en deux temps :

1. si le message **n'est pas** dans la corbeille, il y est déplacé — récupérable ;
2. s'il **y est déjà**, il est marqué `\Deleted` puis expurgé — **définitif**.

La corbeille est trouvée par son flag `\Trash`, pas par son nom : le code fonctionne quelle que
soit la langue du compte.

```jsonc
{ "uid": 10432, "folder": "INBOX", "action": "moved_to_trash", "destination": "Deleted Messages" }
{ "uid": 553, "folder": "Deleted Messages", "action": "expunged" }
```

---

### `flag_message`

| Paramètre | Type | Défaut | Description |
|---|---|---|---|
| `folder` | string | `INBOX` | Dossier contenant le message |
| `uid` | number | *(requis)* | UID du message |
| `actions` | string[] | *(requis)* | Une ou plusieurs parmi `read`, `unread`, `flagged`, `unflagged`, `answered`, `unanswered`, `junk`, `not_junk` |
| `keywords` | string[] | — | Mots-clés IMAP arbitraires à ajouter (en plus des `actions`) |

Les actions sont combinables : `["read", "flagged"]` marque lu **et** favori en un seul appel.
Les ajouts de flags sont appliqués avant les retraits, quel que soit l'ordre de la liste : passer
`["read", "unread"]` laisse donc le message **non lu**.

`answered` pose `\Answered`, `junk` / `not_junk` posent les mots-clés `$Junk` / `$NotJunk` (et
retirent l'opposé). `keywords` permet d'ajouter n'importe quel mot-clé IMAP supporté par le serveur.

```jsonc
{ "uid": 10432, "folder": "INBOX", "applied": ["read", "flagged"], "keywords": ["$Label1"] }
```
