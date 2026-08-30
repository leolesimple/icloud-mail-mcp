import { simpleParser } from 'mailparser';
import type { ImapFlow } from 'imapflow';
import { imapPool } from './pool.js';
import { classifyImapError } from './errors.js';
import { findSpecialFolder } from './special-folders.js';
import { getMessage } from './messages.js';
import { buildReplyHeaders } from './threading.js';
import { sendMail } from '../smtp/client.js';
import type { SendResult } from '../smtp/client.js';
import { composeRaw } from '../smtp/compose.js';
import type { ComposeAttachment } from '../smtp/compose.js';
import { SmtpAuthError, SmtpMessageError, SmtpNetworkError } from '../smtp/errors.js';
import { checkSendAllowed } from '../smtp/guards.js';
import { sendQuota } from '../smtp/quota.js';

/** Les erreurs SMTP portent déjà un message utilisateur : ne pas les reclasser en erreur IMAP. */
function rethrowClassified(err: unknown): never {
  if (err instanceof SmtpAuthError || err instanceof SmtpNetworkError || err instanceof SmtpMessageError) {
    throw err;
  }
  throw classifyImapError(err);
}

export interface DraftInput {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  text?: string;
  html?: string;
  replyFolder?: string;
  replyUid?: number;
  attachments?: ComposeAttachment[];
}

export interface DraftResult {
  folder: string;
  uid?: number;
}

interface ComposedDraft {
  raw: Buffer;
  to: string[];
}

/** Résout destinataire + sujet (avec threading si réponse), puis compile le MIME du brouillon. */
async function composeDraft(input: DraftInput): Promise<ComposedDraft> {
  let to = input.to;
  let subject = input.subject;
  let inReplyTo: string | undefined;
  let references: string[] = [];

  if (input.replyFolder && input.replyUid) {
    const original = await getMessage(input.replyFolder, input.replyUid);
    const reply = buildReplyHeaders(original);

    if (!to || to.length === 0) {
      to = reply.to;
    }
    subject = subject ?? reply.subject;
    inReplyTo = reply.inReplyTo;
    references = reply.references;
  }

  if (!to || to.length === 0) {
    throw new Error(
      'Destinataire ("to") requis, ou fournir replyFolder + replyUid pour répondre à un message existant.',
    );
  }
  if (!subject) {
    throw new Error('Sujet requis, sauf en réponse à un message existant (replyFolder + replyUid).');
  }

  const raw = await composeRaw({
    to,
    cc: input.cc,
    bcc: input.bcc,
    subject,
    text: input.text,
    html: input.html,
    inReplyTo,
    references,
    attachments: input.attachments,
  });

  return { raw, to };
}

export async function saveDraft(input: DraftInput): Promise<DraftResult> {
  const { raw } = await composeDraft(input);

  try {
    return await imapPool.withConnection(async (client) => {
      const draftsPath = (await findSpecialFolder(client, '\\Drafts')) ?? 'Drafts';
      const result = await client.append(draftsPath, raw, ['\\Draft']);
      return { folder: draftsPath, uid: result ? result.uid : undefined };
    });
  } catch (err) {
    throw classifyImapError(err);
  }
}

export interface UpdateDraftResult {
  folder: string;
  uid?: number;
  /** UID de l'ancienne version, supprimée après l'écriture de la nouvelle. */
  replacedUid: number;
}

/**
 * Cœur testable du remplacement de brouillon. L'ordre est volontaire : on
 * APPEND la nouvelle version PUIS on supprime l'ancienne. Une panne au milieu
 * laisse un doublon (récupérable) plutôt qu'un contenu perdu.
 */
export async function updateDraftOn(
  client: ImapFlow,
  draftsPath: string,
  uid: number,
  input: DraftInput,
): Promise<UpdateDraftResult> {
  const { raw } = await composeDraft(input);

  const appended = await client.append(draftsPath, raw, ['\\Draft']);
  const lock = await client.getMailboxLock(draftsPath);
  try {
    await client.messageDelete(uid, { uid: true });
  } finally {
    lock.release();
  }

  return { folder: draftsPath, uid: appended ? appended.uid : undefined, replacedUid: uid };
}

export async function updateDraft(uid: number, input: DraftInput): Promise<UpdateDraftResult> {
  try {
    return await imapPool.withConnection(async (client) => {
      const draftsPath = (await findSpecialFolder(client, '\\Drafts')) ?? 'Drafts';
      return updateDraftOn(client, draftsPath, uid, input);
    });
  } catch (err) {
    throw classifyImapError(err);
  }
}

export interface SendDraftResult {
  /** `undefined` si le message n'est pas parti (voir `reason`). */
  send?: SendResult;
  /** Renseigné quand les garde-fous ont dévié l'envoi (DRAFTS_ONLY). */
  reason?: 'DRAFTS_ONLY';
  /** Le brouillon a été recopié dans le dossier Sent. */
  copiedToSent: boolean;
  /** Le brouillon d'origine a été supprimé du dossier Drafts. */
  draftDeleted: boolean;
}

/**
 * Cœur testable de l'envoi d'un brouillon. Ordre : lire la source, envoyer
 * (chemin SMTP normal, coupe-circuit ENABLE_SENDING inclus), copier dans Sent,
 * puis seulement supprimer le brouillon. Si l'envoi échoue, le brouillon reste
 * intact.
 */
export async function sendDraftOn(
  client: ImapFlow,
  draftsPath: string,
  sentPath: string | undefined,
  uid: number,
): Promise<SendDraftResult> {
  const readLock = await client.getMailboxLock(draftsPath, { readOnly: true });
  let raw: Buffer;
  try {
    const fetched = await client.fetchOne(uid, { uid: true, source: true }, { uid: true });
    if (!fetched || !fetched.source) {
      throw new Error(`Brouillon UID ${uid} introuvable dans "${draftsPath}"`);
    }
    raw = fetched.source;
  } finally {
    readLock.release();
  }
  const parsed = await simpleParser(raw);

  const addresses = (value: (typeof parsed)['to']): string[] => {
    if (!value) return [];
    const list = Array.isArray(value) ? value : [value];
    return list.flatMap((entry) => entry.value.map((v) => v.address).filter((a): a is string => Boolean(a)));
  };

  const to = addresses(parsed.to);
  if (to.length === 0) {
    throw new Error(`Le brouillon UID ${uid} n'a pas de destinataire : impossible de l'envoyer.`);
  }

  const cc = addresses(parsed.cc);
  const bcc = addresses(parsed.bcc);

  // Mêmes garde-fous que send_message / reply_message. En DRAFTS_ONLY le
  // brouillon est déjà dans Drafts : on le laisse intact, sans doublon.
  const decision = checkSendAllowed({ to, cc, bcc });
  if (decision.action === 'deny') {
    throw new SmtpMessageError(decision.reason);
  }
  if (decision.action === 'draft') {
    return { copiedToSent: false, draftDeleted: false, reason: 'DRAFTS_ONLY' };
  }

  const send = await sendMail({
    to,
    cc,
    bcc,
    subject: parsed.subject ?? '',
    text: parsed.text,
    html: parsed.html || undefined,
    inReplyTo: parsed.inReplyTo,
    references: Array.isArray(parsed.references)
      ? parsed.references
      : parsed.references
        ? [parsed.references]
        : undefined,
  });

  sendQuota.record();

  let copiedToSent = false;
  if (sentPath) {
    // iCloud ne classe pas les envois SMTP externes : on recopie nous-mêmes.
    await client.append(sentPath, raw, ['\\Seen']);
    copiedToSent = true;
  }

  const lock = await client.getMailboxLock(draftsPath);
  try {
    await client.messageDelete(uid, { uid: true });
  } finally {
    lock.release();
  }

  return { send, copiedToSent, draftDeleted: true };
}

export async function sendDraft(uid: number): Promise<SendDraftResult> {
  try {
    return await imapPool.withConnection(async (client) => {
      const draftsPath = (await findSpecialFolder(client, '\\Drafts')) ?? 'Drafts';
      const sentPath = await findSpecialFolder(client, '\\Sent');
      return sendDraftOn(client, draftsPath, sentPath, uid);
    });
  } catch (err) {
    rethrowClassified(err);
  }
}
