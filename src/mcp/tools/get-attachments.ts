import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  getAttachmentPart,
  getMessageAttachments,
  type AttachmentContent,
  type AttachmentPartContent,
} from '../../imap/messages.js';
import { classifyImapError } from '../../imap/errors.js';
import { assertReadableSize, AttachmentTooLargeError } from '../../attachments.js';
import { config } from '../../config.js';
import type { DownloadLinkService } from '../../download-links.js';
import {
  binaryFormatSchema,
  binaryPayload,
  checkBinaryFormat,
  type BinaryFormat,
  type InlineBinaryJson,
  type LinkBinaryJson,
} from '../binary-output.js';
import { logger } from '../../logger.js';
import { toLocator, type AttachmentLocator } from '../../attachment-locator.js';
import { attachmentIndexInput, attachmentPartInput, refineLocator } from './inputs.js';

const log = logger.child({ tool: 'get_attachments' });

/** Nombre maximal d'éléments par appel. */
export const GET_ATTACHMENTS_MAX_ITEMS = 25;

/** Une pièce jointe demandée : message (`folder`, `uid`) et `index` ou `part`. */
export type AttachmentRequest = { folder: string; uid: number } & AttachmentLocator;

type ItemKey = AttachmentRequest & { ok: boolean };

/**
 * Résultat d'un élément. En format `auto`, une image n'a pas de `contentBase64`
 * dans le JSON : son contenu suit dans un bloc `image` (`imageBlock: true`).
 */
export type AttachmentItemResult =
  | (ItemKey & { ok: true } & (
        | InlineBinaryJson
        | LinkBinaryJson
        | { filename: string; contentType: string; size: number; imageBlock: true }
      ))
  | (ItemKey & { ok: false; error: string });

export interface AttachmentsBatchOptions {
  format: BinaryFormat;
  /** Taille maximale d'une pièce jointe (`ATTACHMENT_MAX_BYTES`). */
  maxBytes: number;
  /**
   * Taille cumulée maximale des contenus renvoyés inline (`auto`, `text_base64`).
   * Le format `url` n'y est pas soumis : il ne renvoie aucun contenu.
   */
  inlineMaxBytes: number;
  /** `PUBLIC_BASE_URL`, pour le format `url`. */
  publicBaseUrl: string;
  /** Émetteur de liens. Défaut : le service partagé du serveur. */
  links?: DownloadLinkService;
  /** Lecture des pièces jointes d'un message. Défaut : `getMessageAttachments` (IMAP). */
  fetchMessageAttachments?: (folder: string, uid: number) => Promise<AttachmentContent[]>;
  /** Lecture d'une seule partie. Défaut : `getAttachmentPart` (IMAP). */
  fetchAttachmentPart?: (
    folder: string,
    uid: number,
    part: string,
    maxBytes: number,
  ) => Promise<AttachmentPartContent>;
}

export interface AttachmentsBatch {
  items: AttachmentItemResult[];
  /** Images à renvoyer en bloc `image` (format `auto`), avec la position de leur élément. */
  images: { item: number; data: string; mimeType: string }[];
}

/**
 * Récupère un lot de pièces jointes. Les éléments par `index` sont regroupés
 * par message (`folder`, `uid`) : chaque message n'est téléchargé et parsé
 * qu'une fois, quel que soit le nombre d'index demandés. Un élément par `part`
 * ne télécharge que sa partie.
 *
 * Même logique que `searchMessagesAcross` : un élément en échec (message ou
 * index introuvable, pièce jointe trop grosse, budget cumulé dépassé) porte
 * son `error` sans faire échouer le lot ; une erreur d'auth ou réseau IMAP
 * concerne la connexion entière et est propagée.
 */
export async function collectAttachments(
  requests: AttachmentRequest[],
  options: AttachmentsBatchOptions,
): Promise<AttachmentsBatch> {
  const fetchAttachments = options.fetchMessageAttachments ?? getMessageAttachments;
  const fetchPart = options.fetchAttachmentPart ?? getAttachmentPart;

  // Un téléchargement par message distinct, dans l'ordre de première apparition.
  const messages = new Map<string, { folder: string; uid: number }>();
  for (const { folder, uid, part } of requests) {
    if (part !== undefined) continue;
    const key = messageKey(folder, uid);
    if (!messages.has(key)) messages.set(key, { folder, uid });
  }

  const fetched = new Map<string, AttachmentContent[] | { error: string }>();
  for (const [key, { folder, uid }] of messages) {
    try {
      fetched.set(key, await fetchAttachments(folder, uid));
    } catch (err) {
      const classified = classifyImapError(err);
      if (classified.name !== 'ImapCommandError') throw classified;
      fetched.set(key, { error: classified.message });
    }
  }

  const items: AttachmentItemResult[] = [];
  const images: AttachmentsBatch['images'] = [];
  const inline = options.format !== 'url';
  let inlineBytes = 0;

  for (const request of requests) {
    const { folder, uid } = request;
    const locator = toLocator(request);
    const key: AttachmentRequest = { folder, uid, ...locator };
    const fail = (error: string) => items.push({ ...key, ok: false, error });

    let attachment: { filename?: string; contentType: string; size: number; content: Buffer };
    if (locator.part !== undefined) {
      try {
        attachment = await fetchPart(folder, uid, locator.part, options.maxBytes);
      } catch (err) {
        if (err instanceof AttachmentTooLargeError) {
          fail(err.message);
          continue;
        }
        const classified = classifyImapError(err);
        if (classified.name !== 'ImapCommandError') throw classified;
        fail(classified.message);
        continue;
      }
    } else {
      const message = fetched.get(messageKey(folder, uid));
      if (!message || !Array.isArray(message)) {
        fail(message?.error ?? `Message UID ${uid} introuvable dans "${folder}"`);
        continue;
      }
      const found = message[locator.index];
      if (!found) {
        fail(
          `Pièce jointe #${locator.index} introuvable pour le message UID ${uid} ` +
            `(${message.length} pièce(s) jointe(s))`,
        );
        continue;
      }
      attachment = found;
    }

    try {
      assertReadableSize(attachment.size, options.maxBytes);
    } catch (err) {
      if (!(err instanceof AttachmentTooLargeError)) throw err;
      fail(err.message);
      continue;
    }

    if (inline) {
      if (inlineBytes + attachment.size > options.inlineMaxBytes) {
        fail(
          `Limite cumulée du lot atteinte : cette pièce jointe de ${attachment.size} octets porterait ` +
            `le total à ${inlineBytes + attachment.size} octets, au-delà de ${options.inlineMaxBytes} ` +
            `octets. Demandez-la dans un autre appel, ou utilisez format "url".`,
        );
        continue;
      }
      inlineBytes += attachment.size;
    }

    const payload = binaryPayload(
      {
        filename: attachment.filename ?? `attachment-${locator.part ?? locator.index}`,
        contentType: attachment.contentType,
        content: attachment.content,
      },
      {
        format: options.format,
        target: { kind: 'attachment', ...key },
        publicBaseUrl: options.publicBaseUrl,
        links: options.links,
      },
    );

    if (payload.type === 'image') {
      images.push({ item: items.length, data: payload.data, mimeType: payload.mimeType });
      items.push({
        ...key,
        ok: true,
        filename: attachment.filename ?? `attachment-${locator.part ?? locator.index}`,
        contentType: attachment.contentType,
        size: attachment.size,
        imageBlock: true,
      });
    } else {
      items.push({ ...key, ok: true, ...payload.data });
    }
  }

  return { items, images };
}

/**
 * Réponse MCP : d'abord le récapitulatif JSON de tous les éléments, puis, pour
 * chaque image (format `auto`), une ligne qui la situe suivie de son bloc `image`.
 */
export function attachmentsBatchResult(batch: AttachmentsBatch): CallToolResult {
  const succeeded = batch.items.filter((item) => item.ok).length;
  const summary = { succeeded, failed: batch.items.length - succeeded, items: batch.items };
  const content: CallToolResult['content'] = [
    { type: 'text', text: JSON.stringify(summary, null, 2) },
  ];
  for (const image of batch.images) {
    const item = batch.items[image.item]!;
    const filename = item.ok ? item.filename : '';
    content.push({
      type: 'text',
      text:
        `items[${image.item}] : ${filename} ` +
        `(folder "${item.folder}", uid ${item.uid}, ${placeOf(item)})`,
    });
    content.push({ type: 'image', data: image.data, mimeType: image.mimeType });
  }
  return { content };
}

/** « index 1 » ou « part 2 », pour situer un élément. */
function placeOf(item: AttachmentLocator): string {
  return item.part !== undefined ? `part ${item.part}` : `index ${item.index}`;
}

function messageKey(folder: string, uid: number): string {
  return `${folder}\u0000${uid}`;
}

export function registerGetAttachmentsTool(server: McpServer): void {
  server.registerTool(
    'get_attachments',
    {
      title: 'Get attachments',
      description:
        `Downloads several attachments (pièce jointe) at once, up to ${GET_ATTACHMENTS_MAX_ITEMS}, ` +
        'possibly from different email messages; each item is { folder, uid, index } with "index" as ' +
        'listed by read_message, or { folder, uid, part } with the IMAP "part" number listed by ' +
        'find_messages (only that part is downloaded). Same "format" as get_attachment. Returns a ' +
        'JSON summary { succeeded, failed, items } with one result per item, in request order: ' +
        '{ folder, uid, index or part, ok, error? } plus the attachment fields. A failed item (unknown message or index, too large) does not ' +
        'fail the batch. In "auto" format, images follow the summary as image blocks. With "auto" and ' +
        '"text_base64", inline content is capped at ATTACHMENT_MAX_BYTES in total: extra items fail ' +
        'and can be fetched in another call or with format "url".',
      inputSchema: {
        items: z
          .array(
            z
              .object({
                folder: z
                  .string()
                  .min(1)
                  .default('INBOX')
                  .describe('Folder containing the message'),
                uid: z.coerce.number().int().positive().describe('IMAP UID of the message'),
                index: attachmentIndexInput.optional(),
                part: attachmentPartInput.optional(),
              })
              .superRefine(refineLocator),
          )
          .min(1)
          .max(GET_ATTACHMENTS_MAX_ITEMS)
          .describe(`Attachments to download (1 to ${GET_ATTACHMENTS_MAX_ITEMS})`),
        format: binaryFormatSchema,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ items, format }) => {
      const refused = checkBinaryFormat(format, config.PUBLIC_BASE_URL);
      if (refused) return refused;

      log.info({ count: items.length, format }, 'fetching attachments');
      const requests = items.map((item) => ({
        folder: item.folder,
        uid: item.uid,
        ...toLocator(item),
      }));
      const batch = await collectAttachments(requests, {
        format,
        maxBytes: config.ATTACHMENT_MAX_BYTES,
        inlineMaxBytes: config.ATTACHMENT_MAX_BYTES,
        publicBaseUrl: config.PUBLIC_BASE_URL,
      });
      return attachmentsBatchResult(batch);
    },
  );
}
