import './helpers/env.js';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { connectClient, firstText } from './helpers/mcp-client.js';
import { createDownloadLinkService } from '../src/download-links.js';
import { createUploadStore } from '../src/uploads.js';
import { AttachmentSourceError, resolveAttachmentSources } from '../src/attachment-sources.js';
import type { NewMessageInput, SendOutcome } from '../src/smtp/send.js';
import type { DraftInput } from '../src/imap/drafts.js';

/**
 * `create_upload_link` et la source `attachments[].uploadId` de
 * `compose_message`. L'envoi SMTP et l'écriture IMAP sont simulés : aucun mail
 * ne part, aucune connexion n'est ouverte.
 */

const BASE = 'https://mail.example.com';
const SECRET = 'secret-de-test-0123456789abcdef-0123456789';

const clients: Client[] = [];
after(async () => {
  await Promise.all(clients.map((client) => client.close()));
});

function setup(options: { publicBaseUrl?: string; failSend?: boolean } = {}) {
  const links = createDownloadLinkService({ secret: SECRET });
  const store = createUploadStore({ maxFiles: 10, maxTotalBytes: 1_000_000 });
  const sent: NewMessageInput[] = [];
  const drafts: DraftInput[] = [];
  const deps = {
    uploadLink: { publicBaseUrl: options.publicBaseUrl ?? BASE, links, maxBytes: 5000 },
    compose: {
      uploads: store,
      sendNewMessage: async (input: NewMessageInput): Promise<SendOutcome> => {
        if (options.failSend) throw new Error('SMTP indisponible (simulé)');
        sent.push(input);
        return { sent: true, messageId: '<x@test>', accepted: input.to, rejected: [] };
      },
      saveDraft: async (input: DraftInput) => {
        drafts.push(input);
        return { folder: 'Drafts', uid: 9 };
      },
    },
  };
  const open = async () => {
    const client = await connectClient(deps);
    clients.push(client);
    return client;
  };
  return { links, store, sent, drafts, open };
}

const NEW_MAIL = {
  deliver: 'send',
  to: ['alice@example.com'],
  subject: 'Rapport',
  text: 'Ci-joint.',
};

async function confirmedCall(
  client: Client,
  request: { name: string; arguments: Record<string, unknown> },
) {
  const first = await client.callTool(request);
  const token = (first.structuredContent as Record<string, unknown> | undefined)?.confirmToken;
  if (typeof token !== 'string') return first;
  return client.callTool({ ...request, arguments: { ...request.arguments, confirmToken: token } });
}

describe('create_upload_link', () => {
  it('renvoie un lien de dépôt signé pour la cible upload', async () => {
    const { links, open } = setup();
    const client = await open();
    const result = await client.callTool({
      name: 'create_upload_link',
      arguments: { filename: 'C:\\docs\\rapport.pdf', contentType: 'application/PDF' },
    });
    assert.equal(result.isError, undefined);
    const data = result.structuredContent as Record<string, unknown>;
    assert.equal(data.method, 'POST');
    assert.equal(data.maxBytes, 5000);
    assert.match(String(data.expiresAt), /^\d{4}-\d\d-\d\dT/);
    const prefix = `${BASE}/upload/`;
    assert.ok(String(data.uploadUrl).startsWith(prefix));
    const redeemed = links.redeem(String(data.uploadUrl).slice(prefix.length), ['upload']);
    assert.deepEqual(redeemed, {
      ok: true,
      target: {
        kind: 'upload',
        uploadId: data.uploadId,
        filename: 'rapport.pdf',
        contentType: 'application/pdf',
      },
    });
  });

  it('exige PUBLIC_BASE_URL', async () => {
    const client = await setup({ publicBaseUrl: '' }).open();
    const result = await client.callTool({ name: 'create_upload_link', arguments: {} });
    assert.equal(result.isError, true);
    assert.match(firstText(result), /PUBLIC_BASE_URL/);
  });

  it('refuse un contentType invalide', async () => {
    const client = await setup().open();
    const result = await client.callTool({
      name: 'create_upload_link',
      arguments: { contentType: 'pas un type' },
    });
    assert.equal(result.isError, true);
    assert.match(firstText(result), /contentType/);
  });
});

describe('compose_message : source uploadId', () => {
  it('first send request performs no write; confirmation binds attachment bytes', async () => {
    const { store, sent, drafts, open } = setup();
    store.put({ uploadId: 'u1', filename: 'a.txt', content: Buffer.from('first') });
    const client = await open();
    const input = { ...NEW_MAIL, attachments: [{ uploadId: 'u1' }] };
    const first = await client.callTool({ name: 'compose_message', arguments: input });
    assert.equal(sent.length, 0);
    assert.equal(drafts.length, 0);
    assert.ok(store.get('u1'));
    const token = (first.structuredContent as Record<string, unknown>).confirmToken;
    assert.equal(typeof token, 'string');
    store.delete('u1');
    store.put({ uploadId: 'u1', filename: 'a.txt', content: Buffer.from('changed') });
    const second = await client.callTool({
      name: 'compose_message',
      arguments: { ...input, confirmToken: token },
    });
    assert.equal(second.isError, true);
    assert.equal(sent.length, 0);
    assert.ok(store.get('u1'));
  });

  it('omitting deliver stores a draft', async () => {
    const { sent, drafts, open } = setup();
    const client = await open();
    const input = { to: NEW_MAIL.to, subject: NEW_MAIL.subject, text: NEW_MAIL.text };
    const result = await client.callTool({ name: 'compose_message', arguments: input });
    assert.equal(result.isError, undefined);
    assert.equal(sent.length, 0);
    assert.equal(drafts.length, 1);
  });

  it('attache le dépôt et le consomme après l’envoi', async () => {
    const { store, sent, open } = setup();
    store.put({
      uploadId: 'u1',
      filename: 'rapport.pdf',
      contentType: 'application/pdf',
      content: Buffer.from('%PDF'),
    });
    const client = await open();
    const result = await confirmedCall(client, {
      name: 'compose_message',
      arguments: { ...NEW_MAIL, attachments: [{ uploadId: 'u1' }] },
    });
    assert.equal(result.isError, undefined, firstText(result));
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]?.attachments, [
      { filename: 'rapport.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF') },
    ]);
    assert.equal(store.get('u1'), undefined);
  });

  it('applique les surcharges filename / contentType', async () => {
    const { store, sent, open } = setup();
    store.put({ uploadId: 'u1', filename: 'a.bin', content: Buffer.from('x') });
    const client = await open();
    await confirmedCall(client, {
      name: 'compose_message',
      arguments: {
        ...NEW_MAIL,
        attachments: [{ uploadId: 'u1', filename: 'b.txt', contentType: 'text/plain' }],
      },
    });
    assert.equal(sent[0]?.attachments?.[0]?.filename, 'b.txt');
    assert.equal(sent[0]?.attachments?.[0]?.contentType, 'text/plain');
  });

  it('consomme aussi après l’enregistrement d’un brouillon', async () => {
    const { store, drafts, open } = setup();
    store.put({ uploadId: 'u1', filename: 'a.txt', content: Buffer.from('x') });
    const client = await open();
    const result = await confirmedCall(client, {
      name: 'compose_message',
      arguments: { ...NEW_MAIL, deliver: 'draft', attachments: [{ uploadId: 'u1' }] },
    });
    assert.equal(result.isError, undefined, firstText(result));
    assert.equal(drafts[0]?.attachments?.[0]?.filename, 'a.txt');
    assert.equal(store.get('u1'), undefined);
  });

  it('garde le dépôt si l’envoi échoue', async () => {
    const { store, open } = setup({ failSend: true });
    store.put({ uploadId: 'u1', filename: 'a.txt', content: Buffer.from('x') });
    const client = await open();
    const result = await confirmedCall(client, {
      name: 'compose_message',
      arguments: { ...NEW_MAIL, attachments: [{ uploadId: 'u1' }] },
    });
    assert.equal(result.isError, true);
    assert.ok(store.get('u1'));
  });

  it('nomme l’élément fautif pour un dépôt inconnu, sans rien envoyer', async () => {
    const { store, sent, open } = setup();
    store.put({ uploadId: 'u1', filename: 'a.txt', content: Buffer.from('x') });
    const client = await open();
    const result = await confirmedCall(client, {
      name: 'compose_message',
      arguments: { ...NEW_MAIL, attachments: [{ uploadId: 'u1' }, { uploadId: 'absent' }] },
    });
    assert.equal(result.isError, true);
    assert.match(firstText(result), /attachments\[1\] \(uploadId\).*inconnu, expiré/);
    assert.equal(sent.length, 0);
    assert.ok(store.get('u1'), 'un échec ne consomme aucun dépôt');
  });

  it('refuse deux sources sur un même élément', async () => {
    const client = await setup().open();
    const result = await confirmedCall(client, {
      name: 'compose_message',
      arguments: { ...NEW_MAIL, attachments: [{ uploadId: 'u1', url: 'https://x.example/a' }] },
    });
    assert.equal(result.isError, true);
    assert.match(firstText(result), /exactement une source/);
  });
});

describe('resolveAttachmentSources : uploadId', () => {
  const store = createUploadStore({ maxFiles: 5, maxTotalBytes: 1000 });
  store.put({ uploadId: 'big', filename: 'big.bin', content: Buffer.alloc(100) });
  store.put({ uploadId: 'anon', content: Buffer.from('x') });

  it('exige filename quand le dépôt n’en a pas', async () => {
    await assert.rejects(
      resolveAttachmentSources([{ uploadId: 'anon' }], { maxBytes: 1000, uploads: store }),
      (err: Error) => err instanceof AttachmentSourceError && /fournir filename/.test(err.message),
    );
    const [resolved] = await resolveAttachmentSources([{ uploadId: 'anon', filename: 'x.txt' }], {
      maxBytes: 1000,
      uploads: store,
    });
    assert.equal(resolved?.contentType, 'application/octet-stream');
  });

  it('compte le dépôt dans le cumul ATTACHMENT_MAX_BYTES', async () => {
    await assert.rejects(
      resolveAttachmentSources(
        [
          { contentBase64: Buffer.alloc(60).toString('base64'), filename: 'a' },
          { uploadId: 'big' },
        ],
        { maxBytes: 150, uploads: store },
      ),
      /attachments\[1\] \(uploadId\).*ATTACHMENT_MAX_BYTES/,
    );
  });
});
