import { z } from 'zod';
import type { FullMessage, MessageAddress, MessageAttachment, MessageSummary } from '../imap/messages.js';
import type { FolderInfo } from '../imap/folders.js';
import type { BulkItemResult } from '../imap/mutations.js';
import type { DraftResult } from '../imap/drafts.js';

/**
 * Schémas de sortie (`outputSchema`) des outils MCP.
 *
 * Ils sont *dérivés* des types déjà définis dans la couche IMAP/SMTP, pas
 * redécrits : `schemaFor<T>()(...)` échoue à la compilation si un schéma ne
 * produit plus une valeur assignable à son type source. Quand un de ces types
 * change, le `typecheck` casse ici — c'est voulu.
 *
 * Les lots A et B ajoutent des outils et modifient des formes de retour :
 * `objectResultSchema` / `listResultSchema` sont là pour qu'ils déclarent
 * leurs propres schémas sans réécrire ce fumble d'`outputSchema`.
 */

/** Contraint `schema` à produire un `T` (assignabilité vérifiée à la compilation). */
export function schemaFor<T>() {
  return <S extends z.ZodType<T>>(schema: S): S => schema;
}

/** Enveloppe un schéma d'objet en `outputSchema` (le SDK exige un objet racine). */
export function objectResultSchema<S extends z.ZodRawShape>(shape: S) {
  return z.object(shape);
}

/** `outputSchema` d'un outil qui renvoie une liste, sous la clé `key`. */
export function listResultSchema<K extends string, S extends z.ZodTypeAny>(key: K, item: S) {
  return z.object({ [key]: z.array(item) } as Record<K, z.ZodArray<S>>);
}

export const messageAddressSchema = schemaFor<MessageAddress>()(
  z.object({
    name: z.string().optional(),
    address: z.string().optional(),
  }),
);

export const messageAttachmentSchema = schemaFor<MessageAttachment>()(
  z.object({
    filename: z.string().optional(),
    contentType: z.string(),
    size: z.number(),
    contentId: z.string().optional(),
    // Index stable : c'est lui qu'on passe à get_attachment.
    index: z.number(),
  }),
);

export const messageSummarySchema = schemaFor<MessageSummary>()(
  z.object({
    uid: z.number(),
    subject: z.string().optional(),
    from: z.array(messageAddressSchema),
    to: z.array(messageAddressSchema),
    date: z.string().optional(),
    seen: z.boolean(),
    flagged: z.boolean(),
    size: z.number().optional(),
  }),
);

/** `get_message` : message complet + drapeau de troncature + en-têtes bruts optionnels. */
export interface GetMessageResult extends FullMessage {
  bodyTruncated: boolean;
  rawHeaders?: string;
}

export const getMessageResultSchema = schemaFor<GetMessageResult>()(
  z.object({
    ...messageSummarySchema.shape,
    cc: z.array(messageAddressSchema),
    messageId: z.string().optional(),
    references: z.array(z.string()),
    text: z.string().optional(),
    html: z.union([z.string(), z.literal(false)]),
    attachments: z.array(messageAttachmentSchema),
    bodyTruncated: z.boolean(),
    rawHeaders: z.string().optional(),
  }),
);

export const folderInfoSchema = schemaFor<FolderInfo>()(
  z.object({
    path: z.string(),
    name: z.string(),
    delimiter: z.string(),
    parentPath: z.string(),
    specialUse: z.string().optional(),
    flags: z.array(z.string()),
    subscribed: z.boolean(),
    // Présents seulement avec includeStatus (une commande STATUS par dossier).
    messages: z.number().optional(),
    unseen: z.number().optional(),
  }),
);

export const listFoldersResultSchema = z.object({ folders: z.array(folderInfoSchema) });
// `nextCursor` est le plus petit UID de la page : à repasser en `beforeUid`.
export const listMessagesResultSchema = z.object({
  messages: z.array(messageSummarySchema),
  nextCursor: z.number().optional(),
});

// Une recherche multi-dossiers étiquette chaque résumé par son dossier.
export const searchMessagesResultSchema = z.object({
  messages: z.array(messageSummarySchema.extend({ folder: z.string().optional() })),
  nextCursor: z.number().optional(),
});

/** Résultat par UID d'une opération en masse. */
export const bulkItemResultSchema = schemaFor<BulkItemResult>()(
  z.object({ uid: z.number(), ok: z.boolean(), error: z.string().optional() }),
);


/**
 * NOTE — les outils de mutation ont deux formes de retour (un UID, ou un lot
 * d'UID) et l'envoi peut être dévié vers Drafts. Le SDK MCP exige un objet à la
 * racine d'un `outputSchema` (il en lit le `.shape`) : une union y est
 * inutilisable. Ces schémas décrivent donc l'union « à plat », les champs
 * propres à une forme étant optionnels.
 */
export const moveResultSchema = z.object({
  // Forme « un message ».
  uid: z.number().optional(),
  newUid: z.number().optional(),
  from: z.string(),
  to: z.string(),
  // Forme « en masse » : un statut par UID.
  results: z.array(bulkItemResultSchema).optional(),
});

export const deleteResultSchema = z.object({
  uid: z.number().optional(),
  folder: z.string(),
  action: z.enum(['moved_to_trash', 'expunged']).optional(),
  destination: z.string().optional(),
  results: z.array(bulkItemResultSchema).optional(),
});

const flagActionSchema = z.enum([
  'read',
  'unread',
  'flagged',
  'unflagged',
  'answered',
  'unanswered',
  'junk',
  'not_junk',
]);

export const flagResultSchema = z.object({
  uid: z.number().optional(),
  folder: z.string(),
  applied: z.array(flagActionSchema),
  keywords: z.array(z.string()).optional(),
  results: z.array(bulkItemResultSchema).optional(),
});

// Un envoi peut être dévié vers Drafts (DRAFTS_ONLY) : `sent` distingue les
// deux formes, et c'est un succès dans les deux cas.
export const sendResultSchema = z.object({
  sent: z.boolean(),
  // Forme « parti ».
  messageId: z.string().optional(),
  accepted: z.array(z.string()).optional(),
  rejected: z.array(z.string()).optional(),
  savedToSent: z.boolean().optional(),
  markedAnswered: z.boolean().optional(),
  // Forme « dévié vers Drafts ».
  draft: z.object({ folder: z.string(), uid: z.number().optional() }).optional(),
  reason: z.literal('DRAFTS_ONLY').optional(),
});

export const draftResultSchema = schemaFor<DraftResult>()(
  z.object({
    folder: z.string(),
    uid: z.number().optional(),
  }),
);

export const waitForNewMessageResultSchema = z.object({
  folder: z.string(),
  timedOut: z.boolean(),
  newMessages: z.array(messageSummarySchema),
});
