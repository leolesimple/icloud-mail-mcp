# Suivi de l'audit sécurité et performance

Cette passe est basée sur `main` 0.2.3, commit `16fa63ca621774647df281b1f93abe9eef814440`. Les corrections restent non committées dans le worktree `hardening/security-performance`. Aucun déploiement ni changement de visibilité GitHub n'a été effectué.

## Corrections

- Configuration booléenne stricte, envoi désactivé et brouillon par défaut.
- Confirmation des envois et suppressions irréversibles, liaison aux paramètres, contenus et état IMAP ; refus si la corbeille n'existe pas.
- Réservation atomique du quota SMTP, absence de retry après une issue ambiguë, archivage unique et prévention des renvois de brouillons.
- Conservation des Cci dans les brouillons et retrait des en-têtes Cci à l'envoi.
- Lectures MIME plafonnées avant et pendant téléchargement, pièces jointes par partie IMAP, liens générés sans téléchargement préalable, budget de lots progressif et résolution DNS sous deadline.
- Validation Host/Origin, proxies explicitement configurés, limites des sessions/requêtes/files d'attente/uploads ; réservation du budget mémoire des uploads.
- Logs sans liens signés, redaction des secrets usuels, environnement de tests synthétique ; fichiers secrets exclus de Git.
- Actions GitHub épinglées, permissions réduites, clés d'hôte SSH préconfigurées et déploiement explicitement appelé après publication de l'image.
- Documentation et politique de signalement synchronisées avec les protections effectives ; licence existante conservée.
- Nodemailer mis à jour de 10.0.13 à 10.0.14, à partir du cache npm local.

## Vérification et limites

La compilation, le contrôle des types et ESLint passent. 710 tests unitaires passent, sans échec ni skip, sans compte réel ni connexion IMAP/SMTP. La suite HTTP nécessitant des sockets ne peut pas tourner ici : le sandbox refuse `listen` avec `EPERM`. Les tests du middleware Host/Origin, des budgets, confirmations et transports simulés s'exécutent sans socket. La CI doit effectuer la suite complète et le build Docker dans un environnement autorisant les sockets.

Le registre npm n'est pas accessible depuis le shell de ce sandbox. Le contrôle actuel des avis de sécurité et la mise à jour complète des dépendances restent donc à valider via `npm audit --omit=dev` et une installation fraîche en CI. Les versions SDK 1.32.1 et Mailparser 3.9.33 identifiées dans les sources officielles ne sont pas installables depuis le cache disponible ; leurs mises à jour ne sont pas prétendues effectuées. Sources : [releases SDK](https://github.com/modelcontextprotocol/typescript-sdk/releases), [versions Mailparser](https://www.npmjs.com/package/mailparser?activeTab=versions).

La configuration réelle du proxy, le secret `DEPLOY_KNOWN_HOSTS`, les droits de release et le déploiement doivent être vérifiés avant mise en service. Les quotas en mémoire ne coordonnent pas plusieurs processus ; persister le quota évite sa remise à zéro normale au redémarrage, sans fournir de verrou interprocessus. Une issue SMTP incertaine demande une vérification manuelle de la boîte avant toute nouvelle tentative.

Un jeton de confirmation utilisé par un client sans formulaire ne prouve pas à lui seul qu'un humain a confirmé : le client doit demander cet accord. Les plafonds mémoire réduisent l'exposition mais ne garantissent pas une consommation RSS exacte lors du parsing MIME.

## Avis sur la publication publique

La publication devient raisonnable après une CI entièrement verte, un scan spécialisé de tout l'historique, le contrôle des avis npm et une vérification des réglages GitHub/proxy. Aucun de ces contrôles dépendant d'un environnement externe n'est annoncé comme exécuté ici. Rendre le dépôt public ne change pas la licence : la licence actuelle reste une licence propriétaire/source disponible, pas une licence open source permissive.

## Derniere verification externe

GitHub confirme que le depot est deja public. Le ruleset Protect main est actif : pull request obligatoire, refus de suppression et de force-push, historique lineaire et controle Typecheck/lint/tests requis. Le build Docker et le scan de secrets ne sont pas encore des checks obligatoires ; les deploy keys et administrateurs disposent de bypass. Ces reglages ne peuvent pas etre modifies par le connecteur disponible. Le signalement prive reste a verifier/activer dans les reglages GitHub.

Une nouvelle tentative npm echoue sur DNS ENOTFOUND. Le daemon Docker est absent. Le script `scripts/verify-security.sh` prepare les validations restantes dans un environnement disposant du reseau, des sockets, de Docker et de Gitleaks. Il ne cree aucun commit. Mettre d'abord a jour les deux dependances avec `npm install @modelcontextprotocol/sdk@1.32.1 mailparser@3.9.33 --ignore-scripts`, puis executer `bash scripts/verify-security.sh`.

## Validation finale apres ouverture des permissions

Les blocages reseau et sockets ci-dessus ont ete leves pour les commandes de verification. SDK 1.32.1 et Mailparser 3.9.33 sont installes. Les cinq alertes de production detectees ont ete corrigees par mises a jour compatibles : npm audit --omit=dev retourne zero vulnerabilite.

745 tests passent, sans echec ni skip, HTTP compris. Typecheck, lint et build passent. L assertion HTTP de plafond upload a ete alignee sur le message generique volontaire du serveur. Gitleaks 8.30.1, archive officielle verifiee SHA256, ne detecte aucune fuite sur les historiques du worktree et du depot original, ni sur les repertoires modifies. Les onze alertes initiales correspondaient a des valeurs synthetiques ; .gitleaks.toml n exclut que ces valeurs exactes dans les tests nommes, pas les fichiers entiers.

Docker a demarre, la construction, le smoke test de l artefact et le test HTTP health/auth dans un conteneur sans reseau externe passent. Installation Docker avec ignore-scripts alignee sur la CI. Aucun commit, push ou deploiement.

L audit incluant les outils de developpement conserve 15 alertes (13 hautes, 2 moderees), dans la chaine semantic-release/npm. Elles ne sont pas presentes dans les dependances de production de l image. npm audit fix --force propose notamment des retrogradations incompatibles ; elles n ont pas ete appliquees. Ces alertes necessitent une remediation distincte de la chaine de release et restent un point ouvert. GitHub, configuration reelle du proxy et licence restent a la charge de l utilisateur, selon son instruction.

## Correction des alertes de developpement

Le backport de braces 3.0.3-pn.3 est epingle apres comparaison du code et tests de garde de profondeur et de compatibilite des globs. Le plugin npm inutilise pour publication est remplace par un workspace local ne mettant a jour que la version ; semantic-release et les autres hooks restent en place. Aucun avis nest masque par une exclusion npm audit. La CI controle maintenant aussi les dependances de developpement. Node minimum 24.15 pour correspondre aux outils de release existants.

### Resultat de cette correction

Installation fraiche npm ci verifiee, puis npm audit complet : zero vulnerabilite, developpement compris. Les 750 tests passent, ainsi que typecheck, lint et build. La reconstruction de l image Docker et son smoke test passent. Le hook local preserve les regles feat=>patch et breaking=>minor ; il est teste sans commit ni publication. La chaine npm de publication a ete retiree du graphe, pas simplement masquee au scanner. Les anciennes alertes et anciens blocages mentionnes plus haut constituent l historique de ce chantier et sont supersedes par ces controles.
