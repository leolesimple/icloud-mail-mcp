import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { sendDraft } from '../../imap/drafts.js';
import { jsonResult } from '../result.js';
import { logger } from '../../logger.js';

const log = logger.child({ tool: 'send_draft' });

export function registerSendDraftTool(server: McpServer): void {
  server.registerTool(
    'send_draft',
    {
      title: 'Send draft',
      description:
        'Sends an existing draft (by its UID in the Drafts folder): reads the stored source, sends it ' +
        'through the normal SMTP path (subject to ENABLE_SENDING and any sending guards), copies it to the ' +
        'Sent folder, then deletes the draft. If sending fails, the draft is left untouched.',
      inputSchema: {
        uid: z.coerce.number().int().positive().describe('UID of the draft to send, in the Drafts folder'),
      },
    },
    async ({ uid }) => {
      log.info({ uid }, 'sending draft');
      return jsonResult(await sendDraft(uid));
    },
  );
}
