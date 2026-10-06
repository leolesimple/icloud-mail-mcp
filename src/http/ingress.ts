import type { RequestHandler } from 'express';

/** Check the actual Host and exact browser Origin, ignoring proxy-supplied host headers. */
export function validateIngress(
  hosts: ReadonlySet<string>,
  origins: ReadonlySet<string>,
): RequestHandler {
  return (req, res, next) => {
    const rawHost = req.headers.host;
    let host: string;
    try {
      if (!rawHost || /[\s/@?#\\]/.test(rawHost)) throw new Error('Malformed Host');
      host = new URL(`http://${rawHost}`).hostname.toLowerCase();
    } catch {
      res.status(403).send('Invalid Host');
      return;
    }
    if (!hosts.has(host)) {
      res.status(403).send('Host not allowed');
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && (typeof origin !== 'string' || !origins.has(origin))) {
      res.status(403).send('Origin not allowed');
      return;
    }
    next();
  };
}
