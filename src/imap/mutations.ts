import type { ImapFlow } from 'imapflow';
import { withMailbox } from './mailbox.js';
import { imapPool } from './pool.js';
import { classifyImapError } from './errors.js';
import { findSpecialFolder } from './special-folders.js';

export interface MoveResult {
  uid: number;
  from: string;
  to: string;
  newUid?: number;
}

export async function moveMessage(folder: string, uid: number, destination: string): Promise<MoveResult> {
  return withMailbox(folder, async (client) => {
    const result = await client.messageMove(uid, destination, { uid: true });
    if (!result) {
      throw new Error(`Message UID ${uid} introuvable dans "${folder}"`);
    }
    return { uid, from: folder, to: destination, newUid: result.uidMap?.get(uid) };
  });
}

export type DeleteAction = 'moved_to_trash' | 'expunged';

export interface DeleteResult {
  uid: number;
  folder: string;
  action: DeleteAction;
  destination?: string;
}

async function withLock<T>(client: ImapFlow, path: string, fn: () => Promise<T>): Promise<T> {
  const lock = await client.getMailboxLock(path);
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

/**
 * Suit la convention iCloud : déplace vers la corbeille plutôt que de
 * détruire immédiatement. Si le message est déjà dans la corbeille, il est
 * marqué \Deleted puis expurgé (suppression définitive).
 */
export async function deleteMessage(folder: string, uid: number): Promise<DeleteResult> {
  try {
    return await imapPool.withConnection(async (client) => {
      const trashPath = await findSpecialFolder(client, '\\Trash');

      if (trashPath && trashPath !== folder) {
        return withLock(client, folder, async () => {
          const result = await client.messageMove(uid, trashPath, { uid: true });
          if (!result) {
            throw new Error(`Message UID ${uid} introuvable dans "${folder}"`);
          }
          return { uid, folder, action: 'moved_to_trash' as const, destination: trashPath };
        });
      }

      return withLock(client, folder, async () => {
        const ok = await client.messageDelete(uid, { uid: true });
        if (!ok) {
          throw new Error(`Message UID ${uid} introuvable dans "${folder}"`);
        }
        return { uid, folder, action: 'expunged' as const };
      });
    });
  } catch (err) {
    throw classifyImapError(err);
  }
}

export type FlagAction =
  | 'read'
  | 'unread'
  | 'flagged'
  | 'unflagged'
  | 'answered'
  | 'unanswered'
  | 'junk'
  | 'not_junk';

export interface FlagResult {
  uid: number;
  folder: string;
  applied: FlagAction[];
  keywords?: string[];
}

const FLAG_ADDITIONS: Partial<Record<FlagAction, string>> = {
  read: '\\Seen',
  flagged: '\\Flagged',
  answered: '\\Answered',
  junk: '$Junk',
  not_junk: '$NotJunk',
};
const FLAG_REMOVALS: Partial<Record<FlagAction, string>> = {
  unread: '\\Seen',
  unflagged: '\\Flagged',
  unanswered: '\\Answered',
  junk: '$NotJunk',
  not_junk: '$Junk',
};

/**
 * Applique un ou plusieurs changements de flags. Les `keywords` sont des
 * mots-clés IMAP arbitraires ajoutés en plus des actions nommées. Les ajouts
 * sont appliqués avant les retraits.
 */
export async function flagMessage(
  folder: string,
  uid: number,
  actions: FlagAction[],
  keywords: string[] = [],
): Promise<FlagResult> {
  return withMailbox(folder, async (client) => {
    const toAdd = [
      ...actions.map((action) => FLAG_ADDITIONS[action]).filter((flag): flag is string => Boolean(flag)),
      ...keywords,
    ];
    const toRemove = actions
      .map((action) => FLAG_REMOVALS[action])
      .filter((flag): flag is string => Boolean(flag));

    if (toAdd.length > 0) {
      await client.messageFlagsAdd(uid, toAdd, { uid: true });
    }
    if (toRemove.length > 0) {
      await client.messageFlagsRemove(uid, toRemove, { uid: true });
    }

    return { uid, folder, applied: actions, keywords: keywords.length > 0 ? keywords : undefined };
  });
}
