import { convert } from 'html-to-text';
import type { FullMessage } from '../imap/messages.js';

/**
 * Mise en forme du corps d'un message pour la réponse MCP : conversion
 * HTML → texte quand la partie texte manque, et surtout maîtrise de la taille
 * — aujourd'hui `get_message` déverse le corps entier (texte ET HTML brut)
 * dans le contexte du client, ce qui est le premier poste de gaspillage.
 */

export interface BodyOptions {
  /** Longueur max, en caractères, de chaque partie renvoyée. */
  maxBodyChars: number;
  /** Inclure la partie HTML brute. `false` par défaut côté outil. */
  includeHtml: boolean;
}

export interface PreparedBody {
  /** Corps texte (issu de la partie texte, ou converti depuis le HTML). */
  text?: string;
  /** Partie HTML si `includeHtml`, sinon `false`. */
  html: string | false;
  /** `true` dès qu'une partie a été coupée : la troncature n'est jamais silencieuse. */
  bodyTruncated: boolean;
}

const HTML_TO_TEXT_OPTIONS: Record<string, unknown> = { wordwrap: false };

/** Convertit une partie HTML en texte lisible. */
export function htmlToPlainText(html: string): string {
  return convert(html, HTML_TO_TEXT_OPTIONS).trim();
}

function truncate(value: string, max: number): { value: string; truncated: boolean } {
  return value.length <= max ? { value, truncated: false } : { value: value.slice(0, max), truncated: true };
}

export function prepareMessageBody(
  message: Pick<FullMessage, 'text' | 'html'>,
  options: BodyOptions,
): PreparedBody {
  const rawText = message.text ?? (message.html ? htmlToPlainText(message.html) : undefined);

  let bodyTruncated = false;

  let text: string | undefined;
  if (rawText !== undefined) {
    const cut = truncate(rawText, options.maxBodyChars);
    text = cut.value;
    bodyTruncated ||= cut.truncated;
  }

  let html: string | false = false;
  if (options.includeHtml && message.html) {
    const cut = truncate(message.html, options.maxBodyChars);
    html = cut.value;
    bodyTruncated ||= cut.truncated;
  }

  return { text, html, bodyTruncated };
}

/**
 * Bloc d'en-têtes brut d'un message RFC 5322 : tout jusqu'à la première ligne
 * vide, corps exclu. Utile pour `List-Unsubscribe`, la signature DKIM, ou le
 * débogage d'un message mal rendu.
 */
export function extractRawHeaders(source: Buffer | string): string {
  const text = typeof source === 'string' ? source : source.toString('utf8');
  const crlf = text.indexOf('\r\n\r\n');
  const lf = text.indexOf('\n\n');

  if (crlf !== -1 && (lf === -1 || crlf < lf)) {
    return text.slice(0, crlf);
  }
  if (lf !== -1) {
    return text.slice(0, lf);
  }
  return text.trimEnd();
}
