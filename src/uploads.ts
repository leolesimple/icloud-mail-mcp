import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import { config } from './config.js';
import { sanitizeFilename as headerSafeFilename } from './download-links.js';

/**
 * Fichiers déposés hors du protocole MCP par `POST /upload/:token` (lien émis
 * par `create_upload_link`), puis attachés à un mail par `compose_message`
 * (`attachments[].uploadId`) sans transiter en base64 par le modèle.
 *
 * Stockage EN MÉMOIRE uniquement : un dépôt vit `UPLOAD_TTL_MS` (1 h) après le
 * dépôt, ou jusqu'à l'envoi du mail (ou l'enregistrement du brouillon) qui le
 * consomme, et ne survit pas à un redémarrage. Deux plafonds globaux
 * (`UPLOAD_MAX_FILES`, `UPLOAD_MAX_TOTAL_BYTES`) empêchent un client de saturer
 * la RAM ; chaque fichier reste en outre borné par `ATTACHMENT_MAX_BYTES`.
 */

/** Durée de conservation d'un dépôt : 1 heure. */
export const UPLOAD_TTL_MS = 60 * 60_000;

const UPLOAD_ID_BYTES = 16;
const FALLBACK_CONTENT_TYPE = 'application/octet-stream';

/** Nouvel identifiant de dépôt : 16 octets aléatoires en base64url (22 caractères). */
export function newUploadId(): string {
  return randomBytes(UPLOAD_ID_BYTES).toString('base64url');
}

export interface StoredUpload {
  uploadId: string;
  /** Absent si ni le lien ni la requête de dépôt ne l'ont donné. */
  filename?: string;
  contentType: string;
  size: number;
  content: Buffer;
  /** Instant d'expiration, en ms depuis l'epoch. */
  expiresAt: number;
}

export interface NewUpload {
  uploadId: string;
  filename?: string;
  contentType?: string;
  content: Buffer;
}

/** Levée quand un plafond global (nombre ou octets) serait dépassé. */
export class UploadStoreFullError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadStoreFullError';
  }
}

export interface UploadStore {
  /** Reserves bytes and one slot before reading an HTTP body. */
  reserve(
    uploadId: string,
    maxBytes: number,
  ): { commit(upload: NewUpload): StoredUpload; release(): void };
  /** Exclusively leases uploads until composition succeeds or fails. */
  claim(uploadIds: string[]): { uploads: StoredUpload[]; consume(): void; release(): void };
  /** Dépôt encore valide, ou `undefined` (inconnu, expiré, déjà consommé). */
  get(uploadId: string): StoredUpload | undefined;
  /** Range un dépôt. Lève `UploadStoreFullError` au-delà d'un plafond. */
  put(upload: NewUpload): StoredUpload;
  /** Consomme (supprime) un dépôt. `true` s'il existait. */
  delete(uploadId: string): boolean;
  /** Octets encore acceptables avant le plafond global ; 0 si le nombre maximal est atteint. */
  available(): number;
  /** Oublie les dépôts expirés. */
  sweep(): void;
  stats(): { count: number; bytes: number };
}

export interface UploadStoreOptions {
  maxFiles: number;
  maxTotalBytes: number;
  ttlMs?: number;
  /** Horloge, en ms. Injectable pour les tests. */
  now?: () => number;
}

export function createUploadStore(options: UploadStoreOptions): UploadStore {
  const ttlMs = options.ttlMs ?? UPLOAD_TTL_MS;
  const now = options.now ?? Date.now;
  const uploads = new Map<string, StoredUpload>();
  let bytes = 0;
  const reservations = new Map<string, number>();
  const claimed = new Set<string>();
  const pendingBytes = () => [...reservations.values()].reduce((sum, size) => sum + size, 0);

  function remove(uploadId: string): boolean {
    const upload = uploads.get(uploadId);
    if (!upload) return false;
    uploads.delete(uploadId);
    bytes -= upload.size;
    return true;
  }

  function sweep(): void {
    const current = now();
    for (const [uploadId, upload] of uploads) {
      if (upload.expiresAt <= current && !claimed.has(uploadId)) remove(uploadId);
    }
  }

  const store: UploadStore = {
    reserve(uploadId, maxBytes) {
      sweep();
      if (
        !Number.isSafeInteger(maxBytes) ||
        maxBytes < 0 ||
        uploads.has(uploadId) ||
        reservations.has(uploadId)
      ) {
        throw new UploadStoreFullError('Dépôt invalide ou déjà en cours.');
      }
      if (
        uploads.size + reservations.size >= options.maxFiles ||
        bytes + pendingBytes() + maxBytes > options.maxTotalBytes
      ) {
        throw new UploadStoreFullError('Stockage des dépôts plein (dépôts en cours inclus).');
      }
      reservations.set(uploadId, maxBytes);
      let active = true;
      return {
        commit(upload) {
          if (!active || upload.uploadId !== uploadId || upload.content.length > maxBytes)
            throw new Error('Réservation de dépôt invalide');
          reservations.delete(uploadId);
          active = false;
          return store.put(upload);
        },
        release() {
          if (active) reservations.delete(uploadId);
          active = false;
        },
      };
    },
    claim(uploadIds) {
      const ids = [...new Set(uploadIds)];
      const selected = ids.map((id) => {
        const upload = store.get(id);
        if (!upload || claimed.has(id))
          throw new Error('Dépôt indisponible ou déjà utilisé par une autre opération.');
        return upload;
      });
      ids.forEach((id) => claimed.add(id));
      let active = true;
      return {
        uploads: selected,
        consume() {
          if (active) ids.forEach((id) => remove(id));
          ids.forEach((id) => claimed.delete(id));
          active = false;
        },
        release() {
          if (active) ids.forEach((id) => claimed.delete(id));
          active = false;
        },
      };
    },
    get(uploadId) {
      const upload = uploads.get(uploadId);
      if (!upload) return undefined;
      if (upload.expiresAt <= now() && !claimed.has(uploadId)) {
        remove(uploadId);
        return undefined;
      }
      return upload;
    },

    put({ uploadId, filename, contentType, content }) {
      sweep();
      if (uploads.has(uploadId)) {
        throw new Error(`Dépôt ${uploadId} déjà présent`);
      }
      if (uploads.size + reservations.size >= options.maxFiles) {
        throw new UploadStoreFullError(
          `Trop de dépôts en attente (${options.maxFiles}, UPLOAD_MAX_FILES) : ` +
            'attacher ou laisser expirer les précédents.',
        );
      }
      if (bytes + pendingBytes() + content.length > options.maxTotalBytes) {
        throw new UploadStoreFullError(
          `Stockage des dépôts plein (${options.maxTotalBytes} octets, UPLOAD_MAX_TOTAL_BYTES) : ` +
            'attacher ou laisser expirer les précédents.',
        );
      }
      const upload: StoredUpload = {
        uploadId,
        ...(filename ? { filename } : {}),
        contentType: contentType ?? FALLBACK_CONTENT_TYPE,
        size: content.length,
        content,
        expiresAt: now() + ttlMs,
      };
      uploads.set(uploadId, upload);
      bytes += content.length;
      return upload;
    },

    delete: remove,

    available() {
      sweep();
      if (uploads.size + reservations.size >= options.maxFiles) return 0;
      return Math.max(options.maxTotalBytes - bytes - pendingBytes(), 0);
    },

    sweep,

    stats() {
      return { count: uploads.size, bytes };
    },
  };
  return store;
}

/** Stockage partagé du serveur (route `/upload` et `compose_message`). */
export const uploadStore: UploadStore = createUploadStore({
  maxFiles: config.UPLOAD_MAX_FILES,
  maxTotalBytes: config.UPLOAD_MAX_TOTAL_BYTES,
});

/**
 * Nom de fichier d'un dépôt : sans chemin (un client peut envoyer
 * `C:\dossier\x.pdf`), sans caractère de contrôle ni réservé, borné.
 * `undefined` s'il ne reste rien.
 */
export function sanitizeUploadFilename(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const base = posix.basename(name.replace(/\\/g, '/'));
  if (!base) return undefined;
  const safe = headerSafeFilename(base, '');
  return safe || undefined;
}

/**
 * Type MIME d'un dépôt, réduit à son essence (`type/sous-type`, paramètres
 * retirés) et en minuscules. `undefined` s'il est absent ou mal formé.
 * `application/x-www-form-urlencoded` (le défaut de `curl --data-binary`) est
 * traité comme absent : il ne décrit jamais le fichier.
 */
export function normalizeUploadContentType(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const essence = (value.split(';')[0] ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(essence)) return undefined;
  if (essence === 'application/x-www-form-urlencoded') return undefined;
  return essence;
}
