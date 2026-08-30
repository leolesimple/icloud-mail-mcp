import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { deleteMessage, deleteMessages, BULK_UID_LIMIT } from '../../imap/mutations.js';
import { jsonResult, errorResult } from '../result.js';
import { logger } from '../../logger.js';

const log = logger.child({ tool: 'delete_message' });

export function registerDeleteMessageTool(server: McpServer): void {
  server.registerTool(
    'delete_message',
    {
      title: 'Delete message',
      description:
        'Deletes one message (uid) or up to 200 messages (uids), following iCloud convention: moves them to ' +
        'Trash, or permanently expunges them (flag \\Deleted + EXPUNGE) if they are already in Trash. The ' +
        'move/expunge runs as a single IMAP command. Exactly one of uid / uids is required.',
      inputSchema: {
        folder: z.string().min(1),
        uid: z.coerce.number().int().positive().optional(),
        uids: z.array(z.coerce.number().int().positive()).min(1).max(BULK_UID_LIMIT).optional(),
      },
    },
    async ({ folder, uid, uids }) => {
      if ((uid === undefined) === (uids === undefined)) {
        return errorResult('Fournir exactement un de "uid" (un message) ou "uids" (jusqu\'à 200 messages).');
      }

      if (uids) {
        log.info({ folder, count: uids.length }, 'deleting messages (bulk)');
        return jsonResult(await deleteMessages(folder, uids));
      }

      log.info({ folder, uid }, 'deleting message');
      return jsonResult(await deleteMessage(folder, uid as number));
    },
  );
}
