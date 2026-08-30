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
