import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { sendDraft } from '../../imap/drafts.js';
import { jsonResult } from '../result.js';
import { sendDraftResultSchema } from '../schemas.js';
import { logger } from '../../logger.js';

const log = logger.child({ tool: 'send_draft' });

export function registerSendDraftTool(server: McpServer): void {
  server.registerTool(
    'send_draft',
    {
      title: 'Send draft',
      description:
        'Sends an existing draft (brouillon) of the Drafts folder, by its UID (as returned by ' +
        'compose_message with deliver "draft"). The stored email is sent as is through iCloud SMTP, subject ' +
        'to the sending guardrails, copied to Sent (Envoyés), then removed from Drafts. If sending fails, the ' +
        'draft is left untouched. Always confirm with the user before sending.',
      inputSchema: {
        uid: z.coerce.number().int().positive().describe('UID of the draft to send, in the Drafts folder'),
      },
      outputSchema: sendDraftResultSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ uid }) => {
      log.info({ uid }, 'sending draft');
      return jsonResult(await sendDraft(uid), sendDraftResultSchema);
    },
  );
}
