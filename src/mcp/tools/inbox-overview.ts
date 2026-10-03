import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildInboxOverview } from '../overview.js';
import { inboxOverviewSchema } from '../schemas.js';
import { jsonResult } from '../result.js';
import { logger } from '../../logger.js';

const log = logger.child({ tool: 'inbox_overview' });

export function registerInboxOverviewTool(server: McpServer): void {
  server.registerTool(
    'inbox_overview',
    {
      title: 'Inbox overview',
      description:
        "Call this first for any request about the user's mail, email or iCloud Mail (courriels, boîte de " +
        'réception, non lus). Returns the account address, the INBOX unread count (non lus) with the latest ' +
        'unread messages, the latest messages in the inbox (boîte de réception), message/unread counts for ' +
        'every folder (dossier), and the active sending guardrails. Set includeDiagnostics for the IMAP ' +
        'connection probe, pool state and server hosts. Never returns any password or token.',
      inputSchema: {
        limit: z.coerce
          .number()
          .int()
          .positive()
          .max(50)
          .default(10)
          .describe('How many latest unread / latest messages to return (newest first)'),
        includeDiagnostics: z
          .boolean()
          .default(false)
          .describe('Add a live IMAP connection check, the connection pool state and the server hosts'),
      },
      outputSchema: inboxOverviewSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ limit, includeDiagnostics }) => {
      log.info({ limit, includeDiagnostics }, 'inbox overview');
      return jsonResult(await buildInboxOverview({ limit, includeDiagnostics }), inboxOverviewSchema);
    },
  );
}
