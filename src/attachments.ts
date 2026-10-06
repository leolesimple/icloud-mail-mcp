import type { ComposeAttachment } from './smtp/compose.js';

/**
 * Pièces jointes : décodage base64 → Buffer et contrôle de taille. Module pur
 * (aucun accès réseau, aucune dépendance IMAP/SMTP), testé directement.
 */

/** Levée quand le cumul des pièces jointes dépasse `ATTACHMENT_MAX_BYTES`. */
export class AttachmentTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentTooLargeError';
  }
}

/** Pièce jointe telle que la fournit un appelant MCP (contenu en base64). */
export interface InboundAttachment {
  filename: string;
  contentType?: string;
  contentBase64: string;
}

/** Decoded byte count without creating an intermediate string or Buffer. */
export function decodedBase64Size(value: string): number {
  let digits = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code > 127) throw new Error('Contenu base64 invalide : caractères non ASCII.');
    if (code === 61) break;
    if (
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47 ||
      code === 45 ||
      code === 95
    )
      digits++;
  }
  return Math.floor((digits * 3) / 4);
}

/**
 * Décode une liste de pièces jointes base64 en `ComposeAttachment`. Refuse si le
 * cumul dépasse `maxBytes` — jamais de troncature silencieuse.
 */
export function decodeInboundAttachments(
  items: InboundAttachment[] | undefined,
  maxBytes: number,
): ComposeAttachment[] {
  if (!items || items.length === 0) {
    return [];
  }

  // Preflight all inputs before allocating decoded buffers. Node accepts
  // whitespace and the URL-safe alphabet; padding ends the encoded payload.
  const total = items.reduce((sum, item) => sum + decodedBase64Size(item.contentBase64), 0);
  if (total > maxBytes) {
    throw new AttachmentTooLargeError(
      `Pièces jointes trop volumineuses : ${total} octets au total, ` +
        `au-delà de la limite de ${maxBytes} octets (ATTACHMENT_MAX_BYTES).`,
    );
  }
  const decoded: ComposeAttachment[] = [];
  let actual = 0;
  for (const item of items) {
    const content = Buffer.from(item.contentBase64, 'base64');
    actual += content.length;
    if (actual > maxBytes)
      throw new AttachmentTooLargeError('Limite ATTACHMENT_MAX_BYTES dépassée.');
    decoded.push({ filename: item.filename, contentType: item.contentType, content });
  }

  return decoded;
}

/**
 * Refuse la lecture d'une pièce jointe dont le contenu dépasse `maxBytes`, en
 * mentionnant la taille réelle ET la limite.
 */
export function assertReadableSize(actualBytes: number, maxBytes: number): void {
  if (actualBytes > maxBytes) {
    throw new AttachmentTooLargeError(
      `Pièce jointe de ${actualBytes} octets, au-delà de la limite de ${maxBytes} octets ` +
        `(ATTACHMENT_MAX_BYTES). Récupérez-la depuis Mail.app.`,
    );
  }
}

/** En format `auto`, une pièce jointe image est renvoyée en bloc `image` (voir `src/mcp/binary-output.ts`). */
export function isImageMimeType(contentType: string | undefined): boolean {
  return typeof contentType === 'string' && /^image\//i.test(contentType.trim());
}
