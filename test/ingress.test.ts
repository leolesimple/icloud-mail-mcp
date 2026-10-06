import { it } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { validateIngress } from '../src/http/ingress.js';

function check(host: string | undefined, origin?: string) {
  let status = 200;
  let passed = false;
  const response = {
    status(code: number) {
      status = code;
      return this;
    },
    send() {
      return this;
    },
  };
  validateIngress(
    new Set(['localhost', 'mail.example.com']),
    new Set(['https://mail.example.com']),
  )({ headers: { host, origin } } as Request, response as unknown as Response, () => {
    passed = true;
  });
  return { status, passed };
}
it('accepts native clients without Origin and exact approved browser origin', () => {
  assert.equal(check('localhost:3000').passed, true);
  assert.equal(check('mail.example.com', 'https://mail.example.com').passed, true);
});
it('rejects DNS rebinding hosts and unapproved/malformed Origin or Host', () => {
  for (const host of ['evil.example', 'localhost@evil.example', 'localhost/path', undefined])
    assert.equal(check(host).status, 403);
  for (const origin of ['null', 'https://evil.example', 'https://mail.example.com.evil'])
    assert.equal(check('localhost', origin).status, 403);
});
