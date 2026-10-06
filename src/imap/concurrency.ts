import { config } from '../config.js';

/**
 * Nombre de connexions qu'une opération multi-dossiers peut occuper à la fois :
 * toutes celles du pool sauf une, laissée libre pour les autres appels
 * (minimum 1, soit le parcours séquentiel avec un pool de 1 ou 2).
 */
export function folderConcurrency(poolSize: number = config.IMAP_POOL_SIZE): number {
  return Math.max(1, poolSize - 1);
}

/**
 * `items.map(fn)` avec au plus `limit` appels en cours à la fois. Les résultats
 * suivent l'ordre de `items`, quel que soit l'ordre d'achèvement. Au premier
 * échec, plus aucun élément n'est lancé et la promesse est rejetée avec cette
 * erreur ; les appels déjà en cours se terminent sans être attendus.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index] as T, index);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}
