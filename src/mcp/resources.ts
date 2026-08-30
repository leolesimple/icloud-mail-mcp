import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listFolders } from '../imap/folders.js';
import { getMessage } from '../imap/messages.js';
import { completeFolder } from './folder-cache.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'resources' });

/**
 * Resources MCP en lecture seule :
 *   - `mail://folders`                              → la liste des dossiers ;
 *   - `mail://folder/{path}/message/{uid}`          → un message complet.
 *
 * Elles doublent `list_folders` / `get_message` pour les clients qui préfèrent
 * référencer une ressource (mention @, pièce jointe de contexte) plutôt que
 * d'appeler un outil.
 */
export function registerMailResources(server: McpServer): void {
  server.registerResource(
    'folders',
    'mail://folders',
    {
      title: 'Dossiers IMAP',
      description: 'La liste des dossiers du compte iCloud Mail (chemin, rôle spécial, abonnement).',
      mimeType: 'application/json',
    },
    async (uri) => {
      log.info('reading folders resource');
      const folders = await listFolders();
      return {
        contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(folders, null, 2) }],
      };
    },
  );

  server.registerResource(
    'message',
    new ResourceTemplate('mail://folder/{+path}/message/{uid}', {
      list: undefined,
      complete: {
        path: (value) => completeFolder(value),
      },
    }),
    {
      title: 'Message',
      description: 'Un message complet, désigné par le chemin de son dossier et son UID IMAP.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const path = decodeURIComponent(String(variables.path));
      const uid = Number(variables.uid);
      if (!Number.isInteger(uid) || uid <= 0) {
        throw new Error(`UID invalide dans l'URI de ressource : ${String(variables.uid)}`);
      }
      log.info({ path, uid }, 'reading message resource');
      const message = await getMessage(path, uid);
      return {
        contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(message, null, 2) }],
      };
    },
  );
}
