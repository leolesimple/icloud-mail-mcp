import './helpers/env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ImapFlow } from 'imapflow';
import { ImapConnectionPool } from '../src/imap/pool.js';
import { ImapAuthError, ImapNetworkError, ImapPoolTimeoutError } from '../src/imap/errors.js';
import { authError, FakeImapClient, networkError } from './helpers/fake-imap.js';

/** Pool branché sur des clients factices : aucun accès réseau, aucun compte iCloud requis. */
function makePool(
  maxSize: number,
  onConnect?: (client: FakeImapClient) => void,
  acquireTimeoutMs?: number,
) {
  const created: FakeImapClient[] = [];
  const pool = new ImapConnectionPool(
    maxSize,
    () => {
      const client = new FakeImapClient(onConnect);
      created.push(client);
      return client.asImapFlow();
    },
    acquireTimeoutMs,
  );
  return { pool, created };
}

/** Laisse tourner la file d'attente : release() sert les waiters de façon asynchrone. */
const tick = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
    const idle = { waiting: 0, maxRecentWaitMs: 0, acquireTimeouts: 0 };
    assert.deepEqual(pool.stats(), { open: 0, inUse: 0, max: 2, ...idle });

    const first = await pool.acquire();
    assert.deepEqual(pool.stats(), { open: 1, inUse: 1, max: 2, ...idle });

    pool.release(first);
    assert.deepEqual(pool.stats(), { open: 1, inUse: 0, max: 2, ...idle });

    await pool.close();
  });

  it('stats() compte la file d’attente et la plus longue attente récente', async () => {
    const { pool } = makePool(1);
    const held = await pool.acquire();

    const pending = pool.acquire();
    await tick();
    assert.equal(pool.stats().waiting, 1);

    await sleep(30);
    pool.release(held);
    pool.release(await pending);

    const stats = pool.stats();
    assert.equal(stats.waiting, 0);
    assert.ok(stats.maxRecentWaitMs >= 25, `attente mesurée : ${stats.maxRecentWaitMs} ms`);
    await pool.close();
  });
});

describe('ImapConnectionPool — délai d’acquisition', () => {
  it('rejette un appel en attente au-delà du délai, avec une erreur actionnable', async () => {
    const { pool } = makePool(1, undefined, 20);
    await pool.acquire();

    const err = await pool.acquire().then(
      () => assert.fail('la demande aurait dû expirer'),
      (e: unknown) => e,
    );

    assert.ok(err instanceof ImapPoolTimeoutError);
    // Sous-classe réseau : propagée telle quelle, jamais avalée dossier par dossier.
    assert.ok(err instanceof ImapNetworkError);
    assert.match(err.message, /saturé/);
    assert.match(err.message, /1\/1 connexions occupées/);
    assert.match(err.message, /0 autre\(s\) appel\(s\) en attente/);
    assert.match(err.message, /IMAP_POOL_SIZE \(actuellement 1\)/);
    assert.equal(pool.stats().acquireTimeouts, 1);
    await pool.close();
  });

  it('retire le waiter expiré de la file : la connexion libérée va au suivant', async () => {
    const { pool } = makePool(1, undefined, 30);
    const held = await pool.acquire();

    const expired = pool.acquire();
    const expiredOutcome = expired.then(
      () => 'servi',
      () => 'expiré',
    );
    await sleep(15);
    // Arrive plus tard : expirera après le premier.
    let served: ImapFlow | undefined;
    const next = pool.acquire().then((client) => (served = client));
    await tick();
    assert.equal(pool.stats().waiting, 2);

    assert.equal(await expiredOutcome, 'expiré');
    assert.equal(pool.stats().waiting, 1, 'le waiter expiré ne doit plus être en file');

    pool.release(held);
    assert.equal(await next, held, 'le waiter suivant récupère la connexion');
    assert.equal(served, held);
    assert.equal(pool.stats().waiting, 0);
    await pool.close();
  });

  it('ne règle jamais deux fois un waiter servi juste avant son délai', async () => {
    const { pool, created } = makePool(1, undefined, 25);
    const held = await pool.acquire();

    let settlements = 0;
    const pending = pool.acquire().then(
      (client) => {
        settlements += 1;
        return client;
      },
      () => {
        settlements += 1;
      },
    );
    await sleep(15);
    pool.release(held);
    const client = await pending;

    // Laisse passer l'échéance du délai : elle ne doit plus rien faire.
    await sleep(30);
    assert.equal(client, held);
    assert.equal(settlements, 1);
    assert.equal(pool.stats().acquireTimeouts, 0);
    assert.equal(created.length, 1);

    // La connexion reste attribuée au waiter servi : pas de double attribution.
    let other: ImapFlow | undefined;
    void pool.acquire().then(
      (c) => (other = c),
      () => undefined,
    );
    await tick();
    assert.equal(other, undefined);
    await pool.close();
  });

  it('une connexion libérée après expiration redevient disponible, sans fuite', async () => {
    const { pool, created } = makePool(1, undefined, 15);
    const held = await pool.acquire();

    await assert.rejects(pool.acquire(), ImapPoolTimeoutError);
    pool.release(held);
    await tick();

    assert.deepEqual(
      { open: pool.stats().open, inUse: pool.stats().inUse, waiting: pool.stats().waiting },
      { open: 1, inUse: 0, waiting: 0 },
    );
    assert.equal(await pool.acquire(), held);
    assert.equal(created.length, 1);
    await pool.close();
  });

  it('transmet au premier en file l’échec d’ouverture d’une connexion de remplacement', async () => {
    let attempt = 0;
    const { pool, created } = makePool(
      1,
      () => {
        attempt += 1;
        if (attempt > 1) throw authError();
      },
      1_000,
    );
    const first = await pool.acquire();

    const pending = pool.acquire();
    await tick();
    created[0]?.die();
    pool.release(first); // connexion morte : le pool doit en ouvrir une neuve, qui échoue

    await assert.rejects(pending, ImapAuthError);
    assert.equal(pool.stats().waiting, 0);
    await pool.close();
  });
});
