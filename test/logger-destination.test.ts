import './helpers/env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { logStreamFd } from '../src/logger.js';

/**
 * C1 — en transport stdio, stdout porte le canal JSON-RPC : les logs doivent
 * partir sur stderr (fd 2), sinon le serveur devient inutilisable.
 */
describe('logStreamFd', () => {
  it('écrit sur stdout (fd 1) en transport http', () => {
    assert.equal(logStreamFd('http'), 1);
  });

  it('bascule sur stderr (fd 2) en transport stdio', () => {
    assert.equal(logStreamFd('stdio'), 2);
  });

  it('bascule sur stderr (fd 2) en transport both (stdio actif)', () => {
    assert.equal(logStreamFd('both'), 2);
  });
});
