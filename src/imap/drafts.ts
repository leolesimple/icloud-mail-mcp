import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { config } from '../config.js';
import { imapPool } from './pool.js';
import { classifyImapError } from './errors.js';
import { findSpecialFolder } from './special-folders.js';
import { getMessage } from './messages.js';
import { buildReplyHeaders } from './threading.js';

export interface DraftInput {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  text?: string;
  html?: string;
  replyFolder?: string;
  replyUid?: number;
}

export interface DraftResult {
  folder: string;
  uid?: number;
}

export async function saveDraft(input: DraftInput): Promise<DraftResult> {
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

  const raw = await new MailComposer({
    from: config.ICLOUD_EMAIL,
    to,
    cc: input.cc,
    bcc: input.bcc,
    subject,
    text: input.text,
    html: input.html,
    inReplyTo,
    references,
  })
    .compile()
    .build();

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
