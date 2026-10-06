import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { PART_PATTERN } from './attachment-locator.js';
import type { AttachmentLocator } from './attachment-locator.js';

/**
 * Liens de téléchargement signés, servis par `GET /download/:token`.
 *
 * Certains clients MCP (Claude Desktop) refusent les blocs `resource` binaires :
 * le format `url` de `get_attachment` (et, plus tard, d'`export_message`) leur
 * renvoie à la place un lien court à ouvrir hors du protocole MCP, donc sans
 * bearer. Le lien porte lui-même son autorisation : une cible précise, signée,
 * qui expire vite et ne sert qu'une fois.
 *
 * Format (base64url, opaque) : payload JSON (version, cible, expiration en ms,
 * nonce) suivi du HMAC-SHA256 (32 octets) de ce payload. La cible circule en
 * clair (encodée, non chiffrée) : dossier, UID et index ou partie, aucun contenu.
 *
 * Ce module ne parle pas à IMAP : la route récupère le contenu de la cible.
 */

/** Durée de vie d'un lien : 15 minutes. */
export const DOWNLOAD_LINK_TTL_MS = 15 * 60_000;

const VERSION = 1;
const MAC_BYTES = 32;
const NONCE_BYTES = 16;
const MIN_SECRET_BYTES = 32;
/** Borne haute d'un jeton accepté : un nom de dossier IMAP reste court. */
const MAX_TOKEN_CHARS = 4096;

/** Ce que désigne un lien : une pièce jointe, ou un message entier (EML brut). */
export type DownloadTarget =
  | ({ kind: 'attachment'; folder: string; uid: number } & AttachmentLocator)
  | { kind: 'message'; folder: string; uid: number };

export interface IssuedDownloadLink {
  token: string;
  /** Instant d'expiration, en ms depuis l'epoch. */
  expiresAt: number;
}

/** Motif d'un refus. Réservé aux logs : la route répond un 404 générique. */
export type DownloadLinkRefusal = 'malformed' | 'forged' | 'expired' | 'replayed';

export type RedeemResult =
  { ok: true; target: DownloadTarget } | { ok: false; reason: DownloadLinkRefusal };

export interface DownloadLinkService {
  issue(target: DownloadTarget): IssuedDownloadLink;
  /** Vérifie le jeton et le consomme : un second appel avec le même jeton est refusé. */
  redeem(token: string): RedeemResult;
  /** Oublie les nonces consommés dont l'expiration est passée. */
  sweep(): void;
}

export interface DownloadLinkServiceOptions {
  /** Secret HMAC. Absent : 32 octets aléatoires, propres à cette instance. */
  secret?: string | Buffer;
  /** Horloge, en ms. Injectable pour les tests. */
  now?: () => number;
  ttlMs?: number;
}

interface Payload {
  v: number;
  t: DownloadTarget;
  exp: number;
  n: string;
}

const isUid = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;

/** Relit une cible signée. Le HMAC est déjà vérifié : ceci ne protège que d'un bug d'émission. */
function parseTarget(value: unknown): DownloadTarget | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const t = value as Record<string, unknown>;
  if (typeof t.folder !== 'string' || t.folder.length === 0 || !isUid(t.uid)) return undefined;
  if (t.kind === 'message') return { kind: 'message', folder: t.folder, uid: t.uid };
  if (t.kind === 'attachment' && Number.isSafeInteger(t.index) && (t.index as number) >= 0) {
    if (t.part !== undefined) return undefined;
    return { kind: 'attachment', folder: t.folder, uid: t.uid, index: t.index as number };
  }
  // Pièce jointe désignée par son numéro de partie IMAP (voir attachment-locator.ts).
  if (t.kind === 'attachment' && typeof t.part === 'string' && PART_PATTERN.test(t.part)) {
    if (t.index !== undefined) return undefined;
    return { kind: 'attachment', folder: t.folder, uid: t.uid, part: t.part };
  }
  return undefined;
}

function parsePayload(bytes: Buffer): Payload | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== 'object') return undefined;
  const p = raw as Record<string, unknown>;
  const target = parseTarget(p.t);
  if (p.v !== VERSION || !target || !Number.isSafeInteger(p.exp) || typeof p.n !== 'string') {
    return undefined;
  }
  return { v: VERSION, t: target, exp: p.exp as number, n: p.n };
}

export function createDownloadLinkService(
  options: DownloadLinkServiceOptions = {},
): DownloadLinkService {
  const secret =
    options.secret === undefined ? randomBytes(MIN_SECRET_BYTES) : Buffer.from(options.secret);
  if (secret.length < MIN_SECRET_BYTES) {
    throw new Error(
      `Le secret des liens de téléchargement doit faire au moins ${MIN_SECRET_BYTES} octets`,
    );
  }
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DOWNLOAD_LINK_TTL_MS;
  // Nonces déjà consommés → expiration. Seul un jeton authentique y entre :
  // un tiers ne peut pas la faire grossir avec des jetons forgés.
  const consumed = new Map<string, number>();

  const mac = (payload: Buffer) => createHmac('sha256', secret).update(payload).digest();

  function sweep(): void {
    const current = now();
    for (const [nonce, expiry] of consumed) {
      if (expiry <= current) consumed.delete(nonce);
    }
  }

  return {
    issue(target) {
      const expiresAt = now() + ttlMs;
      const payload: Payload = {
        v: VERSION,
        t: target,
        exp: expiresAt,
        n: randomBytes(NONCE_BYTES).toString('base64url'),
      };
      const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
      return {
        token: Buffer.concat([bytes, mac(bytes)]).toString('base64url'),
        expiresAt,
      };
    },

    redeem(token) {
      if (
        typeof token !== 'string' ||
        token.length > MAX_TOKEN_CHARS ||
        !/^[A-Za-z0-9_-]+$/.test(token)
      ) {
        return { ok: false, reason: 'malformed' };
      }
      const raw = Buffer.from(token, 'base64url');
      if (raw.length <= MAC_BYTES) return { ok: false, reason: 'malformed' };

      const bytes = raw.subarray(0, raw.length - MAC_BYTES);
      // Signature d'abord, en temps constant : rien n'est lu d'un jeton non authentifié.
      if (!timingSafeEqual(raw.subarray(raw.length - MAC_BYTES), mac(bytes))) {
        return { ok: false, reason: 'forged' };
      }
      const payload = parsePayload(bytes);
      if (!payload) return { ok: false, reason: 'malformed' };

      sweep();
      if (payload.exp <= now()) return { ok: false, reason: 'expired' };
      if (consumed.has(payload.n)) return { ok: false, reason: 'replayed' };
      consumed.set(payload.n, payload.exp);
      return { ok: true, target: payload.t };
    },

    sweep,
  };
}

/** Service partagé du serveur, sur `DOWNLOAD_URL_SECRET` ou un secret tiré au démarrage. */
export const downloadLinks: DownloadLinkService = createDownloadLinkService({
  secret: config.DOWNLOAD_URL_SECRET,
});

/** URL publique d'un jeton. `baseUrl` sans slash final (comme `PUBLIC_BASE_URL`). */
export function downloadUrl(baseUrl: string, token: string): string {
  return `${baseUrl}/download/${token}`;
}

/**
 * Nom de fichier sûr pour `Content-Disposition` : ni chemin, ni caractère de
 * contrôle, ni guillemet, longueur bornée. Vide après nettoyage → `fallback`.
 */
export function sanitizeFilename(name: string | undefined, fallback = 'download'): string {
  const cleaned = (name ?? '')
    .normalize('NFC')
    // Contrôles C0/C1, séparateurs de chemin, caractères réservés des en-têtes.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f/\\"<>:|?*]/g, '_')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 200);
  return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * En-tête `Content-Disposition: attachment` (RFC 6266) : `filename` ASCII de
 * repli, plus `filename*` encodé UTF-8 pour les noms accentués.
 */
export function contentDisposition(name: string | undefined, fallback?: string): string {
  const safe = sanitizeFilename(name, fallback);
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_').replace(/[%;]/g, '_');
  const encoded = encodeURIComponent(safe).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
