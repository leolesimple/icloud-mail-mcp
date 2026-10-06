import './helpers/env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createUploadStore,
  newUploadId,
  normalizeUploadContentType,
  sanitizeUploadFilename,
  UPLOAD_TTL_MS,
  UploadStoreFullError,
} from '../src/uploads.js';
import { UPLOAD_ID_PATTERN } from '../src/download-links.js';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const bytes = (n: number) => Buffer.alloc(n, 0x61);

describe('stockage des dépôts', () => {
  it('range, relit et consomme un dépôt', () => {
    const store = createUploadStore({ maxFiles: 5, maxTotalBytes: 100 });
    const stored = store.put({
      uploadId: 'a',
      filename: 'x.pdf',
      contentType: 'application/pdf',
      content: bytes(10),
    });
    assert.equal(stored.size, 10);
    assert.equal(store.get('a')?.filename, 'x.pdf');
    assert.deepEqual(store.stats(), { count: 1, bytes: 10 });
    assert.equal(store.delete('a'), true);
    assert.equal(store.get('a'), undefined);
    assert.deepEqual(store.stats(), { count: 0, bytes: 0 });
  });

  it('type par défaut application/octet-stream', () => {
    const store = createUploadStore({ maxFiles: 5, maxTotalBytes: 100 });
    assert.equal(
      store.put({ uploadId: 'a', content: bytes(1) }).contentType,
      'application/octet-stream',
    );
  });

  it('plafonne le nombre de dépôts', () => {
    const store = createUploadStore({ maxFiles: 2, maxTotalBytes: 100 });
    store.put({ uploadId: 'a', content: bytes(1) });
    store.put({ uploadId: 'b', content: bytes(1) });
    assert.equal(store.available(), 0);
    assert.throws(() => store.put({ uploadId: 'c', content: bytes(1) }), UploadStoreFullError);
    store.delete('a');
    store.put({ uploadId: 'c', content: bytes(1) });
  });

  it('plafonne les octets cumulés', () => {
    const store = createUploadStore({ maxFiles: 5, maxTotalBytes: 100 });
    store.put({ uploadId: 'a', content: bytes(60) });
    assert.equal(store.available(), 40);
    assert.throws(() => store.put({ uploadId: 'b', content: bytes(41) }), /UPLOAD_MAX_TOTAL_BYTES/);
    store.put({ uploadId: 'b', content: bytes(40) });
    assert.equal(store.available(), 0);
  });

  it('expire un dépôt 1 h après et libère sa place', () => {
    const c = clock();
    const store = createUploadStore({ maxFiles: 1, maxTotalBytes: 100, now: c.now });
    const stored = store.put({ uploadId: 'a', content: bytes(50) });
    assert.equal(stored.expiresAt, c.now() + UPLOAD_TTL_MS);
    c.advance(UPLOAD_TTL_MS - 1);
    assert.ok(store.get('a'));
    c.advance(1);
    assert.equal(store.get('a'), undefined);
    assert.equal(store.available(), 100);
  });

  it('purge les dépôts expirés au balayage', () => {
    const c = clock();
    const store = createUploadStore({ maxFiles: 5, maxTotalBytes: 100, ttlMs: 10, now: c.now });
    store.put({ uploadId: 'a', content: bytes(5) });
    c.advance(5);
    store.put({ uploadId: 'b', content: bytes(5) });
    c.advance(5);
    store.sweep();
    assert.deepEqual(store.stats(), { count: 1, bytes: 5 });
  });

  it('refuse un identifiant déjà présent', () => {
    const store = createUploadStore({ maxFiles: 5, maxTotalBytes: 100 });
    store.put({ uploadId: 'a', content: bytes(1) });
    assert.throws(() => store.put({ uploadId: 'a', content: bytes(1) }), /déjà présent/);
  });
});

describe('assainissement des dépôts', () => {
  it('génère des identifiants au format signé', () => {
    const id = newUploadId();
    assert.match(id, UPLOAD_ID_PATTERN);
    assert.notEqual(id, newUploadId());
  });

  it('retire le chemin et les caractères dangereux du nom', () => {
    assert.equal(sanitizeUploadFilename('C:\\Users\\moi\\rapport.pdf'), 'rapport.pdf');
    assert.equal(sanitizeUploadFilename('../../etc/passwd'), 'passwd');
    assert.equal(sanitizeUploadFilename('a\r\n"b".txt'), 'a___b_.txt');
    assert.equal(sanitizeUploadFilename('Facture été.pdf'), 'Facture été.pdf');
    assert.equal(sanitizeUploadFilename('  ..  '), undefined);
    assert.equal(sanitizeUploadFilename(undefined), undefined);
  });

  it('réduit le type MIME à son essence et écarte le défaut de curl', () => {
    assert.equal(normalizeUploadContentType('Text/Plain; charset=utf-8'), 'text/plain');
    assert.equal(normalizeUploadContentType('application/x-www-form-urlencoded'), undefined);
    assert.equal(normalizeUploadContentType('pas un type'), undefined);
    assert.equal(normalizeUploadContentType(undefined), undefined);
  });
});

it('reserves in-flight bytes and slots atomically and releases failed uploads', () => {
  const store = createUploadStore({ maxFiles: 2, maxTotalBytes: 10 });
  const reservation = store.reserve('a', 8);
  assert.equal(store.available(), 2);
  assert.throws(() => store.reserve('b', 3), UploadStoreFullError);
  reservation.release();
  assert.equal(store.available(), 10);
  const next = store.reserve('b', 10);
  next.commit({ uploadId: 'b', content: Buffer.alloc(6) });
  assert.equal(store.available(), 4);
  assert.equal(store.stats().bytes, 6);
});
it('leases uploaded files exclusively until composition releases or consumes them', () => {
  const store = createUploadStore({ maxFiles: 2, maxTotalBytes: 10 });
  store.put({ uploadId: 'a', content: Buffer.alloc(6) });
  const claim = store.claim(['a']);
  assert.throws(() => store.claim(['a']), /indisponible/);
  claim.release();
  store.claim(['a']).consume();
  assert.equal(store.get('a'), undefined);
  assert.equal(store.stats().bytes, 0);
});

it('keeps leased uploads within the byte budget until composition finishes', () => {
  let now = 0;
  const store = createUploadStore({ maxFiles: 1, maxTotalBytes: 6, ttlMs: 1, now: () => now });
  store.put({ uploadId: 'a', content: Buffer.alloc(6) });
  const claim = store.claim(['a']);
  now = 2;
  store.sweep();
  assert.equal(store.available(), 0);
  claim.release();
  store.sweep();
  assert.equal(store.available(), 6);
});
