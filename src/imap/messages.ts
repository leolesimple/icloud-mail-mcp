import type { AddressObject } from 'mailparser';
import { simpleParser } from 'mailparser';
import type { FetchMessageObject, ImapFlow, SearchObject } from 'imapflow';
import { withMailbox } from './mailbox.js';

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
  filename?: string;
  contentType: string;
  size: number;
  contentId?: string;
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

async function fetchSummaries(client: ImapFlow, query: SearchObject, limit: number): Promise<MessageSummary[]> {
  const uids = await client.search(query, { uid: true });
  if (!uids || uids.length === 0) {
    return [];
  }

  // Les UID croissent avec le temps sur un même dossier : les plus grands sont les plus récents.
  const selected = [...uids].sort((a, b) => b - a).slice(0, limit);
  const messages = await client.fetchAll(selected, SUMMARY_QUERY, { uid: true });
  return messages.map(toSummary).sort((a, b) => b.uid - a.uid);
}

export interface ListMessagesOptions {
  unreadOnly?: boolean;
  since?: Date;
  before?: Date;
  from?: string;
  limit: number;
}

export async function listMessages(folder: string, options: ListMessagesOptions): Promise<MessageSummary[]> {
  const query: SearchObject = { all: true };
  if (options.unreadOnly) query.seen = false;
  if (options.since) query.since = options.since;
  if (options.before) query.before = options.before;
  if (options.from) query.from = options.from;

  return withMailbox(folder, (client) => fetchSummaries(client, query, options.limit), { readOnly: true });
}

export interface SearchMessagesOptions {
  subject?: string;
  body?: string;
  from?: string;
  to?: string;
  limit: number;
}

export async function searchMessages(folder: string, options: SearchMessagesOptions): Promise<MessageSummary[]> {
  const query: SearchObject = {};
  if (options.subject) query.subject = options.subject;
  if (options.body) query.body = options.body;
  if (options.from) query.from = options.from;
  if (options.to) query.to = options.to;

  return withMailbox(folder, (client) => fetchSummaries(client, query, options.limit), { readOnly: true });
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
        attachments: (parsed?.attachments ?? []).map((att) => ({
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
