import './helpers/env.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createHttpServer } from '../src/http/server.js';
import type { HttpServer } from '../src/http/server.js';
import { config } from '../src/config.js';
import { serverVersion } from '../src/version.js';
import { imapPool } from '../src/imap/pool.js';
import { closeSmtp } from '../src/smtp/client.js';
import { createDownloadLinkService, DOWNLOAD_LINK_TTL_MS } from '../src/download-links.js';
import type { AttachmentContent } from '../src/imap/messages.js';
import { createUploadStore } from '../src/uploads.js';
import { AttachmentTooLargeError } from '../src/attachments.js';

/**
 * Tests d'intégration de la couche HTTP : un vrai serveur Express sur un port
 * éphémère. Aucun outil n'est appelé, donc aucune connexion IMAP ou SMTP n'est
 * ouverte — seuls l'authentification, le rate limit, le routage et la gestion
 * (TTL compris) des sessions MCP sont exercés.
 */

let http: HttpServer;
let server: Server;
let baseUrl: string;

const AUTH = { Authorization: `Bearer ${config.MCP_BEARER_TOKEN}` };
const MCP_HEADERS = {
  ...AUTH,
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '0.0.0' },
  },
};

/** Démarre un serveur HTTP sur un port éphémère et renvoie de quoi le piloter. */
async function startServer(options?: Parameters<typeof createHttpServer>[0]) {
  const instance = createHttpServer(options);
  const srv = instance.app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve, reject) => {
      srv.once('listening', resolve);
      srv.once('error', reject);
    });
  } catch (error) {
    await instance.close();
    throw error;
  }
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return { instance, srv, url };
}

async function stopServer(instance: HttpServer, srv: Server) {
  await instance?.close();
  if (srv?.listening) await new Promise((resolve) => srv.close(resolve));
}

before(async () => {
  // Limite haute : les tests généraux ne doivent jamais buter dessus.
  const started = await startServer({ rateLimitPerMinute: 10_000 });
  http = started.instance;
  server = started.srv;
  baseUrl = started.url;
});

after(async () => {
  await stopServer(http, server);
  await imapPool.close();
  closeSmtp();
});

describe('GET /health', () => {
  it('répond sans authentification (healthcheck Docker)', async () => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok', version: serverVersion });
  });
});

describe('authentification du endpoint /mcp', () => {
  it('refuse un POST sans token', async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(INITIALIZE),
    });

    assert.equal(response.status, 401);
    const body = (await response.json()) as { error: { code: number } };
    assert.equal(body.error.code, -32001);
  });

  it('refuse un POST avec un mauvais token', async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer mauvais-token-de-test-xxxxx',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(INITIALIZE),
    });

    assert.equal(response.status, 401);
  });

  it('refuse un GET sans token', async () => {
    assert.equal((await fetch(`${baseUrl}/mcp`)).status, 401);
  });

  it('refuse un DELETE sans token', async () => {
    assert.equal((await fetch(`${baseUrl}/mcp`, { method: 'DELETE' })).status, 401);
  });
});

describe('sessions MCP', () => {
  it(
    'ouvre une session sur initialize et renvoie son identifiant',
    { timeout: 10_000 },
    async () => {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: MCP_HEADERS,
        body: JSON.stringify(INITIALIZE),
      });

      assert.equal(response.status, 200);
      const sessionId = response.headers.get('mcp-session-id');
      assert.ok(sessionId, 'le transport doit renvoyer un en-tête mcp-session-id');
      await response.body?.cancel();

      // La session ouverte doit ensuite accepter une fermeture explicite.
      const deleted = await fetch(`${baseUrl}/mcp`, {
        method: 'DELETE',
        headers: { ...AUTH, 'mcp-session-id': sessionId },
      });
      assert.ok(deleted.status < 400, `fermeture de session refusée (${deleted.status})`);
    },
  );

  it('refuse une requête authentifiée qui n’est ni un initialize ni une session connue', async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });

    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: { message: string } };
    assert.match(body.error.message, /no valid session ID/);
  });

  it('répond 404 (spec MCP) sur un identifiant de session inconnu, en GET comme en POST', async () => {
    const get = await fetch(`${baseUrl}/mcp`, {
      method: 'GET',
      headers: { ...AUTH, 'mcp-session-id': 'session-qui-n-existe-pas' },
    });
    assert.equal(get.status, 404);
    await get.body?.cancel();

    const post = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, 'mcp-session-id': 'session-qui-n-existe-pas' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
    });
    assert.equal(post.status, 404);
    const body = (await post.json()) as { error: { code: number; message: string } };
    assert.equal(body.error.code, -32001);
    assert.match(body.error.message, /Session not found/);
  });

  it('refuse un DELETE sans identifiant de session', async () => {
    const response = await fetch(`${baseUrl}/mcp`, { method: 'DELETE', headers: AUTH });
    assert.equal(response.status, 400);
  });
});

describe('rate limit sur /mcp', () => {
  let instance: HttpServer;
  let srv: Server;
  let url: string;

  before(async () => {
    const started = await startServer({ rateLimitPerMinute: 3, sessionTtlMs: 60_000 });
    instance = started.instance;
    srv = started.srv;
    url = started.url;
  });

  after(() => stopServer(instance, srv));

  it('renvoie 429 au-delà de la limite, avec une erreur JSON-RPC', async () => {
    // Le rate limit s'applique avant l'auth : des requêtes non authentifiées suffisent.
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      statuses.push((await fetch(`${url}/mcp`, { method: 'GET' })).status);
    }
    // 3 autorisées (401 faute de token) puis 429.
    assert.deepEqual(statuses.slice(0, 3), [401, 401, 401]);
    assert.equal(statuses[3], 429);
    assert.equal(statuses[4], 429);

    const body = (await (await fetch(`${url}/mcp`, { method: 'GET' })).json()) as {
      error: { code: number; message: string };
    };
    assert.equal(body.error.code, -32002);
    assert.match(body.error.message, /Too Many Requests/);
  });

  it('n’applique jamais le rate limit à /health', async () => {
    for (let i = 0; i < 20; i += 1) {
      assert.equal((await fetch(`${url}/health`)).status, 200);
    }
  });

  it('ignores spoofed CF-Connecting-IP on direct sockets', async () => {
    const isolated = await startServer({ rateLimitPerMinute: 1 });
    try {
      for (const [index, ip] of ['203.0.113.10', '203.0.113.20'].entries()) {
        const response = await fetch(`${isolated.url}/mcp`, {
          headers: { 'CF-Connecting-IP': ip },
        });
        assert.equal(response.status, index === 0 ? 401 : 429);
      }
    } finally {
      await stopServer(isolated.instance, isolated.srv);
    }
  });
});

describe('TTL des sessions MCP', () => {
  let instance: HttpServer;
  let srv: Server;
  let url: string;

  before(async () => {
    // TTL très court + pas de balayage automatique (on déclenche sweep() à la main).
    const started = await startServer({
      sessionTtlMs: 40,
      sweepIntervalMs: 3_600_000,
      rateLimitPerMinute: 10_000,
    });
    instance = started.instance;
    srv = started.srv;
    url = started.url;
  });

  after(() => stopServer(instance, srv));

  async function openSession(): Promise<string> {
    const response = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: JSON.stringify(INITIALIZE),
    });
    assert.equal(response.status, 200);
    const sessionId = response.headers.get('mcp-session-id');
    assert.ok(sessionId);
    await response.body?.cancel();
    return sessionId as string;
  }

  it('évince une session inactive au-delà du TTL et préserve une session active', async () => {
    const idle = await openSession();
    const active = await openSession();

    // Laisse le TTL (40 ms) s'écouler : les deux sessions sont maintenant "vieilles".
    await new Promise((resolve) => setTimeout(resolve, 80));

    // La session "active" reçoit une requête juste avant le balayage : `touch()`
    // rafraîchit son `lastSeen`, quel que soit le code de retour du transport.
    const ping = await fetch(`${url}/mcp`, {
      method: 'GET',
      headers: { ...MCP_HEADERS, 'mcp-session-id': active },
    });
    await ping.body?.cancel().catch(() => {});

    instance.sweep();

    // La session inactive a disparu…
    const afterIdle = await fetch(`${url}/mcp`, {
      method: 'GET',
      headers: { ...AUTH, 'mcp-session-id': idle },
    });
    assert.equal(afterIdle.status, 404);
    await afterIdle.body?.cancel();

    // …mais la session active est toujours là.
    const afterActive = await fetch(`${url}/mcp`, {
      method: 'GET',
      headers: { ...AUTH, 'mcp-session-id': active },
    });
    assert.notEqual(afterActive.status, 404);
    await afterActive.body?.cancel().catch(() => {});
  });
});

describe('reprise après redémarrage du serveur', () => {
  async function initialize(url: string, staleSessionId?: string): Promise<string> {
    const response = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: staleSessionId ? { ...MCP_HEADERS, 'mcp-session-id': staleSessionId } : MCP_HEADERS,
      body: JSON.stringify(INITIALIZE),
    });
    assert.equal(response.status, 200);
    const sessionId = response.headers.get('mcp-session-id');
    assert.ok(sessionId);
    await response.body?.cancel();
    return sessionId as string;
  }

  it('init → restart → 404 sur l’ancienne session, puis un initialize rouvre une session', async () => {
    const first = await startServer({ rateLimitPerMinute: 10_000 });
    const oldSession = await initialize(first.url);
    await stopServer(first.instance, first.srv);

    // Nouveau process : les sessions en mémoire sont perdues.
    const second = await startServer({ rateLimitPerMinute: 10_000 });
    try {
      const call = await fetch(`${second.url}/mcp`, {
        method: 'POST',
        headers: { ...MCP_HEADERS, 'mcp-session-id': oldSession },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      });
      assert.equal(call.status, 404, 'le client doit recevoir 404 pour se réinitialiser');
      await call.body?.cancel();

      // Le client réinitialise, même s'il renvoie encore l'ancien identifiant.
      const newSession = await initialize(second.url, oldSession);
      assert.notEqual(newSession, oldSession);
    } finally {
      await stopServer(second.instance, second.srv);
    }
  });
});

describe('GET /download/:token', () => {
  let instance: HttpServer;
  let srv: Server;
  let url: string;
  let now = 1_000_000;
  const links = createDownloadLinkService({
    secret: 'secret-de-test-0123456789abcdef-0123456789',
    now: () => now,
  });
  const fetched: string[] = [];
  const PDF = Buffer.from('%PDF-1.7 contenu factice');

  before(async () => {
    const started = await startServer({
      rateLimitPerMinute: 10_000,
      download: {
        links,
        maxBytes: 64,
        // Récupération IMAP simulée : aucune connexion n'est ouverte.
        fetchAttachment: async (folder, uid, index): Promise<AttachmentContent> => {
          fetched.push(`attachment:${folder}:${uid}:${index}`);
          if (uid === 404) throw new Error(`Message UID ${uid} introuvable dans "${folder}"`);
          if (uid === 413) {
            return {
              index,
              filename: 'gros.bin',
              contentType: 'application/octet-stream',
              size: 65,
              content: Buffer.alloc(65),
            };
          }
          return {
            index,
            filename: 'Facture été/../x.pdf',
            contentType: 'application/pdf',
            size: PDF.length,
            content: PDF,
          };
        },
        fetchAttachmentPart: async (folder, uid, part, maxBytes) => {
          fetched.push(`part:${folder}:${uid}:${part}:${maxBytes}`);
          if (uid === 413) {
            throw new AttachmentTooLargeError(
              `Pièce jointe (partie ${part}) interrompue, au-delà de la limite (ATTACHMENT_MAX_BYTES).`,
            );
          }
          return {
            part,
            filename: 'Facture.pdf',
            contentType: 'application/pdf',
            size: PDF.length,
            content: PDF,
          };
        },
        fetchMessageSource: async (folder, uid) => {
          fetched.push(`message:${folder}:${uid}`);
          return Buffer.from('From: a@example.com\r\nSubject: test\r\n\r\ncorps\r\n');
        },
      },
    });
    instance = started.instance;
    srv = started.srv;
    url = started.url;
  });

  after(() => stopServer(instance, srv));

  function issue(uid = 12) {
    return links.issue({ kind: 'attachment', folder: 'INBOX', uid, index: 0 }).token;
  }

  async function expectGeneric404(response: Response) {
    assert.equal(response.status, 404);
    assert.equal(await response.text(), 'Not found');
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }

  it('sert la pièce jointe sans bearer, avec les en-têtes de sécurité', async () => {
    const response = await fetch(`${url}/download/${issue()}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/pdf');
    assert.equal(
      response.headers.get('content-disposition'),
      `attachment; filename="Facture _t__.._x.pdf"; filename*=UTF-8''Facture%20%C3%A9t%C3%A9_.._x.pdf`,
    );
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.ok(Buffer.from(await response.arrayBuffer()).equals(PDF));
    assert.equal(fetched.at(-1), 'attachment:INBOX:12:0');
  });

  it('sert une pièce jointe désignée par son numéro de partie IMAP', async () => {
    const token = links.issue({ kind: 'attachment', folder: 'Apple', uid: 371, part: '2' }).token;
    const response = await fetch(`${url}/download/${token}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition') ?? '', /filename="Facture\.pdf"/);
    assert.ok(Buffer.from(await response.arrayBuffer()).equals(PDF));
    assert.equal(fetched.at(-1), 'part:Apple:371:2:64');
  });

  it('répond 413 quand la partie dépasse la limite', async () => {
    const token = links.issue({ kind: 'attachment', folder: 'Apple', uid: 413, part: '2' }).token;
    const response = await fetch(`${url}/download/${token}`);
    assert.equal(response.status, 413);
    assert.match(await response.text(), /partie 2.*ATTACHMENT_MAX_BYTES/);
  });

  it('sert un message entier en message/rfc822', async () => {
    const token = links.issue({ kind: 'message', folder: 'Archive', uid: 7 }).token;
    const response = await fetch(`${url}/download/${token}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'message/rfc822');
    assert.match(response.headers.get('content-disposition') ?? '', /filename="message-7\.eml"/);
    assert.match(await response.text(), /Subject: test/);
  });

  it('répond 404 générique à la deuxième utilisation', async () => {
    const token = issue();
    assert.equal((await fetch(`${url}/download/${token}`)).status, 200);
    await expectGeneric404(await fetch(`${url}/download/${token}`));
  });

  it('répond 404 générique à un jeton expiré, sans lire IMAP', async () => {
    const token = issue();
    now += DOWNLOAD_LINK_TTL_MS;
    const before = fetched.length;
    await expectGeneric404(await fetch(`${url}/download/${token}`));
    assert.equal(fetched.length, before);
  });

  it('répond 404 générique à un jeton falsifié ou illisible, sans lire IMAP', async () => {
    const token = issue();
    const raw = Buffer.from(token, 'base64url');
    raw.writeUInt8(raw.readUInt8(raw.length - 1) ^ 0x01, raw.length - 1);
    const before = fetched.length;
    await expectGeneric404(await fetch(`${url}/download/${raw.toString('base64url')}`));
    await expectGeneric404(await fetch(`${url}/download/pas-un-jeton`));
    assert.equal(fetched.length, before);
  });

  it('répond 404 générique si la cible a disparu', async () => {
    await expectGeneric404(await fetch(`${url}/download/${issue(404)}`));
  });

  it('refuse au-delà de la taille maximale (413)', async () => {
    const response = await fetch(`${url}/download/${issue(413)}`);
    assert.equal(response.status, 413);
    assert.match(await response.text(), /ATTACHMENT_MAX_BYTES/);
  });

  it('refuse HEAD sans consommer le jeton', async () => {
    const token = issue();
    const head = await fetch(`${url}/download/${token}`, { method: 'HEAD' });
    assert.equal(head.status, 405);
    assert.equal((await fetch(`${url}/download/${token}`)).status, 200);
  });

  it('est soumis au rate limit', async () => {
    const limited = await startServer({ rateLimitPerMinute: 2, download: { links } });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        const response = await fetch(`${limited.url}/download/pas-un-jeton`);
        statuses.push(response.status);
        await response.body?.cancel();
      }
      assert.deepEqual(statuses, [404, 404, 429]);
    } finally {
      await stopServer(limited.instance, limited.srv);
    }
  });
});

describe('POST /upload/:token', () => {
  let instance: HttpServer;
  let srv: Server;
  let url: string;
  let now = 1_000_000;
  const links = createDownloadLinkService({
    secret: 'secret-de-test-0123456789abcdef-0123456789',
    now: () => now,
  });
  const store = createUploadStore({ maxFiles: 3, maxTotalBytes: 100 });
  let counter = 0;

  before(async () => {
    const started = await startServer({
      rateLimitPerMinute: 10_000,
      upload: { links, store, maxBytes: 64 },
    });
    instance = started.instance;
    srv = started.srv;
    url = started.url;
  });

  after(() => stopServer(instance, srv));

  function issue(extra: { filename?: string; contentType?: string } = {}) {
    counter += 1;
    const uploadId = `upload-test-${String(counter).padStart(10, '0')}`;
    return { uploadId, token: links.issue({ kind: 'upload', uploadId, ...extra }).token };
  }

  function post(
    token: string,
    body: RequestInit['body'],
    headers: Record<string, string> = {},
    query = '',
  ) {
    return fetch(`${url}/upload/${token}${query}`, { method: 'POST', body, headers });
  }

  async function expectGeneric404(response: Response) {
    assert.equal(response.status, 404);
    assert.equal(await response.text(), 'Not found');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  }

  it('range le fichier sans bearer et répond 201', async () => {
    const { uploadId, token } = issue();
    const response = await post(token, 'contenu du fichier', {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Filename': encodeURIComponent('Notes été.txt'),
    });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.uploadId, uploadId);
    assert.equal(body.size, 18);
    assert.equal(body.filename, 'Notes été.txt');
    assert.equal(body.contentType, 'text/plain');
    assert.equal(store.get(uploadId)?.content.toString(), 'contenu du fichier');
    store.delete(uploadId);
  });

  it('préfère le nom et le type du jeton, et lit un corps JSON brut', async () => {
    const { uploadId, token } = issue({ filename: 'data.json', contentType: 'application/json' });
    const response = await post(token, '{"a":1}', {
      'Content-Type': 'application/json',
      'X-Filename': 'autre.bin',
    });
    assert.equal(response.status, 201);
    const stored = store.get(uploadId);
    assert.equal(stored?.filename, 'data.json');
    assert.equal(stored?.contentType, 'application/json');
    assert.equal(stored?.content.toString(), '{"a":1}');
    store.delete(uploadId);
  });

  it('accepte ?filename= et assainit le nom', async () => {
    const { uploadId, token } = issue();
    const response = await post(token, 'x', {}, `?filename=${encodeURIComponent('../../a"b.pdf')}`);
    assert.equal(response.status, 201);
    assert.equal(store.get(uploadId)?.filename, 'a_b.pdf');
    store.delete(uploadId);
  });

  it('refuse un fichier trop gros (413) sans le garder', async () => {
    const { uploadId, token } = issue();
    const response = await post(token, Buffer.alloc(65));
    assert.equal(response.status, 413);
    assert.match(await response.text(), /ATTACHMENT_MAX_BYTES/);
    assert.equal(store.get(uploadId), undefined);
  });

  it('coupe un corps en flux sans Content-Length au-delà de la limite (413)', async () => {
    const { uploadId, token } = issue();
    const chunks = [Buffer.alloc(40), Buffer.alloc(40)];
    const stream = new ReadableStream({
      pull(controller) {
        const next = chunks.shift();
        if (next) controller.enqueue(next);
        else controller.close();
      },
    });
    const response = await fetch(`${url}/upload/${token}`, {
      method: 'POST',
      body: stream,
      duplex: 'half',
    } as RequestInit);
    assert.equal(response.status, 413);
    assert.equal(store.get(uploadId), undefined);
  });

  it('refuse le multipart (415) sans brûler le jeton', async () => {
    const { token } = issue();
    const form = new FormData();
    form.append('file', new Blob(['x']), 'x.txt');
    const response = await post(token, form);
    assert.equal(response.status, 415);
    await response.body?.cancel();
    const retry = await post(token, 'x');
    assert.equal(retry.status, 201);
    store.delete(((await retry.json()) as { uploadId: string }).uploadId);
  });

  it('répond 404 générique à un jeton rejoué', async () => {
    const { uploadId, token } = issue();
    assert.equal((await post(token, 'x')).status, 201);
    await expectGeneric404(await post(token, 'y'));
    assert.equal(store.get(uploadId)?.content.toString(), 'x');
    store.delete(uploadId);
  });

  it('répond 404 générique à un jeton expiré, falsifié ou de téléchargement', async () => {
    const expired = issue().token;
    now += DOWNLOAD_LINK_TTL_MS;
    await expectGeneric404(await post(expired, 'x'));

    const raw = Buffer.from(issue().token, 'base64url');
    raw.writeUInt8(raw.readUInt8(raw.length - 1) ^ 0x01, raw.length - 1);
    await expectGeneric404(await post(raw.toString('base64url'), 'x'));
    await expectGeneric404(await post('pas-un-jeton', 'x'));

    const download = links.issue({ kind: 'attachment', folder: 'INBOX', uid: 1, index: 0 }).token;
    await expectGeneric404(await post(download, 'x'));
    assert.deepEqual(store.stats(), { count: 0, bytes: 0 });
  });

  it('refuse au-delà des plafonds globaux (507)', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const { uploadId, token } = issue();
      assert.equal((await post(token, Buffer.alloc(30))).status, 201);
      ids.push(uploadId);
    }
    const full = await post(issue().token, 'x');
    assert.equal(full.status, 507);
    assert.match(await full.text(), /Stockage des dépôts plein/);

    store.delete(ids[0] as string);
    // Reste 40 octets sur 100 : un dépôt de 50 octets est coupé en flux.
    const tooMuch = await post(issue().token, Buffer.alloc(50));
    assert.equal(tooMuch.status, 507);
    await tooMuch.body?.cancel();
    for (const id of ids) store.delete(id);
  });

  it('est soumis au rate limit', async () => {
    const limited = await startServer({ rateLimitPerMinute: 2, upload: { links, store } });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        const response = await fetch(`${limited.url}/upload/pas-un-jeton`, {
          method: 'POST',
          body: 'x',
        });
        statuses.push(response.status);
        await response.body?.cancel();
      }
      assert.deepEqual(statuses, [404, 404, 429]);
    } finally {
      await stopServer(limited.instance, limited.srv);
    }
  });
});
