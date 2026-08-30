import { listFolders } from '../imap/folders.js';
import { imapPool } from '../imap/pool.js';

// Petit script de vérification manuelle : se connecte à iCloud et affiche les
// dossiers IMAP trouvés. Pas de MCP ici, juste pour valider la connexion et
// list_folders avant de brancher le reste.

async function main(): Promise<void> {
  console.log('Connexion à iCloud IMAP et récupération des dossiers…\n');
  const folders = await listFolders();

  console.log(`${folders.length} dossier(s) trouvé(s) :\n`);
  for (const folder of folders) {
    const specialUse = folder.specialUse ? ` [${folder.specialUse}]` : '';
    console.log(`- ${folder.path}${specialUse}`);
  }
}

main()
  .catch((err) => {
    console.error('\nÉchec de la vérification :', err.message);
    process.exitCode = 1;
  })
  .finally(() => {
    void imapPool.close();
  });
