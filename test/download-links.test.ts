import './helpers/env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  contentDisposition,
  createDownloadLinkService,
  DOWNLOAD_LINK_TTL_MS,
  downloadUrl,
  sanitizeFilename,
  type DownloadTarget,
} from '../src/download-links.js';

const SECRET = 'secret-de-test-0123456789abcdef-0123456789';
const ATTACHMENT: DownloadTarget = { kind: 'attachment', folder: 'INBOX', uid: 42, index: 1 };
const MESSAGE: DownloadTarget = { kind: 'message', folder: 'Archive/2026', uid: 7 };

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

/** Rejoue le format du jeton (payload JSON + HMAC) pour fabriquer des variantes. */
function split(token: string) {
  const raw = Buffer.from(token, 'base64url');
  return { payload: raw.subarray(0, raw.length - 32), mac: raw.subarray(raw.length - 32) };
}

describe('liens de téléchargement signés', () => {
  it('fait un aller-retour pour une pièce jointe et pour un message', () => {
    const links = createDownloadLinkService({ secret: SECRET });
    for (const target of [ATTACHMENT, MESSAGE]) {
      const { token } = links.issue(target);
      assert.match(token, /^[A-Za-z0-9_-]+$/, 'le jeton doit tenir dans un segment d’URL');
      assert.deepEqual(links.redeem(token), { ok: true, target });
    }
  });

  it('accepte une pièce jointe désignée par son numéro de partie IMAP', () => {
    const links = createDownloadLinkService({ secret: SECRET });
    const byPart: DownloadTarget = { kind: 'attachment', folder: 'Apple', uid: 371, part: '1.2' };
    assert.deepEqual(links.redeem(links.issue(byPart).token), { ok: true, target: byPart });
  });

  it('refuse une cible signée avec index ET part, ou une partie mal formée', () => {
    const links = createDownloadLinkService({ secret: SECRET });
    const invalid = [
      { kind: 'attachment', folder: 'INBOX', uid: 1, index: 0, part: '2' },
      { kind: 'attachment', folder: 'INBOX', uid: 1, part: '2.' },
      { kind: 'attachment', folder: 'INBOX', uid: 1, part: '2.TEXT' },
      { kind: 'attachment', folder: 'INBOX', uid: 1 },
    ];
    for (const target of invalid) {
      const { token } = links.issue(target as unknown as DownloadTarget);
      assert.deepEqual(links.redeem(token), { ok: false, reason: 'malformed' });
    }
  });

  it('expire après 15 minutes', () => {
    const c = clock();
    const links = createDownloadLinkService({ secret: SECRET, now: c.now });
    const { token, expiresAt } = links.issue(ATTACHMENT);
    assert.equal(expiresAt, c.now() + DOWNLOAD_LINK_TTL_MS);
    assert.equal(DOWNLOAD_LINK_TTL_MS, 15 * 60_000);

    c.advance(DOWNLOAD_LINK_TTL_MS);
    assert.deepEqual(links.redeem(token), { ok: false, reason: 'expired' });
  });

  it('reste valable juste avant l’expiration', () => {
    const c = clock();
    const links = createDownloadLinkService({ secret: SECRET, now: c.now });
    const { token } = links.issue(ATTACHMENT);
    c.advance(DOWNLOAD_LINK_TTL_MS - 1);
    assert.equal(links.redeem(token).ok, true);
  });

  it('ne sert qu’une fois', () => {
    const links = createDownloadLinkService({ secret: SECRET });
    const { token } = links.issue(ATTACHMENT);
    assert.equal(links.redeem(token).ok, true);
    assert.deepEqual(links.redeem(token), { ok: false, reason: 'replayed' });
  });

  it('distingue deux liens vers la même cible (nonce)', () => {
    const links = createDownloadLinkService({ secret: SECRET });
    const a = links.issue(ATTACHMENT).token;
    const b = links.issue(ATTACHMENT).token;
    assert.notEqual(a, b);
    assert.equal(links.redeem(a).ok, true);
    assert.equal(links.redeem(b).ok, true);
  });

  it('refuse un jeton signé avec un autre secret', () => {
    const other = createDownloadLinkService({ secret: `${SECRET}-autre` });
    const links = createDownloadLinkService({ secret: SECRET });
    assert.deepEqual(links.redeem(other.issue(ATTACHMENT).token), { ok: false, reason: 'forged' });
  });

  it('refuse une cible modifiée (UID, dossier ou index changés)', () => {
    const links = createDownloadLinkService({ secret: SECRET });
    const { payload, mac } = split(links.issue(ATTACHMENT).token);
    const json = JSON.parse(payload.toString('utf8'));
    for (const t of [
      { ...json.t, uid: 43 },
      { ...json.t, folder: 'Sent Messages' },
      { ...json.t, index: 0 },
      { kind: 'message', folder: 'INBOX', uid: 42 },
    ]) {
      const forged = Buffer.concat([Buffer.from(JSON.stringify({ ...json, t }), 'utf8'), mac]);
      assert.deepEqual(links.redeem(forged.toString('base64url')), { ok: false, reason: 'forged' });
    }
  });

  it('refuse une expiration repoussée', () => {
    const links = createDownloadLinkService({ secret: SECRET });
    const { payload, mac } = split(links.issue(ATTACHMENT).token);
    const json = JSON.parse(payload.toString('utf8'));
    const forged = Buffer.concat([
      Buffer.from(JSON.stringify({ ...json, exp: json.exp + 86_400_000 }), 'utf8'),
      mac,
    ]);
    assert.deepEqual(links.redeem(forged.toString('base64url')), { ok: false, reason: 'forged' });
  });

  it('refuse un jeton tronqué, vide, trop long ou hors alphabet base64url', () => {
    const links = createDownloadLinkService({ secret: SECRET });
    const { token } = links.issue(ATTACHMENT);
    for (const bad of ['', 'abc', token.slice(0, -4), `${token}.x`, 'a'.repeat(5000), 'é']) {
      const result = links.redeem(bad);
      assert.equal(result.ok, false, `jeton accepté : ${bad.slice(0, 20)}`);
    }
    // Le jeton intact reste utilisable : les refus ne l'ont pas consommé.
    assert.equal(links.redeem(token).ok, true);
  });

  it('purge les nonces consommés une fois expirés', () => {
    const c = clock();
    const links = createDownloadLinkService({ secret: SECRET, now: c.now });
    const { token } = links.issue(ATTACHMENT);
    assert.equal(links.redeem(token).ok, true);
    c.advance(DOWNLOAD_LINK_TTL_MS + 1);
    links.sweep();
    // Le nonce a été oublié, mais le jeton reste refusé : il a expiré.
    assert.deepEqual(links.redeem(token), { ok: false, reason: 'expired' });
  });

  it('exige un secret d’au moins 32 octets', () => {
    assert.throws(() => createDownloadLinkService({ secret: 'trop-court' }), /32 octets/);
  });

  it('construit l’URL publique', () => {
    assert.equal(
      downloadUrl('https://mail.example.com', 'abc'),
      'https://mail.example.com/download/abc',
    );
  });
});

describe('nom de fichier servi', () => {
  it('retire chemins, contrôles et guillemets', () => {
    assert.equal(sanitizeFilename('../../etc/passwd'), '_.._etc_passwd');
    assert.equal(sanitizeFilename('a\r\nb"c\\d.pdf'), 'a__b_c_d.pdf');
    assert.equal(sanitizeFilename('  ..  '), 'download');
    assert.equal(sanitizeFilename(undefined, 'message-7.eml'), 'message-7.eml');
    assert.equal(sanitizeFilename('x'.repeat(500)).length, 200);
  });

  it('produit un Content-Disposition attachment avec repli ASCII et filename* UTF-8', () => {
    assert.equal(
      contentDisposition('Facture été.pdf'),
      `attachment; filename="Facture _t_.pdf"; filename*=UTF-8''Facture%20%C3%A9t%C3%A9.pdf`,
    );
    assert.equal(
      contentDisposition('rapport.pdf'),
      `attachment; filename="rapport.pdf"; filename*=UTF-8''rapport.pdf`,
    );
  });
});
