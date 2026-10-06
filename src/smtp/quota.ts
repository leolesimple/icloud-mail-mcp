import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Quota d'envoi glissant sur 24 h.
 *
 * Sans dépendance réseau : l'horloge et le stockage sont injectables pour que
 * les tests fassent avancer le temps sans attendre et sans toucher au disque.
 *
 * **Persistance optionnelle.** Si `QUOTA_STATE_PATH` est défini, les horodatages
 * des envois sont rechargés au démarrage et réécrits (atomiquement) à chaque
 * envoi : un redémarrage ne remet plus le compteur à zéro. Vide (défaut), le
 * compteur reste en mémoire seule et repart à zéro au redémarrage (voir
 * `docs/configuration.md`).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** Stockage des horodatages d'envoi (ms epoch). */
export interface QuotaStore {
  /** Horodatages connus. Ne lève jamais : un état illisible vaut liste vide. */
  load(): number[];
  /** Remplace l'état persisté. Ne lève jamais : un échec est loggué. */
  save(sends: readonly number[]): void;
}

/** Aucun stockage : compteur en mémoire seule (comportement historique). */
export const memoryStore: QuotaStore = {
  load: () => [],
  save: () => {},
};

const log = logger.child({ module: 'quota' });

/**
 * Stockage dans un fichier JSON `{ "sends": [ms, ...] }`. Écriture atomique
 * (fichier temporaire puis `rename`), dossier parent créé au besoin. Fichier
 * absent = état vide ; fichier corrompu = `warn` et état vide, jamais de crash.
 */
export function fileStore(
  path: string,
  warn: (obj: object, msg: string) => void = (o, m) => log.warn(o, m),
): QuotaStore {
  return {
    load() {
      let raw: string;
      try {
        raw = readFileSync(path, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          warn({ err, path }, 'quota d’envoi : état illisible, compteur repris à zéro');
        }
        return [];
      }
      try {
        const sends = (JSON.parse(raw) as { sends?: unknown }).sends;
        if (
          !Array.isArray(sends) ||
          !sends.every((t) => typeof t === 'number' && Number.isFinite(t))
        ) {
          throw new Error('format inattendu');
        }
        return sends as number[];
      } catch (err) {
        warn({ err, path }, 'quota d’envoi : état corrompu, compteur repris à zéro');
        return [];
      }
    },
    save(sends) {
      const tmp = `${path}.${process.pid}.tmp`;
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(tmp, JSON.stringify({ sends }));
        renameSync(tmp, path);
      } catch (err) {
        warn(
          { err, path },
          'quota d’envoi : écriture de l’état impossible, compteur conservé en mémoire',
        );
      }
    },
  };
}

/**
 * Photo du quota, en LECTURE SEULE (aucun effet de bord — ne consomme pas de
 * crédit). Destinée à un affichage type `whoami`.
 */
export interface QuotaStatus {
  /** `MAX_SENDS_PER_DAY` tel que configuré. `0` = illimité. */
  limit: number;
  /** `true` si `limit <= 0` : aucun plafond. */
  unlimited: boolean;
  /** Envois comptabilisés dans les dernières 24 h. */
  used: number;
  /** Envois restants avant refus, ou `null` si illimité. */
  remaining: number | null;
  /** Instant où le plus ancien envoi sort de la fenêtre (undefined si aucun envoi récent). */
  resetsAt?: Date;
}

export class SendQuota {
  private readonly sends: number[];

  /**
   * @param limit Nombre max d'envois sur 24 h glissantes. `0` (ou négatif) = illimité.
   * @param clock Horloge, injectable pour les tests.
   * @param store Stockage des horodatages, chargé à la construction et réécrit à chaque `record()`.
   */
  constructor(
    private readonly limit: number,
    private readonly clock: Clock = systemClock,
    private readonly store: QuotaStore = memoryStore,
  ) {
    // `prune` suppose un tableau trié : on ne fait pas confiance à l'ordre du fichier.
    this.sends = store.load().sort((a, b) => a - b);
    this.prune(clock.now());
  }

  private prune(now: number): void {
    const cutoff = now - DAY_MS;
    // Les horodatages sont insérés dans l'ordre : on retire par la tête.
    let drop = 0;
    while (drop < this.sends.length && this.sends[drop]! <= cutoff) {
      drop += 1;
    }
    if (drop > 0) {
      this.sends.splice(0, drop);
    }
  }

  /** Nombre d'envois comptabilisés dans les dernières 24 h. */
  count(): number {
    this.prune(this.clock.now());
    return this.sends.length;
  }

  /** Limite configurée (`0` = illimité). */
  get max(): number {
    return this.limit;
  }

  /** `true` si un envoi de plus dépasserait la limite. Toujours `false` si illimité. */
  wouldExceed(): boolean {
    if (this.limit <= 0) {
      return false;
    }
    return this.count() >= this.limit;
  }

  /** Comptabilise un envoi réussi. */
  record(): void {
    const now = this.clock.now();
    this.prune(now);
    this.sends.push(now);
    this.store.save(this.sends);
  }

  /**
   * Photo du quota, sans effet de bord. Ne consomme rien : sûr à appeler depuis
   * un outil de lecture (`whoami`).
   */
  status(): QuotaStatus {
    const now = this.clock.now();
    this.prune(now);
    const used = this.sends.length;
    const unlimited = this.limit <= 0;
    const oldest = this.sends[0];
    return {
      limit: this.limit,
      unlimited,
      used,
      remaining: unlimited ? null : Math.max(0, this.limit - used),
      resetsAt: oldest === undefined ? undefined : new Date(oldest + DAY_MS),
    };
  }
}

/** Stockage correspondant à `QUOTA_STATE_PATH` : vide = mémoire seule, sinon fichier. */
export function quotaStoreFor(path: string): QuotaStore {
  return path === '' ? memoryStore : fileStore(path);
}

/**
 * Instance partagée par le process, dimensionnée par `MAX_SENDS_PER_DAY` et
 * persistée dans `QUOTA_STATE_PATH` s'il est défini.
 */
export const sendQuota = new SendQuota(
  config.MAX_SENDS_PER_DAY,
  systemClock,
  quotaStoreFor(config.QUOTA_STATE_PATH),
);

/** Photo du quota partagé, en lecture seule. Point d'entrée pour `whoami` (lot E). */
export function getQuotaStatus(): QuotaStatus {
  return sendQuota.status();
}
