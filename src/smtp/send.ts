import { sendMail } from './client.js';
import type { SendResult } from './client.js';
import { getMessage } from '../imap/messages.js';
import { buildReplyHeaders } from '../imap/threading.js';

export interface NewMessageInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
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
}

export async function sendReply(input: ReplyInput): Promise<SendResult> {
  const original = await getMessage(input.folder, input.uid);
  const reply = buildReplyHeaders(original);

  const to = input.to && input.to.length > 0 ? input.to : reply.to;
  if (to.length === 0) {
    throw new Error(
      `Impossible de déterminer un destinataire pour la réponse au message UID ${input.uid} ` +
        `(pas de champ "From" sur le message original et aucun "to" fourni)`,
    );
  }

  return sendMail({
    to,
    cc: input.cc,
    bcc: input.bcc,
    subject: reply.subject,
    text: input.text,
    html: input.html,
    inReplyTo: reply.inReplyTo,
    references: reply.references,
  });
}
