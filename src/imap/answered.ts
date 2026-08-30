import type { ImapFlow } from 'imapflow';
import { withMailbox } from './mailbox.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'imap-answered' });

/** Pose le flag `\Answered` sur un message ciblé par UID. Prend le client : testable. */
export async function addAnsweredFlag(client: ImapFlow, uid: number): Promise<void> {
  await client.messageFlagsAdd(uid, ['\\Answered'], { uid: true });
}

/** Sélecteur de boîte, injectable pour les tests (défaut : `withMailbox` sur le pool partagé). */
type WithMailbox = (folder: string, fn: (client: ImapFlow) => Promise<void>) => Promise<void>;

/**
 * Marque le message d'origine comme répondu (`\Answered`) après un envoi de
 * réponse réussi. Non bloquant : un échec logue un `warn` et renvoie `false`.
 */
export async function markAnswered(
  folder: string,
  uid: number,
  withMailboxFn: WithMailbox = (path, fn) => withMailbox(path, fn),
): Promise<boolean> {
  try {
    await withMailboxFn(folder, (client) => addAnsweredFlag(client, uid));
    return true;
  } catch (err) {
    log.warn(
      { folder, uid, reason: err instanceof Error ? err.message : String(err) },
      'could not mark original message as answered',
    );
    return false;
  }
}
