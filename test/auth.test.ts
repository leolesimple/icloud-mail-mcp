import './helpers/env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { bearerAuth } from '../src/http/auth.js';
import { config } from '../src/config.js';

const VALID = config.MCP_BEARER_TOKEN;

function run(authorization?: string) {
  const res = {
    statusCode: undefined as number | undefined,
    body: undefined as Record<string, unknown> | undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: Record<string, unknown>) {
      this.body = payload;
      return this;
    },
  };
  let nextCalled = false;

  bearerAuth({ headers: { authorization } } as Request, res as unknown as Response, () => {
    nextCalled = true;
  });

  return { res, nextCalled };
}

describe('bearerAuth', () => {
  it('laisse passer le bon token', () => {
    const { res, nextCalled } = run(`Bearer ${VALID}`);
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, undefined);
  });

  it('rejette une requête sans en-tête Authorization', () => {
    const { res, nextCalled } = run(undefined);
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  });

  it('répond une erreur JSON-RPC exploitable par un client MCP', () => {
    const { res } = run(undefined);
    assert.equal(res.body?.jsonrpc, '2.0');
    assert.deepEqual(res.body?.error, {
      code: -32001,
      message: 'Unauthorized: missing or invalid bearer token',
    });
  });

  it('rejette un mauvais token de même longueur', () => {
    const { res, nextCalled } = run(`Bearer ${'x'.repeat(VALID.length)}`);
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  });

  it('rejette un token plus court sans planter (timingSafeEqual exige des longueurs égales)', () => {
    const { res, nextCalled } = run('Bearer court');
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  });

  it('rejette un token plus long', () => {
    const { res, nextCalled } = run(`Bearer ${VALID}suffixe`);
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  });

  it('rejette le bon token sans le préfixe Bearer', () => {
    const { nextCalled } = run(VALID);
    assert.equal(nextCalled, false);
  });

  it('rejette un autre schéma d’authentification', () => {
    const { nextCalled } = run(`Basic ${VALID}`);
    assert.equal(nextCalled, false);
  });

  it('rejette un en-tête vide', () => {
    const { nextCalled } = run('');
    assert.equal(nextCalled, false);
  });

  it('rejette "Bearer" sans token', () => {
    const { nextCalled } = run('Bearer ');
    assert.equal(nextCalled, false);
  });
});
