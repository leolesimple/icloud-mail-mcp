import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { moveMessage, moveMessages, BULK_UID_LIMIT } from '../../imap/mutations.js';
import { jsonResult, errorResult } from '../result.js';
import { moveResultSchema } from '../schemas.js';
import { logger } from '../../logger.js';

const log = logger.child({ tool: 'move_message' });

export function registerMoveMessageTool(server: McpServer): void {
  server.registerTool(
    'move_message',
    {
      title: 'Move message',
      description:
        'Moves one message (uid) or up to 200 messages (uids) from one IMAP folder to another, in a single ' +
        'IMAP command. Exactly one of uid / uids is required. With uids, the response is a per-UID list ' +
        '({ uid, ok, error? }) so a partial failure stays readable.',
      inputSchema: {
        folder: z.string().min(1).describe('Source folder'),
        uid: z.coerce.number().int().positive().optional(),
        uids: z.array(z.coerce.number().int().positive()).min(1).max(BULK_UID_LIMIT).optional(),
        destination: z.string().min(1).describe('Destination folder path'),
      },
      outputSchema: moveResultSchema.shape,
    },
    async ({ folder, uid, uids, destination }) => {
      if ((uid === undefined) === (uids === undefined)) {
        return errorResult('Fournir exactement un de "uid" (un message) ou "uids" (jusqu\'à 200 messages).');
      }

      if (uids) {
        log.info({ folder, count: uids.length, destination }, 'moving messages (bulk)');
        return jsonResult(await moveMessages(folder, uids, destination), moveResultSchema);
      }

      log.info({ folder, uid, destination }, 'moving message');
      return jsonResult(await moveMessage(folder, uid as number, destination), moveResultSchema);
    },
  );
}
