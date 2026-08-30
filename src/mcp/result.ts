import type { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Résultat d'outil MCP.
 *
 * NOTE (lot C) : fichier appartenant au lot 0. Le lot C y ajoute le support
 * des sorties structurées (`structuredContent`) ; la version du lot 0 fait foi
 * au merge, ce fichier ne doit pas diverger de la signature du contrat.
 */

/**
 * Sérialise `data` dans un bloc texte (pour les clients qui ne lisent que le
 * texte) et, si un `schema` est fourni, l'attache aussi en `structuredContent`.
 *
 * Le `schema` passé ici doit être le même `outputSchema` que celui déclaré sur
 * l'outil : le SDK MCP valide `structuredContent` contre lui à l'émission.
 */
export function jsonResult(data: unknown, schema?: z.ZodType): CallToolResult {
  const result: CallToolResult = {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
  if (schema) {
    result.structuredContent = data as CallToolResult['structuredContent'];
  }
  return result;
}

/**
 * Résultat d'un outil qui renvoie une liste.
 *
 * `structuredContent` porte TOUJOURS la forme enveloppée (`{ [key]: items }`,
 * plus `nextCursor` s'il y en a un) : le protocole MCP impose un objet, pas un
 * tableau nu.
 *
 * Le bloc texte, lui, reste le **tableau nu par défaut** (contrat historique
 * des outils). Il passe à la forme enveloppée seulement si `envelope: true`,
 * ou — quoi qu'il arrive — dès qu'un `nextCursor` est présent : sinon le
 * curseur de pagination serait invisible pour un client qui ne lit pas le
 * structuré.
 *
 * NOTE MERGE (lot B) : la pagination (`nextCursor`) n'existe pas dans cette
 * branche. Le paramètre `nextCursor` ci-dessous est le point de branchement :
 * le lot B le renseignera depuis `list_messages`, et pensera à ajouter
 * `nextCursor` à l'`outputSchema` correspondant.
 */
export function listResult<T>(
  key: string,
  items: T[],
  options: { envelope?: boolean; nextCursor?: number | string } = {},
): CallToolResult {
  const enveloped: Record<string, unknown> = { [key]: items };
  if (options.nextCursor !== undefined) {
    enveloped.nextCursor = options.nextCursor;
  }

  const textPayload = options.envelope || options.nextCursor !== undefined ? enveloped : items;

  return {
    content: [{ type: 'text', text: JSON.stringify(textPayload, null, 2) }],
    structuredContent: enveloped as CallToolResult['structuredContent'],
  };
}

/** Résultat d'erreur : message utilisateur (français) dans un bloc texte, `isError` posé. */
export function errorResult(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  };
}
