import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildWhoami } from '../whoami.js';
import { jsonResult } from '../result.js';
import { logger } from '../../logger.js';

const log = logger.child({ tool: 'whoami' });

export function registerWhoamiTool(server: McpServer): void {
  server.registerTool(
    'whoami',
    {
      title: 'Account and server status',
      description:
        'Reports which iCloud account this server is bound to (address, IMAP/SMTP hosts and ports), the effective sending guardrails, the server version, and the IMAP connection pool state. Never returns the app password or bearer token — only whether they are configured. Set `probe` to true for a real, lightweight IMAP connection check.',
      inputSchema: {
        probe: z
          .boolean()
          .default(false)
          .describe('Perform a real, lightweight IMAP connection check (a single folder listing).'),
      },
    },
    async ({ probe }) => {
      log.info({ probe }, 'whoami');
      return jsonResult(await buildWhoami(probe));
    },
  );
}
