/**
 * Validation de `compose_message`, sans effet de bord. L'outil regroupe cinq
 * anciens outils (send_message, reply_message, forward_message, save_draft,
 * update_draft) : chaque combinaison `mode` × `deliver` (× `draftUid`) est
 * soit ramenée à l'une de ces opérations, soit refusée avec un message en
 * français qui dit quoi corriger.
 *
 * Les combinaisons sans équivalent existant (transfert ou réponse à tous en
 * brouillon) sont refusées plutôt qu'approximées.
 */

export const COMPOSE_MODES = ['new', 'reply', 'reply_all', 'forward'] as const;
export type ComposeMode = (typeof COMPOSE_MODES)[number];

export const COMPOSE_DELIVERIES = ['send', 'draft'] as const;
export type ComposeDelivery = (typeof COMPOSE_DELIVERIES)[number];

export interface ComposeRequest {
  mode: ComposeMode;
  deliver: ComposeDelivery;
  draftUid?: number;
  folder?: string;
  uid?: number;
  to?: string[];
  subject?: string;
  text?: string;
  html?: string;
}

/** Opération existante vers laquelle la requête est routée. */
export type ComposeOperation = 'send_new' | 'send_reply' | 'send_forward' | 'save_draft' | 'update_draft';

export type ComposePlan = { ok: true; operation: ComposeOperation } | { ok: false; error: string };

const fail = (error: string): ComposePlan => ({ ok: false, error });

export function planCompose(request: ComposeRequest): ComposePlan {
  const { mode, deliver, draftUid } = request;
  const hasTo = (request.to?.length ?? 0) > 0;

  if (draftUid !== undefined && deliver !== 'draft') {
    return fail(
      'draftUid ne s\'utilise qu\'avec deliver: "draft" (pour remplacer ce brouillon). ' +
        'Pour envoyer un brouillon existant, utiliser send_draft.',
    );
  }

  // Combinaisons sans équivalent dans la couche IMAP/SMTP actuelle.
  if (deliver === 'draft' && mode === 'forward') {
    return fail(
      'Le transfert en brouillon n\'est pas pris en charge : utiliser deliver: "send", ' +
        'ou mode "new" en brouillon (sans le message d\'origine en pièce jointe).',
    );
  }
  if (deliver === 'draft' && mode === 'reply_all') {
    return fail(
      'La réponse à tous en brouillon n\'est pas prise en charge : utiliser mode "reply" ' +
        'en brouillon en listant les autres destinataires dans cc, ou deliver: "send".',
    );
  }

  if (mode === 'new') {
    if (request.uid !== undefined || request.folder !== undefined) {
      return fail('folder et uid ne s\'utilisent qu\'avec mode "reply", "reply_all" ou "forward".');
    }
    if (!hasTo) {
      return fail('Un nouveau message exige au moins un destinataire ("to").');
    }
    if (!request.subject) {
      return fail('Un nouveau message exige un sujet ("subject").');
    }
  } else if (request.uid === undefined) {
    return fail(`Le mode "${mode}" exige l'uid du message d'origine (et son folder, INBOX par défaut).`);
  }

  if (mode === 'forward' && !hasTo) {
    return fail('Un transfert exige au moins un destinataire ("to").');
  }

  if (mode !== 'forward' && !request.text && !request.html) {
    return fail('Fournir au moins un corps de message (text ou html).');
  }

  // À l'envoi, le sujet d'une réponse ou d'un transfert est dérivé de l'original
  // (Re: / Fwd:) : un `subject` fourni serait ignoré sans le dire.
  if (deliver === 'send' && mode !== 'new' && request.subject !== undefined) {
    return fail(
      `Le sujet est dérivé du message d'origine en mode "${mode}" : ne pas fournir "subject" ` +
        '(ou passer par deliver: "draft" pour le modifier).',
    );
  }

  if (deliver === 'draft') {
    return { ok: true, operation: draftUid !== undefined ? 'update_draft' : 'save_draft' };
  }
  if (mode === 'new') return { ok: true, operation: 'send_new' };
  if (mode === 'forward') return { ok: true, operation: 'send_forward' };
  return { ok: true, operation: 'send_reply' };
}
