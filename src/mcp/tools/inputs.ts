import { z } from 'zod';
import { BULK_UID_LIMIT } from '../../imap/mutations.js';
import { attachmentSourceProblem } from '../../attachment-sources.js';
import { locatorProblem, PART_PATTERN } from '../../attachment-locator.js';

/**
 * Fragments de schémas d'entrée partagés par les outils.
 */

// z.coerce.date() ne peut pas être représenté en JSON Schema (tools/list plante).
// On valide une chaîne ISO 8601 et on convertit en Date nous-mêmes.
export const isoDate = z.union([z.iso.date(), z.iso.datetime({ offset: true, local: true })]);

export const uidInput = z.coerce.number().int().positive();

export const uidsInput = z
  .array(z.coerce.number().int().positive())
  .min(1)
  .max(BULK_UID_LIMIT)
  .describe(
    `IMAP UIDs to act on, 1 to ${BULK_UID_LIMIT} (a single message is a one-element array)`,
  );

export const textCriteriaInput = z
  .object({
    subject: z.string().optional(),
    body: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    text: z.string().optional().describe('Matches anywhere in headers or body'),
  })
  .describe('A set of text criteria');

/** Position d'une pièce jointe dans `read_message`. */
export const attachmentIndexInput = z.coerce
  .number()
  .int()
  .nonnegative()
  .describe('Attachment index, as reported by read_message (give index or part, not both)');

/** Numéro de partie IMAP d'une pièce jointe, tel que le renvoie `find_messages`. */
export const attachmentPartInput = z
  .string()
  .regex(PART_PATTERN, 'part est un numéro de partie IMAP, ex. "2" ou "1.3"')
  .describe(
    'IMAP part number of the attachment, as reported by find_messages, e.g. "2" or "1.3": ' +
      'downloads only that part (give index or part, not both)',
  );

/** Refus zod d'une désignation sans, ou avec à la fois, `index` et `part`. */
export function refineLocator(
  value: { index?: unknown; part?: unknown },
  ctx: z.RefinementCtx,
): void {
  const problem = locatorProblem(value);
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
}

/** Pièce jointe d'un message existant, reprise côté serveur. */
const fromMessageInput = z
  .object({
    folder: z.string().min(1).default('INBOX').describe('Folder of the message holding it'),
    uid: uidInput.describe('IMAP UID of that message'),
    index: attachmentIndexInput.optional(),
    part: attachmentPartInput.optional(),
  })
  .describe(
    'Reuse an attachment of a message already in the mailbox, without downloading it; ' +
      'designate it by index (read_message) or part (find_messages), exactly one',
  );

/**
 * Un élément de `attachments` : exactement une source parmi
 * `ATTACHMENT_SOURCE_KEYS` (voir `src/attachment-sources.ts`).
 */
export const attachmentInput = z
  .object({
    filename: z
      .string()
      .min(1)
      .optional()
      .describe(
        'File name. Required with contentBase64; otherwise overrides the original or deduced name',
      ),
    contentType: z
      .string()
      .optional()
      .describe('MIME type; overrides the original, the uploaded or the one returned by the URL'),
    contentBase64: z
      .string()
      .min(1)
      .optional()
      .describe('Source 1: the content, base64-encoded (small files only)'),
    fromMessage: fromMessageInput.optional().describe('Source 2: ' + fromMessageInput.description),
    url: z
      .string()
      .min(1)
      .optional()
      .describe('Source 3: a public https:// URL the server downloads (no redirects beyond 3)'),
    uploadId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Source 4: uploadId of a file uploaded through create_upload_link (filename and ' +
          'contentType kept unless overridden; consumed once the mail is sent or the draft saved)',
      ),
  })
  .superRefine((item, ctx) => {
    const problem = attachmentSourceProblem(item);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  });

export const attachmentsInput = z
  .array(attachmentInput)
  .optional()
  .describe(
    'Attachments (pièces jointes). Each item has exactly one source: contentBase64, ' +
      'fromMessage { folder, uid, index } or { folder, uid, part }, url or uploadId',
  );
