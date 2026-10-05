import { z } from 'zod';
import type {
  FullMessage,
  MessageAddress,
  MessageAttachment,
  MessageSummary,
} from '../imap/messages.js';
import type { FolderInfo } from '../imap/folders.js';
import type { BulkItemResult } from '../imap/mutations.js';
import type { DraftResult, SendDraftResult } from '../imap/drafts.js';
import type { Thread, ThreadMessage } from '../imap/thread.js';
import type { WhoamiGuardrails, WhoamiQuota, WhoamiReport } from './whoami.js';
import type { InboxOverview } from './overview.js';

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

// Une recherche multi-dossiers étiquette chaque résumé par son dossier, et
// reporte à part les dossiers en échec (ex. nom inexistant) sans faire
// échouer les autres.
export const searchMessagesResultSchema = z.object({
  messages: z.array(messageSummarySchema.extend({ folder: z.string().optional() })),
  nextCursor: z.number().optional(),
  errors: z.array(z.object({ folder: z.string(), error: z.string() })).optional(),
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

// --- Surface par intention (8 outils) --------------------------------------

export const threadMessageSchema = schemaFor<ThreadMessage>()(
  messageSummarySchema.extend({
    folder: z.string(),
    role: z.enum(['sent', 'received']),
  }),
);

export const threadSchema = schemaFor<Thread>()(
  z.object({
    subject: z.string(),
    messages: z.array(threadMessageSchema),
  }),
);

/** `read_message` : `get_message`, plus le fil (`includeThread`). */
export interface ReadMessageResult extends GetMessageResult {
  thread?: Thread;
}

export const readMessageResultSchema = schemaFor<ReadMessageResult>()(
  getMessageResultSchema.extend({ thread: threadSchema.optional() }),
);

/**
 * `find_messages` : même contrat que `search_messages` (le listing n'a ni
 * `folder` ni `errors`), à ceci près que `fields` peut restreindre chaque
 * message à quelques champs : seul `uid` y est donc garanti.
 */
export const findMessagesResultSchema = searchMessagesResultSchema.extend({
  messages: z.array(
    messageSummarySchema.partial().extend({ uid: z.number(), folder: z.string().optional() }),
  ),
});

const whoamiQuotaSchema = schemaFor<WhoamiQuota>()(
  z.object({
    windowHours: z.number(),
    limit: z.number(),
    unlimited: z.boolean(),
    used: z.number(),
    remaining: z.number().nullable(),
    resetsAt: z.string().optional(),
  }),
);

export const guardrailsSchema = schemaFor<WhoamiGuardrails>()(
  z.object({
    sendingEnabled: z.boolean(),
    draftsOnly: z.boolean().optional(),
    unrestricted: z.boolean().optional(),
    allowlistActive: z.boolean().optional(),
    maxSendsPerDay: z.number().optional(),
    quota: whoamiQuotaSchema.optional(),
  }),
);

const hostPortSchema = z.object({ host: z.string(), port: z.number() });

export const whoamiReportSchema = schemaFor<WhoamiReport>()(
  z.object({
    server: z.object({ name: z.string(), version: z.string() }),
    account: z.object({ email: z.string(), imap: hostPortSchema, smtp: hostPortSchema }),
    credentials: z.object({
      appPasswordConfigured: z.boolean(),
      bearerTokenConfigured: z.boolean(),
    }),
    guardrails: guardrailsSchema,
    imapPool: z.object({ open: z.number(), inUse: z.number(), max: z.number() }),
    probe: z
      .object({
        attempted: z.literal(true),
        ok: z.boolean(),
        folderCount: z.number().optional(),
        error: z.string().optional(),
      })
      .optional(),
  }),
);

export const inboxOverviewSchema = schemaFor<InboxOverview>()(
  z.object({
    account: z.object({ email: z.string() }),
    inbox: z.object({
      folder: z.string(),
      total: z.number().optional(),
      unread: z.number().optional(),
      recentUnread: z.array(messageSummarySchema),
      recent: z.array(messageSummarySchema),
    }),
    folders: z.array(
      z.object({
        path: z.string(),
        specialUse: z.string().optional(),
        messages: z.number().optional(),
        unseen: z.number().optional(),
      }),
    ),
    guardrails: guardrailsSchema,
    diagnostics: whoamiReportSchema.optional(),
  }),
);

// `compose_message` : la forme d'envoi (`sent: true`), ou un brouillon
// (`sent: false` + `draft`), qu'il soit demandé (deliver "draft") ou imposé par
// DRAFTS_ONLY (`reason`). `replacedUid` signale un brouillon remplacé.
export const composeResultSchema = sendResultSchema.extend({
  replacedUid: z.number().optional(),
});

export const sendDraftResultSchema = schemaFor<SendDraftResult>()(
  z.object({
    send: z
      .object({
        messageId: z.string(),
        accepted: z.array(z.string()),
        rejected: z.array(z.string()),
        savedToSent: z.boolean().optional(),
        markedAnswered: z.boolean().optional(),
      })
      .optional(),
    reason: z.literal('DRAFTS_ONLY').optional(),
    copiedToSent: z.boolean(),
    draftDeleted: z.boolean(),
  }),
);

/** Actions de `organize_messages`. Liste ouverte : les lots suivants y ajoutent archive / spam. */
export const ORGANIZE_ACTIONS = [
  'move',
  'trash',
  'read',
  'unread',
  'flag',
  'unflag',
  'answered',
  'unanswered',
  'junk',
  'not_junk',
] as const;

export const organizeActionSchema = z.enum(ORGANIZE_ACTIONS);

export const organizeResultSchema = z.object({
  action: organizeActionSchema,
  folder: z.string(),
  // move : dossier cible ; trash : la corbeille (absent en cas d'expunge).
  destination: z.string().optional(),
  // trash : déplacé vers la corbeille, ou supprimé définitivement s'il y était déjà.
  outcome: z.enum(['moved_to_trash', 'expunged']).optional(),
  // Actions de flag : flags IMAP effectivement demandés, et mots-clés ajoutés.
  applied: z.array(flagActionSchema).optional(),
  keywords: z.array(z.string()).optional(),
  results: z.array(bulkItemResultSchema),
});

export const manageFoldersResultSchema = z.object({
  // action "list".
  folders: z.array(folderInfoSchema).optional(),
  // actions create / rename / delete.
  action: z.enum(['create', 'rename', 'delete']).optional(),
  path: z.string().optional(),
  newPath: z.string().optional(),
});
