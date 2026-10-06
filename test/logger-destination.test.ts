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

import pino from 'pino';
import { secretLogPaths } from '../src/logger.js';

it('redacts root credentials and request authorization headers', () => {
  let output = '';
  const instance = pino(
    { redact: { paths: secretLogPaths, censor: '[redacted]' } },
    {
      write(chunk: string) {
        output += chunk;
      },
    },
  );
  instance.info({
    password: 'fixture-password',
    token: 'fixture-token',
    MCP_BEARER_TOKEN: 'fixture-bearer',
    req: { headers: { authorization: 'Bearer fixture-auth', cookie: 'fixture-cookie' } },
    smtp: { pass: 'fixture-smtp' },
  });
  assert.ok(output.includes('[redacted]'));
  assert.ok(!output.includes('fixture-'));
});
