import { simpleParser } from 'mailparser';
import { sendMail } from './client.js';
import type { SendResult } from './client.js';
import type { ComposeAttachment } from './compose.js';
import { SmtpMessageError } from './errors.js';
import { checkSendAllowed } from './guards.js';
import type { GuardContext, GuardMessage } from './guards.js';
import { sendQuota } from './quota.js';
import { config } from '../config.js';
import { getMessage, getMessageSource } from '../imap/messages.js';
import { markAnswered } from '../imap/answered.js';
import { saveDraft } from '../imap/drafts.js';
import type { DraftResult } from '../imap/drafts.js';
import { buildReplyHeaders, forwardSubject } from '../imap/threading.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'smtp' });

export interface NewMessageInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: ComposeAttachment[];
}

/** Le message est parti. */
export interface SentOutcome {
  sent: true;
  messageId: string;
  accepted: string[];
  rejected: string[];
  /** Copie dans « Sent » : `false` si l'APPEND a échoué (l'envoi reste un succès). */
  savedToSent?: boolean;
  /** Flag `\Answered` posé sur le message d'origine (réponses uniquement). */
  markedAnswered?: boolean;
}

/** Le message n'est pas parti : il a été déposé dans Drafts (DRAFTS_ONLY). */
export interface DraftOutcome {
  sent: false;
  draft: { folder: string; uid?: number };
  reason: 'DRAFTS_ONLY';
}

export type SendOutcome = SentOutcome | DraftOutcome;

export interface SendActions {
  /** Émet réellement le message et renvoie le résultat du transport. */
  send: () => Promise<SendResult>;
  /** Compose le message et le dépose dans Drafts (threading compris). */
  draft: () => Promise<DraftResult>;
}

/**
 * Applique les garde-fous puis exécute l'action correspondante. Partagé par
 * `send_message`, `reply_message`, `forward_message` — et `send_draft` (lot B),
 * qui peut réutiliser cette fonction telle quelle.
 *
 * `ctx` est injectable pour les tests ; par défaut la vraie config + le vrai quota.
 */
export async function resolveSendOutcome(
  recipients: GuardMessage,
  actions: SendActions,
  ctx?: GuardContext,
): Promise<SendOutcome> {
  const decision = checkSendAllowed(recipients, ctx);

  if (decision.action === 'deny') {
    throw new SmtpMessageError(decision.reason);
  }

  if (decision.action === 'draft') {
    const draft = await actions.draft();
    log.info({ folder: draft.folder, uid: draft.uid }, 'DRAFTS_ONLY: message saved to Drafts, not sent');
    return { sent: false, draft: { folder: draft.folder, uid: draft.uid }, reason: 'DRAFTS_ONLY' };
  }

  // decision.action === 'allow'
  // Traçabilité : on doit voir dans les logs chaque envoi passé sans garde-fou.
  if ((ctx?.config ?? config).UNRESTRICTED) {
    log.warn(
      { to: recipients.to, cc: recipients.cc, bcc: recipients.bcc },
      'UNRESTRICTED=true: message sent with sending guards disabled (allowlist, quota, circuit breaker)',
    );
  }

  const result = await actions.send();
  sendQuota.record();
  return {
    sent: true,
    messageId: result.messageId,
    accepted: result.accepted,
    rejected: result.rejected,
    savedToSent: result.savedToSent,
  };
}

export async function sendNewMessage(input: NewMessageInput): Promise<SendOutcome> {
  return resolveSendOutcome(
    { to: input.to, cc: input.cc, bcc: input.bcc },
    {
      send: () => sendMail(input),
      draft: () =>
        saveDraft({
          to: input.to,
          cc: input.cc,
          bcc: input.bcc,
          subject: input.subject,
          text: input.text,
          html: input.html,
          attachments: input.attachments,
        }),
    },
  );
}

export interface ReplyInput {
  folder: string;
  uid: number;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  replyAll?: boolean;
  text?: string;
  html?: string;
  attachments?: ComposeAttachment[];
}

export async function sendReply(input: ReplyInput): Promise<SendOutcome> {
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

  const outcome = await resolveSendOutcome(
    { to, cc: reply.cc, bcc: input.bcc },
    {
      send: () =>
        sendMail({
          to,
          cc: reply.cc,
          bcc: input.bcc,
          subject: reply.subject,
          text: input.text,
          html: input.html,
          inReplyTo: reply.inReplyTo,
          references: reply.references,
          attachments: input.attachments,
        }),
      draft: () =>
        saveDraft({
          to,
          cc: reply.cc,
          bcc: input.bcc,
          text: input.text,
          html: input.html,
          replyFolder: input.folder,
          replyUid: input.uid,
          attachments: input.attachments,
        }),
    },
  );

  // `\Answered` n'a de sens que si la réponse est réellement partie : en
  // DRAFTS_ONLY, le message d'origine n'a pas encore reçu de réponse.
  if (!outcome.sent) {
    return outcome;
  }

  // Non bloquant : l'échec du flag ne remet pas en cause l'envoi réussi.
  const markedAnswered = await markAnswered(input.folder, input.uid);
  return { ...outcome, markedAnswered };
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

export async function sendForward(input: ForwardInput): Promise<SendOutcome> {
  const source = await getMessageSource(input.folder, input.uid);
  const parsed = await simpleParser(source);

  // Message d'origine joint verbatim (en-têtes et pièces jointes préservés)
  // plutôt que cité en texte : fidélité totale.
  const forwarded: ComposeAttachment = {
    filename: forwardFilename(parsed.subject),
    contentType: 'message/rfc822',
    content: source,
  };
  const subject = forwardSubject(parsed.subject);
  const attachments = [forwarded, ...(input.attachments ?? [])];

  return resolveSendOutcome(
    { to: input.to, cc: input.cc, bcc: input.bcc },
    {
      send: () =>
        sendMail({
          to: input.to,
          cc: input.cc,
          bcc: input.bcc,
          subject,
          text: input.text,
          html: input.html,
          attachments,
        }),
      draft: () =>
        saveDraft({
          to: input.to,
          cc: input.cc,
          bcc: input.bcc,
          subject,
          text: input.text,
          html: input.html,
          attachments,
        }),
    },
  );
}

function forwardFilename(subject: string | undefined): string {
  const base = (subject ?? 'message').replace(/[^\p{L}\p{N} ._-]/gu, '').trim() || 'message';
  return `${base}.eml`.slice(0, 100);
}
