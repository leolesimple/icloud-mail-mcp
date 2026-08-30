import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MAX_WAIT_SECONDS, waitForNewMessage } from '../../imap/idle.js';
import { waitForNewMessageResultSchema } from '../schemas.js';
import { jsonResult } from '../result.js';
import { logger } from '../../logger.js';

const log = logger.child({ tool: 'wait_for_new_message' });

export function registerWaitForNewMessageTool(server: McpServer): void {
  server.registerTool(
    'wait_for_new_message',
    {
      title: 'Wait for new message',
      description:
        'Blocks until a new message arrives in the given folder, or until timeoutSec elapses. Uses a dedicated ' +
        'IMAP connection outside the pool. Returns { timedOut, newMessages }: a reached timeout is not an error. ' +
        `timeoutSec is capped at ${MAX_WAIT_SECONDS}s.`,
      inputSchema: {
        folder: z.string().min(1).default('INBOX'),
        timeoutSec: z
          .coerce.number()
          .int()
          .positive()
          .max(MAX_WAIT_SECONDS)
          .default(60)
          .describe(`How long to wait, in seconds (max ${MAX_WAIT_SECONDS})`),
      },
      outputSchema: waitForNewMessageResultSchema.shape,
    },
    async ({ folder, timeoutSec }) => {
      log.info({ folder, timeoutSec }, 'waiting for new message');
      const result = await waitForNewMessage(folder, timeoutSec);
      return jsonResult(result, waitForNewMessageResultSchema);
    },
  );
}
