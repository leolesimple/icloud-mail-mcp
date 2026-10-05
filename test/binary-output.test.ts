import './helpers/env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  binaryOutput,
  checkBinaryFormat,
  URL_FORMAT_UNAVAILABLE,
  type BinaryContent,
} from '../src/mcp/binary-output.js';
import { createDownloadLinkService, type DownloadTarget } from '../src/download-links.js';

const PDF: BinaryContent = {
  filename: 'facture.pdf',
  contentType: 'application/pdf',
  content: Buffer.from('%PDF-1.7 contenu factice'),
};
const PNG: BinaryContent = {
  filename: 'photo.png',
  contentType: 'image/png',
  content: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
};
const TARGET: DownloadTarget = { kind: 'attachment', folder: 'INBOX', uid: 12, index: 0 };
const BASE = 'https://mail.example.com';

function onlyBlock(result: ReturnType<typeof binaryOutput>) {
  assert.equal(result.content.length, 1);
  return result.content[0]!;
}

function textJson(result: ReturnType<typeof binaryOutput>): Record<string, unknown> {
  const block = onlyBlock(result);
  assert.equal(block.type, 'text');
  return JSON.parse((block as { text: string }).text) as Record<string, unknown>;
}

describe('binaryOutput — format auto', () => {
  it('renvoie une image en bloc image', () => {
    const block = onlyBlock(
      binaryOutput(PNG, { format: 'auto', target: TARGET, publicBaseUrl: '' }),
    );
    assert.deepEqual(block, {
      type: 'image',
      data: PNG.content.toString('base64'),
      mimeType: 'image/png',
    });
  });

  it('renvoie un PDF en bloc text JSON, jamais en bloc resource', () => {
    const result = binaryOutput(PDF, { format: 'auto', target: TARGET, publicBaseUrl: '' });
    assert.ok(!result.content.some((b) => b.type === 'resource'));
    assert.deepEqual(textJson(result), {
      filename: 'facture.pdf',
      contentType: 'application/pdf',
      size: PDF.content.length,
      contentBase64: PDF.content.toString('base64'),
    });
  });
});

describe('binaryOutput — format text_base64', () => {
  it('renvoie aussi les images en bloc text JSON', () => {
    const data = textJson(
      binaryOutput(PNG, { format: 'text_base64', target: TARGET, publicBaseUrl: '' }),
    );
    assert.equal(data.contentType, 'image/png');
    assert.equal(data.size, 4);
    assert.equal(Buffer.from(data.contentBase64 as string, 'base64').equals(PNG.content), true);
  });
});

describe('binaryOutput — format url', () => {
  it('renvoie un lien signé qui désigne la cible, sans le contenu', () => {
    const links = createDownloadLinkService({
      secret: 'secret-de-test-0123456789abcdef-0123',
      now: () => 0,
    });
    const data = textJson(
      binaryOutput(PDF, { format: 'url', target: TARGET, publicBaseUrl: BASE, links }),
    );

    assert.deepEqual(Object.keys(data).sort(), [
      'contentType',
      'expiresAt',
      'filename',
      'size',
      'url',
    ]);
    assert.equal(data.expiresAt, new Date(15 * 60_000).toISOString());
    assert.equal(data.size, PDF.content.length);
    const prefix = `${BASE}/download/`;
    assert.ok((data.url as string).startsWith(prefix));
    assert.deepEqual(links.redeem((data.url as string).slice(prefix.length)), {
      ok: true,
      target: TARGET,
    });
  });

  it('refuse clairement sans PUBLIC_BASE_URL', () => {
    const result = binaryOutput(PDF, { format: 'url', target: TARGET, publicBaseUrl: '' });
    assert.equal(result.isError, true);
    assert.deepEqual(result.content, [{ type: 'text', text: URL_FORMAT_UNAVAILABLE }]);
    assert.match(URL_FORMAT_UNAVAILABLE, /PUBLIC_BASE_URL/);
  });

  it('checkBinaryFormat ne refuse que url sans base', () => {
    assert.equal(checkBinaryFormat('auto', ''), undefined);
    assert.equal(checkBinaryFormat('text_base64', ''), undefined);
    assert.equal(checkBinaryFormat('url', BASE), undefined);
    assert.equal(checkBinaryFormat('url', '')?.isError, true);
  });
});
