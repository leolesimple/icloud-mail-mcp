# ADR 0001 · Passer d'un MCP iCloud à un MCP mail générique

- **Statut :** accepté (2026-11-05)
- **Jalons :** milestones « v2.0.0 » du dépôt

## Contexte

Le serveur est écrit pour iCloud Mail (hôtes, variables `ICLOUD_*`, dossiers, instructions). Il a été
validé en test sur un autre serveur IMAP/SMTP (IMAP 993 en TLS implicite, SMTP 587 en STARTTLS,
dossiers spéciaux annoncés par flags). Les seuls blocages étaient la configuration et le CLI `auth`.

## Décision

1. **1.0.0 d'abord**, sur le code iCloud tel quel, sans nouvelle fonctionnalité.
2. **Branche `1.x`** créée depuis `v1.0.0` : correctifs et sécurité uniquement.
3. **Branche `next`** pour la v2 (prereleases `2.0.0-next.N`) ; `main` reste stable.
4. **MCP générique** : au démarrage, le serveur interroge l'IMAP (CAPABILITY, ID, hôte) et construit un
   *profil serveur*. Les outils sont enregistrés **de façon conditionnelle** selon ce profil, sur le
   modèle de `idleWatch`. Le socle (lecture, recherche, envoi) est toujours présent.
5. **Configuration** `MAIL_*`, TLS configurable (`IMAP_SECURE`, `SMTP_SECURE`), `MAIL_LOGIN` optionnel.
6. **Même dépôt**, pas de fork. Le dépôt est **renommé à la sortie de 2.0.0**, pas avant.
7. **Rupture assumée en 2.0.0** : un pied `BREAKING CHANGE:` est requis (avec le preset angular,
   `feat!:` seul ne déclenche pas de majeure).

## Questions ouvertes

- Serveur injoignable au démarrage : socle seul ou échec franc ? (#89)
- Alias `ICLOUD_*` avec avertissement ou rupture nette ? (#84)

## Conséquences

- Deux lignes à maintenir pendant la transition (`1.x` et `next`).
- Un guide de migration est obligatoire (#93).
- Les tests doivent simuler plusieurs profils de serveur sans réseau (#91).
