import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listMessages, searchMessages, searchMessagesAcross } from '../../imap/messages.js';
import type { SearchMessagesOptions } from '../../imap/messages.js';
import { hasSearchCriteria } from '../../imap/search-query.js';
import { listResult, errorResult } from '../result.js';
import { findMessagesResultSchema } from '../schemas.js';
import { isoDate, textCriteriaInput } from './inputs.js';
import { logger } from '../../logger.js';

const log = logger.child({ tool: 'find_messages' });

export function registerFindMessagesTool(server: McpServer): void {
  server.registerTool(
    'find_messages',
    {
      title: 'Find messages',
      description:
        'Lists or searches email messages (courriels) in a mail folder (dossier), newest first. Without any ' +
        'criterion it lists the folder (INBOX / boîte de réception by default); with at least one criterion ' +
        'it runs a native IMAP SEARCH. Criteria are combined with AND: text (subject/body/from/to/text), ' +
        'date range (since/before), unreadOnly (non lus), flagged (starred / suivis), negation (not), ' +
        'alternation (or). Returns { messages, nextCursor? }: pass nextCursor as beforeUid to get the next ' +
        'page. folders[] searches several folders at once (a criterion is then required): each message is ' +
        'tagged with its "folder", no cursor is returned, and a failing folder is reported in "errors". ' +
        'Use read_message to open a message.',
      inputSchema: {
        folder: z
          .string()
          .min(1)
          .default('INBOX')
          .describe('Folder path, e.g. "INBOX", "Archive" (ignored if folders[] is set)'),
        folders: z
          .array(z.string().min(1))
          .min(1)
          .optional()
          .describe('Search several folders; results merged and each tagged with its folder'),
        subject: z.string().optional(),
        body: z.string().optional(),
        from: z.string().optional().describe('Sender address or name (partial match)'),
        to: z.string().optional(),
        text: z.string().optional().describe('Matches anywhere in headers or body'),
        since: isoDate.optional().describe('Messages received on or after this date (ISO 8601, e.g. "2026-07-01")'),
        before: isoDate.optional().describe('Messages received before this date (ISO 8601)'),
        unreadOnly: z.boolean().optional().describe('Only unread messages (non lus)'),
        flagged: z.boolean().optional().describe('Only starred (flagged) messages'),
        not: textCriteriaInput.optional().describe('Text criteria to exclude'),
        or: z.array(textCriteriaInput).optional().describe('Branches; at least one must match'),
        beforeUid: z.coerce
          .number()
          .int()
          .positive()
          .optional()
          .describe('Pagination cursor: only messages with a UID below this value (pass a previous nextCursor)'),
        limit: z.coerce.number().int().positive().max(200).default(50).describe('Max number of messages'),
        envelope: z
          .boolean()
          .default(false)
          .describe(
            'Wrap the text block as { messages, nextCursor? } instead of a bare array. ' +
              'Forced on whenever a nextCursor or errors exist.',
          ),
      },
      outputSchema: findMessagesResultSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ folder, folders, since, before, beforeUid, envelope, limit, ...criteria }) => {
      const options: SearchMessagesOptions = {
        ...criteria,
        since: since ? new Date(since) : undefined,
        before: before ? new Date(before) : undefined,
        beforeUid,
        limit,
      };
      const searching = hasSearchCriteria(options);

      if (folders && folders.length > 0) {
        if (!searching) {
          return errorResult(
            'La recherche sur plusieurs dossiers (folders) exige au moins un critère (subject, body, from, ' +
              'to, text, since, before, unreadOnly, flagged, not ou or). Pour lister un dossier, utiliser folder.',
          );
        }
        log.info({ folders, subject: criteria.subject, from: criteria.from }, 'searching messages (multi-folder)');
        const result = await searchMessagesAcross(folders, options);
        if (result.errors) log.warn({ errors: result.errors }, 'some folders failed');
        return listResult('messages', result.messages, {
          envelope,
          extra: result.errors ? { errors: result.errors } : undefined,
        });
      }

      // Compat : tableau nu par défaut ; enveloppé sur demande, ou dès qu'un curseur existe.
      if (!searching) {
        log.info({ folder, beforeUid, limit }, 'listing messages');
        const page = await listMessages(folder, { beforeUid, limit });
        return listResult('messages', page.messages, { envelope, nextCursor: page.nextCursor });
      }

      log.info({ folder, subject: criteria.subject, from: criteria.from, beforeUid }, 'searching messages');
      const page = await searchMessages(folder, options);
      return listResult('messages', page.messages, { envelope, nextCursor: page.nextCursor });
    },
  );
}
