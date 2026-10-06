import './helpers/env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDownloadLinkService } from '../src/download-links.js';
import { URL_FORMAT_UNAVAILABLE } from '../src/mcp/binary-output.js';
import { exportMessage, type ExportMessageOptions } from '../src/mcp/tools/export-message.js';

const BASE = 'https://mail.example.com';
const EML = Buffer.from('From: alice@example.com\r\nSubject: Bonjour\r\n\r\nCorps\r\n');

function options(overrides: Partial<ExportMessageOptions> = {}): ExportMessageOptions {
  return {
    format: 'auto',
    maxBytes: 1_000,
    publicBaseUrl: BASE,
    fetchMessageSource: async () => EML,
    ...overrides,
  };
}

function textJson(result: Awaited<ReturnType<typeof exportMessage>>): Record<string, unknown> {
  assert.equal(result.content.length, 1);
  const block = result.content[0]!;
  assert.equal(block.type, 'text');
  return JSON.parse((block as { text: string }).text) as Record<string, unknown>;
}

describe('exportMessage', () => {
  for (const format of ['auto', 'text_base64'] as const) {
    it(`${format} : bloc text JSON avec l’EML en base64`, async () => {
      const result = await exportMessage('INBOX', 42, options({ format }));
      assert.equal(result.isError, undefined);
      assert.deepEqual(textJson(result), {
        filename: 'message-42.eml',
        contentType: 'message/rfc822',
        size: EML.length,
        contentBase64: EML.toString('base64'),
      });
    });
  }

  it('url : lien signé de cible message, sans contenu', async () => {
    const links = createDownloadLinkService({ secret: 'x'.repeat(32) });
    const data = textJson(await exportMessage('Archive', 42, options({ format: 'url', links })));

    assert.equal(data.filename, 'message-42.eml');
    assert.equal(data.contentType, 'message/rfc822');
    assert.equal(data.size, EML.length);
    assert.equal(data.contentBase64, undefined);
    const url = data.url as string;
    assert.ok(url.startsWith(`${BASE}/download/`));
    assert.deepEqual(links.redeem(url.slice(`${BASE}/download/`.length)), {
      ok: true,
      target: { kind: 'message', folder: 'Archive', uid: 42 },
    });
  });

  it('url sans PUBLIC_BASE_URL : refus avant toute lecture IMAP', async () => {
    let fetched = false;
    const result = await exportMessage(
      'INBOX',
      42,
      options({
        format: 'url',
        publicBaseUrl: '',
        fetchMessageSource: async () => {
          fetched = true;
          return EML;
        },
      }),
    );
    assert.equal(result.isError, true);
    assert.equal((result.content[0] as { text: string }).text, URL_FORMAT_UNAVAILABLE);
    assert.equal(fetched, false);
  });

  it('refuse un message au-delà de ATTACHMENT_MAX_BYTES, sans tronquer', async () => {
    const result = await exportMessage('INBOX', 42, options({ maxBytes: EML.length - 1 }));
    assert.equal(result.isError, true);
    assert.match(
      (result.content[0] as { text: string }).text,
      new RegExp(`${EML.length} octets.*${EML.length - 1} octets.*ATTACHMENT_MAX_BYTES`),
    );
  });
});

describe('export links use metadata', () => {
  it('issues URL without reading the source and defers bytes to download', async () => {
    let read = false;
    const result = await exportMessage(
      'INBOX',
      42,
      options({
        format: 'url',
        fetchMessageMetadata: async () => ({ size: EML.length }),
        fetchMessageSource: async () => {
          read = true;
          throw new Error('must not download');
        },
      }),
    );
    assert.equal(read, false);
    assert.equal(textJson(result).size, EML.length);
  });
});
