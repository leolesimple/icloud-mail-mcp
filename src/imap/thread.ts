import type { FetchMessageObject, FetchQueryObject, ImapFlow } from 'imapflow';
import { config } from '../config.js';
import { imapPool } from './pool.js';
import { classifyImapError } from './errors.js';
import { findSpecialFolder } from './special-folders.js';
import { toSummary } from './messages.js';
import type { MessageSummary } from './messages.js';
import { normalizeSubject } from './threading.js';

export type MessageRole = 'sent' | 'received';

export interface ThreadMessage extends MessageSummary {
  folder: string;
  /** « sent » si l'adresse du compte figure dans le From, « received » sinon. */
  role: MessageRole;
}

export interface Thread {
  /** Sujet normalisé (préfixes Re:/Fwd: retirés). */
  subject: string;
  /** Messages du fil, du plus ancien au plus récent. */
  messages: ThreadMessage[];
}

const HEADER_QUERY: FetchQueryObject = {
  uid: true,
  envelope: true,
  flags: true,
  size: true,
  headers: ['message-id', 'references', 'in-reply-to'],
};

/** Extrait les jetons `<...>` d'un en-tête donné dans le bloc d'en-têtes brut. */
function headerRefs(headers: Buffer | undefined, name: string): string[] {
  if (!headers) return [];
  const text = headers.toString('utf8');
  const line = text.match(new RegExp(`^${name}:\\s*([\\s\\S]*?)(?:\\r?\\n(?!\\s)|$)`, 'im'));
  if (!line || !line[1]) return [];
  return line[1].match(/<[^>]+>/g) ?? [];
}

function roleOf(summary: MessageSummary): MessageRole {
  const account = config.ICLOUD_EMAIL.toLowerCase();
  return summary.from.some((addr) => addr.address?.toLowerCase() === account) ? 'sent' : 'received';
}

/** Le message appartient-il vraiment au fil, ou est-ce du bruit ramené par le repli sur le sujet ? */
function belongsToThread(entry: FetchMessageObject, relatedIds: Set<string>, normalized: string): boolean {
  const messageId = entry.envelope?.messageId;
  if (messageId && relatedIds.has(messageId)) return true;

  const inReplyTo = entry.envelope?.inReplyTo;
  if (inReplyTo && relatedIds.has(inReplyTo)) return true;

  const refs = headerRefs(entry.headers, 'references');
  if (refs.some((ref) => relatedIds.has(ref))) return true;

  return normalized.length > 0 && normalizeSubject(entry.envelope?.subject) === normalized;
}

async function collectThreadUids(
  client: ImapFlow,
  messageId: string | undefined,
  relatedIds: Set<string>,
  normalized: string,
): Promise<number[]> {
  const found = new Set<number>();
  const add = (uids: number[] | false | undefined): void => {
    for (const uid of uids || []) found.add(uid);
  };

  for (const id of relatedIds) {
    add(await client.search({ header: { 'message-id': id } }, { uid: true }));
  }
  if (messageId) {
    add(await client.search({ header: { references: messageId } }, { uid: true }));
    add(await client.search({ header: { 'in-reply-to': messageId } }, { uid: true }));
  }
  if (normalized) {
    add(await client.search({ subject: normalized }, { uid: true }));
  }
  return [...found];
}

async function scanFolder(
  client: ImapFlow,
  folder: string,
  relatedIds: Set<string>,
  normalized: string,
  rootId: string | undefined,
  seen: Map<string, ThreadMessage>,
): Promise<void> {
  const lock = await client.getMailboxLock(folder, { readOnly: true });
  try {
    const uids = await collectThreadUids(client, rootId, relatedIds, normalized);
    if (uids.length === 0) return;

    const fetched = await client.fetchAll(uids, HEADER_QUERY, { uid: true });
    for (const entry of fetched) {
      if (!belongsToThread(entry, relatedIds, normalized)) continue;
      const summary = toSummary(entry);
      const key = entry.envelope?.messageId ?? `${folder}:${entry.uid}`;
      if (seen.has(key)) continue;
      seen.set(key, { ...summary, folder, role: roleOf(summary) });
    }
  } finally {
    lock.release();
  }
}

/**
 * Cœur testable : reconstitue un fil autour du message (`folder`, `uid`) en
 * balayant les `folders` donnés (courant + Sent + Archive en pratique). Cherche
 * par `References` / `In-Reply-To`, replie sur le sujet normalisé quand les
 * en-têtes manquent, et renvoie les résumés triés par date croissante.
 */
export async function getThreadOn(
  client: ImapFlow,
  folders: string[],
  folder: string,
  uid: number,
): Promise<Thread> {
  const root = await (async (): Promise<{
    messageId?: string;
    inReplyTo?: string;
    references: string[];
    subject?: string;
  }> => {
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      const fetched = await client.fetchOne(uid, HEADER_QUERY, { uid: true });
      if (!fetched) {
        throw new Error(`Message UID ${uid} introuvable dans "${folder}"`);
      }
      return {
        messageId: fetched.envelope?.messageId,
        inReplyTo: fetched.envelope?.inReplyTo,
        references: headerRefs(fetched.headers, 'references'),
        subject: fetched.envelope?.subject,
      };
    } finally {
      lock.release();
    }
  })();

  const relatedIds = new Set<string>();
  if (root.messageId) relatedIds.add(root.messageId);
  if (root.inReplyTo) relatedIds.add(root.inReplyTo);
  for (const ref of root.references) relatedIds.add(ref);

  const normalized = normalizeSubject(root.subject);
  const seen = new Map<string, ThreadMessage>();

  // Dédupliqué en gardant l'ordre : le dossier courant est balayé en premier.
  for (const target of [...new Set([folder, ...folders])]) {
    await scanFolder(client, target, relatedIds, normalized, root.messageId, seen);
  }

  const messages = [...seen.values()].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
  return { subject: normalized || (root.subject ?? ''), messages };
}

export async function getThread(folder: string, uid: number): Promise<Thread> {
  try {
    return await imapPool.withConnection(async (client) => {
      const extra = await Promise.all([
        findSpecialFolder(client, '\\Sent'),
        findSpecialFolder(client, '\\Archive'),
      ]);
      const folders = extra.filter((path): path is string => Boolean(path));
      return getThreadOn(client, folders, folder, uid);
    });
  } catch (err) {
    throw classifyImapError(err);
  }
}
