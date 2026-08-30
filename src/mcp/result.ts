import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Résultat MCP « succès » : les données sérialisées en JSON indenté dans un
 * bloc texte. Les 10 outils répétaient ce motif à l'identique.
 *
 * La signature est stable volontairement : le lot C y ajoutera
 * `structuredContent` sans toucher aux appelants.
 */
export function jsonResult(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

/** Résultat MCP « erreur » : `isError: true` et le message (en français) en texte. */
export function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}
