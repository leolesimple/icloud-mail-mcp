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

// --- Opérations en masse ---------------------------------------------------
//
// imapflow accepte une liste d'UID en un seul MOVE / STORE / EXPUNGE : trier
// 200 newsletters = une poignée de commandes, pas 200 allers-retours sur un
// pool à 2 connexions. Le retour est par UID pour qu'un échec partiel (un UID
// déjà déplacé par ailleurs, par exemple) reste lisible.

/** Nombre maximal d'UID acceptés en une opération de masse. */
export const BULK_UID_LIMIT = 200;

export interface BulkItemResult {
  uid: number;
  ok: boolean;
  error?: string;
}

function dedupe(uids: number[]): number[] {
  return [...new Set(uids)].sort((a, b) => a - b);
}

/** UID de la liste qui existent réellement dans le dossier courant (une commande SEARCH). */
async function existingUids(client: ImapFlow, uids: number[]): Promise<Set<number>> {
  if (uids.length === 0) return new Set();
  const found = await client.search({ uid: uids.join(',') }, { uid: true });
  return new Set(found || []);
}

/**
 * Partitionne la liste : les UID présents dans le dossier d'un côté, un
 * `BulkItemResult` d'échec « introuvable » déjà posé pour les absents de l'autre.
 */
async function partitionUids(
  client: ImapFlow,
  folder: string,
  uids: number[],
): Promise<{ actionable: number[]; results: BulkItemResult[] }> {
  const unique = dedupe(uids);
  const present = await existingUids(client, unique);
  const results: BulkItemResult[] = [];
  const actionable = unique.filter((uid) => {
    if (present.has(uid)) return true;
    results.push({ uid, ok: false, error: `Message UID ${uid} introuvable dans "${folder}"` });
    return false;
  });
  return { actionable, results };
}

function markOk(results: BulkItemResult[], uids: number[]): BulkItemResult[] {
  for (const uid of uids) results.push({ uid, ok: true });
  return results.sort((a, b) => a.uid - b.uid);
}

export async function moveMessagesOn(
  client: ImapFlow,
  folder: string,
  uids: number[],
  destination: string,
): Promise<BulkItemResult[]> {
  const { actionable, results } = await partitionUids(client, folder, uids);
  if (actionable.length > 0) {
    await client.messageMove(actionable, destination, { uid: true });
  }
  return markOk(results, actionable);
}

export async function moveMessages(
  folder: string,
  uids: number[],
  destination: string,
): Promise<{ from: string; to: string; results: BulkItemResult[] }> {
  const results = await withMailbox(folder, (client) => moveMessagesOn(client, folder, uids, destination));
  return { from: folder, to: destination, results };
}

export async function deleteMessagesOn(
  client: ImapFlow,
  folder: string,
  uids: number[],
): Promise<{ action: DeleteAction; destination?: string; results: BulkItemResult[] }> {
  const trashPath = await findSpecialFolder(client, '\\Trash');

  return withLock(client, folder, async () => {
    const { actionable, results } = await partitionUids(client, folder, uids);

    if (trashPath && trashPath !== folder) {
      if (actionable.length > 0) {
        await client.messageMove(actionable, trashPath, { uid: true });
      }
      return { action: 'moved_to_trash' as const, destination: trashPath, results: markOk(results, actionable) };
    }

    if (actionable.length > 0) {
      await client.messageDelete(actionable, { uid: true });
    }
    return { action: 'expunged' as const, results: markOk(results, actionable) };
  });
}

export async function deleteMessages(
  folder: string,
  uids: number[],
): Promise<{ folder: string; action: DeleteAction; destination?: string; results: BulkItemResult[] }> {
  try {
    const outcome = await imapPool.withConnection((client) => deleteMessagesOn(client, folder, uids));
    return { folder, ...outcome };
  } catch (err) {
    throw classifyImapError(err);
  }
}

export async function flagMessagesOn(
  client: ImapFlow,
  folder: string,
  uids: number[],
  actions: FlagAction[],
  keywords: string[] = [],
): Promise<BulkItemResult[]> {
  const toAdd = [
    ...actions.map((action) => FLAG_ADDITIONS[action]).filter((flag): flag is string => Boolean(flag)),
    ...keywords,
  ];
  const toRemove = actions.map((action) => FLAG_REMOVALS[action]).filter((flag): flag is string => Boolean(flag));

  const { actionable, results } = await partitionUids(client, folder, uids);
  if (actionable.length > 0) {
    if (toAdd.length > 0) {
      await client.messageFlagsAdd(actionable, toAdd, { uid: true });
    }
    if (toRemove.length > 0) {
      await client.messageFlagsRemove(actionable, toRemove, { uid: true });
    }
  }
  return markOk(results, actionable);
}

export async function flagMessages(
  folder: string,
  uids: number[],
  actions: FlagAction[],
  keywords: string[] = [],
): Promise<{
  folder: string;
  applied: FlagAction[];
  keywords?: string[];
  results: BulkItemResult[];
}> {
  const results = await withMailbox(folder, (client) => flagMessagesOn(client, folder, uids, actions, keywords));
  return { folder, applied: actions, keywords: keywords.length > 0 ? keywords : undefined, results };
}
