import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getAttachment } from '../../imap/messages.js';
import { assertReadableSize, AttachmentTooLargeError } from '../../attachments.js';
import { config } from '../../config.js';
import { errorResult } from '../result.js';
import { binaryFormatSchema, binaryOutput, checkBinaryFormat } from '../binary-output.js';
import { logger } from '../../logger.js';

const log = logger.child({ tool: 'get_attachment' });

export function registerGetAttachmentTool(server: McpServer): void {
  server.registerTool(
    'get_attachment',
    {
      title: 'Get attachment',
      description:
        'Downloads one attachment (pièce jointe) of an email message, by its "index" as listed by ' +
        'read_message. By default (format "auto") images are returned as an image content block and ' +
        'other files (PDF, documents…) as a text block holding JSON { filename, mimeType, size, ' +
        'contentBase64 }. Format "url" returns a signed, single-use download link valid 15 minutes ' +
        'instead of the bytes. Attachments larger than ATTACHMENT_MAX_BYTES are refused rather than ' +
        'truncated.',
      inputSchema: {
        folder: z.string().min(1).default('INBOX').describe('Folder containing the message'),
        uid: z.coerce.number().int().positive().describe('IMAP UID of the message'),
        index: z.coerce
          .number()
          .int()
          .nonnegative()
          .describe('Attachment index, as reported by read_message'),
        format: binaryFormatSchema,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ folder, uid, index, format }) => {
      const refused = checkBinaryFormat(format, config.PUBLIC_BASE_URL);
      if (refused) return refused;

      log.info({ folder, uid, index, format }, 'fetching attachment');
      const attachment = await getAttachment(folder, uid, index);

      try {
        assertReadableSize(attachment.size, config.ATTACHMENT_MAX_BYTES);
      } catch (err) {
        if (err instanceof AttachmentTooLargeError) {
          return errorResult(err.message);
        }
        throw err;
      }

      return binaryOutput(
        {
          filename: attachment.filename ?? `attachment-${index}`,
          mimeType: attachment.contentType,
          content: attachment.content,
        },
        {
          format,
          target: { kind: 'attachment', folder, uid, index },
          publicBaseUrl: config.PUBLIC_BASE_URL,
        },
      );
    },
  );
}
