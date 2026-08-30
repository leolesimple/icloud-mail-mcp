import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { sendNewMessage } from '../../smtp/send.js';
import { errorResult, jsonResult } from '../result.js';
import { logger } from '../../logger.js';

const log = logger.child({ tool: 'send_message' });

export function registerSendMessageTool(server: McpServer): void {
  server.registerTool(
    'send_message',
    {
      title: 'Send message',
      description: 'Sends a new email via the iCloud SMTP server. Provide a text and/or an HTML body.',
      inputSchema: {
        to: z.array(z.string().email()).min(1),
        cc: z.array(z.string().email()).optional(),
        bcc: z.array(z.string().email()).optional(),
        subject: z.string().min(1),
        text: z.string().optional(),
        html: z.string().optional(),
      },
    },
    async ({ to, cc, bcc, subject, text, html }) => {
      if (!text && !html) {
        return errorResult('Fournir au moins un corps de message (text ou html).');
      }

      log.info({ to, subject }, 'sending message');
      const result = await sendNewMessage({ to, cc, bcc, subject, text, html });
      return jsonResult(result);
    },
  );
}
