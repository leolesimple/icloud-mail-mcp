import './helpers/env.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { closeAllSessions, createHttpServer } from '../src/http/server.js';
import { config } from '../src/config.js';
import { imapPool } from '../src/imap/pool.js';
import { closeSmtp } from '../src/smtp/client.js';

/**
 * Tests d'intégration de la couche HTTP : un vrai serveur Express sur un port
 * éphémère. Aucun outil n'est appelé, donc aucune connexion IMAP ou SMTP n'est
 * ouverte — seuls l'authentification, le routage et la gestion de session MCP
 * sont exercés.
 */

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

before(async () => {
  server = createHttpServer().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await closeAllSessions();
  await imapPool.close();
  closeSmtp();
  await new Promise((resolve) => server.close(resolve));
});

describe('GET /health', () => {
  it('répond sans authentification (healthcheck Docker)', async () => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
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
