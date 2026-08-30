import nodemailer from 'nodemailer';
import { account } from '../account.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { composeRaw } from './compose.js';
import type { ComposeAttachment } from './compose.js';
import { saveToSent } from '../imap/sent.js';
import { classifySmtpError, SmtpMessageError, SmtpNetworkError } from './errors.js';

const log = logger.child({ module: 'smtp' });

const transporter = nodemailer.createTransport({
  host: account.smtp.host,
  port: account.smtp.port,
  secure: false, // STARTTLS sur le port 587, pas de TLS implicite
  requireTLS: true,
  auth: {
    user: account.email,
    pass: account.password,
  },
  pool: true,
  maxConnections: config.SMTP_POOL_SIZE,
  connectionTimeout: 15_000,
  greetingTimeout: 15_000,
  socketTimeout: 30_000,
});

export interface OutgoingMessage {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: ComposeAttachment[];
}

export interface SendResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
  /** `true` si le message a bien été archivé dans « Sent », `false` si l'APPEND a échoué. */
  savedToSent?: boolean;
  /** `true` si le message d'origine a bien été marqué `\Answered` (réponses uniquement). */
  markedAnswered?: boolean;
}

/** Message-ID généré par MailComposer, lu dans le buffer déjà composé (jamais régénéré). */
function extractMessageId(raw: Buffer): string {
  const headerBlock = raw.toString('utf8').split(/\r?\n\r?\n/, 1)[0] ?? '';
  return headerBlock.match(/^message-id:\s*(<[^>\r\n]+>)/im)?.[1] ?? '';
}

async function sendRawOnce(raw: Buffer, envelope: { from: string; to: string[] }, messageId: string): Promise<SendResult> {
  const info = await transporter.sendMail({ envelope, raw });
  log.info(
    { messageId, accepted: info.accepted.length, rejected: info.rejected.length },
    'message sent',
  );
  return {
    messageId: messageId || String(info.messageId ?? ''),
    accepted: info.accepted.map(String),
    rejected: info.rejected.map(String),
  };
}

export async function sendMail(message: OutgoingMessage): Promise<SendResult> {
  if (!config.ENABLE_SENDING) {
    throw new SmtpMessageError(
      "Envoi de messages désactivé (ENABLE_SENDING=false) : send_message et reply_message n'émettent rien tant que ce n'est pas réactivé dans .env.",
    );
  }

  // Composé une seule fois, HORS de la boucle de retry : le message archivé dans
  // « Sent » est bit-pour-bit celui qui part, et le Message-ID est unique.
  const raw = await composeRaw({
    from: account.email,
    to: message.to,
    cc: message.cc,
    bcc: message.bcc,
    subject: message.subject,
    text: message.text,
    html: message.html,
    inReplyTo: message.inReplyTo,
    references: message.references,
    attachments: message.attachments,
  });
  const messageId = extractMessageId(raw);
  const envelope = {
    from: account.email,
    to: [...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])],
  };

  let result: SendResult;
  try {
    result = await sendRawOnce(raw, envelope, messageId);
  } catch (err) {
    const classified = classifySmtpError(err);
    if (!(classified instanceof SmtpNetworkError)) {
      throw classified;
    }
    log.warn({ reason: classified.message }, 'smtp send failed, retrying once');
    await new Promise((resolve) => setTimeout(resolve, 750));
    try {
      result = await sendRawOnce(raw, envelope, messageId);
    } catch (retryErr) {
      throw classifySmtpError(retryErr);
    }
  }

  const savedToSent = await saveToSent(raw);
  return { ...result, savedToSent };
}

export function closeSmtp(): void {
  transporter.close();
}
