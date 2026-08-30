import { simpleParser } from 'mailparser';
import { sendMail } from './client.js';
import type { SendResult } from './client.js';
import type { ComposeAttachment } from './compose.js';
import { config } from '../config.js';
import { getMessage, getMessageSource } from '../imap/messages.js';
import { markAnswered } from '../imap/answered.js';
import { buildReplyHeaders, forwardSubject } from '../imap/threading.js';

export interface NewMessageInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: ComposeAttachment[];
}

export async function sendNewMessage(input: NewMessageInput): Promise<SendResult> {
  return sendMail(input);
}

export interface ReplyInput {
  folder: string;
  uid: number;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  text?: string;
  html?: string;
  replyAll?: boolean;
  attachments?: ComposeAttachment[];
}

export async function sendReply(input: ReplyInput): Promise<SendResult> {
  const original = await getMessage(input.folder, input.uid);
  const reply = buildReplyHeaders(original, {
    replyAll: input.replyAll ?? false,
    selfAddress: config.ICLOUD_EMAIL,
    cc: input.cc,
  });

  const to = input.to && input.to.length > 0 ? input.to : reply.to;
  if (to.length === 0) {
    throw new Error(
      `Impossible de déterminer un destinataire pour la réponse au message UID ${input.uid} ` +
        `(pas de champ "From" sur le message original et aucun "to" fourni)`,
    );
  }

  const result = await sendMail({
    to,
    cc: reply.cc,
    bcc: input.bcc,
    subject: reply.subject,
    text: input.text,
    html: input.html,
    inReplyTo: reply.inReplyTo,
    references: reply.references,
    attachments: input.attachments,
  });

  // Non bloquant : l'échec du flag ne remet pas en cause l'envoi réussi.
  const markedAnswered = await markAnswered(input.folder, input.uid);
  return { ...result, markedAnswered };
}

export interface ForwardInput {
  folder: string;
  uid: number;
  to: string[];
  cc?: string[];
  bcc?: string[];
  text?: string;
  html?: string;
  attachments?: ComposeAttachment[];
}

export async function sendForward(input: ForwardInput): Promise<SendResult> {
  const source = await getMessageSource(input.folder, input.uid);
  const parsed = await simpleParser(source);

  // Message d'origine joint verbatim (en-têtes et pièces jointes préservés)
  // plutôt que cité en texte : fidélité totale.
  const forwarded: ComposeAttachment = {
    filename: forwardFilename(parsed.subject),
    contentType: 'message/rfc822',
    content: source,
  };

  return sendMail({
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: forwardSubject(parsed.subject),
    text: input.text,
    html: input.html,
    attachments: [forwarded, ...(input.attachments ?? [])],
  });
}

function forwardFilename(subject: string | undefined): string {
  const base = (subject ?? 'message').replace(/[^\p{L}\p{N} ._-]/gu, '').trim() || 'message';
  return `${base}.eml`.slice(0, 100);
}
