import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Jeton d'appel, cherché dans deux en-têtes :
 *
 * - `Authorization: Bearer <jeton>` — le cas courant (Claude Code, Claude
 *   Desktop, MCP Inspector, curl).
 * - `X-Api-Key: <jeton>` — les connecteurs personnalisés de claude.ai
 *   interdisent l'en-tête `Authorization` et n'autorisent qu'une liste blanche
 *   de noms, dont `x-api-key`. Jeton brut, sans préfixe.
 *
 * Un en-tête répété (donc `string[]`) est ignoré.
 */
function extractToken(req: Request): string | undefined {
  const authorization = req.headers.authorization;
  if (authorization?.startsWith('Bearer ')) {
    return authorization.slice('Bearer '.length);
  }
  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey.length > 0) {
    return apiKey;
  }
  return undefined;
}

export function bearerAuth(req: Request, res: Response, next: NextFunction): void {
  const token = extractToken(req);

  if (!token || !safeEqual(token, config.MCP_BEARER_TOKEN)) {
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized: missing or invalid token' },
      id: null,
    });
    return;
  }

  next();
}
