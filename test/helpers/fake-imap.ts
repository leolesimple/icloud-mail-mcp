import { EventEmitter } from 'node:events';
import type { ImapFlow } from 'imapflow';

/**
 * Client imapflow minimal : juste ce que le pool manipule (connect, logout,
 * close, `usable`, et les événements error/close). Aucun accès réseau.
 */
export class FakeImapClient extends EventEmitter {
  usable = true;
  connectCount = 0;
  logoutCount = 0;
  closeCount = 0;

  constructor(private readonly onConnect?: (client: FakeImapClient) => void) {
    super();
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
