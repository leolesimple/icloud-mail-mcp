import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { saveDraft } from '../../imap/drafts.js';
import { AttachmentTooLargeError, decodeInboundAttachments } from '../../attachments.js';
import { config } from '../../config.js';
import { jsonResult, errorResult } from '../result.js';
import { draftResultSchema } from '../schemas.js';
import { logger } from '../../logger.js';

const log = logger.child({ tool: 'save_draft' });

export function registerSaveDraftTool(server: McpServer): void {
  server.registerTool(
    'save_draft',
    {
      title: 'Save draft',
      description:
        'Composes a message and saves it to the Drafts folder via IMAP APPEND, without sending it. ' +
        "Not affected by ENABLE_SENDING. To draft a reply with correct threading, pass replyFolder/replyUid " +
        '(subject and "to" default from the original message if omitted). Attachments are passed as ' +
        'base64-encoded content.',
      inputSchema: {
        to: z.array(z.string().email()).optional().describe('Required unless replyFolder/replyUid is given'),
        cc: z.array(z.string().email()).optional(),
        bcc: z.array(z.string().email()).optional(),
        subject: z.string().optional().describe('Required unless replyFolder/replyUid is given'),
        text: z.string().optional(),
        html: z.string().optional(),
        replyFolder: z.string().optional().describe('Folder of the message being replied to, for threading'),
        replyUid: z.coerce.number().int().positive().optional().describe('UID of the message being replied to'),
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
      outputSchema: draftResultSchema.shape,
    },
    async ({ to, cc, bcc, subject, text, html, replyFolder, replyUid, attachments }) => {
      if (!text && !html) {
        return errorResult('Fournir au moins un corps de message (text ou html).');
      }
      if ((replyFolder && !replyUid) || (!replyFolder && replyUid)) {
        return errorResult('replyFolder et replyUid doivent être fournis ensemble.');
      }

      try {
        const decoded = decodeInboundAttachments(attachments, config.ATTACHMENT_MAX_BYTES);
        log.info({ to, subject, replyFolder, replyUid }, 'saving draft');
        const result = await saveDraft({
          to,
          cc,
          bcc,
          subject,
          text,
          html,
          replyFolder,
          replyUid,
          attachments: decoded,
        });
        return jsonResult(result, draftResultSchema);
      } catch (err) {
        if (err instanceof AttachmentTooLargeError) {
          return errorResult(err.message);
        }
        throw err;
      }
    },
  );
}
