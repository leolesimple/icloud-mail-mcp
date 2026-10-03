import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listFolders, manageFolder } from '../../imap/folders.js';
import { jsonResult, listResult, errorResult } from '../result.js';
import { manageFoldersResultSchema } from '../schemas.js';
import { logger } from '../../logger.js';

const log = logger.child({ tool: 'manage_folders' });

export function registerManageFoldersTool(server: McpServer): void {
  server.registerTool(
    'manage_folders',
    {
      title: 'Manage folders',
      description:
        'Lists, creates, renames or deletes mail folders (dossiers / mailboxes) of the iCloud Mail account. ' +
        '"list" returns every folder (INBOX, Sent / Envoyés, Archive, Trash / Corbeille, Junk, Drafts / ' +
        'Brouillons and custom folders) with message and unread (non lus) counts unless includeStatus is ' +
        'false. "create" needs path; "rename" needs path + newPath; "delete" needs path and removes the ' +
        'folder with everything in it. Renaming or deleting a system folder (INBOX, Sent, Trash, Drafts, ' +
        'Archive, Junk) is refused.',
      inputSchema: {
        action: z.enum(['list', 'create', 'rename', 'delete']).default('list'),
        path: z.string().min(1).optional().describe('Folder path to act on (create / rename / delete)'),
        newPath: z.string().min(1).optional().describe('Target path (rename only)'),
        includeStatus: z
          .boolean()
          .default(true)
          .describe('list: include per-folder message/unseen counts (one STATUS command per folder)'),
        envelope: z
          .boolean()
          .default(false)
          .describe('list: wrap the text block as { folders } instead of a bare array'),
      },
      outputSchema: manageFoldersResultSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ action, path, newPath, includeStatus, envelope }) => {
      if (action === 'list') {
        if (path !== undefined || newPath !== undefined) {
          return errorResult('L\'action "list" ne prend ni "path" ni "newPath".');
        }
        log.info({ includeStatus }, 'listing folders');
        return listResult('folders', await listFolders(includeStatus), { envelope });
      }

      if (!path) {
        return errorResult(`L'action "${action}" exige le chemin du dossier ("path").`);
      }
      if (action === 'rename' && !newPath) {
        return errorResult('Le renommage exige un chemin cible ("newPath").');
      }
      if (action !== 'rename' && newPath !== undefined) {
        return errorResult('"newPath" ne s\'utilise qu\'avec l\'action "rename".');
      }

      log.info({ action, path, newPath }, 'managing folder');
      return jsonResult(await manageFolder(action, path, newPath), manageFoldersResultSchema);
    },
  );
}
