import { ImapFlow } from 'imapflow';
import type { ExistsEvent } from 'imapflow';
import { account } from '../account.js';
import { classifyImapError } from './errors.js';
import { toSummary } from './messages.js';
import type { MessageSummary } from './messages.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'imap-idle' });

/** Plafond dur du délai d'attente : une connexion hors pool ne doit jamais rester ouverte indéfiniment. */
export const MAX_WAIT_SECONDS = 300;

export interface WaitForNewMessageResult {
  folder: string;
  timedOut: boolean;
  newMessages: MessageSummary[];
}

/** Borne le délai demandé dans `[1, MAX_WAIT_SECONDS]`. */
export function boundTimeout(seconds: number): number {
  if (!Number.isFinite(seconds)) return 1;
  return Math.min(Math.max(1, Math.floor(seconds)), MAX_WAIT_SECONDS);
}

/**
 * Attend l'arrivée d'un nouveau message dans `folder`, jusqu'à `timeoutSec`
 * secondes. Ouvre une connexion IMAP **hors du pool** (le pool ne fait que 2
 * connexions et IDLE les monopolise), et la referme systématiquement.
 *
 * Version minimale du push MCP : pas de reconnexion, pas de `resources/updated`.
 * Un timeout atteint n'est pas une erreur (`timedOut: true`).
 */
export async function waitForNewMessage(folder: string, timeoutSec: number): Promise<WaitForNewMessageResult> {
  const bounded = boundTimeout(timeoutSec);
  const client = new ImapFlow({
    host: account.imap.host,
    port: account.imap.port,
    secure: true,
    auth: { user: account.email, pass: account.password },
    logger: false,
  });

  try {
    await client.connect();
    const mailbox = await client.mailboxOpen(folder, { readOnly: true });
    const startExists = mailbox.exists;

    const finalCount = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), bounded * 1000);
      client.on('exists', (data: ExistsEvent) => {
        if (data.path === folder && data.count > startExists) {
          clearTimeout(timer);
          resolve(data.count);
        }
      });
    });

    if (finalCount === null) {
      return { folder, timedOut: true, newMessages: [] };
    }

    const fetched = await client.fetchAll(`${startExists + 1}:*`, {
      uid: true,
      envelope: true,
      flags: true,
      size: true,
    });
    return { folder, timedOut: false, newMessages: fetched.map(toSummary) };
  } catch (err) {
    throw classifyImapError(err);
  } finally {
    try {
      await client.logout();
    } catch {
      client.close();
    }
    log.debug({ folder }, 'idle connection closed');
  }
}
