import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { sendForward } from '../../smtp/send.js';
import { AttachmentTooLargeError, decodeInboundAttachments } from '../../attachments.js';
import { config } from '../../config.js';
import { jsonResult, errorResult } from '../result.js';
import { logger } from '../../logger.js';

const log = logger.child({ tool: 'forward_message' });

export function registerForwardMessageTool(server: McpServer): void {
  server.registerTool(
    'forward_message',
    {
      title: 'Forward message',
      description:
        'Forwards an existing message to new recipients. The original is attached verbatim as message/rfc822 ' +
        '(headers and its own attachments preserved), with your note as the body. Subject is prefixed "Fwd:" ' +
        'unless already present. A copy is archived in "Sent" (savedToSent in the result).',
      inputSchema: {
        folder: z.string().min(1).default('INBOX').describe('Folder containing the message to forward'),
        uid: z.coerce.number().int().positive().describe('UID of the message to forward'),
        to: z.array(z.string().email()).min(1),
        cc: z.array(z.string().email()).optional(),
        bcc: z.array(z.string().email()).optional(),
        text: z.string().optional().describe('Note added as the forwarding message body'),
        html: z.string().optional(),
        attachments: z
          .array(
            z.object({
              filename: z.string().min(1),
              contentType: z.string().optional(),
              contentBase64: z.string().min(1),
            }),
          )
          .optional()
          .describe('Extra attachments, in addition to the forwarded message'),
      },
    },
    async ({ folder, uid, to, cc, bcc, text, html, attachments }) => {
      try {
        const decoded = decodeInboundAttachments(attachments, config.ATTACHMENT_MAX_BYTES);
        log.info({ folder, uid, to }, 'forwarding message');
        const result = await sendForward({ folder, uid, to, cc, bcc, text, html, attachments: decoded });
        return jsonResult(result);
      } catch (err) {
        if (err instanceof AttachmentTooLargeError) {
          return errorResult(err.message);
        }
        throw err;
      }
    },
  );
}
