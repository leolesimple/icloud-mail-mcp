import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { deleteMessages, flagMessages, moveMessages } from '../../imap/mutations.js';
import type { FlagAction } from '../../imap/mutations.js';
import { jsonResult, errorResult } from '../result.js';
import { organizeActionSchema, organizeResultSchema } from '../schemas.js';
import { uidsInput } from './inputs.js';
import { logger } from '../../logger.js';

const log = logger.child({ tool: 'organize_messages' });

type OrganizeAction = z.infer<typeof organizeActionSchema>;

/** Actions qui se ramènent à un changement de flags IMAP. */
const FLAG_ACTIONS: Partial<Record<OrganizeAction, FlagAction>> = {
  read: 'read',
  unread: 'unread',
  flag: 'flagged',
  unflag: 'unflagged',
  answered: 'answered',
  unanswered: 'unanswered',
  junk: 'junk',
  not_junk: 'not_junk',
};

export function registerOrganizeMessagesTool(server: McpServer): void {
  server.registerTool(
    'organize_messages',
    {
      title: 'Organize messages',
      description:
        'Moves, trashes or flags one or more email messages (courriels) of a folder (dossier), in a single ' +
        'IMAP command for up to 200 UIDs. Actions: "move" to another folder (destination required, e.g. ' +
        'Archive); "trash" (supprimer / corbeille) moves them to Trash, or permanently deletes them if they ' +
        'are already in Trash; "read" / "unread" (lu / non lu); "flag" / "unflag" (star / suivi); ' +
        '"answered" / "unanswered"; "junk" / "not_junk" only set the junk (spam / indésirable) mark and do ' +
        'not move the message. Flag actions also accept extra IMAP keywords. Returns a per-UID "results" ' +
        'list ({ uid, ok, error? }) so a partial failure stays readable.',
      inputSchema: {
        folder: z.string().min(1).describe('Folder containing the messages (UIDs are per folder)'),
        uids: uidsInput,
        action: organizeActionSchema.describe('What to do with the messages'),
        destination: z
          .string()
          .min(1)
          .optional()
          .describe('Target folder path (required for "move")'),
        keywords: z
          .array(z.string().min(1))
          .optional()
          .describe('Arbitrary IMAP keywords to add (flag actions only)'),
      },
      outputSchema: organizeResultSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ folder, uids, action, destination, keywords }) => {
      if (action === 'move' && !destination) {
        return errorResult('L\'action "move" exige un dossier de destination ("destination").');
      }
      if (action !== 'move' && destination !== undefined) {
        return errorResult('"destination" ne s\'utilise qu\'avec l\'action "move".');
      }

      const flagAction = FLAG_ACTIONS[action];
      if (!flagAction && keywords !== undefined) {
        return errorResult(
          '"keywords" ne s\'utilise qu\'avec une action de flag (read, unread, flag, unflag…).',
        );
      }

      log.info({ folder, count: uids.length, action, destination }, 'organizing messages');

      if (action === 'move') {
        const result = await moveMessages(folder, uids, destination as string);
        return jsonResult(
          { action, folder, destination: result.to, results: result.results },
          organizeResultSchema,
        );
      }

      if (action === 'trash') {
        const result = await deleteMessages(folder, uids);
        return jsonResult(
          {
            action,
            folder,
            outcome: result.action,
            ...(result.destination ? { destination: result.destination } : {}),
            results: result.results,
          },
          organizeResultSchema,
        );
      }

      if (!flagAction) {
        return errorResult(`Action inconnue : "${action}".`);
      }
      const result = await flagMessages(folder, uids, [flagAction], keywords);
      return jsonResult(
        {
          action,
          folder,
          applied: result.applied,
          ...(result.keywords ? { keywords: result.keywords } : {}),
          results: result.results,
        },
        organizeResultSchema,
      );
    },
  );
}
