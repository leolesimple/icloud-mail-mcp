import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getAttachment, getAttachmentPart } from '../../imap/messages.js';
import { assertReadableSize, AttachmentTooLargeError } from '../../attachments.js';
import { config } from '../../config.js';
import { errorResult } from '../result.js';
import { binaryFormatSchema, binaryOutput, checkBinaryFormat } from '../binary-output.js';
import { logger } from '../../logger.js';
import { toLocator } from '../../attachment-locator.js';
import { attachmentIndexInput, attachmentPartInput, refineLocator } from './inputs.js';

const log = logger.child({ tool: 'get_attachment' });

export function registerGetAttachmentTool(server: McpServer): void {
  server.registerTool(
    'get_attachment',
    {
      title: 'Get attachment',
      description:
        'Downloads one attachment (pièce jointe) of an email message, by its "index" as listed by ' +
        'read_message, or by its IMAP "part" number as listed by find_messages (exactly one of the ' +
        'two; with part, only that part is downloaded, not the whole message). By default (format "auto") images are returned as an image content block and ' +
        'other files (PDF, documents…) as a text block holding JSON { filename, contentType, size, ' +
        'contentBase64 }. Format "url" returns a signed, single-use download link valid 15 minutes ' +
        'instead of the bytes. Attachments larger than ATTACHMENT_MAX_BYTES are refused rather than ' +
        'truncated.',
      inputSchema: z
        .object({
          folder: z.string().min(1).default('INBOX').describe('Folder containing the message'),
          uid: z.coerce.number().int().positive().describe('IMAP UID of the message'),
          index: attachmentIndexInput.optional(),
          part: attachmentPartInput.optional(),
          format: binaryFormatSchema,
        })
        .superRefine(refineLocator),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ folder, uid, index, part, format }) => {
      const refused = checkBinaryFormat(format, config.PUBLIC_BASE_URL);
      if (refused) return refused;

      const locator = toLocator({ index, part });
      log.info({ folder, uid, ...locator, format }, 'fetching attachment');
      let attachment;
      try {
        // Par partie, la limite s'applique pendant le téléchargement.
        attachment =
          locator.part !== undefined
            ? await getAttachmentPart(folder, uid, locator.part, config.ATTACHMENT_MAX_BYTES)
            : await getAttachment(folder, uid, locator.index);
        assertReadableSize(attachment.size, config.ATTACHMENT_MAX_BYTES);
      } catch (err) {
        if (err instanceof AttachmentTooLargeError) {
          return errorResult(err.message);
        }
        throw err;
      }

      return binaryOutput(
        {
          filename: attachment.filename ?? `attachment-${locator.part ?? locator.index}`,
          contentType: attachment.contentType,
          content: attachment.content,
        },
        {
          format,
          target: { kind: 'attachment', folder, uid, ...locator },
          publicBaseUrl: config.PUBLIC_BASE_URL,
        },
      );
    },
  );
}
