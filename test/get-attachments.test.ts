import './helpers/env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ImapFlow } from 'imapflow';
import { getMessageAttachments, type AttachmentContent } from '../src/imap/messages.js';
import { ImapAuthError, ImapNetworkError } from '../src/imap/errors.js';
import { createDownloadLinkService } from '../src/download-links.js';
import {
  attachmentsBatchResult,
  collectAttachments,
  type AttachmentRequest,
  type AttachmentsBatchOptions,
} from '../src/mcp/tools/get-attachments.js';
import { FakeMail, authError, networkError } from './helpers/fake-imap.js';

const BASE = 'https://mail.example.com';
const SECRET = 'x'.repeat(32);

function attachment(
  index: number,
  filename: string,
  contentType: string,
  content: Buffer,
): AttachmentContent {
  return { index, filename, contentType, size: content.length, content };
}

const PDF = Buffer.from('%PDF-1.7 facture');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const TXT = Buffer.from('bonjour');

/** Boîte factice : INBOX/12 a un PDF et un PNG, INBOX/13 un texte. Compte les téléchargements. */
function store() {
  const messages = new Map<string, AttachmentContent[]>([
    [
      'INBOX/12',
      [
        attachment(0, 'facture.pdf', 'application/pdf', PDF),
        attachment(1, 'photo.png', 'image/png', PNG),
      ],
    ],
    ['INBOX/13', [attachment(0, 'notes.txt', 'text/plain', TXT)]],
  ]);
  const calls: string[] = [];
  const fetchMessageAttachments = async (folder: string, uid: number) => {
    calls.push(`${folder}/${uid}`);
    const found = messages.get(`${folder}/${uid}`);
    if (!found) throw new Error(`Message UID ${uid} introuvable dans "${folder}"`);
    return found;
  };
  return { calls, fetchMessageAttachments };
}

function options(overrides: Partial<AttachmentsBatchOptions> = {}): AttachmentsBatchOptions {
  return {
    format: 'auto',
    maxBytes: 1_000,
    inlineMaxBytes: 1_000,
    publicBaseUrl: BASE,
    ...overrides,
  };
}

const item = (uid: number, index: number, folder = 'INBOX'): AttachmentRequest => ({
  folder,
  uid,
  index,
});

describe('collectAttachments — résultats partiels', () => {
  it('reporte une erreur par élément sans faire échouer le lot', async () => {
    const { fetchMessageAttachments } = store();
    const batch = await collectAttachments(
      [item(12, 0), item(99, 0), item(12, 7), item(13, 0)],
      options({ format: 'text_base64', fetchMessageAttachments }),
    );

    assert.deepEqual(
      batch.items.map((r) => [r.uid, r.index, r.ok]),
      [
        [12, 0, true],
        [99, 0, false],
        [12, 7, false],
        [13, 0, true],
      ],
    );
    const [, unknownMessage, unknownIndex] = batch.items;
    assert.ok(!unknownMessage!.ok && /UID 99 introuvable/.test(unknownMessage!.error));
    assert.ok(
      !unknownIndex!.ok && /#7 introuvable.*2 pièce\(s\) jointe\(s\)/.test(unknownIndex!.error),
    );
  });

  it('refuse un élément au-delà de ATTACHMENT_MAX_BYTES, en gardant les autres', async () => {
    const { fetchMessageAttachments } = store();
    const batch = await collectAttachments(
      [item(12, 0), item(13, 0)],
      options({ maxBytes: TXT.length, fetchMessageAttachments }),
    );

    const [pdf, txt] = batch.items;
    assert.ok(!pdf!.ok);
    assert.match(pdf!.error, new RegExp(`${PDF.length} octets.*${TXT.length} octets`));
    assert.equal(txt!.ok, true);
  });

  it('propage une erreur d’authentification IMAP', async () => {
    await assert.rejects(
      () =>
        collectAttachments(
          [item(12, 0)],
          options({
            fetchMessageAttachments: async () => {
              throw authError();
            },
          }),
        ),
      ImapAuthError,
    );
  });

  it('propage une erreur réseau IMAP', async () => {
    await assert.rejects(
      () =>
        collectAttachments(
          [item(12, 0)],
          options({
            fetchMessageAttachments: async () => {
              throw networkError();
            },
          }),
        ),
      ImapNetworkError,
    );
  });
});

describe('collectAttachments — regroupement par message', () => {
  it('ne télécharge chaque message qu’une fois, quel que soit le nombre d’index', async () => {
    const { calls, fetchMessageAttachments } = store();
    const batch = await collectAttachments(
      [item(12, 0), item(13, 0), item(12, 1), item(12, 0), item(12, 5)],
      options({ format: 'text_base64', fetchMessageAttachments }),
    );

    assert.deepEqual(calls, ['INBOX/12', 'INBOX/13']);
    assert.equal(batch.items.length, 5);
  });

  it('distingue le même UID dans deux dossiers', async () => {
    const { calls, fetchMessageAttachments } = store();
    await collectAttachments(
      [item(12, 0), item(12, 0, 'Archive')],
      options({ fetchMessageAttachments }),
    );
    assert.deepEqual(calls, ['INBOX/12', 'Archive/12']);
  });

  it('getMessageAttachments lit les parties sans télécharger la source complète', async () => {
    const source = Buffer.from(
      [
        'From: alice@example.com',
        'To: bob@example.com',
        'Subject: Deux pièces',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="b"',
        '',
        '--b',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Corps',
        '--b',
        'Content-Type: application/pdf; name="facture.pdf"',
        'Content-Disposition: attachment; filename="facture.pdf"',
        'Content-Transfer-Encoding: base64',
        '',
        PDF.toString('base64'),
        '--b',
        'Content-Type: text/plain; name="notes.txt"',
        'Content-Disposition: attachment; filename="notes.txt"',
        '',
        'bonjour',
        '--b--',
        '',
      ].join('\r\n'),
    );
    const mail = new FakeMail().addMailbox('INBOX');
    mail.addMessage('INBOX', {
      uid: 12,
      source,
      bodyStructure: {
        type: 'multipart/mixed',
        childNodes: [
          { part: '1', type: 'text/plain' },
          {
            part: '2',
            type: 'application/pdf',
            disposition: 'attachment',
            dispositionParameters: { filename: 'facture.pdf' },
          },
          {
            part: '3',
            type: 'text/plain',
            disposition: 'attachment',
            dispositionParameters: { filename: 'notes.txt' },
          },
        ],
      },
      parts: { '2': PDF, '3': Buffer.from('bonjour') },
    });
    let fetches = 0;
    const fetchOne = mail.fetchOne.bind(mail);
    mail.fetchOne = (...args: Parameters<typeof fetchOne>) => {
      fetches += 1;
      return fetchOne(...args);
    };
    const withMailboxOn = async <T>(folder: string, fn: (client: ImapFlow) => Promise<T>) => {
      await mail.getMailboxLock(folder);
      return fn(mail.asImapFlow());
    };

    const batch = await collectAttachments([item(12, 1), item(12, 0)], {
      ...options({ format: 'text_base64' }),
      fetchMessageAttachments: (folder, uid) => getMessageAttachments(folder, uid, withMailboxOn),
    });

    assert.equal(fetches, 3);
    assert.deepEqual(
      mail.downloads.map((d) => d.part),
      ['2', '3'],
    );
    const [notes, facture] = batch.items;
    assert.ok(notes!.ok && 'contentBase64' in notes!);
    assert.equal(notes.filename, 'notes.txt');
    assert.equal(Buffer.from(notes.contentBase64, 'base64').toString(), 'bonjour');
    assert.ok(facture!.ok && 'contentBase64' in facture!);
    assert.deepEqual(Buffer.from(facture.contentBase64, 'base64'), PDF);
  });
});

describe('collectAttachments — limite cumulée inline', () => {
  it('refuse les éléments qui dépasseraient le budget, sans bloquer les suivants plus petits', async () => {
    const { fetchMessageAttachments } = store();
    const batch = await collectAttachments(
      [item(12, 0), item(12, 0), item(13, 0)],
      options({
        format: 'text_base64',
        inlineMaxBytes: PDF.length + TXT.length,
        fetchMessageAttachments,
      }),
    );

    assert.deepEqual(
      batch.items.map((r) => r.ok),
      [true, false, true],
    );
    const refused = batch.items[1]!;
    assert.ok(!refused.ok);
    assert.match(refused.error, /Limite cumulée/);
    assert.match(refused.error, /format "url"/);
  });

  it('ne s’applique pas au format url', async () => {
    const { fetchMessageAttachments } = store();
    const batch = await collectAttachments(
      [item(12, 0), item(12, 0), item(13, 0)],
      options({
        format: 'url',
        inlineMaxBytes: 1,
        links: createDownloadLinkService({ secret: SECRET }),
        fetchMessageAttachments,
      }),
    );
    assert.ok(batch.items.every((r) => r.ok));
  });
});

describe('collectAttachments — formats', () => {
  it('auto : JSON pour le PDF, bloc image après le récapitulatif pour le PNG', async () => {
    const { fetchMessageAttachments } = store();
    const batch = await collectAttachments(
      [item(12, 1), item(12, 0)],
      options({ fetchMessageAttachments }),
    );
    const result = attachmentsBatchResult(batch);

    assert.deepEqual(
      result.content.map((block) => block.type),
      ['text', 'text', 'image'],
    );
    const summary = JSON.parse((result.content[0] as { text: string }).text);
    assert.equal(summary.succeeded, 2);
    assert.equal(summary.failed, 0);
    assert.deepEqual(summary.items[0], {
      folder: 'INBOX',
      uid: 12,
      index: 1,
      ok: true,
      filename: 'photo.png',
      contentType: 'image/png',
      size: PNG.length,
      imageBlock: true,
    });
    assert.deepEqual(summary.items[1], {
      folder: 'INBOX',
      uid: 12,
      index: 0,
      ok: true,
      filename: 'facture.pdf',
      contentType: 'application/pdf',
      size: PDF.length,
      contentBase64: PDF.toString('base64'),
    });
    assert.match((result.content[1] as { text: string }).text, /^items\[0\] : photo\.png/);
    assert.deepEqual(result.content[2], {
      type: 'image',
      data: PNG.toString('base64'),
      mimeType: 'image/png',
    });
    assert.ok(!JSON.stringify(summary).includes('mimeType'));
  });

  it('text_base64 : images comprises dans le JSON, aucun bloc image', async () => {
    const { fetchMessageAttachments } = store();
    const result = attachmentsBatchResult(
      await collectAttachments(
        [item(12, 1)],
        options({ format: 'text_base64', fetchMessageAttachments }),
      ),
    );

    assert.equal(result.content.length, 1);
    const summary = JSON.parse((result.content[0] as { text: string }).text);
    assert.equal(summary.items[0].contentBase64, PNG.toString('base64'));
    assert.equal(summary.items[0].contentType, 'image/png');
  });

  it('url : un lien signé par élément, de cible attachment', async () => {
    const links = createDownloadLinkService({ secret: SECRET });
    const { fetchMessageAttachments } = store();
    const batch = await collectAttachments(
      [item(12, 1), item(13, 0)],
      options({ format: 'url', links, fetchMessageAttachments }),
    );

    for (const [position, expected] of [
      [0, { uid: 12, index: 1 }],
      [1, { uid: 13, index: 0 }],
    ] as const) {
      const result = batch.items[position]!;
      assert.ok(result.ok && 'url' in result);
      assert.ok(!('contentBase64' in result));
      assert.ok(result.url.startsWith(`${BASE}/download/`));
      const redeemed = links.redeem(result.url.slice(`${BASE}/download/`.length));
      assert.deepEqual(redeemed, {
        ok: true,
        target: { kind: 'attachment', folder: 'INBOX', ...expected },
      });
    }
    assert.equal(batch.images.length, 0);
  });
});

describe('collectAttachments — téléchargements en parallèle', () => {
  it('borne les téléchargements simultanés, dédoublonne les parties et garde l’ordre', async () => {
    let running = 0;
    let peak = 0;
    const calls: string[] = [];
    const fetchAttachmentPart = async (folder: string, uid: number, part: string) => {
      calls.push(`${uid}/${part}`);
      running += 1;
      peak = Math.max(peak, running);
      // Les uid pairs finissent avant les impairs : l'ordre d'achèvement diffère.
      await new Promise((resolve) => setTimeout(resolve, uid % 2 === 0 ? 1 : 15));
      running -= 1;
      if (uid === 404) throw new Error(`Partie ${part} introuvable`);
      const content = Buffer.from(`uid ${uid} part ${part}`);
      return {
        part,
        filename: `f-${uid}.pdf`,
        contentType: 'application/pdf',
        size: content.length,
        content,
      };
    };
    const requests: AttachmentRequest[] = [
      ...[1, 2, 3, 4, 5, 6].map((uid) => ({ folder: 'INBOX', uid, part: '2' })),
      { folder: 'INBOX', uid: 1, part: '2' },
      { folder: 'INBOX', uid: 404, part: '2' },
    ];

    const batch = await collectAttachments(
      requests,
      options({ format: 'text_base64', fetchAttachmentPart, concurrency: 2 }),
    );

    assert.equal(peak, 1, 'traitement progressif sans télécharger les futurs éléments');
    assert.equal(calls.length, 7, 'la partie demandée deux fois n’est téléchargée qu’une fois');
    assert.deepEqual(
      batch.items.map((r) => [r.uid, r.ok]),
      [
        [1, true],
        [2, true],
        [3, true],
        [4, true],
        [5, true],
        [6, true],
        [1, true],
        [404, false],
      ],
    );
    const last = batch.items.at(-1)!;
    assert.ok(!last.ok && /introuvable/.test(last.error));
  });
});

describe('batch memory budget', () => {
  it('does not download future items after the inline budget is consumed', async () => {
    let downloads = 0;
    const batch = await collectAttachments(
      Array.from({ length: 25 }, (_, i) => ({ folder: 'INBOX', uid: i + 1, part: '2' })),
      options({
        maxBytes: 10,
        inlineMaxBytes: 10,
        fetchAttachmentPart: async () => {
          downloads++;
          return { part: '2', contentType: 'application/pdf', size: 10, content: Buffer.alloc(10) };
        },
      }),
    );
    assert.equal(downloads, 1);
    assert.equal(batch.items.filter((item) => item.ok).length, 1);
    assert.equal(batch.items.length, 25);
  });
});
