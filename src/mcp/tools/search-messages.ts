import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { searchMessages } from '../../imap/messages.js';
import { errorResult, jsonResult } from '../result.js';
import { logger } from '../../logger.js';

const log = logger.child({ tool: 'search_messages' });

export function registerSearchMessagesTool(server: McpServer): void {
  server.registerTool(
    'search_messages',
    {
      title: 'Search messages',
      description:
        'Searches messages in a folder using the native IMAP SEARCH command (subject, body, sender, recipient). ' +
        'At least one of subject/body/from/to is required.',
      inputSchema: {
        folder: z.string().min(1).default('INBOX'),
        subject: z.string().optional(),
        body: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        limit: z.coerce.number().int().positive().max(200).default(50),
      },
    },
    async ({ folder, subject, body, from, to, limit }) => {
      if (!subject && !body && !from && !to) {
        return errorResult('Au moins un critère de recherche est requis (subject, body, from ou to).');
      }

      log.info({ folder, subject, from, to }, 'searching messages');
      const messages = await searchMessages(folder, { subject, body, from, to, limit });
      return jsonResult(messages);
    },
  );
}
