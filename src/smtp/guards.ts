import { config } from '../config.js';
import { sendQuota } from './quota.js';

/**
 * Garde-fous d'envoi gradués — module pur, testable sans réseau.
 *
 * Remplace le coupe-circuit tout-ou-rien `ENABLE_SENDING` par une décision à
 * trois issues, évaluées dans un ordre strict (voir `checkSendAllowed`).
 */

export type SendDecision =
  | { action: 'allow' }
  | { action: 'draft' }
  | { action: 'deny'; reason: string };

export interface GuardMessage {
  to: string[];
  cc?: string[];
  bcc?: string[];
}

/** Sous-ensemble de la config lu par les garde-fous. */
export interface GuardConfig {
  UNRESTRICTED: boolean;
  ENABLE_SENDING: boolean;
  DRAFTS_ONLY: boolean;
  /** Allowlist déjà normalisée (trim + lowercase, vides retirés) — `config.ALLOWED_RECIPIENTS_LIST`. */
  ALLOWED_RECIPIENTS_LIST: string[];
}

export interface GuardContext {
  config: GuardConfig;
  quota: { wouldExceed(): boolean; max: number };
}

function defaultContext(): GuardContext {
  return { config, quota: sendQuota };
}

/**
 * `true` si `recipient` est couvert par l'allowlist : adresse exacte, ou domaine
 * déclaré sous la forme `@exemple.com`. Une allowlist vide autorise tout.
 */
export function isRecipientAllowed(recipient: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) {
    return true;
  }
  const addr = recipient.trim().toLowerCase();
  const at = addr.lastIndexOf('@');
  const domain = at >= 0 ? addr.slice(at) : '';
  return allowlist.some((entry) => (entry.startsWith('@') ? domain === entry : addr === entry));
}

/** Destinataires (to + cc + bcc) qui ne sont couverts par aucune entrée de l'allowlist. */
export function recipientsOutsideAllowlist(message: GuardMessage, allowlist: string[]): string[] {
  if (allowlist.length === 0) {
    return [];
  }
  const all = [...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])];
  return all.filter((recipient) => !isRecipientAllowed(recipient, allowlist));
}

/**
 * Évalue les garde-fous pour un message donné. Ordre strict :
 *
 * 1. `UNRESTRICTED` → `allow` (le warn de traçabilité est émis par l'appelant).
 * 2. `ENABLE_SENDING=false` → `deny` (coupe-circuit historique).
 * 3. `DRAFTS_ONLY=true` → `draft` (ce n'est PAS une erreur — le message est
 *    déposé dans Drafts par l'appelant).
 * 4. `ALLOWED_RECIPIENTS` non vide → `deny` si un destinataire est hors liste,
 *    en nommant les adresses fautives.
 * 5. `MAX_SENDS_PER_DAY` → `deny` au-delà du quota glissant sur 24 h.
 */
export function checkSendAllowed(message: GuardMessage, ctx: GuardContext = defaultContext()): SendDecision {
  const { config: cfg, quota } = ctx;

  // 1. Mode sans filet : tout passe. Les garde-fous n°2 à 5 sont court-circuités.
  if (cfg.UNRESTRICTED) {
    return { action: 'allow' };
  }

  // 2. Coupe-circuit historique.
  if (!cfg.ENABLE_SENDING) {
    return {
      action: 'deny',
      reason:
        "Envoi désactivé (ENABLE_SENDING=false) : aucun message n'est transmis. " +
        'Réactiver ENABLE_SENDING dans .env, ou passer DRAFTS_ONLY=true pour que ' +
        'send_message / reply_message déposent le message en brouillon au lieu de le perdre.',
    };
  }

  // 3. Mode brouillon obligatoire — succès, pas erreur.
  if (cfg.DRAFTS_ONLY) {
    return { action: 'draft' };
  }

  // 4. Allowlist de destinataires.
  const offenders = recipientsOutsideAllowlist(message, cfg.ALLOWED_RECIPIENTS_LIST);
  if (offenders.length > 0) {
    return {
      action: 'deny',
      reason:
        `Destinataire(s) hors de la liste autorisée (ALLOWED_RECIPIENTS) : ${offenders.join(', ')}. ` +
        'Ajouter ces adresses, ou leur domaine sous la forme @exemple.com, à ALLOWED_RECIPIENTS ; ' +
        'ou vider la variable pour lever la restriction.',
    };
  }

  // 5. Quota journalier.
  if (quota.wouldExceed()) {
    return {
      action: 'deny',
      reason:
        `Quota d'envoi atteint : ${quota.max} message(s) sur 24 h glissantes (MAX_SENDS_PER_DAY). ` +
        'Réessayer plus tard, augmenter MAX_SENDS_PER_DAY, ou utiliser save_draft en attendant.',
    };
  }

  return { action: 'allow' };
}
