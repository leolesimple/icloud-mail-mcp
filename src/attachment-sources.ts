import { posix } from 'node:path';
import type { IncomingHttpHeaders } from 'node:http';
import type { ComposeAttachment } from './smtp/compose.js';
import { getAttachment, getAttachmentPart, getMessageAttachments } from './imap/messages.js';
import type { AttachmentContent, AttachmentPartContent } from './imap/messages.js';
import { locatorProblem } from './attachment-locator.js';
import { AttachmentTooLargeError, decodedBase64Size } from './attachments.js';
import { fetchHttpsGuarded, UrlTooLargeError } from './ssrf.js';
import type { GuardedFetchDeps } from './ssrf.js';
import { uploadStore } from './uploads.js';
import type { UploadStore } from './uploads.js';

/**
 * Résolution des pièces jointes de `compose_message`. Chaque élément désigne
 * son contenu par exactement UNE source :
 *
 * - `contentBase64` : le contenu inline (petits fichiers) ;
 * - `fromMessage` : une pièce jointe d'un message déjà dans la boîte, reprise
 *   côté serveur sans transiter par le modèle ;
 * - `url` : un fichier téléchargé par le serveur, sous garde SSRF (`ssrf.ts`) ;
 * - `uploadId` : un fichier déposé hors MCP par `create_upload_link` puis
 *   `POST /upload/:token` (`uploads.ts`). Le dépôt n'est PAS consommé ici :
 *   l'appelant le supprime (`consumeUploads`) une fois le mail envoyé ou le
 *   brouillon enregistré, pour qu'un échec laisse le dépôt réutilisable.
 *
 * Toutes les sources sont résolues AVANT l'envoi ou l'écriture du brouillon :
 * une erreur nomme l'élément fautif et rien n'est émis. `ATTACHMENT_MAX_BYTES`
 * plafonne le cumul ; une URL ne reçoit que le reste disponible et son flux
 * est coupé au-delà.
 */

/** Sources reconnues ; chacune a sa branche dans `resolveOne`. */
export const ATTACHMENT_SOURCE_KEYS = ['contentBase64', 'fromMessage', 'url', 'uploadId'] as const;
export type AttachmentSourceKey = (typeof ATTACHMENT_SOURCE_KEYS)[number];

/** `index` (position dans read_message) ou `part` (numéro de partie IMAP) : exactement un. */
export interface FromMessageSource {
  folder?: string;
  uid: number;
  index?: number;
  part?: string;
}

/** Élément `attachments` tel que validé par `attachmentsInput`. */
export interface AttachmentSourceInput {
  /** Requis avec `contentBase64` ; sinon, surcharge le nom repris ou déduit. */
  filename?: string;
  /** Surcharge le type repris de l'original ou de la réponse HTTP. */
  contentType?: string;
  contentBase64?: string;
  fromMessage?: FromMessageSource;
  url?: string;
  uploadId?: string;
}

/** Levée quand une source ne peut pas être résolue ; le message nomme l'élément. */
export class AttachmentSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentSourceError';
  }
}

export interface AttachmentSourceDeps {
  maxBytes: number;
  /** Toutes les pièces jointes d'un message (défaut : `getMessageAttachments`). */
  fetchMessageAttachments?: (folder: string, uid: number) => Promise<AttachmentContent[]>;
  /** Une seule partie d'un message (défaut : `getAttachmentPart`). */
  fetchAttachmentPart?: (
    folder: string,
    uid: number,
    part: string,
    maxBytes: number,
  ) => Promise<AttachmentPartContent>;
  /** Accès réseau de la source `url` (défaut : DNS et HTTPS réels). */
  fetch?: GuardedFetchDeps;
  /** Dépôts de `create_upload_link` (défaut : le stockage partagé `uploadStore`). */
  uploads?: Pick<UploadStore, 'get'>;
}

const DEFAULT_FOLDER = 'INBOX';

/** Sources présentes dans un élément ; la validation exige qu'il y en ait une seule. */
export function presentSources(item: AttachmentSourceInput): AttachmentSourceKey[] {
  return ATTACHMENT_SOURCE_KEYS.filter((key) => item[key] !== undefined);
}

/** Motif de refus d'un élément mal formé, ou `undefined` s'il est valide. */
export function attachmentSourceProblem(item: AttachmentSourceInput): string | undefined {
  const sources = presentSources(item);
  if (sources.length !== 1) {
    return (
      `chaque pièce jointe doit avoir exactement une source parmi ` +
      `${ATTACHMENT_SOURCE_KEYS.join(', ')} (reçu : ${sources.join(', ') || 'aucune'})`
    );
  }
  if (sources[0] === 'contentBase64' && !item.filename) {
    return 'filename est requis avec contentBase64';
  }
  if (item.fromMessage !== undefined) {
    const problem = locatorProblem(item.fromMessage);
    if (problem) return `fromMessage : ${problem}`;
  }
  return undefined;
}

function label(item: AttachmentSourceInput, position: number): string {
  const source = presentSources(item)[0] ?? 'source absente';
  return `attachments[${position}] (${source})`;
}

/** Nom de fichier sans chemin ni caractère de contrôle. */
export function sanitizeFilename(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\\/g, '/');
  return posix.basename(cleaned).trim();
}

/** `filename*=` (RFC 5987) prioritaire sur `filename=`. */
export function filenameFromContentDisposition(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const extended = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (extended?.[2]) {
    try {
      const name = sanitizeFilename(decodeURIComponent(extended[2].trim().replace(/^"|"$/g, '')));
      if (name) return name;
    } catch {
      // encodage illisible : on retombe sur filename=
    }
  }
  const plain = /filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))/i.exec(header);
  const raw = plain?.[1]?.replace(/\\(.)/g, '$1') ?? plain?.[2]?.trim();
  const name = raw ? sanitizeFilename(raw) : '';
  return name || undefined;
}

/** Dernier segment non vide du chemin de l'URL. */
export function filenameFromUrlPath(url: URL): string | undefined {
  const segment = url.pathname.split('/').filter(Boolean).pop();
  if (!segment) return undefined;
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // segment mal encodé : gardé tel quel
  }
  return sanitizeFilename(decoded) || undefined;
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Résout toutes les sources, dans l'ordre, et renvoie les pièces jointes
 * prêtes à composer. Lève `AttachmentSourceError` (source introuvable ou
 * refusée) ou `AttachmentTooLargeError` (cumul au-delà de `maxBytes`).
 */
export async function resolveAttachmentSources(
  items: AttachmentSourceInput[] | undefined,
  deps: AttachmentSourceDeps,
): Promise<ComposeAttachment[]> {
  if (!items || items.length === 0) return [];

  const fetchMessageAttachments =
    deps.fetchMessageAttachments ??
    ((folder: string, uid: number) => getMessageAttachments(folder, uid));

  // Plusieurs pièces jointes d'un même message : un seul téléchargement IMAP.
  const messageCache = new Map<string, Promise<AttachmentContent[]>>();
  const loadMessage = (folder: string, uid: number) => {
    const key = `${folder}\u0000${uid}`;
    let pending = messageCache.get(key);
    if (!pending) {
      pending = fetchMessageAttachments(folder, uid);
      messageCache.set(key, pending);
    }
    return pending;
  };

  const resolved: ComposeAttachment[] = [];
  let total = 0;

  for (const [position, item] of items.entries()) {
    const name = label(item, position);
    const problem = attachmentSourceProblem(item);
    if (problem) throw new AttachmentSourceError(`${name} : ${problem}.`);

    const remaining = deps.maxBytes - total;
    const attachment = await resolveOne(item, name, remaining, loadMessage, deps);
    total += attachment.content.length;
    if (total > deps.maxBytes) {
      throw new AttachmentTooLargeError(
        `Pièces jointes trop volumineuses : ${total} octets au total à ${name}, ` +
          `au-delà de la limite de ${deps.maxBytes} octets (ATTACHMENT_MAX_BYTES).`,
      );
    }
    resolved.push(attachment);
  }
  return resolved;
}

async function resolveOne(
  item: AttachmentSourceInput,
  name: string,
  remaining: number,
  loadMessage: (folder: string, uid: number) => Promise<AttachmentContent[]>,
  deps: AttachmentSourceDeps,
): Promise<ComposeAttachment> {
  if (item.contentBase64 !== undefined) {
    const decodedSize = decodedBase64Size(item.contentBase64);
    if (decodedSize > remaining)
      throw new AttachmentTooLargeError(
        `${name} : contenu base64 au-delà des ${remaining} octets disponibles.`,
      );
    return {
      filename: item.filename as string,
      contentType: item.contentType,
      content: Buffer.from(item.contentBase64, 'base64'),
    };
  }

  if (item.uploadId !== undefined) {
    const upload = (deps.uploads ?? uploadStore).get(item.uploadId);
    if (!upload) {
      throw new AttachmentSourceError(
        `${name} : dépôt "${item.uploadId}" inconnu, expiré ou déjà utilisé ` +
          '(un dépôt vit 1 h et ne sert qu’à un seul envoi ; recréer un lien avec create_upload_link).',
      );
    }
    if (upload.size > remaining) {
      throw new AttachmentTooLargeError(
        `${name} : fichier de ${upload.size} octets, au-delà des ${remaining} ` +
          `octets encore disponibles (ATTACHMENT_MAX_BYTES, cumul de toutes les pièces jointes).`,
      );
    }
    const filename = item.filename ?? upload.filename;
    if (!filename) {
      throw new AttachmentSourceError(
        `${name} : le dépôt "${item.uploadId}" n’a pas de nom de fichier ; fournir filename.`,
      );
    }
    return {
      filename,
      contentType: item.contentType ?? upload.contentType,
      content: upload.content,
    };
  }

  if (item.fromMessage?.part !== undefined) {
    return resolveMessagePart(item, item.fromMessage.part, name, remaining, deps);
  }

  if (item.fromMessage !== undefined) {
    const { uid } = item.fromMessage;
    const index = item.fromMessage.index as number;
    const folder = item.fromMessage.folder ?? DEFAULT_FOLDER;
    if (!deps.fetchMessageAttachments) {
      const original = await getAttachment(folder, uid, index, remaining);
      return {
        filename: item.filename ?? original.filename ?? `attachment-${index}`,
        contentType: item.contentType ?? original.contentType,
        content: original.content,
      };
    }
    let attachments: AttachmentContent[];
    try {
      attachments = await loadMessage(folder, uid);
    } catch (err) {
      throw new AttachmentSourceError(
        `${name} : impossible de lire le message UID ${uid} dans "${folder}" ` +
          `(${(err as Error).message}).`,
      );
    }
    const original = attachments[index];
    if (!original) {
      throw new AttachmentSourceError(
        `${name} : pièce jointe #${index} introuvable dans le message UID ${uid} de "${folder}" ` +
          `(${attachments.length} pièce(s) jointe(s), voir read_message).`,
      );
    }
    if (original.content.length > remaining) {
      throw new AttachmentTooLargeError(
        `${name} : pièce jointe de ${original.content.length} octets, au-delà des ${remaining} ` +
          `octets encore disponibles (ATTACHMENT_MAX_BYTES, cumul de toutes les pièces jointes).`,
      );
    }
    return {
      filename: item.filename ?? original.filename ?? `attachment-${index}`,
      contentType: item.contentType ?? original.contentType,
      content: original.content,
    };
  }

  // Source `url`.
  const rawUrl = item.url as string;
  let fetched;
  try {
    fetched = await fetchHttpsGuarded(rawUrl, Math.max(remaining, 0), deps.fetch);
  } catch (err) {
    const message = `${name} : ${redactUrl(rawUrl)} refusée ou inaccessible — ${(err as Error).message}.`;
    if (err instanceof UrlTooLargeError) throw new AttachmentTooLargeError(message);
    throw new AttachmentSourceError(message);
  }

  const filename =
    item.filename ??
    filenameFromContentDisposition(headerValue(fetched.headers, 'content-disposition')) ??
    filenameFromUrlPath(fetched.url);
  if (!filename) {
    throw new AttachmentSourceError(
      `${name} : impossible de déduire un nom de fichier de ${redactUrl(rawUrl)} ; ` +
        'fournir filename.',
    );
  }
  return {
    filename,
    contentType: item.contentType ?? headerValue(fetched.headers, 'content-type')?.trim(),
    content: fetched.content,
  };
}

/** Identifiants des dépôts attachés, à consommer une fois l'envoi réussi. */
export function uploadIdsOf(items: AttachmentSourceInput[] | undefined): string[] {
  return (items ?? []).flatMap((item) => (item.uploadId !== undefined ? [item.uploadId] : []));
}

/**
 * Supprime les dépôts attachés. À n'appeler qu'APRÈS l'envoi du mail ou
 * l'enregistrement du brouillon : un échec doit laisser le dépôt réutilisable.
 */
export function consumeUploads(
  items: AttachmentSourceInput[] | undefined,
  uploads: Pick<UploadStore, 'delete'> = uploadStore,
): void {
  for (const uploadId of uploadIdsOf(items)) uploads.delete(uploadId);
}

/**
 * Source `fromMessage` par numéro de partie IMAP : seule cette partie est
 * téléchargée, sous le budget restant (refus sur la taille annoncée, puis
 * coupure du flux).
 */
async function resolveMessagePart(
  item: AttachmentSourceInput,
  part: string,
  name: string,
  remaining: number,
  deps: AttachmentSourceDeps,
): Promise<ComposeAttachment> {
  const { uid } = item.fromMessage as FromMessageSource;
  const folder = item.fromMessage?.folder ?? DEFAULT_FOLDER;
  const fetchPart =
    deps.fetchAttachmentPart ??
    ((f: string, u: number, p: string, max: number) => getAttachmentPart(f, u, p, max));
  let original: AttachmentPartContent;
  try {
    original = await fetchPart(folder, uid, part, Math.max(remaining, 0));
  } catch (err) {
    if (err instanceof AttachmentTooLargeError) {
      throw new AttachmentTooLargeError(
        `${name} : ${err.message} Budget restant : ${remaining} octets (cumul de toutes les ` +
          'pièces jointes).',
      );
    }
    throw new AttachmentSourceError(
      `${name} : impossible de lire la partie ${part} du message UID ${uid} dans "${folder}" ` +
        `(${(err as Error).message}).`,
    );
  }
  return {
    filename: item.filename ?? original.filename ?? `attachment-${part}`,
    contentType: item.contentType ?? original.contentType,
    content: original.content,
  };
}

/** URL sans requête ni fragment (un jeton d'accès n'a rien à faire dans un message d'erreur). */
export function redactUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return 'URL illisible';
  }
}
