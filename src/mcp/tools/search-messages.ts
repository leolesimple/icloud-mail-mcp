import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { searchMessages, searchMessagesAcross } from '../../imap/messages.js';
import type { SearchMessagesOptions } from '../../imap/messages.js';
import { hasSearchCriteria } from '../../imap/search-query.js';
import { jsonResult, errorResult } from '../result.js';
import { logger } from '../../logger.js';

const log = logger.child({ tool: 'search_messages' });

const isoDate = z.union([z.iso.date(), z.iso.datetime({ offset: true, local: true })]);

const textCriteria = z
  .object({
    subject: z.string().optional(),
    body: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    text: z.string().optional().describe('Matches anywhere in headers or body'),
  })
  .describe('A set of text criteria');

export function registerSearchMessagesTool(server: McpServer): void {
  server.registerTool(
    'search_messages',
    {
      title: 'Search messages',
      description:
        'Searches messages with the native IMAP SEARCH command. Criteria are combined with AND. Supports ' +
        'text (subject/body/from/to/text), date range (since/before), unreadOnly, flagged, negation (not), ' +
        'alternation (or), pagination (beforeUid → nextCursor), and multi-folder search (folders[]). ' +
        'At least one real criterion is required. Returns { messages, nextCursor? }; with folders[], each ' +
        'message is tagged with its "folder" and no cursor is returned.',
      inputSchema: {
        folder: z.string().min(1).default('INBOX').describe('Single folder to search (ignored if folders[] is set)'),
        folders: z
          .array(z.string().min(1))
          .min(1)
          .optional()
          .describe('Search several folders; results merged and each tagged with its folder'),
        subject: z.string().optional(),
        body: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        text: z.string().optional().describe('Matches anywhere in headers or body'),
        since: isoDate.optional().describe('Messages received on or after this date (ISO 8601)'),
        before: isoDate.optional().describe('Messages received before this date (ISO 8601)'),
        unreadOnly: z.boolean().optional(),
        flagged: z.boolean().optional().describe('Only starred (flagged) messages'),
        not: textCriteria.optional().describe('Text criteria to exclude'),
        or: z.array(textCriteria).optional().describe('Branches; at least one must match'),
        beforeUid: z.coerce.number().int().positive().optional().describe('Pagination cursor (single-folder only)'),
        envelope: z
          .boolean()
          .default(false)
          .describe(
            'Wrap the text block as { messages, nextCursor? } instead of a bare array. ' +
              'Forced on whenever a nextCursor exists.',
          ),
        limit: z.coerce.number().int().positive().max(200).default(50),
      },
    },
    async ({
      folder,
      folders,
      subject,
      body,
      from,
      to,
      text,
      since,
      before,
      unreadOnly,
      flagged,
      not,
      or,
      beforeUid,
      envelope,
      limit,
    }) => {
      const options: SearchMessagesOptions = {
        subject,
        body,
        from,
        to,
        text,
        since: since ? new Date(since) : undefined,
        before: before ? new Date(before) : undefined,
        unreadOnly,
        flagged,
        not,
        or,
        beforeUid,
        limit,
      };

      if (!hasSearchCriteria(options)) {
        return errorResult(
          'Au moins un critère de recherche est requis (subject, body, from, to, text, since, before, ' +
            'unreadOnly, flagged, not ou or).',
        );
      }

      if (folders && folders.length > 0) {
        log.info({ folders, subject, from }, 'searching messages (multi-folder)');
        const result = await searchMessagesAcross(folders, options);
        return jsonResult(envelope ? result : result.messages);
      }

      log.info({ folder, subject, from, beforeUid }, 'searching messages');
      const page = await searchMessages(folder, options);
      // Compat : tableau nu par défaut ; enveloppé sur demande, ou dès qu'un curseur existe.
      return jsonResult(envelope || page.nextCursor !== undefined ? page : page.messages);
    },
  );
}
