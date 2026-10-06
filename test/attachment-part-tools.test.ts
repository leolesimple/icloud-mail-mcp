import './helpers/env.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { connectClient, firstText } from './helpers/mcp-client.js';
import { createDownloadLinkService } from '../src/download-links.js';
import { collectAttachments } from '../src/mcp/tools/get-attachments.js';
import { AttachmentTooLargeError } from '../src/attachments.js';
import type { AttachmentPartContent } from '../src/imap/messages.js';

const PDF = Buffer.from('%PDF-1.4 facture');
const BASE = 'https://mail.example.com';

describe('get_attachment / get_attachments : index ou part', () => {
  let client: Client;
  before(async () => {
    client = await connectClient();
  });
  after(() => client.close());

  it('expose index et part, tous deux facultatifs', async () => {
    const { tools } = await client.listTools();
    const single = tools.find((t) => t.name === 'get_attachment')!;
    assert.ok(single.inputSchema.properties?.index);
    assert.ok(single.inputSchema.properties?.part);
    assert.deepEqual(single.inputSchema.required, ['uid']);
  });

  // Ces appels sont refusés à la validation : aucune connexion IMAP n'est ouverte.
  for (const [label, args] of [
    ['ni index ni part', { uid: 1 }],
    ['index et part', { uid: 1, index: 0, part: '2' }],
  ] as const) {
    it(`get_attachment refuse ${label}`, async () => {
      const result = await client.callTool({ name: 'get_attachment', arguments: args });
      assert.equal(result.isError, true);
      assert.match(firstText(result), /exactement un de index .* ou part/);
    });
  }

  it('get_attachment refuse une partie mal formée', async () => {
    const result = await client.callTool({
      name: 'get_attachment',
      arguments: { uid: 1, part: '2.TEXT' },
    });
    assert.equal(result.isError, true);
    assert.match(firstText(result), /numéro de partie IMAP/);
  });

  it('get_attachments refuse un élément sans index ni part', async () => {
    const result = await client.callTool({
      name: 'get_attachments',
      arguments: { items: [{ uid: 1, part: '2' }, { uid: 1 }] },
    });
    assert.equal(result.isError, true);
    assert.match(firstText(result), /exactement un de index/);
  });
});

describe('collectAttachments par part', () => {
  function parts() {
    const calls: string[] = [];
    const fetchAttachmentPart = async (
      folder: string,
      uid: number,
      part: string,
      maxBytes: number,
    ): Promise<AttachmentPartContent> => {
      calls.push(`${folder}/${uid}/${part}/${maxBytes}`);
      if (part === '9') throw new Error(`Partie 9 introuvable dans le message UID ${uid}`);
      if (part === '3') throw new AttachmentTooLargeError('Pièce jointe (partie 3) trop grosse');
      return {
        part,
        filename: 'Facture.pdf',
        contentType: 'application/pdf',
        size: PDF.length,
        content: PDF,
      };
    };
    const fetchMessageAttachments = async () => {
      calls.push('message entier');
      return [];
    };
    return { calls, fetchAttachmentPart, fetchMessageAttachments };
  }

  it('ne télécharge que les parties demandées et reporte les échecs par élément', async () => {
    const { calls, ...fetchers } = parts();
    const batch = await collectAttachments(
      [
        { folder: 'Apple', uid: 371, part: '2' },
        { folder: 'Apple', uid: 371, part: '9' },
        { folder: 'Apple', uid: 371, part: '3' },
      ],
      {
        format: 'text_base64',
        maxBytes: 1_000,
        inlineMaxBytes: 1_000,
        publicBaseUrl: BASE,
        ...fetchers,
      },
    );
    assert.deepEqual(calls, ['Apple/371/2/1000', 'Apple/371/9/1000', 'Apple/371/3/1000']);
    assert.deepEqual(
      batch.items.map((item) => [item.part, item.index, item.ok]),
      [
        ['2', undefined, true],
        ['9', undefined, false],
        ['3', undefined, false],
      ],
    );
    const [ok, missing, big] = batch.items;
    assert.equal(ok?.ok && 'contentBase64' in ok ? ok.contentBase64 : '', PDF.toString('base64'));
    assert.match(!missing?.ok ? missing!.error : '', /Partie 9 introuvable/);
    assert.match(!big?.ok ? big!.error : '', /partie 3/);
  });

  it('émet un lien signé qui désigne la partie', async () => {
    const links = createDownloadLinkService({ secret: 'x'.repeat(32) });
    const { fetchAttachmentPart, fetchMessageAttachments } = parts();
    const batch = await collectAttachments([{ folder: 'Apple', uid: 371, part: '2' }], {
      format: 'url',
      maxBytes: 1_000,
      inlineMaxBytes: 1_000,
      publicBaseUrl: BASE,
      links,
      fetchAttachmentPart,
      fetchMessageAttachments,
    });
    const item = batch.items[0]!;
    assert.ok(item.ok && 'url' in item);
    const token = item.url.split('/download/')[1]!;
    assert.deepEqual(links.redeem(token), {
      ok: true,
      target: { kind: 'attachment', folder: 'Apple', uid: 371, part: '2' },
    });
  });
});
