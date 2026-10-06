import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getMessage, getMessageHeaders } from '../../imap/messages.js';
import { getThread } from '../../imap/thread.js';
import { extractRawHeaders, prepareMessageBody } from '../message-content.js';
import { readMessageResultSchema } from '../schemas.js';
import { jsonResult } from '../result.js';
import { uidInput } from './inputs.js';
import { config } from '../../config.js';
import { logger } from '../../logger.js';

const log = logger.child({ tool: 'read_message' });

export function registerReadMessageTool(server: McpServer): void {
  server.registerTool(
    'read_message',
    {
      title: 'Read message',
      description:
        'Opens one email message (courriel) by folder + UID: headers, plain-text body and attachment ' +
        '(pièce jointe) metadata. The body is truncated to maxBodyChars (bodyTruncated flags it); the raw ' +
        'HTML body is omitted unless includeHtml is true; when the message has no text part, the body is ' +
        'derived from its HTML. Set includeThread to also get the whole conversation (fil de discussion) in ' +
        '"thread": summaries from the folder plus Sent and Archive, oldest first, each tagged sent/received. ' +
        'Attachment bytes are never included: pass an attachment "index" to get_attachment. Reading does not ' +
        'mark the message as read.',
      inputSchema: {
        folder: z.string().min(1).default('INBOX').describe('Folder containing the message'),
        uid: uidInput.describe('IMAP UID of the message'),
        includeThread: z
          .boolean()
          .default(false)
          .describe('Also return the conversation this message belongs to, in "thread"'),
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
      outputSchema: readMessageResultSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ folder, uid, includeThread, maxBodyChars, includeHtml, includeRawHeaders }) => {
      log.info({ folder, uid, includeThread, includeHtml, includeRawHeaders }, 'reading message');
      const [message, thread] = await Promise.all([
        getMessage(folder, uid),
        includeThread ? getThread(folder, uid) : undefined,
      ]);
      const { text, html, bodyTruncated } = prepareMessageBody(message, {
        maxBodyChars,
        includeHtml,
      });

      const rawHeaders = includeRawHeaders
        ? extractRawHeaders(await getMessageHeaders(folder, uid))
        : undefined;

      return jsonResult(
        {
          ...message,
          text,
          html,
          bodyTruncated,
          ...(rawHeaders !== undefined ? { rawHeaders } : {}),
          ...(thread !== undefined ? { thread } : {}),
        },
        readMessageResultSchema,
      );
    },
  );
}
