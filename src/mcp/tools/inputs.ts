import { z } from 'zod';
import { BULK_UID_LIMIT } from '../../imap/mutations.js';
import { attachmentSourceProblem } from '../../attachment-sources.js';

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

/** Pièce jointe d'un message existant, reprise côté serveur. */
const fromMessageInput = z
  .object({
    folder: z.string().min(1).default('INBOX').describe('Folder of the message holding it'),
    uid: uidInput.describe('IMAP UID of that message'),
    index: z.coerce
      .number()
      .int()
      .nonnegative()
      .describe('Attachment index, as reported by read_message'),
  })
  .describe('Reuse an attachment of a message already in the mailbox, without downloading it');

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
      'fromMessage { folder, uid, index }, url or uploadId',
  );
