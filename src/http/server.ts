import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMailMcpServer } from '../mcp/server.js';
import { bearerAuth } from './auth.js';
import { clientIp } from './client-ip.js';
import { SlidingWindowRateLimiter } from './rate-limit.js';
import { contentDisposition, downloadLinks } from '../download-links.js';
import type { DownloadLinkService, DownloadTarget } from '../download-links.js';
import { getAttachment, getMessageSource } from '../imap/messages.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { serverVersion } from '../version.js';

const log = logger.child({ module: 'http' });

// dist/http/server.js -> dist/http -> dist -> racine du repo (voir src/version.ts
// pour le même principe). `public/` est copié à côté de `dist/` dans l'image
// (Dockerfile), donc le chemin relatif tient aussi bien en dev qu'en conteneur.
const publicDir = fileURLToPath(new URL('../../public', import.meta.url));

/** Méthode(s) JSON-RPC d'un corps de requête (message seul ou lot), pour les logs. */
function rpcMethods(body: unknown): string | string[] | undefined {
  const methodOf = (msg: unknown): string | undefined =>
    msg && typeof msg === 'object' && 'method' in msg && typeof msg.method === 'string'
      ? msg.method
      : undefined;
  if (Array.isArray(body)) {
    return body.map((msg) => methodOf(msg) ?? 'response');
  }
  return methodOf(body);
}

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
  /** Dépendances de `GET /download/:token`, injectables pour les tests. */
  download?: DownloadOptions;
}

export interface DownloadOptions {
  /** Défaut : le service partagé `downloadLinks`. */
  links?: DownloadLinkService;
  /** Défaut : `getAttachment` (IMAP). */
  fetchAttachment?: typeof getAttachment;
  /** Défaut : `getMessageSource` (IMAP). */
  fetchMessageSource?: typeof getMessageSource;
  /** Taille maximale servie. Défaut : `config.ATTACHMENT_MAX_BYTES`. */
  maxBytes?: number;
}

/** Contenu servi par `/download`, quelle que soit la cible. */
interface DownloadFile {
  filename: string;
  mimeType: string;
  content: Buffer;
}

/** Type MIME servi tel quel s'il est bien formé, sinon `application/octet-stream`. */
function safeMimeType(mimeType: string): string {
  const trimmed = mimeType.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(trimmed)
    ? trimmed
    : 'application/octet-stream';
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

  const links = options.download?.links ?? downloadLinks;
  const fetchAttachment = options.download?.fetchAttachment ?? getAttachment;
  const fetchMessageSource = options.download?.fetchMessageSource ?? getMessageSource;
  const downloadMaxBytes = options.download?.maxBytes ?? config.ATTACHMENT_MAX_BYTES;

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
    links.sweep();
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
      log.warn({ ip: key, path: req.path }, 'rate limit exceeded');
      res.status(429).json({
        jsonrpc: '2.0',
        error: { code: -32002, message: 'Too Many Requests: rate limit exceeded' },
        id: null,
      });
      return;
    }
    next();
  }

  /**
   * Session inconnue (redémarrage, éviction TTL, autre instance) : la spec MCP
   * (Streamable HTTP, « Session Management ») impose un 404, sur lequel le
   * client DOIT rouvrir une session par un nouvel `initialize`. Un 400 ne
   * déclenche pas cette reprise : le client boucle sur l'erreur.
   */
  function sessionNotFound(res: Response): void {
    res.status(404).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Session not found: re-initialize the MCP session' },
      id: null,
    });
  }

  async function handlePost(req: Request, res: Response): Promise<void> {
    const sessionId = req.headers['mcp-session-id'];
    const existing = touch(typeof sessionId === 'string' ? sessionId : undefined);

    try {
      let transport = existing?.transport;

      if (!transport) {
        // Un initialize ouvre toujours une session neuve, même s'il porte encore
        // l'identifiant d'une session perdue : c'est justement la reprise attendue.
        if (!isInitializeRequest(req.body)) {
          if (sessionId) {
            sessionNotFound(res);
            return;
          }
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
      if (sessionId) {
        sessionNotFound(res);
        return;
      }
      res.status(400).send('Invalid or missing session ID');
      return;
    }
    await session.transport.handleRequest(req, res);
  }

  /**
   * Une ligne de log par requête /mcp, à la fin de la réponse : méthode(s)
   * JSON-RPC, session, statut HTTP, durée et pid. Le pid distingue deux
   * instances qui répondraient derrière le même tunnel ; `known` dit si la
   * session était connue de CE process au moment de la requête.
   */
  function logMcpRequest(req: Request, res: Response, next: express.NextFunction): void {
    const started = Date.now();
    const header = req.headers['mcp-session-id'];
    const sessionId = typeof header === 'string' ? header : undefined;
    const known = sessionId !== undefined && sessions.has(sessionId);
    res.on('finish', () => {
      log.info(
        {
          http: req.method,
          rpc: rpcMethods(req.body),
          sessionId,
          known,
          // Session créée par cette requête (initialize).
          newSessionId: sessionId ? undefined : res.getHeader('mcp-session-id'),
          status: res.statusCode,
          ms: Date.now() - started,
          pid: process.pid,
        },
        'mcp request',
      );
    });
    next();
  }

  async function fetchDownload(target: DownloadTarget): Promise<DownloadFile> {
    if (target.kind === 'attachment') {
      const attachment = await fetchAttachment(target.folder, target.uid, target.index);
      return {
        filename: attachment.filename ?? `attachment-${target.index}`,
        mimeType: attachment.contentType,
        content: attachment.content,
      };
    }
    return {
      filename: `message-${target.uid}.eml`,
      mimeType: 'message/rfc822',
      content: await fetchMessageSource(target.folder, target.uid),
    };
  }

  /**
   * Lien signé émis par un outil (format `url`). Pas de bearer : le lien est
   * ouvert hors du protocole MCP, il porte lui-même son autorisation (voir
   * src/download-links.ts et docs/security.md). Tout refus — jeton illisible,
   * falsifié, expiré, déjà utilisé, cible disparue — répond le même 404, sans
   * détail ; le motif ne va qu'aux logs. Le jeton n'est jamais loggé.
   */
  async function handleDownload(req: Request, res: Response): Promise<void> {
    res.set({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
    const notFound = () => res.status(404).type('text/plain').send('Not found');

    const token = req.params.token;
    const redeemed = links.redeem(typeof token === 'string' ? token : '');
    if (!redeemed.ok) {
      log.info({ reason: redeemed.reason }, 'download link refused');
      notFound();
      return;
    }

    const { target } = redeemed;
    let file: DownloadFile;
    try {
      file = await fetchDownload(target);
    } catch (err) {
      log.warn(
        { err, kind: target.kind, folder: target.folder, uid: target.uid },
        'download fetch failed',
      );
      notFound();
      return;
    }

    if (file.content.length > downloadMaxBytes) {
      log.warn({ kind: target.kind, size: file.content.length }, 'download refused: too large');
      res
        .status(413)
        .type('text/plain')
        .send(
          `Fichier de ${file.content.length} octets, au-delà de la limite de ${downloadMaxBytes} octets (ATTACHMENT_MAX_BYTES).`,
        );
      return;
    }

    log.info(
      { kind: target.kind, folder: target.folder, uid: target.uid, size: file.content.length },
      'download served',
    );
    res.set({
      'Content-Type': safeMimeType(file.mimeType),
      'Content-Disposition': contentDisposition(file.filename),
      'Content-Length': String(file.content.length),
    });
    res.status(200).end(file.content);
  }

  const app = express();
  // Le seul ingress est cloudflared, sur le réseau bridge privé : on lui fait
  // confiance pour X-Forwarded-For afin que req.ip porte l'IP cliente. La
  // résolution fine passe par clientIp() (CF-Connecting-IP en priorité).
  app.set('trust proxy', true);
  app.use(express.json());

  // Favicon/webclip : servis à la racine du domaine public (pas d'auth, pas de
  // secret dedans) pour que les connecteurs MCP distants (Claude Desktop,
  // claude.ai) affichent une icône propre au lieu de retomber sur celle du
  // domaine parent.
  app.use(express.static(publicDir, { maxAge: '1d' }));
  app.get('/', (_req, res) => {
    res.type('html').send(`<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>Mail MCP</title>
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" href="/favicon-32x32.png" type="image/png" sizes="32x32">
<link rel="icon" href="/favicon-16x16.png" type="image/png" sizes="16x16">
<link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180">
<link rel="manifest" href="/site.webmanifest">
</head>
<body>Mail MCP — serveur MCP pour iCloud Mail.</body>
</html>
`);
  });

  app.use('/mcp', logMcpRequest);
  app.post('/mcp', rateLimit, bearerAuth, handlePost);
  app.get('/mcp', rateLimit, bearerAuth, handleSessionRequest);
  app.delete('/mcp', rateLimit, bearerAuth, handleSessionRequest);

  // Express route HEAD vers le handler GET : un HEAD (aperçu de lien, antivirus)
  // consommerait le jeton à usage unique sans rien livrer. On le refuse.
  app.head('/download/:token', (_req, res) => {
    res.status(405).set({ Allow: 'GET', 'Cache-Control': 'no-store' }).end();
  });
  app.get('/download/:token', rateLimit, handleDownload);

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
