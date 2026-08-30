import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listFolders } from '../../imap/folders.js';
import { listResult } from '../result.js';
import { listFoldersResultSchema } from '../schemas.js';
import { logger } from '../../logger.js';

const log = logger.child({ tool: 'list_folders' });

export function registerListFoldersTool(server: McpServer): void {
  server.registerTool(
    'list_folders',
    {
      title: 'List mail folders',
      description:
        'Lists all IMAP folders in the iCloud Mail account (INBOX, Sent, Archive, Trash, and any custom ' +
        'folders). With includeStatus (default true), each folder also carries "messages" and "unseen" ' +
        'counts — one extra IMAP STATUS command per folder. Set includeStatus=false for a fast listing.',
      inputSchema: {
        includeStatus: z
          .boolean()
          .default(true)
          .describe('Include per-folder message/unseen counts (one STATUS command per folder)'),
        envelope: z
          .boolean()
          .default(false)
          .describe('Wrap the text block as { folders } instead of a bare array'),
      },
      outputSchema: listFoldersResultSchema.shape,
    },
    async ({ includeStatus, envelope }) => {
      log.info({ includeStatus }, 'listing folders');
      const folders = await listFolders(includeStatus);
      return listResult('folders', folders, { envelope });
    },
  );
}
