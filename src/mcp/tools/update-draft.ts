import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { updateDraft } from '../../imap/drafts.js';
import { jsonResult, errorResult } from '../result.js';
import { logger } from '../../logger.js';

const log = logger.child({ tool: 'update_draft' });

export function registerUpdateDraftTool(server: McpServer): void {
  server.registerTool(
    'update_draft',
    {
      title: 'Update draft',
      description:
        'Replaces an existing draft (identified by its UID in the Drafts folder) with a recomposed one. ' +
        'The new version is APPENDed first, then the old one is deleted — a failure in between leaves a ' +
        'duplicate rather than losing content. Never blocked by ENABLE_SENDING (IMAP only). Pass ' +
        'replyFolder/replyUid to keep reply threading.',
      inputSchema: {
        uid: z.coerce.number().int().positive().describe('UID of the draft to replace, in the Drafts folder'),
        to: z.array(z.string().email()).optional().describe('Required unless replyFolder/replyUid is given'),
        cc: z.array(z.string().email()).optional(),
        bcc: z.array(z.string().email()).optional(),
        subject: z.string().optional().describe('Required unless replyFolder/replyUid is given'),
        text: z.string().optional(),
        html: z.string().optional(),
        replyFolder: z.string().optional(),
        replyUid: z.coerce.number().int().positive().optional(),
      },
    },
    async ({ uid, to, cc, bcc, subject, text, html, replyFolder, replyUid }) => {
      if (!text && !html) {
        return errorResult('Fournir au moins un corps de message (text ou html).');
      }
      if ((replyFolder && !replyUid) || (!replyFolder && replyUid)) {
        return errorResult('replyFolder et replyUid doivent être fournis ensemble.');
      }

      log.info({ uid, subject, replyFolder, replyUid }, 'updating draft');
      return jsonResult(await updateDraft(uid, { to, cc, bcc, subject, text, html, replyFolder, replyUid }));
    },
  );
}
