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
      description:
        'Changes message flags: read/unread, starred/unstarred, answered/unanswered, junk/not_junk. ' +
        'Pass keywords for arbitrary IMAP keywords. Additions are applied before removals.',
      inputSchema: {
        folder: z.string().min(1).default('INBOX'),
        uid: z.coerce.number().int().positive(),
        actions: z
          .array(
            z.enum([
              'read',
              'unread',
              'flagged',
              'unflagged',
              'answered',
              'unanswered',
              'junk',
              'not_junk',
            ]),
          )
          .min(1)
          .describe('One or more flag changes to apply'),
        keywords: z.array(z.string().min(1)).optional().describe('Arbitrary IMAP keywords to add'),
      },
    },
    async ({ folder, uid, actions, keywords }) => {
      log.info({ folder, uid, actions, keywords }, 'flagging message');
      const result = await flagMessage(folder, uid, actions, keywords);
      return jsonResult(result);
    },
  );
}
