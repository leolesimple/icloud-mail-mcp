import { randomUUID } from 'node:crypto';
import express from 'express';
import type { Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMailMcpServer } from '../mcp/server.js';
import { bearerAuth } from './auth.js';
import { clientIp } from './client-ip.js';
import { SlidingWindowRateLimiter } from './rate-limit.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { serverVersion } from '../version.js';

const log = logger.child({ module: 'http' });

interface Session {
  transport: StreamableHTTPServerTransport;
  /** Timestamp de la dernière requête reçue sur cette session. */
  lastSeen: number;
}

export interface HttpServerOptions {
  /** Inactivité au-delà de laquelle une session est évincée. Défaut : `config.SESSION_TTL_MS`. */
  sessionTtlMs?: number;
  /** Requêtes /mcp autorisées par IP et par minute. Défaut : `config.RATE_LIMIT_PER_MINUTE`. */
  rateLimitPerMinute?: number;
  /** Période du balayage TTL + purge du limiteur. Défaut : `sessionTtlMs / 2`, borné à [10 s, 5 min]. */
  sweepIntervalMs?: number;
}

export interface HttpServer {
  app: express.Express;
  /** Balaye immédiatement les sessions expirées et purge le limiteur (exposé pour les tests). */
  sweep(): void;
  /** Ferme toutes les sessions, leurs transports, et arrête le balayage périodique. */
  close(): Promise<void>;
}

export function createHttpServer(options: HttpServerOptions = {}): HttpServer {
  const sessionTtlMs = options.sessionTtlMs ?? config.SESSION_TTL_MS;
  const rateLimitPerMinute = options.rateLimitPerMinute ?? config.RATE_LIMIT_PER_MINUTE;
  const sweepIntervalMs =
    options.sweepIntervalMs ?? Math.min(300_000, Math.max(10_000, Math.floor(sessionTtlMs / 2)));

  const sessions = new Map<string, Session>();
  const rateLimiter = new SlidingWindowRateLimiter(rateLimitPerMinute);

  function touch(sessionId: string | undefined): Session | undefined {
    const session = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
    if (session) {
      session.lastSeen = Date.now();
    }
    return session;
  }

  function evictIdleSessions(): void {
    const cutoff = Date.now() - sessionTtlMs;
    for (const [sessionId, session] of sessions) {
      if (session.lastSeen >= cutoff) {
        continue;
      }
      sessions.delete(sessionId);
      log.info({ sessionId }, 'mcp session evicted (idle TTL)');
      void session.transport.close().catch((err) => {
        log.warn({ err, sessionId }, 'error closing evicted mcp session');
      });
    }
  }

  function sweep(): void {
    evictIdleSessions();
    rateLimiter.sweep();
  }

  // .unref() est indispensable : sans lui, ce timer empêche le process de
  // s'arrêter tout seul (shutdown propre, fin des tests).
  const sweepTimer = setInterval(sweep, sweepIntervalMs);
  sweepTimer.unref();

  function rateLimit(req: Request, res: Response, next: express.NextFunction): void {
    // UNRESTRICTED lève le rate limit — mais jamais l'auth ni le TTL (voir docs/security.md).
    if (config.UNRESTRICTED) {
      next();
      return;
    }
    const key = clientIp(req);
    if (!rateLimiter.allow(key)) {
      log.warn({ ip: key }, 'rate limit exceeded on /mcp');
      res.status(429).json({
        jsonrpc: '2.0',
        error: { code: -32002, message: 'Too Many Requests: rate limit exceeded' },
        id: null,
      });
      return;
    }
    next();
  }

  async function handlePost(req: Request, res: Response): Promise<void> {
    const sessionId = req.headers['mcp-session-id'];
    const existing = touch(typeof sessionId === 'string' ? sessionId : undefined);

    try {
      let transport = existing?.transport;

      if (!transport) {
        if (sessionId || !isInitializeRequest(req.body)) {
          res.status(400).json({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Bad Request: no valid session ID provided' },
            id: null,
          });
          return;
        }

        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            sessions.set(newSessionId, { transport: transport!, lastSeen: Date.now() });
            log.info({ sessionId: newSessionId }, 'mcp session initialized');
          },
          onsessionclosed: (closedSessionId) => {
            sessions.delete(closedSessionId);
            log.info({ sessionId: closedSessionId }, 'mcp session closed');
          },
        });

        const server = createMailMcpServer();
        await server.connect(transport);
      }

      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log.error({ err }, 'error handling mcp request');
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  }

  async function handleSessionRequest(req: Request, res: Response): Promise<void> {
    const sessionId = req.headers['mcp-session-id'];
    const session = touch(typeof sessionId === 'string' ? sessionId : undefined);
    if (!session) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }
    await session.transport.handleRequest(req, res);
  }

  const app = express();
  // Le seul ingress est cloudflared, sur le réseau bridge privé : on lui fait
  // confiance pour X-Forwarded-For afin que req.ip porte l'IP cliente. La
  // résolution fine passe par clientIp() (CF-Connecting-IP en priorité).
  app.set('trust proxy', true);
  app.use(express.json());

  app.post('/mcp', rateLimit, bearerAuth, handlePost);
  app.get('/mcp', rateLimit, bearerAuth, handleSessionRequest);
  app.delete('/mcp', rateLimit, bearerAuth, handleSessionRequest);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: serverVersion });
  });

  async function close(): Promise<void> {
    clearInterval(sweepTimer);
    for (const [sessionId, session] of sessions) {
      try {
        await session.transport.close();
      } catch (err) {
        log.warn({ err, sessionId }, 'error closing mcp session');
      }
    }
    sessions.clear();
  }

  return { app, sweep, close };
}
