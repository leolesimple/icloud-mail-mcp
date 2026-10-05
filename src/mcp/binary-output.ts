import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { isImageMimeType } from '../attachments.js';
import {
  downloadLinks,
  downloadUrl,
  type DownloadLinkService,
  type DownloadTarget,
} from '../download-links.js';
import { errorResult } from './result.js';

/**
 * Mise en forme d'un contenu binaire renvoyé par un outil (pièce jointe,
 * message brut), partagée par `get_attachment` et `export_message`.
 *
 * Aucun bloc `resource` : Claude Desktop les refuse (« not currently
 * supported ») dès que le type MIME n'est pas du texte, ce qui rendait les PDF
 * illisibles. Trois formats :
 *
 * - `auto` : image → bloc `image` ; tout le reste → bloc `text` JSON ;
 * - `text_base64` : toujours le bloc `text` JSON, images comprises ;
 * - `url` : lien signé, à usage unique, servi par `GET /download/:token`.
 */

export const BINARY_FORMATS = ['auto', 'text_base64', 'url'] as const;
export type BinaryFormat = (typeof BINARY_FORMATS)[number];

/** Paramètre `format` des outils, avec sa description pour le modèle. */
export const binaryFormatSchema = z
  .enum(BINARY_FORMATS)
  .default('auto')
  .describe(
    'Output format. "auto" (default): images as an image block, anything else as a text block ' +
      'holding JSON { filename, mimeType, size, contentBase64 }. "text_base64": always that JSON ' +
      'text block, images included. "url": JSON { url, expiresAt, filename, mimeType, size } with a ' +
      'signed download link, valid 15 minutes and usable once (requires PUBLIC_BASE_URL).',
  );

export const URL_FORMAT_UNAVAILABLE =
  'Le format "url" exige PUBLIC_BASE_URL (URL publique HTTPS du serveur), qui n’est pas configurée. ' +
  'Utilisez format "auto" ou "text_base64".';

/** Contenu binaire prêt à être mis en forme. */
export interface BinaryContent {
  filename: string;
  mimeType: string;
  content: Buffer;
}

export interface BinaryOutputOptions {
  format: BinaryFormat;
  /** Cible du lien, pour le format `url`. */
  target: DownloadTarget;
  /** `PUBLIC_BASE_URL`, sans slash final. Vide : le format `url` est refusé. */
  publicBaseUrl: string;
  /** Émetteur de liens. Défaut : le service partagé du serveur. */
  links?: DownloadLinkService;
}

/**
 * Refus anticipé du format demandé, avant toute lecture IMAP. `undefined` si
 * le format est utilisable.
 */
export function checkBinaryFormat(
  format: BinaryFormat,
  publicBaseUrl: string,
): CallToolResult | undefined {
  return format === 'url' && !publicBaseUrl ? errorResult(URL_FORMAT_UNAVAILABLE) : undefined;
}

export function binaryOutput(file: BinaryContent, options: BinaryOutputOptions): CallToolResult {
  const { format } = options;
  const size = file.content.length;

  if (format === 'url') {
    const refused = checkBinaryFormat(format, options.publicBaseUrl);
    if (refused) return refused;
    const { token, expiresAt } = (options.links ?? downloadLinks).issue(options.target);
    const data = {
      url: downloadUrl(options.publicBaseUrl, token),
      expiresAt: new Date(expiresAt).toISOString(),
      filename: file.filename,
      mimeType: file.mimeType,
      size,
    };
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }

  const contentBase64 = file.content.toString('base64');
  if (format === 'auto' && isImageMimeType(file.mimeType)) {
    return { content: [{ type: 'image', data: contentBase64, mimeType: file.mimeType }] };
  }

  const data = { filename: file.filename, mimeType: file.mimeType, size, contentBase64 };
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}
