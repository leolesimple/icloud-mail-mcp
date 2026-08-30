import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { flagMessage } from '../../imap/mutations.js';
import { jsonResult } from '../result.js';
import { logger } from '../../logger.js';

const log = logger.child({ tool: 'flag_message' });

export function registerFlagMessageTool(server: McpServer): void {
  server.registerTool(
    'flag_message',
    {
      title: 'Flag message',
      description: 'Marks a message as read/unread and/or starred (flagged)/unstarred.',
      inputSchema: {
        folder: z.string().min(1).default('INBOX'),
        uid: z.coerce.number().int().positive(),
        actions: z
          .array(z.enum(['read', 'unread', 'flagged', 'unflagged']))
          .min(1)
          .describe('One or more flag changes to apply'),
      },
    },
    async ({ folder, uid, actions }) => {
      log.info({ folder, uid, actions }, 'flagging message');
      const result = await flagMessage(folder, uid, actions);
      return jsonResult(result);
    },
  );
}
