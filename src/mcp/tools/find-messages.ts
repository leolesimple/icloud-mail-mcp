import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listMessages, searchMessages, searchMessagesAcross } from '../../imap/messages.js';
import type { MessageSummary, SearchMessagesOptions } from '../../imap/messages.js';
import { listFolders, searchableFolderPaths } from '../../imap/folders.js';
import { hasSearchCriteria } from '../../imap/search-query.js';
import { listResult, errorResult } from '../result.js';
import { findMessagesResultSchema } from '../schemas.js';
import { isoDate, textCriteriaInput } from './inputs.js';
import { logger } from '../../logger.js';

const log = logger.child({ tool: 'find_messages' });

/** Champs d'un message que `fields` peut demander (`folder` : multi-dossiers seulement). */
export const MESSAGE_FIELDS = [
  'uid',
  'subject',
  'from',
  'to',
  'date',
  'seen',
  'flagged',
  'size',
  'folder',
] as const satisfies readonly (keyof MessageSummary | 'folder')[];

export type MessageField = (typeof MESSAGE_FIELDS)[number];

/**
 * Ne garde de chaque message que les champs demandés. `uid` est toujours
 * conservé (c'est lui qu'on passe à read_message), `folder` aussi quand le
 * message en porte un (recherche multi-dossiers : sans lui, l'uid est ambigu).
 */
export function projectFields<T extends { uid: number; folder?: string }>(
  messages: T[],
  fields: readonly MessageField[] | undefined,
): Partial<T>[] {
  if (!fields) return messages;
  const keep = new Set<string>([...fields, 'uid', 'folder']);
  return messages.map(
    (message) =>
      Object.fromEntries(Object.entries(message).filter(([key]) => keep.has(key))) as Partial<T>,
  );
}

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
        'page. folders[] searches several folders at once, and folders: "*" searches every folder except ' +
        'Trash and Junk (set includeTrash to include them); a criterion is then required, each message is ' +
        'tagged with its "folder", no cursor is returned, and a failing folder is reported in "errors". ' +
        'hasAttachment / attachmentType (MIME type like "application/pdf", or prefix like "image/") filter ' +
        'on attachments (pièces jointes), e.g. invoices: { folders: "*", attachmentType: "application/pdf", ' +
        'from: "apple.com" }. fields keeps only some fields of each message (uid is always returned). ' +
        'Use read_message to open a message.',
      inputSchema: {
        folder: z
          .string()
          .min(1)
          .default('INBOX')
          .describe('Folder path, e.g. "INBOX", "Archive" (ignored if folders[] is set)'),
        folders: z
          .union([z.literal('*'), z.array(z.string().min(1)).min(1)])
          .optional()
          .describe(
            'Search several folders; results merged and each tagged with its folder. ' +
              '"*" = every selectable folder except Trash and Junk',
          ),
        includeTrash: z
          .boolean()
          .optional()
          .describe('With folders: "*", also search Trash (corbeille) and Junk (indésirables)'),
        subject: z.string().optional(),
        body: z.string().optional(),
        from: z.string().optional().describe('Sender address or name (partial match)'),
        to: z.string().optional(),
        text: z.string().optional().describe('Matches anywhere in headers or body'),
        since: isoDate
          .optional()
          .describe('Messages received on or after this date (ISO 8601, e.g. "2026-07-01")'),
        before: isoDate.optional().describe('Messages received before this date (ISO 8601)'),
        unreadOnly: z.boolean().optional().describe('Only unread messages (non lus)'),
        flagged: z.boolean().optional().describe('Only starred (flagged) messages'),
        not: textCriteriaInput.optional().describe('Text criteria to exclude'),
        or: z.array(textCriteriaInput).optional().describe('Branches; at least one must match'),
        hasAttachment: z
          .boolean()
          .optional()
          .describe('Only messages with (true) or without (false) attachments (pièces jointes)'),
        attachmentType: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Only messages with an attachment of this MIME type, e.g. "application/pdf"; ' +
              'a prefix such as "image/" matches any image',
          ),
        fields: z
          .array(z.enum(MESSAGE_FIELDS))
          .min(1)
          .optional()
          .describe(
            'Return only these fields of each message (uid always included, folder too across folders)',
          ),
        beforeUid: z.coerce
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'Pagination cursor: only messages with a UID below this value (pass a previous nextCursor)',
          ),
        limit: z.coerce
          .number()
          .int()
          .positive()
          .max(200)
          .default(50)
          .describe('Max number of messages'),
        envelope: z
          .boolean()
          .default(false)
          .describe(
            'Wrap the text block as { messages, nextCursor? } instead of a bare array. ' +
              'Forced on whenever a nextCursor or errors exist.',
          ),
      },
      outputSchema: findMessagesResultSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({
      folder,
      folders,
      includeTrash,
      fields,
      since,
      before,
      beforeUid,
      envelope,
      limit,
      ...criteria
    }) => {
      if (criteria.attachmentType && criteria.hasAttachment === false) {
        return errorResult(
          'attachmentType exige une pièce jointe : incompatible avec hasAttachment: false.',
        );
      }
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
              'to, text, since, before, unreadOnly, flagged, not, or, hasAttachment ou attachmentType). ' +
              'Pour lister un dossier, utiliser folder.',
          );
        }
        const paths =
          folders === '*' ? searchableFolderPaths(await listFolders(false), includeTrash) : folders;
        log.info(
          { folders: paths, subject: criteria.subject, from: criteria.from },
          'searching messages (multi-folder)',
        );
        const result = await searchMessagesAcross(paths, options);
        if (result.errors) log.warn({ errors: result.errors }, 'some folders failed');
        return listResult('messages', projectFields(result.messages, fields), {
          envelope,
          extra: result.errors ? { errors: result.errors } : undefined,
        });
      }

      // Compat : tableau nu par défaut ; enveloppé sur demande, ou dès qu'un curseur existe.
      if (!searching) {
        log.info({ folder, beforeUid, limit }, 'listing messages');
        const page = await listMessages(folder, { beforeUid, limit });
        return listResult('messages', projectFields(page.messages, fields), {
          envelope,
          nextCursor: page.nextCursor,
        });
      }

      log.info(
        { folder, subject: criteria.subject, from: criteria.from, beforeUid },
        'searching messages',
      );
      const page = await searchMessages(folder, options);
      return listResult('messages', projectFields(page.messages, fields), {
        envelope,
        nextCursor: page.nextCursor,
      });
    },
  );
}
