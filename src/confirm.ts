import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

/**
 * Jetons de confirmation des opérations destructives (vidage de corbeille,
 * expunge, envoi…).
 *
 * Un jeton lie une opération précise : son nom, le dossier visé, l'UIDVALIDITY
 * de ce dossier et une empreinte des paramètres qui comptent (UID triés,
 * destinataires + sujet + hash du corps…). Il ne valide aucune autre
 * opération, expire vite et ne sert qu'une fois.
 *
 * Format (base64url, opaque) : version (1 octet) | expiration en ms (8 octets,
 * big-endian) | nonce (16 octets) | HMAC-SHA256 (32 octets). Le HMAC couvre
 * l'en-tête ET le binding : le binding n'est pas transporté, il est recalculé
 * par l'appelant à la vérification.
 *
 * Ce module ne parle pas à IMAP : l'appelant lit l'UIDVALIDITY
 * (`client.mailbox.uidValidity`, sous verrou) et la passe dans le binding.
 */

/** Durée de vie par défaut d'un jeton : 2 minutes. */
export const CONFIRM_TOKEN_TTL_MS = 2 * 60_000;

const VERSION = 1;
const HEADER_BYTES = 1 + 8 + 16;
const MAC_BYTES = 32;
const TOKEN_BYTES = HEADER_BYTES + MAC_BYTES;
const MIN_SECRET_BYTES = 32;

/** Ce à quoi un jeton est lié, en plus du nom de l'opération. */
export interface ConfirmBinding {
  /** Dossier visé. Absent pour une opération sans dossier (ex. un envoi). */
  folder?: string;
  /** UIDVALIDITY du dossier au moment de l'émission (imapflow la donne en bigint). */
  uidValidity?: bigint | number;
  /**
   * Paramètres qui comptent, sérialisables en JSON (bigint accepté). Ils sont
   * réduits à une empreinte : l'ordre des clés d'objet est indifférent, celui
   * des tableaux compte (trier les UID avant de les passer).
   */
  params?: unknown;
}

export type ConfirmTokenErrorCode = 'malformed' | 'mismatch' | 'expired' | 'replayed';

const ERROR_MESSAGES: Record<ConfirmTokenErrorCode, string> = {
  malformed:
    'Jeton de confirmation illisible. Relancez l’opération sans jeton pour en obtenir un nouveau.',
  mismatch:
    'Jeton de confirmation invalide pour cette opération (opération, dossier, paramètres ou état du dossier différents). Relancez l’opération sans jeton pour en obtenir un nouveau.',
  expired:
    'Jeton de confirmation expiré. Relancez l’opération sans jeton pour en obtenir un nouveau.',
  replayed:
    'Ce jeton de confirmation a déjà servi. Relancez l’opération sans jeton pour en obtenir un nouveau.',
};

/** Refus d'un jeton. `message` est destiné à l'utilisateur et ne contient aucun secret. */
export class ConfirmTokenError extends Error {
  readonly code: ConfirmTokenErrorCode;

  constructor(code: ConfirmTokenErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'ConfirmTokenError';
    this.code = code;
  }
}

export interface IssuedConfirmToken {
  token: string;
  /** Instant d'expiration, en ms depuis l'epoch. */
  expiresAt: number;
}

export interface ConfirmTokenService {
  issue(operation: string, binding: ConfirmBinding): IssuedConfirmToken;
  /** Vérifie le jeton et le consomme. Lève `ConfirmTokenError` en cas de refus. */
  verify(token: string, operation: string, binding: ConfirmBinding): void;
}

export interface ConfirmTokenServiceOptions {
  /** Secret HMAC. Absent : 32 octets aléatoires, propres à cette instance. */
  secret?: string | Buffer;
  /** Horloge, en ms. Injectable pour les tests. */
  now?: () => number;
  ttlMs?: number;
}

/**
 * Sérialisation JSON canonique : clés d'objet triées, bigint en chaîne
 * préfixée (pour ne pas confondre `1n` et `"1"`), `undefined` retiré des
 * objets comme le fait `JSON.stringify`.
 */
function canonicalJson(value: unknown): string {
  if (typeof value === 'bigint') return JSON.stringify(`bigint:${value.toString()}`);
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'function' || typeof value === 'symbol') {
      throw new TypeError('Paramètre non sérialisable dans un binding de confirmation');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.keys(value)
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
    );
  return `{${entries.join(',')}}`;
}

/** Empreinte SHA-256 de l'opération et de son binding. */
function bindingDigest(operation: string, binding: ConfirmBinding): Buffer {
  const material = canonicalJson([
    operation,
    binding.folder ?? null,
    binding.uidValidity === undefined ? null : BigInt(binding.uidValidity),
    binding.params ?? null,
  ]);
  return createHash('sha256').update(material).digest();
}

export function createConfirmTokenService(
  options: ConfirmTokenServiceOptions = {},
): ConfirmTokenService {
  const secret =
    options.secret === undefined ? randomBytes(MIN_SECRET_BYTES) : Buffer.from(options.secret);
  if (secret.length < MIN_SECRET_BYTES) {
    throw new Error(
      `Le secret des jetons de confirmation doit faire au moins ${MIN_SECRET_BYTES} octets`,
    );
  }
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? CONFIRM_TOKEN_TTL_MS;
  // Nonces déjà consommés → expiration. Purgé à chaque vérification : la Map
  // ne contient jamais que des jetons encore dans leur fenêtre de validité.
  const consumed = new Map<string, number>();

  const mac = (header: Buffer, digest: Buffer) =>
    createHmac('sha256', secret).update(header).update(digest).digest();

  return {
    issue(operation, binding) {
      const expiresAt = now() + ttlMs;
      const header = Buffer.alloc(HEADER_BYTES);
      header.writeUInt8(VERSION, 0);
      header.writeBigUInt64BE(BigInt(expiresAt), 1);
      randomBytes(16).copy(header, 9);
      const token = Buffer.concat([header, mac(header, bindingDigest(operation, binding))]);
      return { token: token.toString('base64url'), expiresAt };
    },

    verify(token, operation, binding) {
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]+$/.test(token)) {
        throw new ConfirmTokenError('malformed');
      }
      const raw = Buffer.from(token, 'base64url');
      if (raw.length !== TOKEN_BYTES || raw.readUInt8(0) !== VERSION) {
        throw new ConfirmTokenError('malformed');
      }
      const header = raw.subarray(0, HEADER_BYTES);
      const expected = mac(header, bindingDigest(operation, binding));
      // Signature d'abord : on ne lit l'expiration qu'une fois le jeton authentifié.
      if (!timingSafeEqual(raw.subarray(HEADER_BYTES), expected)) {
        throw new ConfirmTokenError('mismatch');
      }

      const current = now();
      for (const [nonce, expiry] of consumed) {
        if (expiry <= current) consumed.delete(nonce);
      }

      const expiresAt = Number(header.readBigUInt64BE(1));
      if (expiresAt <= current) throw new ConfirmTokenError('expired');

      const nonce = header.subarray(9).toString('hex');
      if (consumed.has(nonce)) throw new ConfirmTokenError('replayed');
      consumed.set(nonce, expiresAt);
    },
  };
}

/** Service partagé du serveur, sur `CONFIRM_SECRET` ou un secret tiré au démarrage. */
export const confirmTokens: ConfirmTokenService = createConfirmTokenService({
  secret: config.CONFIRM_SECRET,
});

export function issueConfirmToken(operation: string, binding: ConfirmBinding): IssuedConfirmToken {
  return confirmTokens.issue(operation, binding);
}

export function verifyConfirmToken(
  token: string,
  operation: string,
  binding: ConfirmBinding,
): void {
  confirmTokens.verify(token, operation, binding);
}
