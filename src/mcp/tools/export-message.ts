import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getMessageSource } from '../../imap/messages.js';
import { config } from '../../config.js';
import type { DownloadLinkService } from '../../download-links.js';
import { errorResult } from '../result.js';
import {
  binaryFormatSchema,
  binaryOutput,
  checkBinaryFormat,
  type BinaryFormat,
} from '../binary-output.js';
import { logger } from '../../logger.js';

const log = logger.child({ tool: 'export_message' });

export interface ExportMessageOptions {
  format: BinaryFormat;
  /** Taille maximale du message (`ATTACHMENT_MAX_BYTES`). */
  maxBytes: number;
  /** `PUBLIC_BASE_URL`, pour le format `url`. */
  publicBaseUrl: string;
  /** Émetteur de liens. Défaut : le service partagé du serveur. */
  links?: DownloadLinkService;
  /** Lecture de la source brute. Défaut : `getMessageSource` (IMAP). */
  fetchMessageSource?: (folder: string, uid: number) => Promise<Buffer>;
}

/**
 * Message brut au format EML (`message/rfc822`), mis en forme par
 * `binaryOutput` : `auto` et `text_base64` donnent le même bloc `text` JSON
 * (ce n'est jamais une image), `url` un lien signé de cible `message`, servi
 * par `GET /download/:token`. Au-delà de `maxBytes`, refus sans troncature.
 */
export async function exportMessage(
  folder: string,
  uid: number,
  options: ExportMessageOptions,
): Promise<CallToolResult> {
  const refused = checkBinaryFormat(options.format, options.publicBaseUrl);
  if (refused) return refused;

  const source = await (options.fetchMessageSource ?? getMessageSource)(folder, uid);
  if (source.length > options.maxBytes) {
    return errorResult(
      `Message de ${source.length} octets, au-delà de la limite de ${options.maxBytes} octets ` +
        `(ATTACHMENT_MAX_BYTES). Exportez-le depuis Mail.app.`,
    );
  }

  return binaryOutput(
    { filename: `message-${uid}.eml`, contentType: 'message/rfc822', content: source },
    {
      format: options.format,
      target: { kind: 'message', folder, uid },
      publicBaseUrl: options.publicBaseUrl,
      links: options.links,
    },
  );
}

export function registerExportMessageTool(server: McpServer): void {
  server.registerTool(
    'export_message',
    {
      title: 'Export message',
      description:
        'Exports an email message (courriel) as a raw EML file (message/rfc822), headers, body and ' +
        'attachments included, e.g. to archive it or open it in another mail client. Formats "auto" ' +
        'and "text_base64" return a text block holding JSON { filename: "message-<uid>.eml", ' +
        'contentType, size, contentBase64 }; "url" returns a signed, single-use download link valid 15 ' +
        'minutes. Messages larger than ATTACHMENT_MAX_BYTES are refused rather than truncated.',
      inputSchema: {
        folder: z.string().min(1).default('INBOX').describe('Folder containing the message'),
        uid: z.coerce.number().int().positive().describe('IMAP UID of the message'),
        format: binaryFormatSchema,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ folder, uid, format }) => {
      log.info({ folder, uid, format }, 'exporting message');
      return exportMessage(folder, uid, {
        format,
        maxBytes: config.ATTACHMENT_MAX_BYTES,
        publicBaseUrl: config.PUBLIC_BASE_URL,
      });
    },
  );
}
