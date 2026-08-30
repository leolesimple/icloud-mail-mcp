import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifySmtpError,
  SmtpAuthError,
  SmtpMessageError,
  SmtpNetworkError,
} from '../src/smtp/errors.js';

function nodemailerError(code: string, message = 'boom'): Error {
  return Object.assign(new Error(message), { code });
}

describe('classifySmtpError', () => {
  for (const code of ['EAUTH', 'ENOAUTH']) {
    it(`classe ${code} en SmtpAuthError`, () => {
      const classified = classifySmtpError(nodemailerError(code));
      assert.ok(classified instanceof SmtpAuthError);
      assert.match(classified.message, /ICLOUD_APP_PASSWORD/);
    });
  }

  for (const code of ['ECONNECTION', 'EDNS', 'ETIMEDOUT', 'ESOCKET']) {
    it(`classe ${code} en SmtpNetworkError`, () => {
      const classified = classifySmtpError(nodemailerError(code));
      assert.ok(classified instanceof SmtpNetworkError);
      assert.match(classified.message, new RegExp(code));
    });
  }

  it('classe un refus de destinataire en SmtpMessageError', () => {
    const classified = classifySmtpError(nodemailerError('EENVELOPE', '550 No such recipient'));
    assert.ok(classified instanceof SmtpMessageError);
    assert.equal(classified.message, '550 No such recipient');
  });

  it('gère une valeur rejetée qui n’est pas une Error', () => {
    const classified = classifySmtpError(42);
    assert.ok(classified instanceof SmtpMessageError);
    assert.match(classified.message, /Erreur SMTP inconnue : 42/);
  });

  it('est idempotent', () => {
    const already = new SmtpAuthError('déjà classée');
    assert.equal(classifySmtpError(already), already);
  });

  it("conserve l'erreur d'origine dans `cause`", () => {
    const original = nodemailerError('ESOCKET');
    assert.equal(classifySmtpError(original).cause, original);
  });
});
