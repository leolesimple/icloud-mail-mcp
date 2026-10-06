import './helpers/env.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ImapFlow } from 'imapflow';
import {
  AttachmentSourceError,
  attachmentSourceProblem,
  filenameFromContentDisposition,
  filenameFromUrlPath,
  resolveAttachmentSources,
} from '../src/attachment-sources.js';
import type { AttachmentSourceDeps } from '../src/attachment-sources.js';
import { AttachmentTooLargeError } from '../src/attachments.js';
import type { AttachmentContent } from '../src/imap/messages.js';
import { getAttachmentPart } from '../src/imap/messages.js';
import type { PinnedRequest, PinnedResponse } from '../src/ssrf.js';
import { attachmentInput } from '../src/mcp/tools/inputs.js';
import { connectClient, firstText } from './helpers/mcp-client.js';
import { FakeMail } from './helpers/fake-imap.js';

/**
 * Sources de pièces jointes de compose_message. IMAP et réseau sont remplacés
 * par des doublures : aucun message n'est lu, envoyé ni écrit.
 */

const LIMIT = 1000;

const INVOICE: AttachmentContent = {
  index: 0,
  filename: 'facture.pdf',
  contentType: 'application/pdf',
  size: 300,
  content: Buffer.alloc(300, 1),
};
const PHOTO: AttachmentContent = {
  index: 1,
  filename: 'photo.jpg',
  contentType: 'image/jpeg',
  size: 200,
  content: Buffer.alloc(200, 2),
};

/** Boîte factice : INBOX/42 porte deux pièces jointes. */
function fakeMailbox() {
  const fetches: string[] = [];
  return {
    fetches,
    fetchMessageAttachments: async (folder: string, uid: number) => {
      fetches.push(`${folder}/${uid}`);
      if (folder === 'INBOX' && uid === 42) return [INVOICE, PHOTO];
      throw new Error(`Message UID ${uid} introuvable dans "${folder}"`);
    },
  };
}

async function* body(...parts: Buffer[]): AsyncIterable<Buffer> {
  for (const part of parts) yield part;
}

/** Réseau factice : tout nom résout vers une IP publique. */
function fakeWeb(handler: (req: PinnedRequest) => Partial<PinnedResponse>) {
  const requests: PinnedRequest[] = [];
  return {
    requests,
    fetch: {
      resolveHost: async () => [{ address: '93.184.216.34', family: 4 as const }],
      request: async (req: PinnedRequest) => {
        requests.push(req);
        return { status: 200, headers: {}, body: body(), close() {}, ...handler(req) };
      },
    },
  };
}

function deps(overrides: Partial<AttachmentSourceDeps> = {}): AttachmentSourceDeps {
  return {
    maxBytes: LIMIT,
    fetchMessageAttachments: fakeMailbox().fetchMessageAttachments,
    fetch: fakeWeb(() => ({})).fetch,
    ...overrides,
  };
}

function rejectsWith(promise: Promise<unknown>, type: new (m: string) => Error, pattern: RegExp) {
  return assert.rejects(promise, (err: Error) => {
    assert.ok(err instanceof type, `${err.name} : ${err.message}`);
    assert.match(err.message, pattern);
    return true;
  });
}

describe('exclusivité des sources', () => {
  it('accepte exactement une source', () => {
    assert.equal(attachmentSourceProblem({ filename: 'a', contentBase64: 'QQ==' }), undefined);
    assert.equal(attachmentSourceProblem({ fromMessage: { uid: 1, index: 0 } }), undefined);
    assert.equal(attachmentSourceProblem({ url: 'https://a.example/x' }), undefined);
  });

  it('refuse aucune source, ou plusieurs', () => {
    assert.match(attachmentSourceProblem({ filename: 'a' }) ?? '', /reçu : aucune/);
    assert.match(
      attachmentSourceProblem({ contentBase64: 'QQ==', url: 'https://a.example/x' }) ?? '',
      /reçu : contentBase64, url/,
    );
    assert.match(
      attachmentSourceProblem({ fromMessage: { uid: 1, index: 0 }, url: 'https://x.example' }) ??
        '',
      /exactement une source/,
    );
  });

  it('exige filename avec contentBase64', () => {
    assert.match(attachmentSourceProblem({ contentBase64: 'QQ==' }) ?? '', /filename/);
  });

  it('le schéma zod applique les mêmes règles', () => {
    assert.equal(attachmentInput.safeParse({ filename: 'a', contentBase64: 'QQ==' }).success, true);
    assert.equal(attachmentInput.safeParse({ fromMessage: { uid: '7', index: 0 } }).success, true);
    assert.equal(attachmentInput.safeParse({ filename: 'a' }).success, false);
    assert.equal(
      attachmentInput.safeParse({ contentBase64: 'QQ==', fromMessage: { uid: 7, index: 0 } })
        .success,
      false,
    );
    const parsed = attachmentInput.parse({ fromMessage: { uid: 7, index: 1 } });
    assert.deepEqual(parsed.fromMessage, { folder: 'INBOX', uid: 7, index: 1 });
  });

  it('le resolver refuse aussi un élément sans source, en le nommant', async () => {
    await rejectsWith(
      resolveAttachmentSources(
        [{ filename: 'a', contentBase64: 'QQ==' }, { filename: 'b' }],
        deps(),
      ),
      AttachmentSourceError,
      /attachments\[1\].*exactement une source/,
    );
  });
});

describe('source contentBase64', () => {
  it('décode le contenu, inchangé par rapport à avant', async () => {
    const [att] = await resolveAttachmentSources(
      [
        {
          filename: 'note.txt',
          contentType: 'text/plain',
          contentBase64: Buffer.from('bonjour').toString('base64'),
        },
      ],
      deps(),
    );
    assert.equal(att?.filename, 'note.txt');
    assert.equal(att?.contentType, 'text/plain');
    assert.equal(att?.content.toString(), 'bonjour');
  });

  it('renvoie une liste vide sans pièce jointe', async () => {
    assert.deepEqual(await resolveAttachmentSources(undefined, deps()), []);
    assert.deepEqual(await resolveAttachmentSources([], deps()), []);
  });
});

describe('source fromMessage', () => {
  it('reprend contenu, nom et type de l’original', async () => {
    const [att] = await resolveAttachmentSources(
      [{ fromMessage: { folder: 'INBOX', uid: 42, index: 0 } }],
      deps(),
    );
    assert.equal(att?.filename, 'facture.pdf');
    assert.equal(att?.contentType, 'application/pdf');
    assert.equal(att?.content, INVOICE.content);
  });

  it('dossier INBOX par défaut ; filename et contentType surchargeables', async () => {
    const [att] = await resolveAttachmentSources(
      [
        {
          filename: 'Facture-octobre.pdf',
          contentType: 'application/octet-stream',
          fromMessage: { uid: 42, index: 0 },
        },
      ],
      deps(),
    );
    assert.equal(att?.filename, 'Facture-octobre.pdf');
    assert.equal(att?.contentType, 'application/octet-stream');
  });

  it('ne télécharge qu’une fois un message cité plusieurs fois', async () => {
    const mailbox = fakeMailbox();
    const result = await resolveAttachmentSources(
      [{ fromMessage: { uid: 42, index: 0 } }, { fromMessage: { uid: 42, index: 1 } }],
      deps({ fetchMessageAttachments: mailbox.fetchMessageAttachments }),
    );
    assert.deepEqual(
      result.map((att) => att.filename),
      ['facture.pdf', 'photo.jpg'],
    );
    assert.deepEqual(mailbox.fetches, ['INBOX/42']);
  });

  it('message introuvable : erreur claire qui nomme l’élément', async () => {
    await rejectsWith(
      resolveAttachmentSources(
        [
          { filename: 'a', contentBase64: 'QQ==' },
          { fromMessage: { folder: 'Archive', uid: 9, index: 0 } },
        ],
        deps(),
      ),
      AttachmentSourceError,
      /attachments\[1\] \(fromMessage\).*UID 9 dans "Archive".*introuvable/,
    );
  });

  it('index introuvable : erreur qui donne le nombre de pièces jointes', async () => {
    await rejectsWith(
      resolveAttachmentSources([{ fromMessage: { uid: 42, index: 5 } }], deps()),
      AttachmentSourceError,
      /attachments\[0\].*#5 introuvable.*2 pièce\(s\) jointe\(s\)/,
    );
  });
});

describe('source fromMessage par numéro de partie', () => {
  /** Apple/371 : un PDF en partie 2 (BODYSTRUCTURE annonçant 400 octets base64). */
  function partMailbox(pdf = Buffer.alloc(250, 3)) {
    const mail = new FakeMail().addMailbox('Apple');
    mail.addMessage('Apple', {
      uid: 371,
      bodyStructure: {
        type: 'multipart/mixed',
        childNodes: [
          { part: '1', type: 'text/plain' },
          {
            part: '2',
            type: 'application/pdf',
            disposition: 'attachment',
            dispositionParameters: { filename: 'Facture.pdf' },
            encoding: 'base64',
            size: 340,
          },
        ],
      },
      parts: { '1': Buffer.from('Merci'), '2': pdf },
    });
    const withMailboxOn = async <T>(folder: string, fn: (client: ImapFlow) => Promise<T>) => {
      await mail.getMailboxLock(folder);
      return fn(mail.asImapFlow());
    };
    const fetchAttachmentPart = (folder: string, uid: number, part: string, maxBytes: number) =>
      getAttachmentPart(folder, uid, part, maxBytes, withMailboxOn);
    return { mail, fetchAttachmentPart };
  }

  it('ne télécharge que la partie, nom et type tirés du BODYSTRUCTURE', async () => {
    const { mail, fetchAttachmentPart } = partMailbox();
    const mailbox = fakeMailbox();
    const [att] = await resolveAttachmentSources(
      [{ fromMessage: { folder: 'Apple', uid: 371, part: '2' } }],
      deps({ fetchAttachmentPart, fetchMessageAttachments: mailbox.fetchMessageAttachments }),
    );
    assert.equal(att?.filename, 'Facture.pdf');
    assert.equal(att?.contentType, 'application/pdf');
    assert.equal(att?.content.length, 250);
    assert.deepEqual(mailbox.fetches, []);
    assert.deepEqual(mail.downloads, [{ uid: 371, part: '2', maxBytes: LIMIT + 1 }]);
  });

  it('partie inexistante ou multipart : erreur qui nomme l’élément', async () => {
    const { fetchAttachmentPart } = partMailbox();
    await rejectsWith(
      resolveAttachmentSources(
        [{ fromMessage: { folder: 'Apple', uid: 371, part: '7' } }],
        deps({ fetchAttachmentPart }),
      ),
      AttachmentSourceError,
      /attachments\[0\] \(fromMessage\).*partie 7 du message UID 371.*introuvable/,
    );
  });

  it('refuse au-delà du budget restant, sans télécharger si la taille annoncée suffit', async () => {
    const { mail, fetchAttachmentPart } = partMailbox();
    await rejectsWith(
      resolveAttachmentSources(
        [
          { filename: 'a.bin', contentBase64: Buffer.alloc(LIMIT - 100).toString('base64') },
          { fromMessage: { folder: 'Apple', uid: 371, part: '2' } },
        ],
        deps({ fetchAttachmentPart }),
      ),
      AttachmentTooLargeError,
      /attachments\[1\] \(fromMessage\).*partie 2.*Budget restant : 100 octets/,
    );
    assert.equal(mail.downloads.length, 0);
  });

  it('zod exige exactement un de index ou part, et une partie bien formée', () => {
    assert.equal(attachmentInput.safeParse({ fromMessage: { uid: 1, part: '1.2' } }).success, true);
    for (const fromMessage of [
      { uid: 1 },
      { uid: 1, index: 0, part: '2' },
      { uid: 1, part: 'TEXT' },
    ]) {
      assert.equal(attachmentInput.safeParse({ fromMessage }).success, false);
    }
    assert.match(
      attachmentSourceProblem({ fromMessage: { uid: 1, index: 0, part: '2' } }) ?? '',
      /fromMessage : exactement un de index/,
    );
  });
});

describe('source url', () => {
  it('nom tiré de Content-Disposition, type de la réponse', async () => {
    const web = fakeWeb(() => ({
      headers: {
        'content-disposition': 'attachment; filename="Facture 2026.pdf"',
        'content-type': 'application/pdf',
      },
      body: body(Buffer.from('%PDF')),
    }));
    const [att] = await resolveAttachmentSources(
      [{ url: 'https://factures.example/dl?id=1' }],
      deps({ fetch: web.fetch }),
    );
    assert.equal(att?.filename, 'Facture 2026.pdf');
    assert.equal(att?.contentType, 'application/pdf');
    assert.equal(att?.content.toString(), '%PDF');
  });

  it('nom tiré du chemin (décodé) à défaut ; surcharges de l’appelant prioritaires', async () => {
    const web = fakeWeb(() => ({ headers: { 'content-type': 'image/png' } }));
    const [fromPath, overridden] = await resolveAttachmentSources(
      [
        { url: 'https://cdn.example/images/re%C3%A7u.png' },
        { url: 'https://cdn.example/images/x.png', filename: 'y.png', contentType: 'image/x' },
      ],
      deps({ fetch: web.fetch }),
    );
    assert.equal(fromPath?.filename, 'reçu.png');
    assert.equal(fromPath?.contentType, 'image/png');
    assert.equal(overridden?.filename, 'y.png');
    assert.equal(overridden?.contentType, 'image/x');
  });

  it('sans nom déductible, exige filename', async () => {
    await rejectsWith(
      resolveAttachmentSources([{ url: 'https://cdn.example/' }], deps()),
      AttachmentSourceError,
      /attachments\[0\] \(url\).*fournir filename/,
    );
  });

  it('URL refusée : erreur qui nomme l’élément, sans la query', async () => {
    await rejectsWith(
      resolveAttachmentSources([{ url: 'https://127.0.0.1/secret?token=abc' }], deps()),
      AttachmentSourceError,
      /^attachments\[0\] \(url\) : https:\/\/127\.0\.0\.1\/secret refusée.*loopback/,
    );
    await assert.rejects(
      resolveAttachmentSources([{ url: 'https://127.0.0.1/secret?token=abc' }], deps()),
      (err: Error) => !err.message.includes('token'),
    );
  });

  it('refuse http://', async () => {
    await rejectsWith(
      resolveAttachmentSources([{ url: 'http://cdn.example/a.pdf' }], deps()),
      AttachmentSourceError,
      /https/,
    );
  });
});

describe('plafond ATTACHMENT_MAX_BYTES (cumul)', () => {
  it('une URL ne reçoit que le reste disponible et son flux est coupé', async () => {
    let pulled = 0;
    async function* big(): AsyncIterable<Buffer> {
      for (;;) {
        pulled++;
        yield Buffer.alloc(100);
      }
    }
    const web = fakeWeb(() => ({ body: big() }));
    await rejectsWith(
      resolveAttachmentSources(
        [{ fromMessage: { uid: 42, index: 0 } }, { url: 'https://cdn.example/gros.bin' }],
        deps({ fetch: web.fetch }),
      ),
      AttachmentTooLargeError,
      /attachments\[1\] \(url\).*700 octets/,
    );
    // 300 octets déjà pris par la facture : coupé au 8ᵉ bloc de 100.
    assert.equal(pulled, 8);
  });

  it('refuse une pièce jointe reprise qui dépasse le reste', async () => {
    await rejectsWith(
      resolveAttachmentSources(
        [
          { filename: 'a.bin', contentBase64: Buffer.alloc(800).toString('base64') },
          { fromMessage: { uid: 42, index: 0 } },
        ],
        deps(),
      ),
      AttachmentTooLargeError,
      /attachments\[1\] \(fromMessage\).*300 octets.*200 octets encore disponibles/,
    );
  });

  it('refuse un cumul base64 au-delà de la limite, en nommant l’élément', async () => {
    await rejectsWith(
      resolveAttachmentSources(
        [
          { filename: 'a.bin', contentBase64: Buffer.alloc(600).toString('base64') },
          { filename: 'b.bin', contentBase64: Buffer.alloc(600).toString('base64') },
        ],
        deps(),
      ),
      AttachmentTooLargeError,
      /1200 octets au total à attachments\[1\].*limite de 1000 octets/,
    );
  });

  it('accepte un cumul de sources mixtes exactement à la limite', async () => {
    const web = fakeWeb(() => ({ body: body(Buffer.alloc(300)) }));
    const result = await resolveAttachmentSources(
      [
        { filename: 'a.bin', contentBase64: Buffer.alloc(200).toString('base64') },
        { fromMessage: { uid: 42, index: 0 } },
        { fromMessage: { uid: 42, index: 1 } },
        { url: 'https://cdn.example/c.bin' },
      ],
      deps({ fetch: web.fetch }),
    );
    assert.equal(
      result.reduce((sum, att) => sum + att.content.length, 0),
      LIMIT,
    );
  });

  it('s’arrête au premier élément en erreur', async () => {
    const web = fakeWeb(() => ({}));
    await assert.rejects(
      resolveAttachmentSources(
        [{ fromMessage: { uid: 404, index: 0 } }, { url: 'https://cdn.example/a.pdf' }],
        deps({ fetch: web.fetch }),
      ),
      AttachmentSourceError,
    );
    assert.equal(web.requests.length, 0);
  });
});

describe('déduction du nom de fichier', () => {
  it('Content-Disposition : filename* prioritaire, chemin retiré', () => {
    assert.equal(
      filenameFromContentDisposition(
        `attachment; filename="fallback.pdf"; filename*=UTF-8''re%C3%A7u%20n%C2%B01.pdf`,
      ),
      'reçu n°1.pdf',
    );
    assert.equal(filenameFromContentDisposition('attachment; filename=../../etc/passwd'), 'passwd');
    assert.equal(filenameFromContentDisposition('inline'), undefined);
    assert.equal(filenameFromContentDisposition(undefined), undefined);
  });

  it('chemin de l’URL : dernier segment non vide', () => {
    assert.equal(filenameFromUrlPath(new URL('https://a.example/x/doc.pdf?v=2')), 'doc.pdf');
    assert.equal(filenameFromUrlPath(new URL('https://a.example/x/dossier/')), 'dossier');
    assert.equal(filenameFromUrlPath(new URL('https://a.example/')), undefined);
  });
});

describe('compose_message : sources refusées avant tout envoi', () => {
  let client: Client;
  before(async () => {
    client = await connectClient();
  });
  after(() => client.close());

  it('expose les trois sources dans le schéma', async () => {
    const { tools } = await client.listTools();
    const compose = tools.find((tool) => tool.name === 'compose_message');
    const schema = JSON.stringify(compose?.inputSchema);
    for (const key of ['contentBase64', 'fromMessage', 'url']) {
      assert.match(schema, new RegExp(`"${key}"`));
    }
  });

  it('refuse deux sources sur un même élément', async () => {
    const result = await client.callTool({
      name: 'compose_message',
      arguments: {
        deliver: 'draft',
        to: ['a@example.com'],
        subject: 'Objet',
        text: 'x',
        attachments: [
          { filename: 'a.pdf', contentBase64: 'QQ==', url: 'https://cdn.example/a.pdf' },
        ],
      },
    });
    assert.equal(result.isError, true);
    assert.match(firstText(result), /exactement une source/);
  });

  it('une URL refusée fait échouer l’appel, l’élément nommé', async () => {
    // Refusée avant toute résolution DNS : ni réseau, ni IMAP, ni SMTP.
    const result = await client.callTool({
      name: 'compose_message',
      arguments: {
        deliver: 'draft',
        to: ['a@example.com'],
        subject: 'Objet',
        text: 'x',
        attachments: [{ url: 'http://cdn.example/a.pdf' }],
      },
    });
    assert.equal(result.isError, true);
    assert.match(firstText(result), /attachments\[0\] \(url\).*https/);
  });
});
