import type { AddressObject, Attachment } from 'mailparser';
import { simpleParser } from 'mailparser';
import type { Readable } from 'node:stream';
import type { FetchMessageObject, ImapFlow, MessageStructureObject } from 'imapflow';
import { withMailbox } from './mailbox.js';
import {
  attachmentFilterOf,
  attachmentParts,
  findStructurePart,
  isInlinePart,
  isMultipartNode,
  matchesAttachmentFilter,
  matchesLocalFilter,
  paginationExhausted,
  planSearch,
} from './search-query.js';
import type {
  AttachmentFilter,
  AttachmentPart,
  LocalCondition,
  LocalFilter,
  SearchCriteria,
} from './search-query.js';
import { classifyImapError } from './errors.js';
import { folderConcurrency, mapWithConcurrency } from './concurrency.js';
import { AttachmentTooLargeError } from '../attachments.js';

export interface MessageAddress {
  name?: string;
  address?: string;
}

export interface MessageSummary {
  uid: number;
  subject?: string;
  from: MessageAddress[];
  to: MessageAddress[];
  date?: string;
  seen: boolean;
  flagged: boolean;
  size?: number;
}

export interface MessageAttachment {
  /** Position stable de la pièce jointe dans le message, à passer à `get_attachment`. */
  index: number;
  filename?: string;
  contentType: string;
  size: number;
  contentId?: string;
  /** Affichée dans le corps (image intégrée…) plutôt que jointe : voir `isInlinePart`. */
  inline: boolean;
}

export interface AttachmentContent {
  index: number;
  filename?: string;
  contentType: string;
  size: number;
  content: Buffer;
}

/** Pièce jointe téléchargée seule, par son numéro de partie IMAP. */
export interface AttachmentPartContent {
  part: string;
  filename?: string;
  contentType: string;
  /** Taille décodée, en octets. */
  size: number;
  content: Buffer;
}

export interface FullMessage extends MessageSummary {
  cc: MessageAddress[];
  messageId?: string;
  references: string[];
  text?: string;
  html: string | false;
  attachments: MessageAttachment[];
}

const SUMMARY_QUERY = { uid: true, envelope: true, flags: true, size: true } as const;

export function toSummary(entry: FetchMessageObject): MessageSummary {
  const flags = entry.flags ?? new Set<string>();
  return {
    uid: entry.uid,
    subject: entry.envelope?.subject,
    from: entry.envelope?.from ?? [],
    to: entry.envelope?.to ?? [],
    date: entry.envelope?.date ? new Date(entry.envelope.date).toISOString() : undefined,
    seen: flags.has('\\Seen'),
    flagged: flags.has('\\Flagged'),
    size: entry.size,
  };
}

export function toAddressList(addr: AddressObject | AddressObject[] | undefined): MessageAddress[] {
  if (!addr) return [];
  const objects = Array.isArray(addr) ? addr : [addr];
  return objects.flatMap((o) => o.value.map((v) => ({ name: v.name, address: v.address })));
}

export function toReferencesList(refs: string[] | string | undefined): string[] {
  if (!refs) return [];
  return Array.isArray(refs) ? refs : [refs];
}

/** Résumé renvoyé par une recherche. */
export interface FoundMessageSummary extends MessageSummary {
  /** Pièces jointes, présentes seulement quand la recherche filtre dessus (BODYSTRUCTURE lu). */
  attachments?: AttachmentPart[];
}

export interface MessagePage {
  messages: FoundMessageSummary[];
  /**
   * Plus petit UID renvoyé. À repasser tel quel en `beforeUid` pour la page
   * suivante. Absent quand la liste est épuisée.
   */
  nextCursor?: number;
}

/** Un résumé rattaché à son dossier d'origine (recherche multi-dossiers). */
export interface TaggedMessageSummary extends FoundMessageSummary {
  folder: string;
}

/**
 * Cœur de la pagination : traduit les critères, laisse IMAP SEARCH filtrer ce
 * qu'il sait filtrer de façon fiable, vérifie le reste (`subject`/`from`/`to`,
 * pièces jointes) sur les candidats, trie par UID décroissant (donc du plus
 * récent au plus ancien), tronque à `limit`, et n'expose un curseur que s'il
 * reste des messages au-delà.
 */
export async function fetchPage(
  client: ImapFlow,
  criteria: SearchCriteria,
  limit: number,
): Promise<MessagePage> {
  if (paginationExhausted(criteria.beforeUid)) {
    return { messages: [] };
  }

  const plan = planSearch(criteria);
  const uids = await client.search(plan.query, { uid: true });
  if (!uids || uids.length === 0) {
    return { messages: [] };
  }

  const ordered = [...uids].sort((a, b) => b - a);
  const attachments = attachmentFilterOf(criteria);
  if (!plan.local && !attachments) {
    const selected = ordered.slice(0, limit);
    const fetched = await client.fetchAll(selected, SUMMARY_QUERY, { uid: true });
    const messages = fetched.map(toSummary).sort((a, b) => b.uid - a.uid);
    return pageOf(messages, ordered.length > selected.length);
  }

  const matching = await filterCandidates(client, ordered, plan.local, attachments, limit);
  return pageOf(matching.slice(0, limit), matching.length > limit);
}

function pageOf(messages: FoundMessageSummary[], hasMore: boolean): MessagePage {
  const smallest = messages.at(-1)?.uid;
  return hasMore && smallest !== undefined ? { messages, nextCursor: smallest } : { messages };
}

/** Nombre de candidats lus par commande FETCH lors d'un filtrage local. */
export const CANDIDATE_FETCH_BATCH = 250;

/**
 * Filtrage local des candidats du SEARCH : critères `subject`/`from`/`to` sur
 * l'ENVELOPE, filtre pièces jointes sur le BODYSTRUCTURE. Une seule passe : un
 * FETCH par lot de candidats lit d'un coup l'enveloppe, les flags, la taille et
 * (si besoin) le BODYSTRUCTURE, du plus récent au plus ancien. On s'arrête dès
 * `limit + 1` correspondances : la dernière ne sert qu'à savoir s'il reste une
 * page, pour que `nextCursor` ne soit jamais un curseur vide.
 *
 * Les parties `body`/`text` des `not` et `or` évalués localement sont résolues
 * avant, par un SEARCH dédié chacune.
 *
 * Renvoie les résumés retenus, dans l'ordre de `ordered`.
 */
async function filterCandidates(
  client: ImapFlow,
  ordered: number[],
  local: LocalFilter | undefined,
  attachments: AttachmentFilter | undefined,
  limit: number,
): Promise<FoundMessageSummary[]> {
  const serverMatches = new Map<LocalCondition, Set<number>>();
  for (const condition of [local?.exclude, ...(local?.anyOf ?? [])]) {
    if (!condition?.server) continue;
    const found = await client.search(condition.server, { uid: true });
    serverMatches.set(condition, new Set(found || []));
  }

  const query = attachments ? { ...SUMMARY_QUERY, bodyStructure: true } : SUMMARY_QUERY;
  const matching: FoundMessageSummary[] = [];
  for (let start = 0; start < ordered.length && matching.length <= limit;) {
    const batch = ordered.slice(start, start + CANDIDATE_FETCH_BATCH);
    start += batch.length;
    const fetched = await client.fetchAll(batch, query, { uid: true });
    const accepted = new Map<number, FoundMessageSummary>();
    for (const entry of fetched) {
      if (local && !matchesLocalFilter(entry.uid, entry.envelope, local, serverMatches)) continue;
      if (attachments && !matchesAttachmentFilter(entry.bodyStructure, attachments)) continue;
      const summary = toSummary(entry);
      // Le BODYSTRUCTURE a déjà été lu pour filtrer : autant exposer les pièces jointes.
      accepted.set(
        entry.uid,
        attachments ? { ...summary, attachments: attachmentParts(entry.bodyStructure) } : summary,
      );
    }
    // Le serveur ne garantit pas l'ordre du FETCH : on garde celui du lot.
    for (const uid of batch) {
      const summary = accepted.get(uid);
      if (summary) matching.push(summary);
    }
  }
  return matching;
}

export interface ListMessagesOptions {
  unreadOnly?: boolean;
  since?: Date;
  before?: Date;
  from?: string;
  beforeUid?: number;
  limit: number;
}

export async function listMessages(
  folder: string,
  options: ListMessagesOptions,
): Promise<MessagePage> {
  const criteria: SearchCriteria = {
    unreadOnly: options.unreadOnly,
    since: options.since,
    before: options.before,
    from: options.from,
    beforeUid: options.beforeUid,
  };
  return withMailbox(folder, (client) => fetchPage(client, criteria, options.limit), {
    readOnly: true,
  });
}

export interface SearchMessagesOptions extends SearchCriteria {
  limit: number;
}

export async function searchMessages(
  folder: string,
  options: SearchMessagesOptions,
): Promise<MessagePage> {
  return withMailbox(folder, (client) => fetchPage(client, options, options.limit), {
    readOnly: true,
  });
}

export interface FolderSearchError {
  folder: string;
  error: string;
}

/** Signature de `withMailbox`, injectable pour les tests (défaut : le pool partagé). */
type WithMailbox = <T>(
  folder: string,
  fn: (client: ImapFlow) => Promise<T>,
  options?: { readOnly?: boolean },
) => Promise<T>;

/**
 * Recherche sur plusieurs dossiers (IMAP ne sait pas chercher globalement),
 * fouillés en parallèle sur au plus `concurrency` connexions du pool (par
 * défaut toutes sauf une, voir `folderConcurrency`). Résultats fusionnés dans
 * l'ordre des dossiers, chacun étiqueté par son dossier, triés du plus récent
 * au plus ancien, tronqués à `limit`. Pas de curseur : la pagination n'a de
 * sens que dossier par dossier.
 *
 * Un dossier en échec (ex. nom inexistant) est écarté et reporté dans
 * `errors` plutôt que de faire échouer tout le lot : sur N dossiers demandés,
 * une faute de frappe sur un seul ne doit pas priver des résultats des autres.
 * Une erreur d'auth/réseau, elle, affecte la connexion entière et est donc
 * toujours propagée (inutile de la répéter dossier par dossier).
 */
export async function searchMessagesAcross(
  folders: string[],
  options: SearchMessagesOptions,
  withMailboxFn: WithMailbox = withMailbox,
  concurrency: number = folderConcurrency(),
): Promise<{ messages: TaggedMessageSummary[]; errors?: FolderSearchError[] }> {
  const results = await mapWithConcurrency(
    folders,
    concurrency,
    async (folder): Promise<TaggedMessageSummary[] | FolderSearchError> => {
      try {
        const page = await withMailboxFn(
          folder,
          (client) => fetchPage(client, options, options.limit),
          { readOnly: true },
        );
        return page.messages.map((message) => ({ ...message, folder }));
      } catch (err) {
        const classified = classifyImapError(err);
        if (classified.name !== 'ImapCommandError') throw classified;
        return { folder, error: classified.message };
      }
    },
  );
  // Fusion dans l'ordre des dossiers : le tri (stable) départage les ex aequo comme avant.
  const merged = results.flatMap((result) => (Array.isArray(result) ? result : []));
  const errors = results.filter((result): result is FolderSearchError => !Array.isArray(result));
  merged.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  return { messages: merged.slice(0, options.limit), ...(errors.length > 0 ? { errors } : {}) };
}

/**
 * Même règle que `find_messages` (`isInlinePart`) ; mailparser marque en plus
 * `related` les parties d'un multipart/related, c'est-à-dire intégrées au HTML.
 */
export function isInlineAttachment(
  att: Pick<Attachment, 'contentDisposition' | 'cid' | 'related'>,
): boolean {
  if (isInlinePart(att.contentDisposition, att.cid)) return true;
  // `related` est absent (et non false) hors multipart/related, malgré son type.
  return att.related === true && att.contentDisposition?.toLowerCase() !== 'attachment';
}

export async function getMessage(folder: string, uid: number): Promise<FullMessage> {
  return withMailbox(
    folder,
    async (client) => {
      const fetched = await client.fetchOne(
        uid,
        { uid: true, envelope: true, flags: true, size: true, source: true },
        { uid: true },
      );
      if (!fetched) {
        throw new Error(`Message UID ${uid} introuvable dans "${folder}"`);
      }

      const parsed = fetched.source ? await simpleParser(fetched.source) : undefined;

      return {
        ...toSummary(fetched),
        cc: toAddressList(parsed?.cc),
        messageId: parsed?.messageId,
        references: toReferencesList(parsed?.references),
        text: parsed?.text,
        html: parsed?.html ?? false,
        attachments: (parsed?.attachments ?? []).map((att, index) => ({
          index,
          filename: att.filename,
          contentType: att.contentType,
          size: att.size,
          contentId: att.cid,
          inline: isInlineAttachment(att),
        })),
      };
    },
    { readOnly: true },
  );
}

/**
 * Source RFC 5322 brute d'un message. Sert à ré-émettre ou recopier un message
 * sans le recomposer (cycle de vie des brouillons) et à joindre l'original en
 * `message/rfc822` pour `forward_message`.
 */
export async function getMessageSource(folder: string, uid: number): Promise<Buffer> {
  return withMailbox(
    folder,
    async (client) => {
      const fetched = await client.fetchOne(uid, { uid: true, source: true }, { uid: true });
      if (!fetched || !fetched.source) {
        throw new Error(`Message UID ${uid} introuvable dans "${folder}"`);
      }
      return fetched.source;
    },
    { readOnly: true },
  );
}

/**
 * Toutes les pièces jointes d'un message, en un seul téléchargement et un seul
 * parsing : `get_attachments` regroupe ses éléments par message pour ne pas
 * re-télécharger la source à chaque index. Positions identiques à `getMessage`.
 */
export async function getMessageAttachments(
  folder: string,
  uid: number,
  withMailboxFn: WithMailbox = withMailbox,
): Promise<AttachmentContent[]> {
  return withMailboxFn(
    folder,
    async (client) => {
      const fetched = await client.fetchOne(uid, { uid: true, source: true }, { uid: true });
      if (!fetched || !fetched.source) {
        throw new Error(`Message UID ${uid} introuvable dans "${folder}"`);
      }

      const parsed = await simpleParser(fetched.source);
      return parsed.attachments.map((attachment, index) => ({
        index,
        filename: attachment.filename,
        contentType: attachment.contentType,
        size: attachment.content.length,
        content: attachment.content,
      }));
    },
    { readOnly: true },
  );
}

/** Contenu binaire d'une pièce jointe, ciblée par son `index` (voir `getMessage`). */
export async function getAttachment(
  folder: string,
  uid: number,
  index: number,
): Promise<AttachmentContent> {
  return withMailbox(
    folder,
    async (client) => {
      const fetched = await client.fetchOne(uid, { uid: true, source: true }, { uid: true });
      if (!fetched || !fetched.source) {
        throw new Error(`Message UID ${uid} introuvable dans "${folder}"`);
      }

      const parsed = await simpleParser(fetched.source);
      const attachment = parsed.attachments[index];
      if (!attachment) {
        throw new Error(
          `Pièce jointe #${index} introuvable pour le message UID ${uid} ` +
            `(${parsed.attachments.length} pièce(s) jointe(s))`,
        );
      }

      return {
        index,
        filename: attachment.filename,
        contentType: attachment.contentType,
        size: attachment.content.length,
        content: attachment.content,
      };
    },
    { readOnly: true },
  );
}

/**
 * Borne basse de la taille décodée d'une partie, d'après la taille encodée
 * annoncée par le BODYSTRUCTURE : base64 code 3 octets en 4 caractères, plus
 * les fins de ligne (0,7 reste en deçà) ; quoted-printable au pire 3
 * caractères par octet ; autrement, imapflow peut convertir un texte en UTF-8,
 * d'où une marge de moitié. Sert à refuser avant tout téléchargement.
 */
export function decodedSizeLowerBound(node: MessageStructureObject): number | undefined {
  if (node.size === undefined) return undefined;
  switch (node.encoding?.toLowerCase()) {
    case 'base64':
      return Math.floor(node.size * 0.7);
    case 'quoted-printable':
      return Math.floor(node.size / 3);
    default:
      return Math.floor(node.size / 2);
  }
}

/** Lit un flux jusqu'à `maxBytes` ; au-delà, le coupe et renvoie `undefined`. */
async function readCapped(stream: Readable, maxBytes: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.length;
    // Sortir de la boucle détruit le flux : imapflow cesse alors de télécharger.
    if (total > maxBytes) return undefined;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

/** Issue d'un téléchargement de partie, le refus de taille étant levé hors de `withMailbox`. */
type PartDownload = { ok: true; value: AttachmentPartContent } | { ok: false; tooLarge: string };

function tooLargeMessage(part: string, detail: string, maxBytes: number): string {
  return (
    `Pièce jointe (partie ${part}) ${detail}, au-delà de la limite de ${maxBytes} octets ` +
    '(ATTACHMENT_MAX_BYTES). Récupérez-la depuis Mail.app.'
  );
}

async function downloadPartOn(
  client: ImapFlow,
  folder: string,
  uid: number,
  part: string,
  maxBytes: number,
): Promise<PartDownload> {
  const fetched = await client.fetchOne(uid, { uid: true, bodyStructure: true }, { uid: true });
  if (!fetched) {
    throw new Error(`Message UID ${uid} introuvable dans "${folder}"`);
  }

  const node = findStructurePart(fetched.bodyStructure, part);
  if (!node) {
    const known = attachmentParts(fetched.bodyStructure).map((p) => p.part);
    throw new Error(
      `Partie ${part} introuvable dans le message UID ${uid} ` +
        `(parties des pièces jointes : ${known.join(', ') || 'aucune'}, voir find_messages)`,
    );
  }
  if (isMultipartNode(node)) {
    throw new Error(
      `La partie ${part} du message UID ${uid} est un conteneur ${node.type}, pas une pièce ` +
        'jointe : désigner l’une de ses sous-parties (voir find_messages)',
    );
  }

  const announced = decodedSizeLowerBound(node);
  if (announced !== undefined && announced > maxBytes) {
    return {
      ok: false,
      tooLarge: tooLargeMessage(
        part,
        `d'au moins ${announced} octets (taille annoncée : ${node.size} octets encodés)`,
        maxBytes,
      ),
    };
  }

  // imapflow décode le transfer-encoding ; `maxBytes + 1` suffit à détecter un dépassement.
  const download = await client.download(String(uid), part, { uid: true, maxBytes: maxBytes + 1 });
  if (!download.content) {
    throw new Error(`Partie ${part} introuvable dans le message UID ${uid}`);
  }
  const content = await readCapped(download.content, maxBytes);
  if (!content) {
    return {
      ok: false,
      tooLarge: tooLargeMessage(part, 'interrompue en cours de téléchargement', maxBytes),
    };
  }

  const filename =
    node.dispositionParameters?.filename || node.parameters?.name || download.meta.filename;
  return {
    ok: true,
    value: {
      part,
      ...(filename ? { filename } : {}),
      contentType:
        node.type.toLowerCase() || download.meta.contentType || 'application/octet-stream',
      size: content.length,
      content,
    },
  };
}

/**
 * Une seule pièce jointe, désignée par son numéro de partie IMAP (voir
 * `find_messages`) : seule cette partie est téléchargée, pas le message
 * entier. Vérifie d'abord dans le BODYSTRUCTURE que la partie existe et n'est
 * pas un conteneur multipart, puis refuse au-delà de `maxBytes`, sur la taille
 * annoncée puis en coupant le flux. Lève `AttachmentTooLargeError` dans ce
 * cas, une erreur IMAP classée sinon.
 */
export async function getAttachmentPart(
  folder: string,
  uid: number,
  part: string,
  maxBytes: number,
  withMailboxFn: WithMailbox = withMailbox,
): Promise<AttachmentPartContent> {
  const result = await withMailboxFn(
    folder,
    (client) => downloadPartOn(client, folder, uid, part, maxBytes),
    { readOnly: true },
  );
  // Levée ici : `withMailbox` reclasserait l'erreur en erreur IMAP.
  if (!result.ok) throw new AttachmentTooLargeError(result.tooLarge);
  return result.value;
}
