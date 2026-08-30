import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { moveMessage } from '../../imap/mutations.js';
import { logger } from '../../logger.js';

const log = logger.child({ tool: 'move_message' });

export function registerMoveMessageTool(server: McpServer): void {
  server.registerTool(
    'move_message',
    {
      title: 'Move message',
      description:
        'Moves a message from one IMAP folder to another (IMAP MOVE, with automatic COPY+DELETE fallback if ' +
        'the server does not support the MOVE extension).',
      inputSchema: {
        folder: z.string().min(1).describe('Source folder'),
        uid: z.coerce.number().int().positive(),
        destination: z.string().min(1).describe('Destination folder path'),
      },
    },
    async ({ folder, uid, destination }) => {
      log.info({ folder, uid, destination }, 'moving message');
      const result = await moveMessage(folder, uid, destination);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}
