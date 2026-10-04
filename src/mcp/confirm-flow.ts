import type {
  CallToolResult,
  ClientCapabilities,
  ElicitRequestFormParams,
  ElicitResult,
} from '@modelcontextprotocol/sdk/types.js';
import { confirmTokens, type ConfirmBinding, type ConfirmTokenService } from '../confirm.js';

/**
 * Confirmation d'une opération destructive, indépendante de tout tool.
 *
 * - Client avec elicitation (formulaire) : on demande à l'utilisateur, via
 *   `elicitInput`, de confirmer. Un `confirmToken` éventuel est ignoré : seule
 *   la réponse humaine compte.
 * - Sinon, repli en deux temps : le premier appel n'exécute rien et renvoie un
 *   jeton ; l'appelant refait le même appel avec `confirmToken`, vérifié (puis
 *   consommé) avant d'exécuter.
 *
 * Un refus ou une annulation n'est pas une erreur : c'est un choix légitime de
 * l'utilisateur, et le présenter comme un échec pousserait le modèle à
 * réessayer ou à contourner.
 */

/** Ce dont le flux a besoin côté serveur MCP : `server.server` convient. */
export interface ElicitationHost {
  getClientCapabilities(): ClientCapabilities | undefined;
  elicitInput(params: ElicitRequestFormParams): Promise<ElicitResult>;
}

export interface ConfirmFlowRequest<T> {
  host: ElicitationHost;
  /** Nom de l'opération (ex. `'empty_folder'`, `'expunge'`, `'send'`). */
  operation: string;
  /** Binding calculé à neuf à chaque appel (UIDVALIDITY relue, paramètres courants). */
  binding: ConfirmBinding;
  /** Résumé lisible, en français, de ce qui sera fait (dossier, nombre de messages, destinataires…). */
  summary: string;
  /** Jeton renvoyé par l'appelant au second temps du repli. */
  confirmToken?: string;
  execute: () => Promise<T>;
  /** Service de jetons. Par défaut, celui du serveur. */
  tokens?: ConfirmTokenService;
}

export type ConfirmFlowOutcome<T> =
  | { status: 'executed'; via: 'elicitation' | 'token'; result: T }
  | {
      status: 'confirmation_required';
      operation: string;
      summary: string;
      confirmToken: string;
      /** ISO 8601. */
      expiresAt: string;
    }
  | { status: 'declined' | 'cancelled'; operation: string; summary: string };

/** Le client sait-il afficher un formulaire d'elicitation ? */
export function supportsFormElicitation(host: ElicitationHost): boolean {
  // Le SDK normalise `elicitation: {}` en `{ form: {} }` (rétrocompatibilité).
  return Boolean(host.getClientCapabilities()?.elicitation?.form);
}

/**
 * Lève `ConfirmTokenError` si un jeton est fourni mais refusé : `execute`
 * n'est alors jamais appelé. Les erreurs d'`execute` et d'`elicitInput`
 * remontent telles quelles.
 */
export async function runConfirmFlow<T>(
  request: ConfirmFlowRequest<T>,
): Promise<ConfirmFlowOutcome<T>> {
  const { host, operation, binding, summary } = request;
  const tokens = request.tokens ?? confirmTokens;

  if (supportsFormElicitation(host)) {
    const answer = await host.elicitInput({
      mode: 'form',
      message: `Confirmation requise : ${summary}\nCette opération est irréversible.`,
      requestedSchema: {
        type: 'object',
        properties: {
          confirm: {
            type: 'boolean',
            title: 'Confirmer',
            description: 'Cochez pour exécuter l’opération.',
            default: false,
          },
        },
        required: ['confirm'],
      },
    });
    if (answer.action === 'cancel') return { status: 'cancelled', operation, summary };
    // Un « accept » sans la case cochée vaut refus : on ne se contente pas
    // d'un client qui accepterait le formulaire sans intervention humaine.
    if (answer.action !== 'accept' || answer.content?.confirm !== true) {
      return { status: 'declined', operation, summary };
    }
    return { status: 'executed', via: 'elicitation', result: await request.execute() };
  }

  if (request.confirmToken === undefined) {
    const issued = tokens.issue(operation, binding);
    return {
      status: 'confirmation_required',
      operation,
      summary,
      confirmToken: issued.token,
      expiresAt: new Date(issued.expiresAt).toISOString(),
    };
  }

  tokens.verify(request.confirmToken, operation, binding);
  return { status: 'executed', via: 'token', result: await request.execute() };
}

/**
 * Résultat d'outil (non-erreur) pour une issue sans exécution. Les tools
 * formatent eux-mêmes le cas `executed`.
 */
export function confirmationResult(
  outcome: Exclude<ConfirmFlowOutcome<unknown>, { status: 'executed' }>,
): CallToolResult {
  const message =
    outcome.status === 'confirmation_required'
      ? `Rien n'a été fait. Pour confirmer (${outcome.summary}), refaites exactement le même appel avec confirmToken avant ${outcome.expiresAt}. Demandez d'abord l'accord explicite de l'utilisateur.`
      : outcome.status === 'declined'
        ? `Opération refusée par l'utilisateur, rien n'a été fait (${outcome.summary}). Ne la relancez pas sans nouvelle demande de sa part.`
        : `Confirmation annulée, rien n'a été fait (${outcome.summary}).`;
  const data = { ...outcome, executed: false, message };
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}
