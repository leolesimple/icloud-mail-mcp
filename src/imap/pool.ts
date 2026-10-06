import { ImapFlow } from 'imapflow';
import { account } from '../account.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { classifyImapError, ImapNetworkError, ImapPoolTimeoutError } from './errors.js';

const log = logger.child({ module: 'imap-pool' });

interface PoolEntry {
  client: ImapFlow;
  inUse: boolean;
}

/** Fabrique un client imapflow non connecté. Injectable pour les tests. */
export type ImapClientFactory = () => ImapFlow;

function defaultClientFactory(): ImapFlow {
  return new ImapFlow({
    host: account.imap.host,
    port: account.imap.port,
    secure: true,
    auth: {
      user: account.email,
      pass: account.password,
    },
    logger: false,
  });
}

interface Waiter {
  resolve: (client: ImapFlow) => void;
  reject: (err: unknown) => void;
  /** Horodatage (ms) de la mise en file, pour mesurer l'attente. */
  enqueuedAt: number;
  timer?: NodeJS.Timeout;
}

/** Au-delà de cette attente, l'obtention d'une connexion est journalisée. */
const SLOW_ACQUIRE_LOG_MS = 1_000;
/** Fenêtre de calcul de `maxRecentWaitMs`. */
const RECENT_WAIT_WINDOW_MS = 15 * 60_000;
/** Nombre maximal d'attentes mémorisées pour `maxRecentWaitMs`. */
const RECENT_WAIT_SAMPLES = 100;

function formatDelay(ms: number): string {
  return ms >= 1_000 ? `${Math.round(ms / 1_000)} s` : `${ms} ms`;
}

/** Photo de l'état du pool, exposée dans les diagnostics (`whoami`, `inbox_overview`). */
export interface PoolStats {
  /** Connexions ouvertes. */
  open: number;
  /** Connexions en cours d'utilisation. */
  inUse: number;
  /** Plafond (`IMAP_POOL_SIZE`). */
  max: number;
  /** Appels en file d'attente d'une connexion. */
  waiting: number;
  /** Plus longue attente d'une connexion sur les 15 dernières minutes (0 si aucune). */
  maxRecentWaitMs: number;
  /** Appels abandonnés après `IMAP_ACQUIRE_TIMEOUT_MS` depuis le démarrage. */
  acquireTimeouts: number;
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
  private recentWaits: { at: number; ms: number }[] = [];
  private acquireTimeouts = 0;

  constructor(
    private readonly maxSize: number,
    private readonly createRawClient: ImapClientFactory = defaultClientFactory,
    private readonly acquireTimeoutMs: number = config.IMAP_ACQUIRE_TIMEOUT_MS,
  ) {}

  async acquire(): Promise<ImapFlow> {
    if (this.closed) {
      throw new Error('Le pool de connexions IMAP est fermé');
    }

    const client = await this.tryClaim();
    if (client) {
      return client;
    }
    if (this.closed) {
      throw new Error('Le pool de connexions IMAP est fermé');
    }

    return this.enqueue();
  }

  /**
   * Met l'appel en file jusqu'à ce qu'une connexion se libère, au plus
   * `acquireTimeoutMs`. Un waiter n'est servi (`fulfillNextWaiter`) ou expiré
   * (`expire`) que s'il est encore dans la file, et il en est retiré avant
   * d'être réglé : jamais de double attribution ni de connexion perdue.
   */
  private enqueue(): Promise<ImapFlow> {
    const { inUse } = this.stats();
    log.warn(
      { waiting: this.waiters.length + 1, inUse, max: this.maxSize },
      'imap pool full, call queued',
    );

    return new Promise<ImapFlow>((resolve, reject) => {
      const waiter: Waiter = {
        enqueuedAt: Date.now(),
        resolve: (client) => {
          clearTimeout(waiter.timer);
          const waitedMs = this.recordWait(waiter);
          if (waitedMs >= SLOW_ACQUIRE_LOG_MS) {
            log.info(
              { waitedMs, waiting: this.waiters.length },
              'imap connection obtained after waiting',
            );
          }
          resolve(client);
        },
        reject: (err) => {
          clearTimeout(waiter.timer);
          reject(err);
        },
      };
      waiter.timer = setTimeout(() => this.expire(waiter), this.acquireTimeoutMs);
      this.waiters.push(waiter);
    });
  }

  private expire(waiter: Waiter): void {
    const index = this.waiters.indexOf(waiter);
    if (index === -1) {
      return; // déjà servi ou rejeté entre-temps
    }
    this.waiters.splice(index, 1);
    this.acquireTimeouts += 1;
    const waitedMs = this.recordWait(waiter);
    const { inUse } = this.stats();
    const waiting = this.waiters.length;
    log.warn({ waitedMs, waiting, inUse, max: this.maxSize }, 'imap pool acquire timed out');
    waiter.reject(
      new ImapPoolTimeoutError(
        `Pool IMAP saturé : aucune connexion libérée en ${formatDelay(this.acquireTimeoutMs)} ` +
          `(${inUse}/${this.maxSize} connexions occupées, ${waiting} autre(s) appel(s) en attente). ` +
          `Des appels longs (recherche multi-dossiers, gros téléchargements) monopolisent les ` +
          `connexions : réessaie dans un instant ; si cela se répète, augmente IMAP_POOL_SIZE ` +
          `(actuellement ${this.maxSize}) ou IMAP_ACQUIRE_TIMEOUT_MS.`,
      ),
    );
  }

  /** Mémorise la durée d'attente d'un waiter et la renvoie, en millisecondes. */
  private recordWait(waiter: Waiter): number {
    const now = Date.now();
    const ms = now - waiter.enqueuedAt;
    this.recentWaits.push({ at: now, ms });
    if (this.recentWaits.length > RECENT_WAIT_SAMPLES) {
      this.recentWaits.shift();
    }
    return ms;
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

  /** Photo de l'état du pool : connexions, file d'attente, attente récente. */
  stats(): PoolStats {
    const since = Date.now() - RECENT_WAIT_WINDOW_MS;
    this.recentWaits = this.recentWaits.filter((w) => w.at >= since);
    return {
      open: this.entries.length,
      inUse: this.entries.filter((e) => e.inUse).length,
      max: this.maxSize,
      waiting: this.waiters.length,
      maxRecentWaitMs: Math.max(0, ...this.recentWaits.map((w) => w.ms)),
      acquireTimeouts: this.acquireTimeouts,
    };
  }

  async close(): Promise<void> {
    this.closed = true;

    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) {
      waiter.reject(new Error('Le pool de connexions IMAP est en cours de fermeture'));
    }

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

    let client: ImapFlow | null;
    try {
      client = await this.tryClaim();
    } catch (err) {
      // Échec d'ouverture d'une connexion de remplacement : le premier en file
      // reçoit l'erreur plutôt que d'attendre son délai pour rien.
      this.waiters.shift()?.reject(err);
      return;
    }
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

    log.info({ host: account.imap.host }, 'imap connection established');
    return client;
  }

  private discard(client: ImapFlow): void {
    this.entries = this.entries.filter((e) => e.client !== client);
    void this.fulfillNextWaiter();
  }
}

export const imapPool = new ImapConnectionPool(config.IMAP_POOL_SIZE);
