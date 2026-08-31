import type { Request } from 'express';

/**
 * IP réelle de l'appelant.
 *
 * Le déploiement de référence place `cloudflared` en unique point d'entrée, sur
 * le réseau bridge privé : sans traitement, toutes les requêtes portent l'IP du
 * conteneur `cloudflared` et le rate limit par IP s'effondre en un seul seau.
 *
 * `cloudflared` renseigne `CF-Connecting-IP` avec l'IP vue par l'edge Cloudflare.
 * Un client ne peut pas l'usurper : l'edge écrase toute valeur entrante. On la
 * privilégie (valeur unique, pas de parsing), puis on retombe sur `req.ip` —
 * résolu depuis `X-Forwarded-For` quand `trust proxy` est actif — puis sur l'IP
 * de socket.
 *
 * Le seul cas où cette valeur redevient usurpable est l'exposition directe du
 * port (section « Tester en local » du guide de déploiement), déjà signalée
 * comme à ne pas laisser en place.
 */
export function clientIp(req: Request): string {
  const cfConnectingIp = req.headers['cf-connecting-ip'];
  if (typeof cfConnectingIp === 'string' && cfConnectingIp.trim().length > 0) {
    return cfConnectingIp.trim();
  }
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}
