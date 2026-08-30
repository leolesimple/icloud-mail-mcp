import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { manageFolder } from '../../imap/folders.js';
import { jsonResult, errorResult } from '../result.js';
import { logger } from '../../logger.js';

const log = logger.child({ tool: 'manage_folder' });

export function registerManageFolderTool(server: McpServer): void {
  server.registerTool(
    'manage_folder',
    {
      title: 'Manage folder',
      description:
        'Creates, renames, or deletes an IMAP folder. Renaming or deleting a system folder (INBOX, Sent, ' +
        'Trash, Drafts, Archive, Junk) is refused: deleting an IMAP folder is irreversible and takes its ' +
        'contents with it. "newPath" is required for rename.',
      inputSchema: {
        action: z.enum(['create', 'rename', 'delete']),
        path: z.string().min(1).describe('Folder path to act on'),
        newPath: z.string().min(1).optional().describe('Target path (required for rename)'),
      },
    },
    async ({ action, path, newPath }) => {
      if (action === 'rename' && !newPath) {
        return errorResult('Le renommage exige un chemin cible ("newPath").');
      }
      log.info({ action, path, newPath }, 'managing folder');
      return jsonResult(await manageFolder(action, path, newPath));
    },
  );
}
