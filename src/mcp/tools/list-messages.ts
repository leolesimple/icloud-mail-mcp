import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listMessages } from '../../imap/messages.js';
import { listResult } from '../result.js';
import { listMessagesResultSchema } from '../schemas.js';
import { logger } from '../../logger.js';

const log = logger.child({ tool: 'list_messages' });

// z.coerce.date() ne peut pas être représenté en JSON Schema (tools/list plante).
// On valide une chaîne ISO 8601 et on convertit en Date nous-mêmes.
const isoDate = z.union([z.iso.date(), z.iso.datetime({ offset: true, local: true })]);

export function registerListMessagesTool(server: McpServer): void {
  server.registerTool(
    'list_messages',
    {
      title: 'List messages',
      description:
        'Lists messages in an IMAP folder, optionally filtered by read status, date range, or sender. ' +
        'Returns { messages, nextCursor? }, newest first. To page further, pass the returned nextCursor ' +
        'as beforeUid on the next call; nextCursor is absent once the folder is exhausted.',
      inputSchema: {
        folder: z.string().min(1).default('INBOX').describe('Folder path, e.g. "INBOX", "Archive"'),
        unreadOnly: z.boolean().optional().describe('Only return unread messages'),
        since: isoDate.optional().describe('Only messages received on or after this date (ISO 8601, e.g. "2026-07-01")'),
        before: isoDate.optional().describe('Only messages received before this date (ISO 8601)'),
        from: z.string().optional().describe('Filter by sender address (partial match)'),
        beforeUid: z.coerce
          .number()
          .int()
          .positive()
          .optional()
          .describe('Pagination cursor: only messages with a UID below this value (pass a previous nextCursor)'),
        envelope: z
          .boolean()
          .default(false)
          .describe(
            'Wrap the text block as { messages, nextCursor? } instead of a bare array. ' +
              'Forced on whenever a nextCursor exists, so pagination is never invisible.',
          ),
        limit: z.coerce
          .number()
          .int()
          .positive()
          .max(200)
          .default(50)
          .describe('Max number of messages to return (newest first)'),
      },
      outputSchema: listMessagesResultSchema.shape,
    },
    async ({ folder, unreadOnly, since, before, from, beforeUid, envelope, limit }) => {
      log.info({ folder, unreadOnly, beforeUid, limit }, 'listing messages');
      const page = await listMessages(folder, {
        unreadOnly,
        since: since ? new Date(since) : undefined,
        before: before ? new Date(before) : undefined,
        from,
        beforeUid,
        limit,
      });
      // Compat : tableau nu par défaut ; enveloppé sur demande, ou dès qu'un curseur existe.
      return listResult('messages', page.messages, { envelope, nextCursor: page.nextCursor });
    },
  );
}
