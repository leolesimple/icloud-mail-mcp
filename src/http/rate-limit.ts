/**
 * Limiteur de débit à fenêtre glissante, par clé (l'IP appelante).
 *
 * Module pur, sans dépendance à Express : `allow()` prend et rend des données
 * simples, l'horloge est injectable pour les tests. Implémentation maison
 * volontaire — le besoin ne justifie pas d'ajouter `express-rate-limit`.
 */

export interface Clock {
  now(): number;
}

const systemClock: Clock = { now: () => Date.now() };

export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();

  /**
   * @param limit Requêtes autorisées par fenêtre et par clé.
   * @param windowMs Largeur de la fenêtre glissante (défaut 60 s).
   * @param clock Horloge, injectable pour les tests.
   */
  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
    private readonly clock: Clock = systemClock,
  ) {}

  /**
   * Comptabilise une requête pour `key` et indique si elle est autorisée.
   * Une requête refusée n'est pas comptée (elle ne repousse pas la fenêtre).
   */
  allow(key: string): boolean {
    const now = this.clock.now();
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);

    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }

    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  /**
   * Retire les clés sans requête récente. À appeler périodiquement : sans ça, la
   * `Map` accumule une entrée par IP vue depuis le démarrage.
   */
  sweep(): void {
    const cutoff = this.clock.now() - this.windowMs;
    for (const [key, times] of this.hits) {
      const recent = times.filter((t) => t > cutoff);
      if (recent.length === 0) {
        this.hits.delete(key);
      } else {
        this.hits.set(key, recent);
      }
    }
  }

  /** Nombre de clés actuellement suivies (diagnostic / tests). */
  get size(): number {
    return this.hits.size;
  }
}
