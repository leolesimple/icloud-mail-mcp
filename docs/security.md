# Sécurité

Le serveur manipule une boîte réelle avec les droits du mot de passe d’application Apple : lecture,
déplacement, suppression et SMTP. Il vise un compte et une instance de confiance. Un bearer token
compromis donne accès aux outils ; les confirmations par jeton ne constituent pas une seconde
identité. Le contenu des emails et des pièces jointes est une entrée non fiable pour le modèle.

## Données et tiers

L’instance est auto-hébergée, mais les messages renvoyés transitent vers le client MCP et peuvent
être traités par son fournisseur IA. Avec Cloudflare Tunnel, Cloudflare relaie le trafic HTTPS ;
iCloud héberge les messages. Les liens de téléchargement contiennent un secret temporaire :
les traiter comme des credentials, y compris dans les historiques et logs de proxies.

## Authentification et exposition HTTP

[`auth.ts`](../src/http/auth.ts) impose `Authorization: Bearer <token>` ou
`X-Api-Key: <token>` sur `/mcp`, avec comparaison en temps constant. Générer un token aléatoire
avec `openssl rand -hex 32`. Le passer en en-tête, jamais dans l’URL. `/health` reste public et
n’affiche que statut et version. Les liens signés authentifient les routes download/upload.

`HTTP_HOST` vaut `127.0.0.1` hors Docker. Le compose fixe `0.0.0.0` dans le réseau interne sans
publier le port en production. Le compose de développement publie sur le loopback de l’hôte.

Host et Origin sont validés : `HTTP_ALLOWED_HOSTS` autorise les hôtes locaux par défaut et le
hostname de `PUBLIC_BASE_URL` ; `HTTP_ALLOWED_ORIGINS` ajoute son origine et peut autoriser des
origines exactes supplémentaires. Les clients natifs sans en-tête Origin restent acceptés.

Le rate limit est appliqué avant l’authentification et reste actif avec `UNRESTRICTED=true`.
L’adresse vient de la socket ou de `X-Forwarded-For` via les seuls proxies déclarés dans
`TRUSTED_PROXIES`. `CF-Connecting-IP` est ignoré. Ne déclarer que les IP/CIDR de proxies dont vous
contrôlez le nettoyage des en-têtes. Sans cette configuration, plusieurs clients derrière le tunnel
partagent le budget de son adresse socket : c’est un choix de sécurité, pas un contournement.

`HTTP_MAX_CONCURRENT_REQUESTS`, `HTTP_BODY_MAX_BYTES`, `MAX_SESSIONS` et `SESSION_TTL_MS` bornent
les requêtes actives, JSON entrants, sessions et leur inactivité. La file du pool IMAP est limitée
par `IMAP_MAX_WAITERS` et son temps d’attente par `IMAP_ACQUIRE_TIMEOUT_MS`.

## Les garde-fous d’envoi

L’envoi est désactivé par défaut (`ENABLE_SENDING=false`) et `compose_message` prépare un
brouillon (`deliver: "draft"`) sans SMTP. Une demande `deliver: "send"` est explicite.

| Protection             | Effet                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `ENABLE_SENDING=false` | Bloque la transmission SMTP ; la préparation explicite de brouillons reste possible. |
| `DRAFTS_ONLY=true`     | Convertit les demandes d’envoi en brouillon.                                         |
| `ALLOWED_RECIPIENTS`   | Refuse tout destinataire to/cc/bcc hors liste d’adresses ou domaines exacts.         |
| `MAX_SENDS_PER_DAY`    | Réservation atomique avant SMTP : les appels simultanés ne dépassent pas la limite.  |
| Confirmation           | Premier appel sans effet, ou formulaire d’elicitation selon le client.               |

Les garde-fous SMTP sont également appliqués au niveau du transport
([`client.ts`](../src/smtp/client.ts)). `UNRESTRICTED=true` contourne les interrupteurs d’envoi,
la liste de destinataires et le quota ; il ne contourne pas les confirmations, l’authentification,
Host/Origin, le débit HTTP ni les limites de ressources. L’activer donne donc un pouvoir SMTP
très large. Les booléens vides ou inconnus sont refusés au démarrage.

Un quota est local à une instance. Sa persistance via `QUOTA_STATE_PATH` survit aux redémarrages,
mais ne fournit pas de coordination entre processus. Un refus SMTP explicite libère la place ; un
envoi accepté ou incertain la conserve. Le quota limite la quantité, pas la sensibilité des données.

## Confirmation des opérations destructives

Les outils actuels et leurs équivalents historiques demandent une confirmation avant envoi,
action `trash` et suppression de dossier. Le premier appel n’exécute pas l’opération.

- Si le client supporte l’elicitation par formulaire, une acceptation explicite `confirm: true`
  autorise l’opération. Refus et annulation n’entraînent aucune mutation.
- Sinon, le serveur renvoie `confirmation_required` avec un jeton. Le client répète le même appel
  avec ce jeton ; changer les paramètres invalide la confirmation.

Le mécanisme ([`confirm.ts`](../src/confirm.ts), [`confirm-flow.ts`](../src/mcp/confirm-flow.ts))
lie les paramètres, les octets résolus des pièces jointes et, pour les opérations concernées,
UIDVALIDITY et l’empreinte de la source. Le HMAC expire après deux minutes et ne sert qu’une fois.
L’exécution doit encore respecter les garde-fous d’envoi et les permissions IMAP.

**Limites :** un jeton prouve un aller-retour technique, pas un consentement humain : un modèle
peut le retransmettre seul. L’elicitation dépend du comportement du client. Avec un
`CONFIRM_SECRET` fixe, l’état des jetons consommés étant en mémoire, un redémarrage peut permettre
un rejeu dans la fenêtre d’expiration. Sans secret fixe, les anciens jetons deviennent invalides.

L’action `trash` déplace vers le dossier `\Trash`, après confirmation. Si le message s’y trouve
déjà, elle supprime définitivement après confirmation. Si aucune corbeille n’est trouvée, elle
refuse : aucun fallback vers EXPUNGE. La suppression d’un dossier personnel peut détruire tout
son contenu ; les dossiers système sont protégés. Toutes les suppressions ne sont donc pas
récupérables.

## Envois incertains et brouillons

Une rupture SMTP ne permet pas toujours de savoir si le serveur a accepté le message. Le transport
n’effectue aucun retry automatique d’envoi. Vérifier Envoyés et, si nécessaire, le destinataire avant
de décider d’une nouvelle tentative ; le statut incertain conserve sa réservation de quota.

`send_draft` pose un marqueur IMAP `$McpDeliveryStarted` avant SMTP. Un brouillon marqué n’est pas
renvoyé automatiquement après un crash, une issue incertaine ou un échec de nettoyage. Seul un
opérateur ayant vérifié l’issue peut retirer le marqueur ou préparer un nouveau brouillon.

Après succès SMTP, une seule copie est ajoutée dans Envoyés avec la connexion IMAP déjà détenue.
Un échec d’archivage ou de nettoyage ne transforme pas l’envoi réussi en échec SMTP. Si l’archivage
échoue, le brouillon original marqué reste disponible (`copiedToSent: false`,
`draftDeleted: false`). Si le nettoyage échoue après archivage, il reste également marqué.

Les Cci sont conservés dans le brouillon local pour pouvoir reconstruire l’enveloppe SMTP. Ils
sont retirés des en-têtes transmis et de la copie dans Envoyés ; les destinataires Cci restent dans
l’enveloppe. La boîte et ses brouillons peuvent donc contenir cette information sensible.

## Limites de taille et mémoire

`MAX_MESSAGE_BYTES` (25 Mio) borne la source MIME entière lue, sur la taille annoncée puis pendant
le téléchargement. `read_message` utilise encore un parsing complet borné ; l’expansion des images
CID en data URLs est désactivée. `MAX_BODY_CHARS` borne les entrées de composition et le corps
retourné par défaut ; les resources renvoient également un corps préparé et tronqué. Les en-têtes
bruts sont téléchargés séparément et sous plafond.

Les pièces jointes par index sont résolues via BODYSTRUCTURE puis téléchargées par partie, comme
celles par numéro IMAP. `ATTACHMENT_MAX_BYTES` borne les flux et les contenus inline cumulés.
Les lots sont traités progressivement et les futurs éléments ne sont pas téléchargés une fois
le budget inline épuisé. Le base64 entrant est contrôlé avant allocation des buffers décodés.

Ces bornes limitent les contenus, pas l’empreinte exacte du processus : buffers de flux, parsing,
chaînes base64 et réponses JSON ont un surcoût. Le défaut de concurrence HTTP est 4 ; Docker borne aussi mémoire et nombre de processus. Augmenter la concurrence ou `MAX_MESSAGE_BYTES` nécessite de dimensionner la mémoire du conteneur et de mesurer les allocations réelles.

## Liens de téléchargement

Les outils `get_attachment`, `get_attachments` et `export_message` en format `url` émettent un lien
HMAC valable quinze minutes et utilisable une fois. La cible est un message ou une pièce jointe,
jamais un chemin local arbitraire. Les octets ne sont lus qu’à l’ouverture du lien ; la taille
initiale des pièces jointes est une estimation encodée BODYSTRUCTURE, et le plafond réel reste
vérifié au téléchargement.

`GET /download/:token` sert en pièce jointe avec `nosniff`, `no-store`, `no-referrer` et une CSP
restrictive. `HEAD` ne consomme pas le jeton et est refusé. Ne pas partager ces URLs. Les logs
applicatifs ne consignent pas leur paramètre signé ; les logs d’un proxy externe doivent être
configurés séparément. Un secret fixe conserve la validité après redémarrage, mais l’état des liens
consommés est en mémoire : un rejeu peut alors redevenir possible jusqu’à expiration.

## Dépôt de fichiers

`create_upload_link` produit un lien signé de dépôt ; `POST /upload/:token` attend les octets bruts,
pas du multipart. `ATTACHMENT_MAX_BYTES` borne chaque flux, `UPLOAD_TIMEOUT_MS` son délai.
`UPLOAD_MAX_FILES` et `UPLOAD_MAX_TOTAL_BYTES` comptent la capacité réservée par les uploads en
cours et les dépôts stockés. Une saturation est refusée avant de laisser plusieurs flux dépasser
ensemble le plafond.

Les fichiers résident en mémoire pendant une heure, jusqu’à expiration ou consommation après
l’opération réussie qui les utilise. Ils disparaissent au redémarrage. Les liens de dépôt sont des
credentials temporaires au même titre que ceux de téléchargement.

## Pièces jointes par URL (SSRF)

[`ssrf.ts`](../src/ssrf.ts) impose HTTPS, bloque credentials intégrés et destinations non publiques,
vérifie toutes les adresses DNS, épingle l’adresse de connexion tout en vérifiant le certificat
pour le hostname, et contrôle chaque redirection. Le délai global couvre aussi la résolution DNS,
même si elle ne termine pas. Les flux sont coupés au plafond restant de pièces jointes.

Cette protection réduit SSRF et l’allocation mémoire ; elle ne garantit pas qu’un fichier public
est sûr, ni qu’un domaine autorisé sera toujours digne de confiance. Un proxy sortant n’est pas
pris en charge par cette lecture directe HTTPS.

## Secrets et conteneur

`.env` et ses variantes locales sont exclus de Git et du contexte Docker, avec `.env.example`
comme exemple sans credentials. Vérifier les exclusions avant publication, y compris l’historique.
Ne pas afficher les secrets dans des rapports ou traces. Le mot de passe Apple doit être dédié à
cette instance et peut être révoqué dans les réglages du compte Apple.

Le conteneur tourne non-root, avec filesystem racine en lecture seule, tmpfs temporaire,
capabilities retirées, `no-new-privileges` et limites de mémoire/processus. Le volume de quota reste
inscriptible. Ces mesures ne remplacent pas les permissions et mises à jour de l’hôte.

## Signalement de vulnérabilités

Voir [SECURITY.md](../SECURITY.md). Ne publier ni exploit complet avec credentials ni contenu réel
de boîte mail dans une issue publique. La licence existante reste une licence de code consultable,
pas une licence open source.
