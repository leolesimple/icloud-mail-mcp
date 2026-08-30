import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { account } from '../account.js';

export interface ComposeAttachment {
  filename: string;
  contentType?: string;
  content: Buffer;
  contentDisposition?: 'attachment' | 'inline';
  cid?: string;
}

export interface ComposeInput {
  from?: string; // défaut : account.email
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

/**
 * Fabrique MIME unique du projet. Produit le message RFC 5322 brut (avec un
 * Message-ID généré) à partir d'une intention d'envoi. Utilisée par les
 * brouillons IMAP et, à terme, par l'envoi SMTP.
 */
export async function composeRaw(input: ComposeInput): Promise<Buffer> {
  return new MailComposer({
    from: input.from ?? account.email,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    text: input.text,
    html: input.html,
    inReplyTo: input.inReplyTo,
    references: input.references,
    attachments: input.attachments?.map((attachment) => ({
      filename: attachment.filename,
      contentType: attachment.contentType,
      content: attachment.content,
      contentDisposition: attachment.contentDisposition,
      cid: attachment.cid,
    })),
  })
    .compile()
    .build();
}
