import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getAttachment } from '../../imap/messages.js';
import { assertReadableSize, AttachmentTooLargeError, isImageMimeType } from '../../attachments.js';
import { config } from '../../config.js';
import { errorResult } from '../result.js';
import { logger } from '../../logger.js';

const log = logger.child({ tool: 'get_attachment' });

export function registerGetAttachmentTool(server: McpServer): void {
  server.registerTool(
    'get_attachment',
    {
      title: 'Get attachment',
      description:
        'Retrieves the binary content of one attachment, targeted by its "index" from get_message. Images ' +
        'are returned as an image content block, other types as a base64 resource. Refuses (without ' +
        'truncating) any attachment larger than ATTACHMENT_MAX_BYTES.',
      inputSchema: {
        folder: z.string().min(1).default('INBOX').describe('Folder containing the message'),
        uid: z.coerce.number().int().positive().describe('IMAP UID of the message'),
        index: z.coerce.number().int().nonnegative().describe('Attachment index, as reported by get_message'),
      },
    },
    async ({ folder, uid, index }) => {
      log.info({ folder, uid, index }, 'fetching attachment');
      const attachment = await getAttachment(folder, uid, index);

      try {
        assertReadableSize(attachment.size, config.ATTACHMENT_MAX_BYTES);
      } catch (err) {
        if (err instanceof AttachmentTooLargeError) {
          return errorResult(err.message);
        }
        throw err;
      }

      const base64 = attachment.content.toString('base64');
      const uri = `mail://${encodeURIComponent(folder)}/${uid}/attachments/${index}`;

      if (isImageMimeType(attachment.contentType)) {
        return { content: [{ type: 'image', data: base64, mimeType: attachment.contentType }] };
      }

      return {
        content: [
          {
            type: 'resource',
            resource: { uri, mimeType: attachment.contentType, blob: base64 },
          },
        ],
      };
    },
  );
}
