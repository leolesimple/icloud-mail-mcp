import './helpers/env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFolderCache, filterFolderPaths } from '../src/mcp/folder-cache.js';

describe('filterFolderPaths', () => {
  const paths = ['INBOX', 'Archive', 'Sent Messages', 'Deleted Messages', 'Notes'];

  it('renvoie tout (dans la limite) pour une saisie vide', () => {
    assert.deepEqual(filterFolderPaths(paths, ''), paths);
  });

  it('filtre en sous-chaîne, casse ignorée', () => {
    assert.deepEqual(filterFolderPaths(paths, 'mess'), ['Sent Messages', 'Deleted Messages']);
  });

  it('applique la limite', () => {
    assert.equal(filterFolderPaths(paths, '', 2).length, 2);
  });
});

describe('createFolderCache', () => {
  it('ne recharge pas tant que le TTL n’est pas dépassé', async () => {
    let calls = 0;
    let now = 1000;
    const cache = createFolderCache(
      async () => {
        calls += 1;
        return ['INBOX'];
      },
      60_000,
      () => now,
    );

    await cache.paths();
    now = 1000 + 59_999;
    await cache.paths();
    assert.equal(calls, 1);

    now = 1000 + 60_001;
    await cache.paths();
    assert.equal(calls, 2);
  });

  it('dédoublonne les chargements concurrents', async () => {
    let calls = 0;
    const cache = createFolderCache(async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 5));
      return ['INBOX'];
    });

    await Promise.all([cache.paths(), cache.paths(), cache.paths()]);
    assert.equal(calls, 1);
  });

  it('reset force un rechargement', async () => {
    let calls = 0;
    const cache = createFolderCache(async () => {
      calls += 1;
      return ['INBOX'];
    });

    await cache.paths();
    cache.reset();
    await cache.paths();
    assert.equal(calls, 2);
  });
});
