import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { sendNewMessage } from '../../smtp/send.js';
import { AttachmentTooLargeError, decodeInboundAttachments } from '../../attachments.js';
import { config } from '../../config.js';
import { jsonResult, errorResult } from '../result.js';
import { sendResultSchema } from '../schemas.js';
import { logger } from '../../logger.js';

const log = logger.child({ tool: 'send_message' });

export function registerSendMessageTool(server: McpServer): void {
  server.registerTool(
    'send_message',
    {
      title: 'Send message',
      description:
        'Sends a new email via the iCloud SMTP server. Provide a text and/or an HTML body. A copy is ' +
        'archived in the "Sent" folder (see savedToSent in the result). Attachments are passed as ' +
        'base64-encoded content.',
      inputSchema: {
        to: z.array(z.string().email()).min(1),
        cc: z.array(z.string().email()).optional(),
        bcc: z.array(z.string().email()).optional(),
        subject: z.string().min(1),
        text: z.string().optional(),
        html: z.string().optional(),
        attachments: z
          .array(
            z.object({
              filename: z.string().min(1),
              contentType: z.string().optional(),
              contentBase64: z.string().min(1),
            }),
          )
          .optional(),
      },
      outputSchema: sendResultSchema.shape,
    },
    async ({ to, cc, bcc, subject, text, html, attachments }) => {
      if (!text && !html) {
        return errorResult('Fournir au moins un corps de message (text ou html).');
      }

      try {
        const decoded = decodeInboundAttachments(attachments, config.ATTACHMENT_MAX_BYTES);
        log.info({ to, subject }, 'sending message');
        const result = await sendNewMessage({ to, cc, bcc, subject, text, html, attachments: decoded });
        return jsonResult(result, sendResultSchema);
      } catch (err) {
        if (err instanceof AttachmentTooLargeError) {
          return errorResult(err.message);
        }
        throw err;
      }
    },
  );
}
