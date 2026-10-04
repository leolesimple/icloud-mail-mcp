import './helpers/env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONFIRM_TOKEN_TTL_MS,
  ConfirmTokenError,
  createConfirmTokenService,
  issueConfirmToken,
  verifyConfirmToken,
  type ConfirmBinding,
  type ConfirmTokenErrorCode,
} from '../src/confirm.js';

const SECRET = 'secret-de-test-0123456789abcdef-0123456789';
const OP = 'empty_folder';
const BINDING: ConfirmBinding = {
  folder: 'Deleted Messages',
  uidValidity: 1700000000n,
  params: { uids: [3, 7, 12] },
};

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function service(now?: () => number) {
  return createConfirmTokenService({ secret: SECRET, now });
}

function rejects(fn: () => void, code: ConfirmTokenErrorCode) {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof ConfirmTokenError);
    assert.equal(err.code, code);
    return true;
  });
}

describe('jetons de confirmation', () => {
  it('fait un aller-retour', () => {
    const c = clock();
    const tokens = service(c.now);
    const issued = tokens.issue(OP, BINDING);
    assert.equal(issued.expiresAt, c.now() + CONFIRM_TOKEN_TTL_MS);
    assert.match(issued.token, /^[A-Za-z0-9_-]+$/);
    tokens.verify(issued.token, OP, BINDING);
  });

  it('accepte un uidValidity en number égal au bigint', () => {
    const tokens = service();
    const { token } = tokens.issue(OP, BINDING);
    tokens.verify(token, OP, { ...BINDING, uidValidity: 1700000000 });
  });

  it("ignore l'ordre des clés des paramètres", () => {
    const tokens = service();
    const { token } = tokens.issue('send', { params: { to: ['a@x.fr'], subject: 'S' } });
    tokens.verify(token, 'send', { params: { subject: 'S', to: ['a@x.fr'] } });
  });

  it('expire après le TTL', () => {
    const c = clock();
    const tokens = service(c.now);
    const { token } = tokens.issue(OP, BINDING);
    c.advance(CONFIRM_TOKEN_TTL_MS - 1);
    tokens.verify(token, OP, BINDING);

    const second = tokens.issue(OP, BINDING);
    c.advance(CONFIRM_TOKEN_TTL_MS);
    rejects(() => tokens.verify(second.token, OP, BINDING), 'expired');
  });

  describe('refuse un binding différent', () => {
    const cases: [string, string, ConfirmBinding][] = [
      ['opération', 'expunge', BINDING],
      ['dossier', OP, { ...BINDING, folder: 'Junk' }],
      ['dossier absent', OP, { ...BINDING, folder: undefined }],
      ['UIDVALIDITY', OP, { ...BINDING, uidValidity: 1700000001n }],
      ['UIDVALIDITY absente', OP, { ...BINDING, uidValidity: undefined }],
      ['empreinte', OP, { ...BINDING, params: { uids: [3, 7] } }],
      ['ordre des UID', OP, { ...BINDING, params: { uids: [7, 3, 12] } }],
      ['type des paramètres', OP, { ...BINDING, params: { uids: ['3', '7', '12'] } }],
    ];
    for (const [label, op, binding] of cases) {
      it(label, () => {
        const tokens = service();
        const { token } = tokens.issue(OP, BINDING);
        rejects(() => tokens.verify(token, op, binding), 'mismatch');
      });
    }

    it('bigint et chaîne ne se confondent pas', () => {
      const tokens = service();
      const { token } = tokens.issue(OP, { params: { n: 1n } });
      for (const n of ['1', 'bigint:1', '1n', 1]) {
        rejects(() => tokens.verify(token, OP, { params: { n } }), 'mismatch');
      }
    });
  });

  it('refuse un jeton signé par un autre secret', () => {
    const { token } = service().issue(OP, BINDING);
    const other = createConfirmTokenService({ secret: 'un-autre-secret-0123456789abcdef-xyz' });
    rejects(() => other.verify(token, OP, BINDING), 'mismatch');
  });

  it('refuse un jeton altéré', () => {
    const tokens = service();
    const { token } = tokens.issue(OP, BINDING);
    const raw = Buffer.from(token, 'base64url');
    for (const index of [5, 20, raw.length - 1]) {
      const altered = Buffer.from(raw);
      altered.writeUInt8(altered.readUInt8(index) ^ 0x01, index);
      rejects(() => tokens.verify(altered.toString('base64url'), OP, BINDING), 'mismatch');
    }
  });

  it("refuse un jeton dont l'expiration a été repoussée", () => {
    const c = clock();
    const tokens = service(c.now);
    const { token } = tokens.issue(OP, BINDING);
    const raw = Buffer.from(token, 'base64url');
    raw.writeBigUInt64BE(BigInt(c.now() + 3_600_000), 1);
    c.advance(CONFIRM_TOKEN_TTL_MS + 1);
    rejects(() => tokens.verify(raw.toString('base64url'), OP, BINDING), 'mismatch');
  });

  it('refuse un jeton malformé', () => {
    const tokens = service();
    const { token } = tokens.issue(OP, BINDING);
    const raw = Buffer.from(token, 'base64url');
    const wrongVersion = Buffer.from(raw);
    wrongVersion[0] = 2;
    for (const bad of [
      '',
      'pas un jeton !',
      token.slice(0, -4),
      `${token}AAAA`,
      wrongVersion.toString('base64url'),
      undefined as unknown as string,
    ]) {
      rejects(() => tokens.verify(bad, OP, BINDING), 'malformed');
    }
  });

  it('refuse le rejeu, y compris après purge des jetons expirés', () => {
    const c = clock();
    const tokens = service(c.now);
    const { token } = tokens.issue(OP, BINDING);
    tokens.verify(token, OP, BINDING);
    rejects(() => tokens.verify(token, OP, BINDING), 'replayed');

    // Un autre jeton consommé puis expiré est purgé ; le rejeu reste refusé (expiré).
    c.advance(CONFIRM_TOKEN_TTL_MS);
    rejects(() => tokens.verify(token, OP, BINDING), 'expired');
  });

  it("n'est pas consommé par un refus", () => {
    const tokens = service();
    const { token } = tokens.issue(OP, BINDING);
    rejects(() => tokens.verify(token, 'expunge', BINDING), 'mismatch');
    tokens.verify(token, OP, BINDING);
  });

  it('émet des jetons distincts pour la même opération', () => {
    const tokens = service();
    assert.notEqual(tokens.issue(OP, BINDING).token, tokens.issue(OP, BINDING).token);
  });

  it('refuse un secret trop court', () => {
    assert.throws(() => createConfirmTokenService({ secret: 'court' }), /au moins 32 octets/);
  });

  it('ne laisse fuiter le secret ni dans un jeton, ni dans une erreur', () => {
    const tokens = service();
    const { token } = tokens.issue(OP, BINDING);
    const decoded = Buffer.from(token, 'base64url').toString('latin1');
    assert.ok(!token.includes(SECRET) && !decoded.includes(SECRET));
    assert.ok(!JSON.stringify(tokens).includes(SECRET));
    for (const code of ['malformed', 'mismatch', 'expired', 'replayed'] as const) {
      const err = new ConfirmTokenError(code);
      assert.ok(!`${err.message} ${err.stack}`.includes(SECRET));
      assert.match(err.message, /jeton/i);
    }
    try {
      createConfirmTokenService({ secret: 'trop-court-secret' });
    } catch (err) {
      assert.ok(!String((err as Error).message).includes('trop-court-secret'));
    }
  });

  it('expose un service par défaut fonctionnel', () => {
    const { token } = issueConfirmToken(OP, BINDING);
    verifyConfirmToken(token, OP, BINDING);
    assert.throws(() => verifyConfirmToken(token, OP, BINDING), ConfirmTokenError);
  });
});
