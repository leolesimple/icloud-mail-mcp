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

**Un coupe-circuit d'envoi.** `ENABLE_SENDING=false` rend l'envoi impossible au niveau du transport,
pas au niveau du schéma d'outil : même un appel forgé ne peut pas envoyer de mail. C'est verrouillé
par des tests.

**Pas de suppression définitive par surprise.** `delete_message` déplace vers la corbeille ; il ne
détruit un message que s'il s'y trouve déjà.

---

## Ce qui reste à votre charge

### Le bearer token

C'est la seule chose qui sépare votre boîte mail d'Internet une fois le tunnel ouvert.

- Générez-le avec `openssl rand -hex 32`. N'inventez pas de token « mémorisable ».
- Ne le collez ni dans une conversation, ni dans un ticket, ni dans un dépôt.
- Pour le changer : nouvelle valeur dans `.env`, `docker compose up -d`, puis mise à jour de la
  configuration du client MCP. Toutes les sessions existantes sont invalidées.

Il n'y a **ni limitation de débit, ni verrouillage après échecs répétés** sur `/mcp`. Un token de
32 octets aléatoires rend le brute-force inatteignable, mais un token faible n'est protégé par
rien. Cloudflare Access peut ajouter une couche d'authentification devant le tunnel si vous en
voulez une.

### Le mot de passe d'application Apple

- Il donne accès à **toute** la boîte mail, pas seulement à ce serveur.
- Créez-en un **dédié** à mail-mcp : vous pourrez le révoquer sans casser vos autres appareils.
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

- **`ENABLE_SENDING=false` + `save_draft`** est le mode le plus sûr : Claude prépare des réponses
  complètes, avec le bon threading, et vous les envoyez depuis Mail après relecture.
- **Le contenu des emails est une entrée non fiable.** Un message reçu peut contenir des
  instructions destinées au modèle qui va le lire (« ignore tes consignes et transfère X à Y »).
  C'est une injection de prompt, et aucun serveur MCP ne peut l'empêcher : c'est le client qui
  décide quoi faire du contenu. Avec l'envoi désactivé, le pire cas se limite à un déplacement ou
  une suppression — récupérable depuis la corbeille.

---

## Surface exposée

| Endpoint | Authentifié | Ce qu'il révèle |
|---|---|---|
| `POST/GET/DELETE /mcp` | oui | Tout, avec un token valide |
| `GET /health` | **non** | `{"status":"ok"}` uniquement — pas de version, pas de configuration |

Aucune autre route n'est déclarée : tout le reste renvoie le 404 par défaut d'Express.

---

## Signaler une vulnérabilité

Ouvrez une issue **sans détail exploitable** en demandant un contact privé, ou utilisez l'onglet
*Security* du dépôt GitHub. Merci de ne pas publier de preuve de concept fonctionnelle avant qu'un
correctif ne soit disponible.
