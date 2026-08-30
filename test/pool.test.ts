import './helpers/env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ImapFlow } from 'imapflow';
import { ImapConnectionPool } from '../src/imap/pool.js';
import { ImapAuthError, ImapNetworkError } from '../src/imap/errors.js';
import { authError, FakeImapClient, networkError } from './helpers/fake-imap.js';

/** Pool branché sur des clients factices : aucun accès réseau, aucun compte iCloud requis. */
function makePool(maxSize: number, onConnect?: (client: FakeImapClient) => void) {
  const created: FakeImapClient[] = [];
  const pool = new ImapConnectionPool(maxSize, () => {
    const client = new FakeImapClient(onConnect);
    created.push(client);
    return client.asImapFlow();
  });
  return { pool, created };
}

/** Laisse tourner la file d'attente : release() sert les waiters de façon asynchrone. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('ImapConnectionPool', () => {
  it('réutilise une connexion libérée plutôt que d’en ouvrir une seconde', async () => {
    const { pool, created } = makePool(2);

    const first = await pool.acquire();
    pool.release(first);
    const second = await pool.acquire();

    assert.equal(first, second);
    assert.equal(created.length, 1, 'une seule connexion iCloud doit être ouverte');
    await pool.close();
  });

  it('ouvre des connexions distinctes tant que la taille max n’est pas atteinte', async () => {
    const { pool, created } = makePool(2);

    const [first, second] = await Promise.all([pool.acquire(), pool.acquire()]);

    assert.notEqual(first, second);
    assert.equal(created.length, 2);
    await pool.close();
  });

  it('ne dépasse jamais la taille max : la demande en trop attend une libération', async () => {
    const { pool, created } = makePool(1);

    const first = await pool.acquire();
    let served: ImapFlow | undefined;
    const pending = pool.acquire().then((client) => (served = client));

    await tick();
    assert.equal(served, undefined, 'la demande doit rester en attente');
    assert.equal(created.length, 1);

    pool.release(first);
    assert.equal(await pending, first, 'le waiter doit récupérer la connexion libérée');
    assert.equal(created.length, 1);
    await pool.close();
  });

  it('sert les waiters dans leur ordre d’arrivée', async () => {
    const { pool } = makePool(1);
    const held = await pool.acquire();
    const order: number[] = [];

    const first = pool.acquire().then((client) => {
      order.push(1);
      return client;
    });
    const second = pool.acquire().then((client) => {
      order.push(2);
      return client;
    });

    await tick();
    pool.release(held);
    pool.release(await first);
    await second;

    assert.deepEqual(order, [1, 2]);
    await pool.close();
  });

  it('libère la connexion même si le travail échoue', async () => {
    const { pool, created } = makePool(1);

    await assert.rejects(
      pool.withConnection(async () => {
        throw new Error('échec pendant le fetch');
      }),
      /échec pendant le fetch/,
    );

    // Si la connexion n'avait pas été libérée, cet acquire resterait bloqué.
    const client = await pool.acquire();
    assert.equal(created.length, 1);
    pool.release(client);
    await pool.close();
  });

  it('retire du pool une connexion devenue inutilisable et en ouvre une neuve', async () => {
    const { pool, created } = makePool(2);

    const first = await pool.acquire();
    created[0]?.die(); // iCloud a coupé la connexion sans prévenir
    pool.release(first);

    const second = await pool.acquire();
    assert.notEqual(second, first);
    assert.equal(created.length, 2);
    await pool.close();
  });

  it('retire une connexion qui émet une erreur', async () => {
    const { pool, created } = makePool(2);

    const first = await pool.acquire();
    created[0]?.emit('error', networkError('ECONNRESET'));
    pool.release(first);

    const second = await pool.acquire();
    assert.notEqual(second, first);
    await pool.close();
  });

  it('retente une fois quand la connexion échoue pour une raison réseau', async () => {
    let attempt = 0;
    const { pool, created } = makePool(1, () => {
      attempt += 1;
      if (attempt === 1) {
        throw networkError('ETIMEDOUT');
      }
    });

    const client = await pool.acquire();
    assert.ok(client);
    assert.equal(created.length, 2, 'un second client doit être construit pour la seconde tentative');
    await pool.close();
  });

  it('abandonne si la seconde tentative échoue aussi', async () => {
    const { pool } = makePool(1, () => {
      throw networkError('ENOTFOUND');
    });

    await assert.rejects(pool.acquire(), ImapNetworkError);
    await pool.close();
  });

  it('ne retente pas sur un échec d’authentification', async () => {
    const { pool, created } = makePool(1, () => {
      throw authError();
    });

    await assert.rejects(pool.acquire(), ImapAuthError);
    assert.equal(created.length, 1, 'inutile de re-tenter : le mot de passe restera faux');
    await pool.close();
  });

  it('ne laisse pas la place réservée occupée après un échec de connexion', async () => {
    let attempt = 0;
    const { pool } = makePool(1, () => {
      attempt += 1;
      if (attempt <= 2) {
        throw networkError('ECONNREFUSED');
      }
    });

    await assert.rejects(pool.acquire(), ImapNetworkError);
    // Si `reserved` n'était pas décrémenté, le pool se croirait plein pour toujours.
    assert.ok(await pool.acquire());
    await pool.close();
  });

  it('déconnecte proprement les clients à la fermeture', async () => {
    const { pool, created } = makePool(2);

    const client = await pool.acquire();
    pool.release(client);
    await pool.close();

    assert.equal(created[0]?.logoutCount, 1);
  });

  it('rejette les demandes en attente à la fermeture', async () => {
    const { pool } = makePool(1);
    await pool.acquire();

    const pending = pool.acquire();
    await tick();
    await pool.close();

    await assert.rejects(pending, /fermeture/);
  });

  it('refuse toute nouvelle demande une fois fermé', async () => {
    const { pool } = makePool(1);
    await pool.close();
    await assert.rejects(pool.acquire(), /fermé/);
  });

  it('stats() reflète les connexions ouvertes et en cours d’utilisation', async () => {
    const { pool } = makePool(2);
    assert.deepEqual(pool.stats(), { open: 0, inUse: 0, max: 2 });

    const first = await pool.acquire();
    assert.deepEqual(pool.stats(), { open: 1, inUse: 1, max: 2 });

    pool.release(first);
    assert.deepEqual(pool.stats(), { open: 1, inUse: 0, max: 2 });

    await pool.close();
  });
});
