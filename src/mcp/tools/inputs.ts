import { z } from 'zod';
import { BULK_UID_LIMIT } from '../../imap/mutations.js';

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
  .describe(`IMAP UIDs to act on, 1 to ${BULK_UID_LIMIT} (a single message is a one-element array)`);

export const textCriteriaInput = z
  .object({
    subject: z.string().optional(),
    body: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    text: z.string().optional().describe('Matches anywhere in headers or body'),
  })
  .describe('A set of text criteria');

export const attachmentsInput = z
  .array(
    z.object({
      filename: z.string().min(1),
      contentType: z.string().optional(),
      contentBase64: z.string().min(1),
    }),
  )
  .optional()
  .describe('Attachments (pièces jointes), base64-encoded');
