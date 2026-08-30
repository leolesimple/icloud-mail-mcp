import { config } from '../config.js';

/**
 * Quota d'envoi glissant sur 24 h, en mémoire.
 *
 * Module pur, sans dépendance réseau : l'horloge est injectable pour que les
 * tests fassent avancer le temps sans attendre.
 *
 * **Non persisté.** Un redémarrage du process remet le compteur à zéro. C'est un
 * choix assumé (voir `docs/security.md`) : le quota protège d'une boucle d'envoi
 * d'un agent qui déraille au sein d'une même exécution, pas d'un opérateur qui
 * relance délibérément le serveur.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

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
  private readonly sends: number[] = [];

  /**
   * @param limit Nombre max d'envois sur 24 h glissantes. `0` (ou négatif) = illimité.
   * @param clock Horloge, injectable pour les tests.
   */
  constructor(
    private readonly limit: number,
    private readonly clock: Clock = systemClock,
  ) {}

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
    this.sends.push(this.clock.now());
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

/** Instance partagée par le process, dimensionnée par `MAX_SENDS_PER_DAY`. */
export const sendQuota = new SendQuota(config.MAX_SENDS_PER_DAY);

/** Photo du quota partagé, en lecture seule. Point d'entrée pour `whoami` (lot E). */
export function getQuotaStatus(): QuotaStatus {
  return sendQuota.status();
}
