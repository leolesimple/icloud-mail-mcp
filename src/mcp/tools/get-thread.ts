import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getThread } from '../../imap/thread.js';
import { jsonResult } from '../result.js';
import { logger } from '../../logger.js';

const log = logger.child({ tool: 'get_thread' });

export function registerGetThreadTool(server: McpServer): void {
  server.registerTool(
    'get_thread',
    {
      title: 'Get thread',
      description:
        'Reconstructs the conversation around a message. Follows References / In-Reply-To headers across ' +
        'the current folder plus Sent and Archive, falling back to a normalized subject (stacked Re:/Fwd: ' +
        'stripped) when headers are missing. Returns message summaries sorted oldest-first, each tagged ' +
        'with its folder and role (sent / received).',
      inputSchema: {
        folder: z.string().min(1).default('INBOX').describe('Folder containing the message'),
        uid: z.coerce.number().int().positive().describe('UID of any message in the thread'),
      },
    },
    async ({ folder, uid }) => {
      log.info({ folder, uid }, 'building thread');
      return jsonResult(await getThread(folder, uid));
    },
  );
}
