import { EventEmitter } from 'node:events';
import type { ImapFlow } from 'imapflow';

/**
 * Client imapflow minimal : juste ce que le pool manipule (connect, logout,
 * close, `usable`, et les événements error/close). Aucun accès réseau.
 */
export interface FakeMailbox {
  path: string;
  specialUse?: string;
}

export class FakeImapClient extends EventEmitter {
  usable = true;
  connectCount = 0;
  logoutCount = 0;
  closeCount = 0;

  // Surface IMAP utilisée par le lot A (copie dans Sent, \Answered, pièces jointes).
  mailboxes: FakeMailbox[] = [];
  appendCalls: { path: string; content: unknown; flags?: string[] }[] = [];
  flagsAddCalls: { range: unknown; flags: string[]; options?: unknown }[] = [];
  lockCalls: string[] = [];
  appendError?: Error;
  flagsAddError?: Error;
  fetchOneResult: unknown = false;

  constructor(private readonly onConnect?: (client: FakeImapClient) => void) {
    super();
  }

  async list(): Promise<FakeMailbox[]> {
    return this.mailboxes;
  }

  async append(path: string, content: unknown, flags?: string[]): Promise<{ uid: number }> {
    if (this.appendError) throw this.appendError;
    this.appendCalls.push({ path, content, flags });
    return { uid: this.appendCalls.length };
  }

  async messageFlagsAdd(range: unknown, flags: string[], options?: unknown): Promise<boolean> {
    if (this.flagsAddError) throw this.flagsAddError;
    this.flagsAddCalls.push({ range, flags, options });
    return true;
  }

  async getMailboxLock(path: string): Promise<{ path: string; release: () => void }> {
    this.lockCalls.push(path);
    return { path, release: () => {} };
  }

  async fetchOne(): Promise<unknown> {
    return this.fetchOneResult;
  }

  async connect(): Promise<void> {
    this.connectCount += 1;
    this.onConnect?.(this);
  }

  async logout(): Promise<void> {
    this.logoutCount += 1;
    this.usable = false;
  }

  close(): void {
    this.closeCount += 1;
    this.usable = false;
  }

  /** Simule une coupure côté serveur : le client reste dans le pool mais devient inutilisable. */
  die(): void {
    this.usable = false;
  }

  asImapFlow(): ImapFlow {
    return this as unknown as ImapFlow;
  }
}

/** Erreur réseau telle que la produit imapflow (code reconnu par classifyImapError). */
export function networkError(code = 'ECONNREFUSED'): Error {
  return Object.assign(new Error(`connect ${code}`), { code });
}

/** Échec d'authentification tel que le produit imapflow. */
export function authError(): Error {
  return Object.assign(new Error('Invalid credentials'), { authenticationFailed: true });
}

// ---------------------------------------------------------------------------
// Serveur IMAP factice, orienté messages.
//
// `FakeImapClient` ci-dessus ne couvre que ce que le pool manipule. `FakeMail`
// implémente la surface utilisée par les couches lecture / écriture / dossiers :
// list, status, search (avec critères), fetchAll/fetchOne, append, messageMove,
// messageDelete, messageFlagsAdd/Remove, mailboxCreate/Rename/Delete,
// getMailboxLock. Toujours zéro accès réseau.
// ---------------------------------------------------------------------------

interface FakeAddress {
  name?: string;
  address?: string;
}

export interface FakeStoredMessage {
  uid: number;
  flags: Set<string>;
  date: Date;
  subject?: string;
  from: FakeAddress[];
  to: FakeAddress[];
  cc?: FakeAddress[];
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  body?: string;
  source?: Buffer;
  size?: number;
}

export interface FakeMessageInput extends Partial<Omit<FakeStoredMessage, 'flags'>> {
  flags?: Iterable<string>;
}

interface FakeMailboxState {
  messages: FakeStoredMessage[];
  specialUse?: string;
  subscribed: boolean;
  flags: string[];
  /** \Noselect : STATUS et SELECT échouent (dossier conteneur). */
  noSelect: boolean;
}

interface MailboxOptions {
  specialUse?: string;
  subscribed?: boolean;
  flags?: string[];
  noSelect?: boolean;
}

type SearchRange = number | number[] | bigint | string;

interface SearchQuery {
  all?: boolean;
  uid?: string | number;
  seen?: boolean;
  flagged?: boolean;
  draft?: boolean;
  answered?: boolean;
  since?: Date | string;
  before?: Date | string;
  subject?: string;
  from?: string;
  to?: string;
  cc?: string;
  body?: string;
  text?: string;
  header?: Record<string, string | boolean>;
  not?: SearchQuery;
  or?: SearchQuery[];
}

interface FetchQuery {
  uid?: boolean;
  flags?: boolean;
  size?: boolean;
  envelope?: boolean;
  source?: boolean;
  headers?: boolean | string[];
}

function dayNumber(value: Date | string): number {
  const date = value instanceof Date ? value : new Date(value);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function includesCI(haystack: string | undefined, needle: string): boolean {
  return (haystack ?? '').toLowerCase().includes(needle.toLowerCase());
}

function addressMatches(list: FakeAddress[] | undefined, needle: string): boolean {
  return (list ?? []).some(
    (addr) => includesCI(addr.address, needle) || includesCI(addr.name, needle),
  );
}

function inSequence(uid: number, sequence: string | number): boolean {
  for (const part of String(sequence).split(',')) {
    if (!part.includes(':')) {
      if (Number(part) === uid) return true;
      continue;
    }
    const [lo, hi] = part.split(':');
    const low = Number(lo);
    const high = hi === '*' ? Number.POSITIVE_INFINITY : Number(hi);
    if (uid >= Math.min(low, high) && uid <= Math.max(low, high)) return true;
  }
  return false;
}

function headerField(message: FakeStoredMessage, key: string): string | undefined {
  switch (key.toLowerCase()) {
    case 'message-id':
      return message.messageId;
    case 'in-reply-to':
      return message.inReplyTo;
    case 'references':
      return (message.references ?? []).join(' ');
    default:
      return undefined;
  }
}

function matches(message: FakeStoredMessage, query: SearchQuery): boolean {
  if (query.uid !== undefined && !inSequence(message.uid, query.uid)) return false;
  if (query.seen !== undefined && message.flags.has('\\Seen') !== query.seen) return false;
  if (query.flagged !== undefined && message.flags.has('\\Flagged') !== query.flagged) return false;
  if (query.draft !== undefined && message.flags.has('\\Draft') !== query.draft) return false;
  if (query.answered !== undefined && message.flags.has('\\Answered') !== query.answered) return false;
  if (query.since !== undefined && dayNumber(message.date) < dayNumber(query.since)) return false;
  if (query.before !== undefined && dayNumber(message.date) >= dayNumber(query.before)) return false;
  if (query.subject !== undefined && !includesCI(message.subject, query.subject)) return false;
  if (query.from !== undefined && !addressMatches(message.from, query.from)) return false;
  if (query.to !== undefined && !addressMatches(message.to, query.to)) return false;
  if (query.cc !== undefined && !addressMatches(message.cc, query.cc)) return false;
  if (query.body !== undefined && !includesCI(message.body, query.body)) return false;
  if (
    query.text !== undefined &&
    !includesCI(`${message.subject ?? ''} ${message.body ?? ''}`, query.text)
  ) {
    return false;
  }
  if (query.header) {
    for (const [key, expected] of Object.entries(query.header)) {
      const actual = headerField(message, key);
      if (typeof expected === 'boolean') {
        if ((actual != null) !== expected) return false;
      } else if (!includesCI(actual, expected)) {
        return false;
      }
    }
  }
  if (query.not && matches(message, query.not)) return false;
  if (query.or && !query.or.some((branch) => matches(message, branch))) return false;
  return true;
}

function renderHeaders(message: FakeStoredMessage): string {
  const lines: string[] = [];
  if (message.messageId) lines.push(`Message-ID: ${message.messageId}`);
  if (message.inReplyTo) lines.push(`In-Reply-To: ${message.inReplyTo}`);
  if (message.references?.length) lines.push(`References: ${message.references.join(' ')}`);
  return lines.length > 0 ? `${lines.join('\r\n')}\r\n` : '';
}

export class FakeMail extends EventEmitter {
  usable = true;
  readonly mailboxes = new Map<string, FakeMailboxState>();
  selected: string | null = null;
  nextUid = 1000;
  readonly counters = { move: 0, delete: 0, flagAdd: 0, flagRemove: 0, status: 0, append: 0, search: 0 };

  // --- Mise en place des tests --------------------------------------------

  addMailbox(path: string, options: MailboxOptions = {}): this {
    this.mailboxes.set(path, {
      messages: [],
      specialUse: options.specialUse,
      subscribed: options.subscribed ?? true,
      flags: options.flags ?? [],
      noSelect: options.noSelect ?? false,
    });
    return this;
  }

  addMessage(path: string, input: FakeMessageInput = {}): FakeStoredMessage {
    const mailbox = this.require(path);
    const message: FakeStoredMessage = {
      uid: input.uid ?? this.nextUid++,
      flags: new Set(input.flags ?? []),
      date: input.date ?? new Date('2026-01-01T00:00:00.000Z'),
      subject: input.subject,
      from: input.from ?? [],
      to: input.to ?? [],
      cc: input.cc,
      messageId: input.messageId,
      inReplyTo: input.inReplyTo,
      references: input.references,
      body: input.body,
      source: input.source,
      size: input.size,
    };
    mailbox.messages.push(message);
    if (message.uid >= this.nextUid) this.nextUid = message.uid + 1;
    return message;
  }

  /** Sélectionne un dossier sans passer par un verrou (raccourci de test). */
  select(path: string): this {
    this.require(path);
    this.selected = path;
    return this;
  }

  messagesIn(path: string): FakeStoredMessage[] {
    return this.require(path).messages;
  }

  asImapFlow(): ImapFlow {
    return this as unknown as ImapFlow;
  }

  // --- Surface imapflow ---------------------------------------------------

  async getMailboxLock(path: string): Promise<{ path: string; release: () => void }> {
    const mailbox = this.require(path);
    if (mailbox.noSelect) throw new Error(`Mailbox "${path}" is not selectable`);
    this.selected = path;
    return { path, release: () => {} };
  }

  async list(): Promise<unknown[]> {
    return [...this.mailboxes.entries()].map(([path, mailbox]) => ({
      path,
      pathAsListed: path,
      name: path.split('/').pop() ?? path,
      delimiter: '/',
      parent: [],
      parentPath: '',
      flags: new Set(mailbox.flags),
      specialUse: mailbox.specialUse,
      listed: true,
      subscribed: mailbox.subscribed,
    }));
  }

  async status(path: string, query: { messages?: boolean; unseen?: boolean }): Promise<unknown> {
    this.counters.status += 1;
    const mailbox = this.require(path);
    if (mailbox.noSelect) throw new Error(`STATUS not allowed on "${path}"`);
    return {
      path,
      messages: query.messages ? mailbox.messages.length : undefined,
      unseen: query.unseen ? mailbox.messages.filter((m) => !m.flags.has('\\Seen')).length : undefined,
    };
  }

  async mailboxCreate(path: string): Promise<unknown> {
    if (this.mailboxes.has(path)) return { path, created: false };
    this.addMailbox(path);
    return { path, created: true };
  }

  async mailboxRename(path: string, newPath: string): Promise<unknown> {
    const mailbox = this.require(path);
    this.mailboxes.delete(path);
    this.mailboxes.set(newPath, mailbox);
    return { path, newPath };
  }

  async mailboxDelete(path: string): Promise<unknown> {
    this.require(path);
    this.mailboxes.delete(path);
    return { path };
  }

  async search(query: SearchQuery): Promise<number[]> {
    this.counters.search += 1;
    return this.current()
      .filter((message) => matches(message, query))
      .map((message) => message.uid);
  }

  async fetchAll(range: SearchRange, query: FetchQuery): Promise<unknown[]> {
    const uids = this.resolve(range);
    return this.current()
      .filter((message) => uids.includes(message.uid))
      .sort((a, b) => a.uid - b.uid)
      .map((message) => this.project(message, query));
  }

  async fetchOne(range: SearchRange, query: FetchQuery): Promise<unknown> {
    const uids = this.resolve(range);
    const message = this.current().find((m) => uids.includes(m.uid));
    return message ? this.project(message, query) : false;
  }

  async append(path: string, content: string | Buffer, flags?: string[]): Promise<unknown> {
    this.counters.append += 1;
    const mailbox = this.require(path);
    const source = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const uid = this.nextUid++;
    const subjectMatch = source.toString('utf8').match(/^subject:\s*(.+)$/im);
    mailbox.messages.push({
      uid,
      flags: new Set(flags ?? []),
      date: new Date(),
      subject: subjectMatch?.[1]?.trim(),
      from: [],
      to: [],
      source,
    });
    return { destination: path, uid };
  }

  async messageMove(range: SearchRange, destination: string): Promise<unknown> {
    this.counters.move += 1;
    const source = this.currentMailbox();
    const target = this.require(destination);
    const uids = this.resolve(range);
    const uidMap = new Map<number, number>();
    for (const uid of uids) {
      const index = source.messages.findIndex((m) => m.uid === uid);
      if (index < 0) continue;
      const message = source.messages.splice(index, 1)[0];
      if (!message) continue;
      const newUid = this.nextUid++;
      message.uid = newUid;
      target.messages.push(message);
      uidMap.set(uid, newUid);
    }
    return { path: this.selected, destination, uidMap };
  }

  async messageDelete(range: SearchRange): Promise<boolean> {
    this.counters.delete += 1;
    const mailbox = this.currentMailbox();
    const uids = this.resolve(range);
    mailbox.messages = mailbox.messages.filter((m) => !uids.includes(m.uid));
    return true;
  }

  async messageFlagsAdd(range: SearchRange, flags: string[]): Promise<boolean> {
    this.counters.flagAdd += 1;
    for (const message of this.matching(range)) {
      for (const flag of flags) message.flags.add(flag);
    }
    return true;
  }

  async messageFlagsRemove(range: SearchRange, flags: string[]): Promise<boolean> {
    this.counters.flagRemove += 1;
    for (const message of this.matching(range)) {
      for (const flag of flags) message.flags.delete(flag);
    }
    return true;
  }

  // --- Interne -----------------------------------------------------------

  private require(path: string): FakeMailboxState {
    const mailbox = this.mailboxes.get(path);
    if (!mailbox) throw new Error(`Mailbox "${path}" not found`);
    return mailbox;
  }

  private currentMailbox(): FakeMailboxState {
    if (!this.selected) throw new Error('No mailbox selected');
    return this.require(this.selected);
  }

  private current(): FakeStoredMessage[] {
    return this.currentMailbox().messages;
  }

  private matching(range: SearchRange): FakeStoredMessage[] {
    const uids = this.resolve(range);
    return this.current().filter((m) => uids.includes(m.uid));
  }

  private resolve(range: SearchRange): number[] {
    if (typeof range === 'number') return [range];
    if (typeof range === 'bigint') return [Number(range)];
    if (Array.isArray(range)) return range.map(Number);

    const out = new Set<number>();
    for (const part of range.split(',')) {
      if (!part.includes(':')) {
        out.add(Number(part));
        continue;
      }
      const [lo, hi] = part.split(':');
      const low = Number(lo);
      const high = hi === '*' ? this.nextUid : Number(hi);
      for (let uid = Math.min(low, high); uid <= Math.max(low, high); uid += 1) out.add(uid);
    }
    return [...out];
  }

  private project(message: FakeStoredMessage, query: FetchQuery): unknown {
    return {
      seq: message.uid,
      uid: message.uid,
      flags: query.flags ? new Set(message.flags) : undefined,
      size: query.size ? (message.size ?? message.source?.length ?? 0) : undefined,
      internalDate: message.date,
      envelope: query.envelope
        ? {
            date: message.date,
            subject: message.subject,
            messageId: message.messageId,
            inReplyTo: message.inReplyTo,
            from: message.from,
            to: message.to,
            cc: message.cc,
          }
        : undefined,
      source: query.source ? message.source : undefined,
      headers: query.headers ? Buffer.from(renderHeaders(message)) : undefined,
    };
  }
}
