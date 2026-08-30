import { account } from '../account.js';
import { verifyImap } from '../imap/verify.js';

// Petit script de vérification manuelle : se connecte à iCloud et affiche les
// dossiers IMAP trouvés. Pas de MCP ici, juste pour valider la connexion et
// les identifiants avant de brancher le reste. Réutilise `verifyImap`, la même
// logique que `npm run auth` et `whoami --probe`.

async function main(): Promise<void> {
  console.log('Connexion à iCloud IMAP et récupération des dossiers…\n');
  const { folderCount, folders } = await verifyImap({
    email: account.email,
    password: account.password,
    host: account.imap.host,
    port: account.imap.port,
  });

  console.log(`Connexion OK — ${folderCount} dossier(s) trouvé(s) :\n`);
  for (const path of folders) {
    console.log(`- ${path}`);
  }
}

main().catch((err: unknown) => {
  console.error('\nÉchec de la vérification :', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
