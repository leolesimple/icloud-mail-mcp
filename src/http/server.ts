import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMailMcpServer } from '../mcp/server.js';
import { bearerAuth } from './auth.js';
import { clientIp } from './client-ip.js';
import { validateIngress } from './ingress.js';
import { SlidingWindowRateLimiter } from './rate-limit.js';
import { contentDisposition, downloadLinks, safeContentType } from '../download-links.js';
import type { DownloadLinkService, DownloadTarget } from '../download-links.js';
import {
  normalizeUploadContentType,
  sanitizeUploadFilename,
  uploadStore,
  UploadStoreFullError,
} from '../uploads.js';
import type { UploadStore } from '../uploads.js';
import { getAttachment, getAttachmentPart, getMessageSource } from '../imap/messages.js';
import { AttachmentTooLargeError } from '../attachments.js';
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
      ? msg.method.slice(0, 128)
      : undefined;
  if (Array.isArray(body)) {
    return body.slice(0, 16).map((msg) => methodOf(msg) ?? 'response');
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
  /** Dépendances de `POST /upload/:token`, injectables pour les tests. */
  upload?: UploadOptions;
}

export interface UploadOptions {
  /** Défaut : le service partagé `downloadLinks` (mêmes jetons, cible `upload`). */
  links?: DownloadLinkService;
  /** Défaut : le stockage partagé `uploadStore`. */
  store?: UploadStore;
  /** Taille maximale d'un dépôt. Défaut : `config.ATTACHMENT_MAX_BYTES`. */
  maxBytes?: number;
}

/** En-têtes durcis des routes à lien signé (`/download`, `/upload`). */
const SIGNED_LINK_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; sandbox",
};

/** Lecture du corps interrompue au-delà de la limite. */
class BodyTooLargeError extends Error {}

/**
 * Lit un corps brut en flux, sans jamais garder plus de `limit` octets : la
 * lecture s'arrête au premier morceau qui dépasse.
 */
async function readBodyCapped(req: Request, limit: number): Promise<Buffer> {
  const timer = setTimeout(
    () => req.destroy(new Error('Upload body timeout')),
    config.UPLOAD_TIMEOUT_MS,
  );
  timer.unref();
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > limit) throw new BodyTooLargeError();
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  } finally {
    clearTimeout(timer);
  }
}

/** Valeur d'un en-tête ou paramètre de requête (première occurrence). */
function firstValue(value: unknown): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** `X-Filename` est encodé en pourcentage (UTF-8) ; illisible → pris tel quel. */
function decodeFilenameHeader(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export interface DownloadOptions {
  /** Défaut : le service partagé `downloadLinks`. */
  links?: DownloadLinkService;
  /** Défaut : `getAttachment` (IMAP). */
  fetchAttachment?: typeof getAttachment;
  /** Défaut : `getAttachmentPart` (IMAP, une seule partie). */
  fetchAttachmentPart?: typeof getAttachmentPart;
  /** Défaut : `getMessageSource` (IMAP). */
  fetchMessageSource?: typeof getMessageSource;
  /** Taille maximale servie. Défaut : `config.ATTACHMENT_MAX_BYTES`. */
  maxBytes?: number;
}

/** Contenu servi par `/download`, quelle que soit la cible. */
interface DownloadFile {
  filename: string;
  contentType: string;
  content: Buffer;
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
  let pendingSessions = 0;
  let activeRequests = 0;
  const rateLimiter = new SlidingWindowRateLimiter(rateLimitPerMinute);

  const links = options.download?.links ?? downloadLinks;
  const fetchAttachment = options.download?.fetchAttachment ?? getAttachment;
  const fetchAttachmentPart = options.download?.fetchAttachmentPart ?? getAttachmentPart;
  const fetchMessageSource = options.download?.fetchMessageSource ?? getMessageSource;
  const downloadMaxBytes = options.download?.maxBytes ?? config.ATTACHMENT_MAX_BYTES;

  const uploadLinks = options.upload?.links ?? downloadLinks;
  const uploads = options.upload?.store ?? uploadStore;
  const uploadMaxBytes = options.upload?.maxBytes ?? config.ATTACHMENT_MAX_BYTES;

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
    if (uploadLinks !== links) uploadLinks.sweep();
    uploads.sweep();
  }

  // .unref() est indispensable : sans lui, ce timer empêche le process de
  // s'arrêter tout seul (shutdown propre, fin des tests).
  const sweepTimer = setInterval(sweep, sweepIntervalMs);
  sweepTimer.unref();

  function rateLimit(req: Request, res: Response, next: express.NextFunction): void {
    // Resource limits remain enabled even when sending restrictions are relaxed.
    const key = clientIp(req);
    if (!rateLimiter.allow(key)) {
      log.warn({ ip: key, route: req.route?.path ?? 'unknown' }, 'rate limit exceeded');
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

    let reservedSession = false;
    let createdTransport: StreamableHTTPServerTransport | undefined;
    let initialized = false;
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

        if (sessions.size + pendingSessions >= config.MAX_SESSIONS) {
          res.status(503).json({ error: 'Session capacity reached' });
          return;
        }
        pendingSessions += 1;
        reservedSession = true;
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            initialized = true;
            sessions.set(newSessionId, { transport: transport!, lastSeen: Date.now() });
            log.info({ sessionId: newSessionId }, 'mcp session initialized');
          },
          onsessionclosed: (closedSessionId) => {
            sessions.delete(closedSessionId);
            log.info({ sessionId: closedSessionId }, 'mcp session closed');
          },
        });

        createdTransport = transport;
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
    } finally {
      if (reservedSession) pendingSessions -= 1;
      if (createdTransport && !initialized) await createdTransport.close();
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
      const attachment =
        target.part !== undefined
          ? await fetchAttachmentPart(target.folder, target.uid, target.part, downloadMaxBytes)
          : await fetchAttachment(target.folder, target.uid, target.index, downloadMaxBytes);
      return {
        filename: attachment.filename ?? `attachment-${target.part ?? target.index}`,
        contentType: attachment.contentType,
        content: attachment.content,
      };
    }
    return {
      filename: `message-${target.uid}.eml`,
      contentType: 'message/rfc822',
      content: await fetchMessageSource(target.folder, target.uid, downloadMaxBytes),
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
    res.set(SIGNED_LINK_HEADERS);
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
      // Partie IMAP refusée avant ou pendant son téléchargement.
      if (err instanceof AttachmentTooLargeError) {
        log.warn({ kind: target.kind }, 'download refused: too large');
        res.status(413).type('text/plain').send(err.message);
        return;
      }
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
      'Content-Type': safeContentType(file.contentType),
      'Content-Disposition': contentDisposition(file.filename),
      'Content-Length': String(file.content.length),
    });
    res.status(200).end(file.content);
  }

  /**
   * Dépôt d'un fichier par un lien signé (`create_upload_link`). Comme
   * `/download` : pas de bearer, le jeton porte l'autorisation ; tout refus de
   * jeton répond le même 404 générique, le jeton n'est jamais loggé.
   *
   * Corps BRUT, de n'importe quel type, lu en flux et coupé dès `uploadMaxBytes`
   * (413) ou dès la place restante du stockage (507). Les refus qui ne
   * dépendent que de la requête (multipart, Content-Length trop grand) passent
   * AVANT le jeton, pour ne pas le brûler ; une fois le jeton vérifié, il est
   * consommé, même si le dépôt échoue ensuite.
   *
   * Nom : celui du jeton, sinon `X-Filename` (UTF-8 encodé en pourcentage), sinon
   * `?filename=`. Type : celui du jeton, sinon `Content-Type`. Tous deux assainis.
   */
  async function handleUpload(req: Request, res: Response): Promise<void> {
    res.set(SIGNED_LINK_HEADERS);
    const fail = (status: number, message: string) => {
      // Corps peut-être pas entièrement lu : on ferme la connexion après la réponse.
      res.set('Connection', 'close');
      res.on('finish', () => req.destroy());
      res.status(status).type('text/plain').send(message);
    };

    const requestType = firstValue(req.headers['content-type'])?.toLowerCase() ?? '';
    if (requestType.startsWith('multipart/')) {
      fail(415, 'Envoyer le fichier en corps brut (curl --data-binary), pas en multipart.');
      return;
    }
    const declared = Number(firstValue(req.headers['content-length']));
    if (Number.isFinite(declared) && declared > uploadMaxBytes) {
      fail(
        413,
        `Fichier de ${declared} octets, au-delà de la limite de ${uploadMaxBytes} octets (ATTACHMENT_MAX_BYTES).`,
      );
      return;
    }

    const token = req.params.token;
    const redeemed = uploadLinks.redeem(typeof token === 'string' ? token : '', ['upload']);
    if (!redeemed.ok) {
      log.info({ reason: redeemed.reason }, 'upload link refused');
      fail(404, 'Not found');
      return;
    }
    const { target } = redeemed;

    const room = uploads.available();
    const limit = Math.min(uploadMaxBytes, room);
    let reservation;
    try {
      reservation = uploads.reserve(target.uploadId, limit);
    } catch {
      fail(507, 'Stockage des dépôts plein.');
      return;
    }
    let content: Buffer;
    try {
      content = await readBodyCapped(req, limit);
    } catch (err) {
      reservation.release();
      if (err instanceof BodyTooLargeError) {
        log.warn({ uploadId: target.uploadId, limit }, 'upload refused: too large');
        if (limit < uploadMaxBytes) {
          fail(
            507,
            `Stockage des dépôts plein (UPLOAD_MAX_FILES / UPLOAD_MAX_TOTAL_BYTES) : réessayer plus tard.`,
          );
        } else {
          fail(
            413,
            `Fichier au-delà de la limite de ${uploadMaxBytes} octets (ATTACHMENT_MAX_BYTES).`,
          );
        }
        return;
      }
      log.warn({ err, uploadId: target.uploadId }, 'upload body read failed');
      if (!res.headersSent) fail(400, 'Lecture du corps interrompue.');
      return;
    }

    const filename =
      sanitizeUploadFilename(target.filename) ??
      sanitizeUploadFilename(decodeFilenameHeader(firstValue(req.headers['x-filename']))) ??
      sanitizeUploadFilename(firstValue(req.query.filename));
    const contentType =
      normalizeUploadContentType(target.contentType) ?? normalizeUploadContentType(requestType);

    let stored;
    try {
      stored = reservation.commit({ uploadId: target.uploadId, filename, contentType, content });
    } catch (err) {
      if (err instanceof UploadStoreFullError) {
        log.warn({ uploadId: target.uploadId, size: content.length }, 'upload refused: store full');
        fail(507, err.message);
        return;
      }
      throw err;
    }

    log.info({ uploadId: stored.uploadId, size: stored.size }, 'upload stored');
    res.status(201).json({
      uploadId: stored.uploadId,
      size: stored.size,
      filename: stored.filename ?? null,
      contentType: stored.contentType,
      expiresAt: new Date(stored.expiresAt).toISOString(),
    });
  }

  const app = express();
  // Le seul ingress est cloudflared, sur le réseau bridge privé : on lui fait
  // confiance pour X-Forwarded-For afin que req.ip porte l'IP cliente. La
  // résolution fine passe par clientIp() (CF-Connecting-IP en priorité).
  const trustedProxies = config.TRUSTED_PROXIES.split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  app.set('trust proxy', trustedProxies.length ? trustedProxies : false);
  const allowedHosts = new Set(
    config.HTTP_ALLOWED_HOSTS.split(',')
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean),
  );
  const allowedOrigins = new Set(
    config.HTTP_ALLOWED_ORIGINS.split(',')
      .map((v) => v.trim())
      .filter(Boolean),
  );
  if (config.PUBLIC_BASE_URL) {
    const publicUrl = new URL(config.PUBLIC_BASE_URL);
    allowedHosts.add(publicUrl.hostname.toLowerCase());
    allowedOrigins.add(publicUrl.origin);
  }
  app.use(validateIngress(allowedHosts, allowedOrigins));
  function capacity(_req: Request, res: Response, next: express.NextFunction): void {
    if (activeRequests >= config.HTTP_MAX_CONCURRENT_REQUESTS) {
      res.status(503).send('Request capacity reached');
      return;
    }
    activeRequests += 1;
    let released = false;
    const release = () => {
      if (!released) activeRequests -= 1;
      released = true;
    };
    res.once('finish', release);
    res.once('close', release);
    next();
  }

  // AVANT express.json() : le corps d'un dépôt est brut, de n'importe quel type
  // (un fichier JSON compris), et lu en flux par la route elle-même.
  app.post('/upload/:token', rateLimit, capacity, (req, res, next) => {
    handleUpload(req, res).catch(next);
  });

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
  app.post(
    '/mcp',
    rateLimit,
    bearerAuth,
    capacity,
    express.json({ limit: config.HTTP_BODY_MAX_BYTES }),
    handlePost,
  );
  app.get('/mcp', rateLimit, bearerAuth, capacity, handleSessionRequest);
  app.delete('/mcp', rateLimit, bearerAuth, capacity, handleSessionRequest);

  // Express route HEAD vers le handler GET : un HEAD (aperçu de lien, antivirus)
  // consommerait le jeton à usage unique sans rien livrer. On le refuse.
  app.head('/download/:token', (_req, res) => {
    res.status(405).set({ Allow: 'GET', 'Cache-Control': 'no-store' }).end();
  });
  app.get('/download/:token', rateLimit, capacity, handleDownload);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: serverVersion });
  });

  // Do not return parser stacks or log their attached request body (which may contain mail content).
  app.use((error: unknown, _req: Request, res: Response, next: express.NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const status =
      error && typeof error === 'object' && 'status' in error ? error.status : undefined;
    const safeStatus = status === 413 ? 413 : status === 400 ? 400 : 500;
    log.warn({ status: safeStatus }, 'HTTP request failed');
    res
      .status(safeStatus)
      .json({
        error:
          safeStatus === 413
            ? 'Request body too large'
            : safeStatus === 400
              ? 'Invalid request body'
              : 'Internal server error',
      });
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
