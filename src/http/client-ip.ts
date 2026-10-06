import type { Request } from 'express';

/** Express resolves forwarding headers only through explicitly trusted socket hops. */
export function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}
