import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { sendReply } from '../../smtp/send.js';
import { errorResult, jsonResult } from '../result.js';
import { logger } from '../../logger.js';

const log = logger.child({ tool: 'reply_message' });

export function registerReplyMessageTool(server: McpServer): void {
  server.registerTool(
    'reply_message',
    {
      title: 'Reply to message',
      description:
        'Replies to an existing message with correct threading (In-Reply-To / References headers) and a ' +
        '"Re:" prefixed subject. Defaults "to" to the original sender if not provided.',
      inputSchema: {
        folder: z.string().min(1).default('INBOX').describe('Folder containing the original message'),
        uid: z.coerce.number().int().positive().describe('UID of the message being replied to'),
        to: z.array(z.string().email()).optional().describe('Defaults to the original sender if omitted'),
        cc: z.array(z.string().email()).optional(),
        bcc: z.array(z.string().email()).optional(),
        text: z.string().optional(),
        html: z.string().optional(),
      },
    },
    async ({ folder, uid, to, cc, bcc, text, html }) => {
      if (!text && !html) {
        return errorResult('Fournir au moins un corps de message (text ou html).');
      }

      log.info({ folder, uid }, 'replying to message');
      const result = await sendReply({ folder, uid, to, cc, bcc, text, html });
      return jsonResult(result);
    },
  );
}
