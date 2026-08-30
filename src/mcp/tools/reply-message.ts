import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { sendReply } from '../../smtp/send.js';
import { AttachmentTooLargeError, decodeInboundAttachments } from '../../attachments.js';
import { config } from '../../config.js';
import { jsonResult, errorResult } from '../result.js';
import { logger } from '../../logger.js';

const log = logger.child({ tool: 'reply_message' });

export function registerReplyMessageTool(server: McpServer): void {
  server.registerTool(
    'reply_message',
    {
      title: 'Reply to message',
      description:
        'Replies to an existing message with correct threading (In-Reply-To / References headers) and a ' +
        '"Re:" prefixed subject. Defaults "to" to the original sender if not provided. Set replyAll to also ' +
        'include the other original recipients (as Cc). The original message is marked \\Answered ' +
        '(markedAnswered in the result), and a copy is archived in "Sent" (savedToSent).',
      inputSchema: {
        folder: z.string().min(1).default('INBOX').describe('Folder containing the original message'),
        uid: z.coerce.number().int().positive().describe('UID of the message being replied to'),
        to: z.array(z.string().email()).optional().describe('Defaults to the original sender if omitted'),
        cc: z.array(z.string().email()).optional().describe('Explicit Cc; overrides the replyAll-derived Cc'),
        bcc: z.array(z.string().email()).optional(),
        text: z.string().optional(),
        html: z.string().optional(),
        replyAll: z.boolean().default(false).describe('Reply to the sender and all original recipients'),
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
    },
    async ({ folder, uid, to, cc, bcc, text, html, replyAll, attachments }) => {
      if (!text && !html) {
        return errorResult('Fournir au moins un corps de message (text ou html).');
      }

      try {
        const decoded = decodeInboundAttachments(attachments, config.ATTACHMENT_MAX_BYTES);
        log.info({ folder, uid, replyAll }, 'replying to message');
        const result = await sendReply({ folder, uid, to, cc, bcc, text, html, replyAll, attachments: decoded });
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
