import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listFolders } from '../../imap/folders.js';
import { jsonResult } from '../result.js';
import { logger } from '../../logger.js';

const log = logger.child({ tool: 'list_folders' });

export function registerListFoldersTool(server: McpServer): void {
  server.registerTool(
    'list_folders',
    {
      title: 'List mail folders',
      description:
        'Lists all IMAP folders in the iCloud Mail account (INBOX, Sent, Archive, Trash, and any custom folders).',
    },
    async () => {
      log.info('listing folders');
      const folders = await listFolders();
      return jsonResult(folders);
    },
  );
}
