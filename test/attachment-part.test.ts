import './helpers/env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ImapFlow, MessageStructureObject } from 'imapflow';
import {
  decodedSizeLowerBound,
  getAttachmentPart,
  getMessageAttachments,
} from '../src/imap/messages.js';
import { attachmentParts } from '../src/imap/search-query.js';
import { AttachmentTooLargeError } from '../src/attachments.js';
import { locatorLabel, locatorProblem, toLocator } from '../src/attachment-locator.js';
import { FakeMail } from './helpers/fake-imap.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF = Buffer.from('%PDF-1.4\n% facture factice\n');

/**
 * Facture : une image intégrée SANS nom (logo référencé par cid), puis un PDF.
 * mailparser compte les deux (index 0 et 1) ; le BODYSTRUCTURE ne retient que
 * le PDF, partie « 2 ».
 */
const SOURCE = [
  'From: Apple <no_reply@email.apple.com>',
  'Subject: Facture',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="mixed"',
  '',
  '--mixed',
  'Content-Type: multipart/related; boundary="rel"',
  '',
  '--rel',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>Merci</p><img src="cid:logo@apple.com">',
  '--rel',
  'Content-Type: image/png',
  'Content-ID: <logo@apple.com>',
  'Content-Transfer-Encoding: base64',
  '',
  PNG.toString('base64'),
  '--rel--',
  '--mixed',
  'Content-Type: application/pdf; name="Facture.pdf"',
  'Content-Disposition: attachment; filename="Facture.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  PDF.toString('base64'),
  '--mixed--',
  '',
].join('\r\n');

const STRUCTURE: MessageStructureObject = {
  type: 'multipart/mixed',
  childNodes: [
    {
      part: '1',
      type: 'multipart/related',
      childNodes: [
        { part: '1.1', type: 'text/html' },
        { part: '1.2', type: 'image/png', id: '<logo@apple.com>', encoding: 'base64', size: 12 },
      ],
    },
    {
      part: '2',
      type: 'application/pdf',
      parameters: { name: 'Facture.pdf' },
      disposition: 'attachment',
      dispositionParameters: { filename: 'Facture.pdf' },
      encoding: 'base64',
      size: 40,
    },
  ],
};

function mailbox(extra: Partial<Parameters<FakeMail['addMessage']>[1]> = {}) {
  const mail = new FakeMail().addMailbox('Apple');
  mail.addMessage('Apple', {
    uid: 371,
    source: Buffer.from(SOURCE),
    bodyStructure: STRUCTURE,
    parts: { '1.1': Buffer.from('<p>Merci</p>'), '1.2': PNG, '2': PDF },
    ...extra,
  });
  const withMailboxOn = async <T>(folder: string, fn: (client: ImapFlow) => Promise<T>) => {
    await mail.getMailboxLock(folder);
    return fn(mail.asImapFlow());
  };
  return { mail, withMailboxOn };
}

describe('getAttachmentPart', () => {
  it('télécharge la seule partie demandée, mêmes octets que par index', async () => {
    const { mail, withMailboxOn } = mailbox();

    const listed = attachmentParts(STRUCTURE);
    assert.deepEqual(
      listed.map((p) => [p.part, p.contentType]),
      [['2', 'application/pdf']],
    );

    const byPart = await getAttachmentPart('Apple', 371, '2', 1_000, withMailboxOn);
    assert.deepEqual(mail.downloads, [{ uid: 371, part: '2', maxBytes: 1_001 }]);
    assert.equal(byPart.filename, 'Facture.pdf');
    assert.equal(byPart.contentType, 'application/pdf');
    assert.equal(byPart.size, PDF.length);

    // mailparser compte l'image sans nom : le PDF y est l'index 1, pas 0.
    const byIndex = await getMessageAttachments('Apple', 371, withMailboxOn);
    assert.equal(byIndex.length, 2);
    assert.equal(byIndex[0]?.contentType, 'image/png');
    assert.ok(byIndex[1]?.content.equals(byPart.content));
  });

  it('numérote « 1 » le corps d’un message mono-partie', async () => {
    const { withMailboxOn } = mailbox({
      bodyStructure: {
        type: 'application/pdf',
        disposition: 'attachment',
        dispositionParameters: { filename: 'scan.pdf' },
      },
      parts: { '1': PDF },
    });
    const single = await getAttachmentPart('Apple', 371, '1', 1_000, withMailboxOn);
    assert.equal(single.filename, 'scan.pdf');
    assert.ok(single.content.equals(PDF));
  });

  it('refuse une partie inexistante sans rien télécharger, en listant les parties', async () => {
    const { mail, withMailboxOn } = mailbox();
    await assert.rejects(
      getAttachmentPart('Apple', 371, '3', 1_000, withMailboxOn),
      /Partie 3 introuvable dans le message UID 371 \(parties des pièces jointes : 2,/,
    );
    assert.equal(mail.downloads.length, 0);
  });

  it('refuse un message inexistant', async () => {
    const { withMailboxOn } = mailbox();
    await assert.rejects(
      getAttachmentPart('Apple', 999, '2', 1_000, withMailboxOn),
      /Message UID 999 introuvable dans "Apple"/,
    );
  });

  it('refuse une partie multipart', async () => {
    const { mail, withMailboxOn } = mailbox();
    await assert.rejects(
      getAttachmentPart('Apple', 371, '1', 1_000, withMailboxOn),
      /partie 1 .* conteneur multipart\/related/,
    );
    assert.equal(mail.downloads.length, 0);
  });

  it('refuse sur la taille annoncée, avant tout téléchargement', async () => {
    const { mail, withMailboxOn } = mailbox();
    // 40 octets base64 annoncés : au moins 28 octets décodés.
    await assert.rejects(getAttachmentPart('Apple', 371, '2', 20, withMailboxOn), (err: Error) => {
      assert.ok(err instanceof AttachmentTooLargeError);
      assert.match(err.message, /au moins 28 octets.*limite de 20 octets.*ATTACHMENT_MAX_BYTES/);
      return true;
    });
    assert.equal(mail.downloads.length, 0);
  });

  it('coupe le flux au-delà de la limite quand la taille annoncée a menti', async () => {
    const big = Buffer.alloc(500, 1);
    const { mail, withMailboxOn } = mailbox({ parts: { '2': big } });
    await assert.rejects(getAttachmentPart('Apple', 371, '2', 100, withMailboxOn), (err: Error) => {
      assert.ok(err instanceof AttachmentTooLargeError);
      assert.match(err.message, /partie 2.*interrompue.*limite de 100 octets/);
      return true;
    });
    assert.equal(mail.downloads[0]?.maxBytes, 101);
  });

  it('accepte une pièce jointe de exactement la taille limite', async () => {
    const { withMailboxOn } = mailbox({ parts: { '2': Buffer.alloc(30, 7) } });
    const exact = await getAttachmentPart('Apple', 371, '2', 30, withMailboxOn);
    assert.equal(exact.size, 30);
  });
});

describe('decodedSizeLowerBound', () => {
  it('reste sous la taille décodée selon l’encodage', () => {
    assert.equal(decodedSizeLowerBound({ type: 'application/pdf' }), undefined);
    // 1 Mo en base64 avec fins de ligne à 76 : environ 1 384 000 caractères.
    const base64 = decodedSizeLowerBound({ type: 'a/b', encoding: 'base64', size: 1_384_000 });
    assert.ok(base64! <= 1_000_000);
    assert.equal(
      decodedSizeLowerBound({ type: 'a/b', encoding: 'quoted-printable', size: 90 }),
      30,
    );
    assert.equal(decodedSizeLowerBound({ type: 'a/b', encoding: '7bit', size: 90 }), 45);
  });
});

describe('index ou part', () => {
  it('exige exactement l’un des deux', () => {
    assert.equal(locatorProblem({ index: 0 }), undefined);
    assert.equal(locatorProblem({ part: '2' }), undefined);
    assert.match(locatorProblem({}) ?? '', /reçu : aucun/);
    assert.match(locatorProblem({ index: 0, part: '2' }) ?? '', /reçu : les deux/);
  });

  it('ramène l’entrée à sa forme discriminée', () => {
    assert.deepEqual(toLocator({ part: '1.3' }), { part: '1.3' });
    assert.deepEqual(toLocator({ index: 2 }), { index: 2 });
    assert.equal(locatorLabel({ part: '1.3' }), 'partie 1.3');
    assert.equal(locatorLabel({ index: 2 }), '#2');
  });
});
