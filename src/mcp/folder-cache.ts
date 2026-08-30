import { listFolders } from '../imap/folders.js';

/**
 * Cache court de la liste des chemins de dossiers, pour la complétion de
 * l'argument `folder` (prompts et resources). Sans lui, chaque frappe de
 * l'utilisateur déclencherait une commande IMAP LIST sur un pool de 2
 * connexions.
 */

const DEFAULT_TTL_MS = 60_000;

export interface FolderCache {
  paths(): Promise<string[]>;
  reset(): void;
}

export function createFolderCache(
  load: () => Promise<string[]>,
  ttlMs: number = DEFAULT_TTL_MS,
  now: () => number = Date.now,
): FolderCache {
  let entry: { paths: string[]; at: number } | undefined;
  let inflight: Promise<string[]> | undefined;

  return {
    async paths() {
      if (entry && now() - entry.at < ttlMs) {
        return entry.paths;
      }
      if (!inflight) {
        inflight = load()
          .then((paths) => {
            entry = { paths, at: now() };
            return paths;
          })
          .finally(() => {
            inflight = undefined;
          });
      }
      return inflight;
    },
    reset() {
      entry = undefined;
      inflight = undefined;
    },
  };
}

/** Filtre la liste des dossiers sur la saisie en cours (sous-chaîne, casse ignorée). */
export function filterFolderPaths(paths: string[], value: string, limit = 100): string[] {
  const needle = value.trim().toLowerCase();
  const matched = needle ? paths.filter((path) => path.toLowerCase().includes(needle)) : paths;
  return matched.slice(0, limit);
}

const folderCache = createFolderCache(() => listFolders().then((folders) => folders.map((folder) => folder.path)));

/**
 * Callback de complétion pour un argument `folder`. Ne remonte jamais d'erreur :
 * une complétion est un confort, pas une opération critique.
 */
export async function completeFolder(value: string): Promise<string[]> {
  const paths = await folderCache.paths().catch(() => [] as string[]);
  return filterFolderPaths(paths, value);
}

/** Vide le cache du module (tests). */
export function resetFolderCache(): void {
  folderCache.reset();
}
