import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { downloadLinks, uploadUrl } from '../../download-links.js';
import type { DownloadLinkService } from '../../download-links.js';
import { newUploadId, normalizeUploadContentType, sanitizeUploadFilename } from '../../uploads.js';
import { config } from '../../config.js';
import { errorResult, jsonResult } from '../result.js';
import { uploadLinkSchema } from '../schemas.js';
import { logger } from '../../logger.js';

const log = logger.child({ tool: 'create_upload_link' });

export const UPLOAD_LINK_UNAVAILABLE =
  'create_upload_link exige PUBLIC_BASE_URL (URL publique HTTPS du serveur), qui n’est pas ' +
  'configurée. Attacher le fichier par contentBase64, fromMessage ou url.';

/** Dépendances injectables pour les tests. */
export interface CreateUploadLinkDeps {
  /** Défaut : `config.PUBLIC_BASE_URL`. Vide : l'outil répond une erreur. */
  publicBaseUrl?: string;
  /** Défaut : le service partagé `downloadLinks`. */
  links?: DownloadLinkService;
  /** Défaut : `config.ATTACHMENT_MAX_BYTES`. */
  maxBytes?: number;
}

export function registerCreateUploadLinkTool(
  server: McpServer,
  deps: CreateUploadLinkDeps = {},
): void {
  const publicBaseUrl = deps.publicBaseUrl ?? config.PUBLIC_BASE_URL;
  const links = deps.links ?? downloadLinks;
  const maxBytes = deps.maxBytes ?? config.ATTACHMENT_MAX_BYTES;

  server.registerTool(
    'create_upload_link',
    {
      title: 'Create upload link',
      description:
        'Creates a signed, single-use upload link (valid 15 minutes) to send a file as an email ' +
        'attachment (pièce jointe) without base64: the client POSTs the raw file bytes to uploadUrl ' +
        '(any Content-Type, no bearer, at most maxBytes), outside of MCP; then compose_message ' +
        'attaches it with attachments: [{ uploadId }]. The uploaded file is kept in memory for 1 hour ' +
        'and consumed once the mail is sent or the draft (brouillon) saved. filename and contentType, ' +
        'if given here, take precedence over the upload request headers. Requires PUBLIC_BASE_URL.',
      inputSchema: {
        filename: z
          .string()
          .min(1)
          .max(255)
          .optional()
          .describe('File name of the attachment (otherwise taken from the upload request)'),
        contentType: z
          .string()
          .min(1)
          .optional()
          .describe('MIME type (otherwise taken from the upload Content-Type)'),
      },
      outputSchema: uploadLinkSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ filename, contentType }) => {
      if (!publicBaseUrl) return errorResult(UPLOAD_LINK_UNAVAILABLE);

      const safeName = sanitizeUploadFilename(filename);
      if (filename !== undefined && !safeName) {
        return errorResult(`filename "${filename}" inutilisable comme nom de fichier.`);
      }
      const safeType = normalizeUploadContentType(contentType);
      if (contentType !== undefined && !safeType) {
        return errorResult(`contentType "${contentType}" n’est pas un type MIME valide.`);
      }

      const uploadId = newUploadId();
      const { token, expiresAt } = links.issue({
        kind: 'upload',
        uploadId,
        ...(safeName ? { filename: safeName } : {}),
        ...(safeType ? { contentType: safeType } : {}),
      });
      log.info({ uploadId }, 'upload link issued');
      return jsonResult(
        {
          uploadUrl: uploadUrl(publicBaseUrl, token),
          uploadId,
          expiresAt: new Date(expiresAt).toISOString(),
          maxBytes,
          method: 'POST' as const,
        },
        uploadLinkSchema,
      );
    },
  );
}
