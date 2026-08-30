import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getMessage, getMessageSource } from '../../imap/messages.js';
import { extractRawHeaders, prepareMessageBody } from '../message-content.js';
import { getMessageResultSchema } from '../schemas.js';
import { jsonResult } from '../result.js';
import { config } from '../../config.js';
import { logger } from '../../logger.js';

const log = logger.child({ tool: 'get_message' });

export function registerGetMessageTool(server: McpServer): void {
  server.registerTool(
    'get_message',
    {
      title: 'Get message',
      description:
        'Fetches the full content of a message by UID: headers, plain-text body, and attachment metadata. ' +
        'The body is truncated to maxBodyChars (bodyTruncated flags it). The raw HTML body is omitted unless ' +
        'includeHtml is true. When the message has no text part, the body is derived from its HTML. ' +
        'Attachment binary content is never included: each attachment carries a stable "index" — pass it to ' +
        'get_attachment to retrieve the bytes.',
      inputSchema: {
        folder: z.string().min(1).default('INBOX'),
        uid: z.coerce.number().int().positive().describe('IMAP UID of the message'),
        maxBodyChars: z.coerce
          .number()
          .int()
          .positive()
          .max(200_000)
          .default(config.MAX_BODY_CHARS)
          .describe('Truncate each returned body part to this many characters'),
        includeHtml: z
          .boolean()
          .default(false)
          .describe('Include the raw HTML body (large; kept out of context by default)'),
        includeRawHeaders: z
          .boolean()
          .default(false)
          .describe('Include the raw RFC 5322 header block (List-Unsubscribe, DKIM, debugging)'),
      },
      outputSchema: getMessageResultSchema.shape,
    },
    async ({ folder, uid, maxBodyChars, includeHtml, includeRawHeaders }) => {
      log.info({ folder, uid, includeHtml, includeRawHeaders }, 'fetching message');
      const message = await getMessage(folder, uid);
      const { text, html, bodyTruncated } = prepareMessageBody(message, { maxBodyChars, includeHtml });

      const rawHeaders = includeRawHeaders
        ? extractRawHeaders(await getMessageSource(folder, uid))
        : undefined;

      return jsonResult(
        {
          ...message,
          text,
          html,
          bodyTruncated,
          ...(rawHeaders !== undefined ? { rawHeaders } : {}),
        },
        getMessageResultSchema,
      );
    },
  );
}
