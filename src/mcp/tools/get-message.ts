import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getMessage } from '../../imap/messages.js';
import { jsonResult } from '../result.js';
import { logger } from '../../logger.js';

const log = logger.child({ tool: 'get_message' });

export function registerGetMessageTool(server: McpServer): void {
  server.registerTool(
    'get_message',
    {
      title: 'Get message',
      description:
        'Fetches the full content of a message by UID: headers, text/HTML body, and attachment metadata ' +
        '(attachment binary content is not included).',
      inputSchema: {
        folder: z.string().min(1).default('INBOX'),
        uid: z.coerce.number().int().positive().describe('IMAP UID of the message'),
      },
    },
    async ({ folder, uid }) => {
      log.info({ folder, uid }, 'fetching message');
      const message = await getMessage(folder, uid);
      return jsonResult(message);
    },
  );
}
