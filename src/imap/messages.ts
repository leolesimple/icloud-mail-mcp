import type { AddressObject } from 'mailparser';
import { simpleParser } from 'mailparser';
import type { FetchMessageObject, ImapFlow } from 'imapflow';
import { withMailbox } from './mailbox.js';
import { buildSearchQuery, paginationExhausted } from './search-query.js';
import type { SearchCriteria } from './search-query.js';

export interface MessageAddress {
  name?: string;
  address?: string;
}

export interface MessageSummary {
  uid: number;
  subject?: string;
  from: MessageAddress[];
  to: MessageAddress[];
  date?: string;
  seen: boolean;
  flagged: boolean;
  size?: number;
}

export interface MessageAttachment {
  /** Position stable de la pièce jointe dans le message, à passer à `get_attachment`. */
  index: number;
  filename?: string;
  contentType: string;
  size: number;
  contentId?: string;
}

export interface AttachmentContent {
  index: number;
  filename?: string;
  contentType: string;
  size: number;
  content: Buffer;
}

export interface FullMessage extends MessageSummary {
  cc: MessageAddress[];
  messageId?: string;
  references: string[];
  text?: string;
  html: string | false;
  attachments: MessageAttachment[];
}

const SUMMARY_QUERY = { uid: true, envelope: true, flags: true, size: true } as const;

export function toSummary(entry: FetchMessageObject): MessageSummary {
  const flags = entry.flags ?? new Set<string>();
  return {
    uid: entry.uid,
    subject: entry.envelope?.subject,
    from: entry.envelope?.from ?? [],
    to: entry.envelope?.to ?? [],
    date: entry.envelope?.date ? new Date(entry.envelope.date).toISOString() : undefined,
    seen: flags.has('\\Seen'),
    flagged: flags.has('\\Flagged'),
    size: entry.size,
  };
}

export function toAddressList(addr: AddressObject | AddressObject[] | undefined): MessageAddress[] {
  if (!addr) return [];
  const objects = Array.isArray(addr) ? addr : [addr];
  return objects.flatMap((o) => o.value.map((v) => ({ name: v.name, address: v.address })));
}

export function toReferencesList(refs: string[] | string | undefined): string[] {
  if (!refs) return [];
  return Array.isArray(refs) ? refs : [refs];
}

export interface MessagePage {
  messages: MessageSummary[];
  /**
   * Plus petit UID renvoyé. À repasser tel quel en `beforeUid` pour la page
   * suivante. Absent quand la liste est épuisée.
   */
  nextCursor?: number;
}

/** Un résumé rattaché à son dossier d'origine (recherche multi-dossiers). */
export interface TaggedMessageSummary extends MessageSummary {
  folder: string;
}

/**
 * Cœur de la pagination : traduit les critères, laisse le serveur filtrer, trie
 * par UID décroissant (donc du plus récent au plus ancien), tronque à `limit`,
 * et n'expose un curseur que s'il reste des messages au-delà.
 */
export async function fetchPage(client: ImapFlow, criteria: SearchCriteria, limit: number): Promise<MessagePage> {
  if (paginationExhausted(criteria.beforeUid)) {
    return { messages: [] };
  }

  const uids = await client.search(buildSearchQuery(criteria), { uid: true });
  if (!uids || uids.length === 0) {
    return { messages: [] };
  }

  const ordered = [...uids].sort((a, b) => b - a);
  const selected = ordered.slice(0, limit);
  const fetched = await client.fetchAll(selected, SUMMARY_QUERY, { uid: true });
  const messages = fetched.map(toSummary).sort((a, b) => b.uid - a.uid);

  const smallest = messages.at(-1)?.uid;
  const hasMore = ordered.length > selected.length;
  return hasMore && smallest !== undefined ? { messages, nextCursor: smallest } : { messages };
}

export interface ListMessagesOptions {
  unreadOnly?: boolean;
  since?: Date;
  before?: Date;
  from?: string;
  beforeUid?: number;
  limit: number;
}

export async function listMessages(folder: string, options: ListMessagesOptions): Promise<MessagePage> {
  const criteria: SearchCriteria = {
    unreadOnly: options.unreadOnly,
    since: options.since,
    before: options.before,
    from: options.from,
    beforeUid: options.beforeUid,
  };
  return withMailbox(folder, (client) => fetchPage(client, criteria, options.limit), { readOnly: true });
}

export interface SearchMessagesOptions extends SearchCriteria {
  limit: number;
}

export async function searchMessages(folder: string, options: SearchMessagesOptions): Promise<MessagePage> {
  return withMailbox(folder, (client) => fetchPage(client, options, options.limit), { readOnly: true });
}

/**
 * Recherche sur plusieurs dossiers, un dossier à la fois (IMAP ne sait pas
 * chercher globalement). Résultats fusionnés, chacun étiqueté par son dossier,
 * triés du plus récent au plus ancien, tronqués à `limit`. Pas de curseur : la
 * pagination n'a de sens que dossier par dossier.
 */
export async function searchMessagesAcross(
  folders: string[],
  options: SearchMessagesOptions,
): Promise<{ messages: TaggedMessageSummary[] }> {
  const merged: TaggedMessageSummary[] = [];
  for (const folder of folders) {
    const page = await withMailbox(folder, (client) => fetchPage(client, options, options.limit), {
      readOnly: true,
    });
    for (const message of page.messages) {
      merged.push({ ...message, folder });
    }
  }
  merged.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  return { messages: merged.slice(0, options.limit) };
}

export async function getMessage(folder: string, uid: number): Promise<FullMessage> {
  return withMailbox(
    folder,
    async (client) => {
      const fetched = await client.fetchOne(
        uid,
        { uid: true, envelope: true, flags: true, size: true, source: true },
        { uid: true },
      );
      if (!fetched) {
        throw new Error(`Message UID ${uid} introuvable dans "${folder}"`);
      }

      const parsed = fetched.source ? await simpleParser(fetched.source) : undefined;

      return {
        ...toSummary(fetched),
        cc: toAddressList(parsed?.cc),
        messageId: parsed?.messageId,
        references: toReferencesList(parsed?.references),
        text: parsed?.text,
        html: parsed?.html ?? false,
        attachments: (parsed?.attachments ?? []).map((att, index) => ({
          index,
          filename: att.filename,
          contentType: att.contentType,
          size: att.size,
          contentId: att.cid,
        })),
      };
    },
    { readOnly: true },
  );
}

/**
 * Source RFC 5322 brute d'un message. Sert à ré-émettre ou recopier un message
 * sans le recomposer (cycle de vie des brouillons) et à joindre l'original en
 * `message/rfc822` pour `forward_message`.
 */
export async function getMessageSource(folder: string, uid: number): Promise<Buffer> {
  return withMailbox(
    folder,
    async (client) => {
      const fetched = await client.fetchOne(uid, { uid: true, source: true }, { uid: true });
      if (!fetched || !fetched.source) {
        throw new Error(`Message UID ${uid} introuvable dans "${folder}"`);
      }
      return fetched.source;
    },
    { readOnly: true },
  );
}

/** Contenu binaire d'une pièce jointe, ciblée par son `index` (voir `getMessage`). */
export async function getAttachment(folder: string, uid: number, index: number): Promise<AttachmentContent> {
  return withMailbox(
    folder,
    async (client) => {
      const fetched = await client.fetchOne(uid, { uid: true, source: true }, { uid: true });
      if (!fetched || !fetched.source) {
        throw new Error(`Message UID ${uid} introuvable dans "${folder}"`);
      }

      const parsed = await simpleParser(fetched.source);
      const attachment = parsed.attachments[index];
      if (!attachment) {
        throw new Error(
          `Pièce jointe #${index} introuvable pour le message UID ${uid} ` +
            `(${parsed.attachments.length} pièce(s) jointe(s))`,
        );
      }

      return {
        index,
        filename: attachment.filename,
        contentType: attachment.contentType,
        size: attachment.content.length,
        content: attachment.content,
      };
    },
    { readOnly: true },
  );
}
