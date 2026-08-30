import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyImapError,
  ImapAuthError,
  ImapCommandError,
  ImapNetworkError,
} from '../src/imap/errors.js';
import { authError, networkError } from './helpers/fake-imap.js';

describe('classifyImapError', () => {
  it('classe un échec d’authentification imapflow en ImapAuthError', () => {
    const classified = classifyImapError(authError());
    assert.ok(classified instanceof ImapAuthError);
    assert.match(classified.message, /mot de passe d'application/);
    assert.match(classified.message, /Invalid credentials/);
  });

  it("conserve l'erreur d'origine dans `cause`", () => {
    const original = authError();
    const classified = classifyImapError(original);
    assert.equal(classified.cause, original);
  });

  for (const code of ['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'NoConnection', 'GREETING_TIMEOUT', 'StateLogout']) {
    it(`classe le code réseau ${code} en ImapNetworkError`, () => {
      const classified = classifyImapError(networkError(code));
      assert.ok(classified instanceof ImapNetworkError);
      assert.match(classified.message, new RegExp(code));
    });
  }

  it('classe une erreur sans code connu en ImapCommandError', () => {
    const classified = classifyImapError(new Error('NO [CANNOT] Mailbox does not exist'));
    assert.ok(classified instanceof ImapCommandError);
    assert.equal(classified.message, 'NO [CANNOT] Mailbox does not exist');
  });

  it('classe un code inconnu en ImapCommandError plutôt qu’en erreur réseau', () => {
    const classified = classifyImapError(networkError('EPERM'));
    assert.ok(classified instanceof ImapCommandError);
  });

  it('gère une valeur rejetée qui n’est pas une Error', () => {
    const classified = classifyImapError('boom');
    assert.ok(classified instanceof ImapCommandError);
    assert.match(classified.message, /Erreur IMAP inconnue : boom/);
  });

  it('est idempotent : une erreur déjà classée est renvoyée telle quelle', () => {
    const already = new ImapNetworkError('déjà classée');
    assert.equal(classifyImapError(already), already);
  });

  it('donne la priorité à l’authentification sur le code réseau', () => {
    const both = Object.assign(new Error('nope'), { authenticationFailed: true, code: 'ECONNRESET' });
    assert.ok(classifyImapError(both) instanceof ImapAuthError);
  });
});
