import type { ImapFlow, MailboxLockOptions } from 'imapflow';
import { imapPool } from './pool.js';
import { classifyImapError } from './errors.js';

/**
 * Acquires a pooled connection, selects/locks the given mailbox, runs `fn`,
 * then always releases the mailbox lock and the connection — in that order,
 * regardless of whether `fn` throws.
 */
export async function withMailbox<T>(
  folder: string,
  fn: (client: ImapFlow) => Promise<T>,
  options?: MailboxLockOptions,
): Promise<T> {
  try {
    return await imapPool.withConnection(async (client) => {
      const lock = await client.getMailboxLock(folder, options);
      try {
        return await fn(client);
      } finally {
        lock.release();
      }
    });
  } catch (err) {
    throw classifyImapError(err);
  }
}
