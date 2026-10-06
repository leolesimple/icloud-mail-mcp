import { confirmToolAction } from '../confirm-flow.js';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { sendForward, sendNewMessage, sendReply } from '../../smtp/send.js';
import { saveDraft, updateDraft } from '../../imap/drafts.js';
import { AttachmentTooLargeError } from '../../attachments.js';
import {
  AttachmentSourceError,
  consumeUploads,
  resolveAttachmentSources,
} from '../../attachment-sources.js';
import { uploadStore } from '../../uploads.js';
import type { UploadStore } from '../../uploads.js';
import { config } from '../../config.js';
import { COMPOSE_DELIVERIES, COMPOSE_MODES, planCompose } from '../compose-plan.js';
import { jsonResult, errorResult } from '../result.js';
import { composeResultSchema } from '../schemas.js';
import { attachmentsInput, uidInput } from './inputs.js';
import { logger } from '../../logger.js';

const log = logger.child({ tool: 'compose_message' });

const DEFAULT_FOLDER = 'INBOX';

/** Accès IMAP/SMTP et stockage des dépôts, injectables pour les tests. */
export interface ComposeMessageDeps {
  sendNewMessage?: typeof sendNewMessage;
  sendReply?: typeof sendReply;
  sendForward?: typeof sendForward;
  saveDraft?: typeof saveDraft;
  updateDraft?: typeof updateDraft;
  /** Dépôts de `create_upload_link` (défaut : le stockage partagé). */
  uploads?: Pick<UploadStore, 'get' | 'delete'> & Partial<Pick<UploadStore, 'claim'>>;
}

export function registerComposeMessageTool(server: McpServer, deps: ComposeMessageDeps = {}): void {
  const ops = {
    sendNewMessage: deps.sendNewMessage ?? sendNewMessage,
    sendReply: deps.sendReply ?? sendReply,
    sendForward: deps.sendForward ?? sendForward,
    saveDraft: deps.saveDraft ?? saveDraft,
    updateDraft: deps.updateDraft ?? updateDraft,
  };
  const uploads = deps.uploads ?? uploadStore;

  server.registerTool(
    'compose_message',
    {
      title: 'Compose message',
      description:
        'Writes an email (courriel): a new message, a reply (répondre), a reply-all, or a forward (transférer), ' +
        'then either sends it or saves it as a draft (brouillon). mode "new" needs to + subject; ' +
        '"reply" / "reply_all" / "forward" need the original folder + uid (reply keeps threading, ' +
        'prefixes "Re:", defaults "to" to the original sender and marks the original answered; reply_all ' +
        'adds the other recipients as Cc; forward attaches the original verbatim and needs "to"). ' +
        'deliver "send" sends through iCloud SMTP and keeps a copy in Sent; deliver "draft" (default) saves ' +
        'to the Drafts folder without sending (new or reply only), and with draftUid replaces that existing ' +
        'draft. Sending is subject to the server guardrails: with DRAFTS_ONLY the message is saved as a draft ' +
        'instead (sent: false). Attachments: each item has exactly one source — contentBase64 (small ' +
        'files only), fromMessage { folder, uid, index or part } to reuse an attachment of a message in ' +
        'the mailbox (filename and contentType kept unless overridden; preferred for large files), or url ' +
        '(a public https:// URL the server downloads; private or local addresses are refused), or ' +
        'uploadId (a file uploaded out of band through create_upload_link; consumed once sent). The ' +
        'total is capped at ATTACHMENT_MAX_BYTES; if any source fails, nothing is sent or saved. ' +
        'Always confirm recipients and content with the user before sending.',
      inputSchema: {
        confirmToken: z.string().optional().describe('Token from the first confirmation request'),
        mode: z.enum(COMPOSE_MODES).default('new').describe('new, reply, reply_all or forward'),
        deliver: z
          .enum(COMPOSE_DELIVERIES)
          .default('draft')
          .describe('send it now, or save it as a draft (brouillon) in Drafts'),
        draftUid: uidInput
          .optional()
          .describe('With deliver "draft": UID of an existing draft (in Drafts) to replace'),
        folder: z
          .string()
          .min(1)
          .optional()
          .describe('reply / reply_all / forward: folder of the original message (default INBOX)'),
        uid: uidInput
          .optional()
          .describe('reply / reply_all / forward: UID of the original message'),
        to: z
          .array(z.string().email())
          .optional()
          .describe(
            'Recipients. Required for new and forward; for a reply, defaults to the original sender',
          ),
        cc: z
          .array(z.string().email())
          .optional()
          .describe('Cc; on reply_all, overrides the derived Cc'),
        bcc: z.array(z.string().email()).optional(),
        subject: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Required for new. Derived from the original for reply / forward (overridable in a draft)',
          ),
        text: z
          .string()
          .max(config.MAX_BODY_CHARS)
          .optional()
          .describe('Plain-text body (or the note above a forwarded message)'),
        html: z.string().max(config.MAX_BODY_CHARS).optional().describe('HTML body'),
        attachments: attachmentsInput,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      const plan = planCompose(input);
      if (!plan.ok) {
        return errorResult(plan.error);
      }

      const { mode, draftUid, to, cc, bcc, subject, text, html } = input;
      const folder = input.folder ?? DEFAULT_FOLDER;
      const uid = input.uid as number;

      const uploadIds =
        input.attachments?.flatMap((item) => (item.uploadId ? [item.uploadId] : [])) ?? [];
      for (const [index, attachment] of (input.attachments ?? []).entries()) {
        if (attachment.uploadId && !uploads.get(attachment.uploadId)) {
          return errorResult(
            `attachments[${index}] (uploadId) : dépôt inconnu, expiré ou déjà consommé.`,
          );
        }
      }
      const claim = uploads.claim?.(uploadIds);
      try {
        // Toutes les sources sont résolues avant d'envoyer ou d'écrire quoi que ce soit.
        const attachments = await resolveAttachmentSources(input.attachments, {
          maxBytes: config.ATTACHMENT_MAX_BYTES,
          uploads,
        });
        // Dépôts consommés seulement après un envoi ou un brouillon réussi.
        const done = <T>(result: T): T => {
          if (claim) claim.consume();
          else consumeUploads(input.attachments, uploads);
          return result;
        };
        log.info(
          { operation: plan.operation, mode, folder: input.folder, uid: input.uid, draftUid },
          'composing',
        );

        const execute = async () => {
          switch (plan.operation) {
            case 'send_new': {
              const result = await ops.sendNewMessage({
                to: to as string[],
                cc,
                bcc,
                subject: subject as string,
                text,
                html,
                attachments,
              });
              return done(jsonResult(result, composeResultSchema));
            }
            case 'send_reply': {
              const result = await ops.sendReply({
                folder,
                uid,
                to,
                cc,
                bcc,
                text,
                html,
                replyAll: mode === 'reply_all',
                attachments,
              });
              return done(jsonResult(result, composeResultSchema));
            }
            case 'send_forward': {
              const result = await ops.sendForward({
                folder,
                uid,
                to: to as string[],
                cc,
                bcc,
                text,
                html,
                attachments,
              });
              return done(jsonResult(result, composeResultSchema));
            }
            case 'save_draft':
            case 'update_draft': {
              const draftInput = {
                to,
                cc,
                bcc,
                subject,
                text,
                html,
                attachments,
                ...(mode === 'reply' ? { replyFolder: folder, replyUid: uid } : {}),
              };
              if (plan.operation === 'update_draft') {
                const { replacedUid, ...draft } = await ops.updateDraft(
                  draftUid as number,
                  draftInput,
                );
                return done(jsonResult({ sent: false, draft, replacedUid }, composeResultSchema));
              }
              const draft = await ops.saveDraft(draftInput);
              return done(jsonResult({ sent: false, draft }, composeResultSchema));
            }
          }
        };
        const boundInput = {
          ...input,
          attachments: attachments?.map((a) => ({ ...a, content: a.content.toString('base64') })),
        };
        return await (input.deliver === 'send'
          ? confirmToolAction(server.server, 'compose_message', boundInput, execute)
          : execute());
      } catch (err) {
        if (err instanceof AttachmentTooLargeError || err instanceof AttachmentSourceError) {
          return errorResult(err.message);
        }
        throw err;
      } finally {
        claim?.release();
      }
    },
  );
}
