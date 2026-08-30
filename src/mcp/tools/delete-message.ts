import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { deleteMessage } from '../../imap/mutations.js';
import { jsonResult } from '../result.js';
import { logger } from '../../logger.js';

const log = logger.child({ tool: 'delete_message' });

export function registerDeleteMessageTool(server: McpServer): void {
  server.registerTool(
    'delete_message',
    {
      title: 'Delete message',
      description:
        'Deletes a message, following iCloud convention: moves it to the Trash folder, or permanently ' +
        'expunges it (flag \\Deleted + EXPUNGE) if it is already in Trash.',
      inputSchema: {
        folder: z.string().min(1),
        uid: z.coerce.number().int().positive(),
      },
    },
    async ({ folder, uid }) => {
      log.info({ folder, uid }, 'deleting message');
      const result = await deleteMessage(folder, uid);
      return jsonResult(result);
    },
  );
}
