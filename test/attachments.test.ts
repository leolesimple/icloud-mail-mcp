import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertReadableSize,
  AttachmentTooLargeError,
  decodeInboundAttachments,
  isImageMimeType,
} from '../src/attachments.js';

const LIMIT = 5_242_880;

function base64(bytes: number): string {
  return Buffer.alloc(bytes, 0x41).toString('base64');
}

describe('decodeInboundAttachments', () => {
  it('décode le base64 en Buffer en conservant le contenu', () => {
    const content = Buffer.from('bonjour le monde', 'utf8');
    const [decoded] = decodeInboundAttachments(
      [{ filename: 'note.txt', contentType: 'text/plain', contentBase64: content.toString('base64') }],
      LIMIT,
    );
    assert.ok(decoded);
    assert.ok(Buffer.isBuffer(decoded.content));
    assert.equal(decoded.content.toString('utf8'), 'bonjour le monde');
    assert.equal(decoded.filename, 'note.txt');
    assert.equal(decoded.contentType, 'text/plain');
  });

  it('renvoie une liste vide pour undefined ou une liste vide', () => {
    assert.deepEqual(decodeInboundAttachments(undefined, LIMIT), []);
    assert.deepEqual(decodeInboundAttachments([], LIMIT), []);
  });

  it('accepte un cumul juste sous la limite', () => {
    const result = decodeInboundAttachments(
      [
        { filename: 'a.bin', contentBase64: base64(3_000_000) },
        { filename: 'b.bin', contentBase64: base64(2_000_000) },
      ],
      LIMIT,
    );
    assert.equal(result.length, 2);
  });

  it('refuse un cumul au-delà de la limite, en mentionnant taille et limite', () => {
    assert.throws(
      () =>
        decodeInboundAttachments(
          [
            { filename: 'a.bin', contentBase64: base64(3_000_000) },
            { filename: 'b.bin', contentBase64: base64(3_000_000) },
          ],
          LIMIT,
        ),
      (err: Error) => {
        assert.ok(err instanceof AttachmentTooLargeError);
        assert.match(err.message, /6000000 octets/);
        assert.match(err.message, /5242880 octets/);
        return true;
      },
    );
  });
});

describe('assertReadableSize', () => {
  it('laisse passer une pièce jointe sous la limite', () => {
    assert.doesNotThrow(() => assertReadableSize(LIMIT, LIMIT));
  });

  it('refuse au-delà de la limite en donnant la taille réelle et la limite', () => {
    assert.throws(
      () => assertReadableSize(LIMIT + 1, LIMIT),
      (err: Error) => {
        assert.ok(err instanceof AttachmentTooLargeError);
        assert.match(err.message, /5242881 octets/);
        assert.match(err.message, /5242880 octets/);
        return true;
      },
    );
  });
});

describe('isImageMimeType', () => {
  it('reconnaît les types image (bloc "image")', () => {
    assert.equal(isImageMimeType('image/png'), true);
    assert.equal(isImageMimeType('IMAGE/JPEG'), true);
  });

  it('rejette les autres types (bloc "resource")', () => {
    assert.equal(isImageMimeType('application/pdf'), false);
    assert.equal(isImageMimeType('text/html'), false);
    assert.equal(isImageMimeType(undefined), false);
  });
});
