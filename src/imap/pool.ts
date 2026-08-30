import { ImapFlow } from 'imapflow';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { classifyImapError, ImapNetworkError } from './errors.js';

const log = logger.child({ module: 'imap-pool' });

interface PoolEntry {
  client: ImapFlow;
  inUse: boolean;
}

/** Fabrique un client imapflow non connecté. Injectable pour les tests. */
export type ImapClientFactory = () => ImapFlow;

function defaultClientFactory(): ImapFlow {
  return new ImapFlow({
    host: config.IMAP_HOST,
    port: config.IMAP_PORT,
    secure: true,
    auth: {
      user: config.ICLOUD_EMAIL,
      pass: config.ICLOUD_APP_PASSWORD,
    },
    logger: false,
  });
}

interface Waiter {
  resolve: (client: ImapFlow) => void;
  reject: (err: unknown) => void;
}

/**
 * Small connection pool around imapflow. iCloud throttles aggressively, so
 * tool calls must reuse a handful of long-lived connections instead of
 * opening a new one per call.
 */
export class ImapConnectionPool {
  private entries: PoolEntry[] = [];
  private reserved = 0;
  private waiters: Waiter[] = [];
  private closed = false;

  constructor(
    private readonly maxSize: number,
    private readonly createRawClient: ImapClientFactory = defaultClientFactory,
  ) {}

  async acquire(): Promise<ImapFlow> {
    if (this.closed) {
      throw new Error('Le pool de connexions IMAP est fermé');
    }

    const client = await this.tryClaim();
    if (client) {
      return client;
    }

    return new Promise<ImapFlow>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  release(client: ImapFlow): void {
    const entry = this.entries.find((e) => e.client === client);
    if (!entry) {
      return; // déjà retiré du pool (erreur ou fermeture entre-temps)
    }

    if (!client.usable) {
      this.entries = this.entries.filter((e) => e !== entry);
    } else {
      entry.inUse = false;
    }

    void this.fulfillNextWaiter();
  }

  async withConnection<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = await this.acquire();
    try {
      return await fn(client);
    } finally {
      this.release(client);
    }
  }

  async close(): Promise<void> {
    this.closed = true;

    for (const waiter of this.waiters) {
      waiter.reject(new Error('Le pool de connexions IMAP est en cours de fermeture'));
    }
    this.waiters = [];

    const clients = this.entries.map((e) => e.client);
    this.entries = [];

    await Promise.allSettled(
      clients.map(async (client) => {
        try {
          await client.logout();
        } catch {
          client.close();
        }
      }),
    );
  }

  /** Renvoie un client idle réutilisable, ou en ouvre un nouveau si sous la limite. Null si le pool est plein. */
  private async tryClaim(): Promise<ImapFlow | null> {
    const idle = this.entries.find((e) => !e.inUse && e.client.usable);
    if (idle) {
      idle.inUse = true;
      return idle.client;
    }

    // Purge les entrées mortes restées idle (fermées côté serveur, jamais notifiées).
    this.entries = this.entries.filter((e) => e.inUse || e.client.usable);

    if (this.entries.length + this.reserved >= this.maxSize) {
      return null;
    }

    this.reserved += 1;
    try {
      const client = await this.createClient();
      this.entries.push({ client, inUse: true });
      return client;
    } finally {
      this.reserved -= 1;
    }
  }

  private async fulfillNextWaiter(): Promise<void> {
    if (this.waiters.length === 0) {
      return;
    }

    const client = await this.tryClaim();
    if (!client) {
      return; // toujours plein, un prochain release() retentera
    }

    const waiter = this.waiters.shift();
    if (!waiter) {
      this.release(client);
      return;
    }

    waiter.resolve(client);
  }

  private async createClient(): Promise<ImapFlow> {
    try {
      return await this.connectOnce();
    } catch (err) {
      if (!(err instanceof ImapNetworkError)) {
        throw err;
      }
      log.warn({ reason: err.message }, 'imap connect failed, retrying once');
      await new Promise((resolve) => setTimeout(resolve, 750));
      return this.connectOnce();
    }
  }

  private async connectOnce(): Promise<ImapFlow> {
    const client = this.createRawClient();

    client.on('error', (err: unknown) => {
      log.warn({ reason: classifyImapError(err).message }, 'imap connection error, dropping from pool');
      this.discard(client);
    });
    client.on('close', () => {
      log.debug('imap connection closed, dropping from pool');
      this.discard(client);
    });

    try {
      await client.connect();
    } catch (err) {
      throw classifyImapError(err);
    }

    log.info({ host: config.IMAP_HOST }, 'imap connection established');
    return client;
  }

  private discard(client: ImapFlow): void {
    this.entries = this.entries.filter((e) => e.client !== client);
    void this.fulfillNextWaiter();
  }
}

export const imapPool = new ImapConnectionPool(config.IMAP_POOL_SIZE);
