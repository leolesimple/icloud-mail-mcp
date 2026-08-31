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
  const srv = instance.app.listen(0);
  await new Promise((resolve) => srv.once('listening', resolve));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return { instance, srv, url };
}

async function stopServer(instance: HttpServer, srv: Server) {
  await instance.close();
  await new Promise((resolve) => srv.close(resolve));
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
      headers: { Authorization: 'Bearer mauvais-token-de-test-xxxxx', 'Content-Type': 'application/json' },
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
  it('ouvre une session sur initialize et renvoie son identifiant', { timeout: 10_000 }, async () => {
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
  });

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

  it('refuse un identifiant de session inconnu', async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'GET',
      headers: { ...AUTH, 'mcp-session-id': 'session-qui-n-existe-pas' },
    });

    assert.equal(response.status, 400);
    assert.match(await response.text(), /Invalid or missing session ID/);
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

  it('compte par CF-Connecting-IP, pas par IP de socket', async () => {
    // Même socket (localhost), deux IP clientes distinctes derrière le tunnel :
    // chacune a son propre seau, aucune ne doit déclencher le 429 de l'autre.
    for (const ip of ['203.0.113.10', '203.0.113.20']) {
      const statuses: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        const res = await fetch(`${url}/mcp`, { method: 'GET', headers: { 'CF-Connecting-IP': ip } });
        statuses.push(res.status);
      }
      assert.deepEqual(statuses, [401, 401, 401], `IP ${ip} ne doit pas être limitée`);
    }
  });
});

describe('TTL des sessions MCP', () => {
  let instance: HttpServer;
  let srv: Server;
  let url: string;

  before(async () => {
    // TTL très court + pas de balayage automatique (on déclenche sweep() à la main).
    const started = await startServer({ sessionTtlMs: 40, sweepIntervalMs: 3_600_000, rateLimitPerMinute: 10_000 });
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
    assert.equal(afterIdle.status, 400);
    assert.match(await afterIdle.text(), /Invalid or missing session ID/);

    // …mais la session active est toujours là.
    const afterActive = await fetch(`${url}/mcp`, {
      method: 'GET',
      headers: { ...AUTH, 'mcp-session-id': active },
    });
    assert.notEqual(afterActive.status, 400);
    await afterActive.body?.cancel().catch(() => {});
  });
});
