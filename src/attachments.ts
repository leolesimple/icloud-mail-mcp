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

  const decoded: ComposeAttachment[] = items.map((item) => ({
    filename: item.filename,
    contentType: item.contentType,
    content: Buffer.from(item.contentBase64, 'base64'),
  }));

  const total = decoded.reduce((sum, attachment) => sum + attachment.content.length, 0);
  if (total > maxBytes) {
    throw new AttachmentTooLargeError(
      `Pièces jointes trop volumineuses : ${total} octets au total, ` +
        `au-delà de la limite de ${maxBytes} octets (ATTACHMENT_MAX_BYTES).`,
    );
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

/** Une pièce jointe image est renvoyée en bloc `image`, les autres en `resource`. */
export function isImageMimeType(contentType: string | undefined): boolean {
  return typeof contentType === 'string' && /^image\//i.test(contentType.trim());
}
