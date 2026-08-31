import './helpers/env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Request } from 'express';
import { clientIp } from '../src/http/client-ip.js';

/** Fabrique un objet assez proche d'un `Request` Express pour `clientIp()`. */
function fakeRequest(options: {
  headers?: Record<string, string | string[] | undefined>;
  ip?: string;
  remoteAddress?: string;
}): Request {
  return {
    headers: options.headers ?? {},
    ip: options.ip,
    socket: { remoteAddress: options.remoteAddress },
  } as unknown as Request;
}

describe('clientIp', () => {
  it('privilégie CF-Connecting-IP', () => {
    const req = fakeRequest({
      headers: { 'cf-connecting-ip': '203.0.113.7' },
      ip: '172.18.0.3',
      remoteAddress: '172.18.0.3',
    });
    assert.equal(clientIp(req), '203.0.113.7');
  });

  it('trim la valeur de CF-Connecting-IP', () => {
    const req = fakeRequest({ headers: { 'cf-connecting-ip': '  203.0.113.7  ' } });
    assert.equal(clientIp(req), '203.0.113.7');
  });

  it('retombe sur req.ip quand CF-Connecting-IP est absent', () => {
    const req = fakeRequest({ ip: '198.51.100.42', remoteAddress: '172.18.0.3' });
    assert.equal(clientIp(req), '198.51.100.42');
  });

  it('ignore un CF-Connecting-IP vide', () => {
    const req = fakeRequest({ headers: { 'cf-connecting-ip': '   ' }, ip: '198.51.100.42' });
    assert.equal(clientIp(req), '198.51.100.42');
  });

  it('retombe sur remoteAddress quand req.ip est absent', () => {
    const req = fakeRequest({ remoteAddress: '172.18.0.3' });
    assert.equal(clientIp(req), '172.18.0.3');
  });

  it('renvoie "unknown" en dernier recours', () => {
    assert.equal(clientIp(fakeRequest({})), 'unknown');
  });
});
