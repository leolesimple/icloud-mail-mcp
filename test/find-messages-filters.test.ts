import './helpers/env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ImapFlow, MessageStructureObject } from 'imapflow';
import { simpleParser } from 'mailparser';
import { fetchPage, isInlineAttachment, searchMessagesAcross } from '../src/imap/messages.js';
import { listFoldersOn, searchableFolderPaths } from '../src/imap/folders.js';
import {
  attachmentFilterOf,
  attachmentParts,
  attachmentTypes,
  findStructurePart,
  hasSearchCriteria,
  isMultipartNode,
  isInlinePart,
  matchesAttachmentFilter,
} from '../src/imap/search-query.js';
import { projectFields } from '../src/mcp/tools/find-messages.js';
import { findMessagesResultSchema } from '../src/mcp/schemas.js';
import { FakeMail } from './helpers/fake-imap.js';

// --- BODYSTRUCTURE factices ------------------------------------------------

const textOnly: MessageStructureObject = {
  type: 'multipart/alternative',
  childNodes: [
    { part: '1', type: 'text/plain' },
    { part: '2', type: 'text/html' },
  ],
};

function withAttachment(type: string, filename = 'piece.bin'): MessageStructureObject {
  return {
    type: 'multipart/mixed',
    childNodes: [
      textOnly,
      { part: '2', type, disposition: 'attachment', dispositionParameters: { filename } },
    ],
  };
}

const invoice = withAttachment('application/pdf', 'Facture.pdf');

/** Rejoue `withMailbox` sur un `FakeMail` unique, sans passer par le pool réel. */
function withMailboxOn(mail: FakeMail) {
  return async <T>(folder: string, fn: (client: ImapFlow) => Promise<T>): Promise<T> => {
    await mail.getMailboxLock(folder);
    return fn(mail.asImapFlow());
  };
}

describe('filtre pièces jointes sur le BODYSTRUCTURE', () => {
  it('reconnaît une disposition attachment, un filename ou un name, et ignore le corps', () => {
    assert.deepEqual(attachmentTypes(textOnly), []);
    assert.deepEqual(attachmentTypes(invoice), ['application/pdf']);

    const inlineNamed: MessageStructureObject = {
      type: 'multipart/related',
      childNodes: [
        { part: '1', type: 'text/html' },
        { part: '2', type: 'image/png', disposition: 'inline', parameters: { name: 'logo.png' } },
      ],
    };
    assert.deepEqual(attachmentTypes(inlineNamed), ['image/png']);
    assert.deepEqual(attachmentTypes(undefined), []);
  });

  it('compte un message joint sans descendre dans ses propres pièces jointes', () => {
    const forwarded: MessageStructureObject = {
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain' },
        {
          part: '2',
          type: 'message/rfc822',
          disposition: 'attachment',
          childNodes: [invoice],
        },
      ],
    };
    assert.deepEqual(attachmentTypes(forwarded), ['message/rfc822']);
  });

  it('filtre par type exact, par préfixe (« image/ » ou « image/* ») et sans casse', () => {
    const pdf = attachmentFilterOf({ attachmentType: 'Application/PDF' });
    assert.deepEqual(pdf, { present: true, type: 'application/pdf' });
    assert.equal(matchesAttachmentFilter(invoice, pdf!), true);
    assert.equal(matchesAttachmentFilter(withAttachment('image/jpeg'), pdf!), false);

    for (const prefix of ['image/', 'image/*']) {
      const filter = attachmentFilterOf({ attachmentType: prefix })!;
      assert.equal(matchesAttachmentFilter(withAttachment('image/jpeg'), filter), true);
      assert.equal(matchesAttachmentFilter(invoice, filter), false);
    }
  });

  it('hasAttachment true / false', () => {
    const yes = attachmentFilterOf({ hasAttachment: true })!;
    const no = attachmentFilterOf({ hasAttachment: false })!;
    assert.equal(matchesAttachmentFilter(invoice, yes), true);
    assert.equal(matchesAttachmentFilter(textOnly, yes), false);
    assert.equal(matchesAttachmentFilter(invoice, no), false);
    assert.equal(matchesAttachmentFilter(textOnly, no), true);
    assert.equal(attachmentFilterOf({}), undefined);
  });

  it('un filtre pièces jointes est un critère de recherche', () => {
    assert.equal(hasSearchCriteria({ hasAttachment: true }), true);
    assert.equal(hasSearchCriteria({ hasAttachment: false }), true);
    assert.equal(hasSearchCriteria({ attachmentType: 'image/' }), true);
    assert.equal(hasSearchCriteria({ attachmentType: '  ' }), false);
  });
});

describe('fetchPage avec filtre pièces jointes', () => {
  // 250 messages : un sur trois porte un PDF. Assez pour traverser plusieurs lots de 100.
  function bigFolder(): { mail: FakeMail; withPdf: number[] } {
    const mail = new FakeMail().addMailbox('INBOX');
    const withPdf: number[] = [];
    for (let uid = 1; uid <= 250; uid += 1) {
      const pdf = uid % 3 === 0;
      if (pdf) withPdf.push(uid);
      mail.addMessage('INBOX', {
        uid,
        subject: `M${uid}`,
        bodyStructure: pdf ? invoice : textOnly,
      });
    }
    return { mail: mail.select('INBOX'), withPdf: withPdf.sort((a, b) => b - a) };
  }

  it('filtre avant de tronquer à limit et pagine sans trou ni doublon', async () => {
    const { mail, withPdf } = bigFolder();
    const client = mail.asImapFlow();
    const seen: number[] = [];
    let beforeUid: number | undefined;
    let pages = 0;
    do {
      const page = await fetchPage(client, { attachmentType: 'application/pdf', beforeUid }, 30);
      pages += 1;
      assert.ok(page.messages.length > 0, 'aucune page vide derrière un curseur');
      assert.ok(page.messages.length <= 30);
      seen.push(...page.messages.map((m) => m.uid));
      beforeUid = page.nextCursor;
    } while (beforeUid !== undefined);

    assert.deepEqual(seen, withPdf);
    assert.equal(pages, Math.ceil(withPdf.length / 30));
  });

  it('ne pose pas de curseur quand la dernière correspondance tombe pile sur limit', async () => {
    const { mail, withPdf } = bigFolder();
    const page = await fetchPage(mail.asImapFlow(), { hasAttachment: true }, withPdf.length);
    assert.equal(page.messages.length, withPdf.length);
    assert.equal(page.nextCursor, undefined);
  });

  it('lit le BODYSTRUCTURE par lots et s’arrête dès qu’une page est pleine', async () => {
    const { mail } = bigFolder();
    await fetchPage(mail.asImapFlow(), { hasAttachment: true }, 10);
    // 11 correspondances (10 + 1 pour savoir s'il reste une page) tiennent dans le premier lot.
    assert.deepEqual(mail.bodyStructureFetches, [100]);

    mail.bodyStructureFetches.length = 0;
    await fetchPage(mail.asImapFlow(), { hasAttachment: true }, 50);
    assert.deepEqual(mail.bodyStructureFetches, [100, 100]);
  });

  it('se combine avec les critères IMAP SEARCH', async () => {
    const mail = new FakeMail().addMailbox('INBOX');
    mail.addMessage('INBOX', { uid: 1, subject: 'Facture', bodyStructure: invoice });
    mail.addMessage('INBOX', { uid: 2, subject: 'Facture', bodyStructure: textOnly });
    mail.addMessage('INBOX', { uid: 3, subject: 'Photo', bodyStructure: invoice });
    const page = await fetchPage(
      mail.select('INBOX').asImapFlow(),
      { subject: 'facture', hasAttachment: true },
      50,
    );
    assert.deepEqual(
      page.messages.map((m) => m.uid),
      [1],
    );
  });
});

describe('folders: "*"', () => {
  function account(): FakeMail {
    const apple = [{ name: 'Apple', address: 'no_reply@email.apple.com' }];
    const mail = new FakeMail()
      .addMailbox('INBOX', { specialUse: '\\Inbox' })
      .addMailbox('Archive', { specialUse: '\\Archive' })
      .addMailbox('Factures')
      .addMailbox('Deleted Messages', { specialUse: '\\Trash' })
      .addMailbox('Junk', { specialUse: '\\Junk' })
      .addMailbox('Projets', { flags: ['\\Noselect'], noSelect: true });
    mail.addMessage('INBOX', {
      uid: 1,
      from: apple,
      bodyStructure: invoice,
      date: new Date('2026-09-01'),
    });
    mail.addMessage('INBOX', {
      uid: 2,
      from: apple,
      bodyStructure: textOnly,
      date: new Date('2026-09-02'),
    });
    mail.addMessage('Archive', {
      uid: 3,
      from: apple,
      bodyStructure: invoice,
      date: new Date('2026-08-01'),
    });
    mail.addMessage('Factures', {
      uid: 4,
      from: [{ address: 'facturation@edf.fr' }],
      bodyStructure: invoice,
      date: new Date('2026-07-01'),
    });
    mail.addMessage('Deleted Messages', {
      uid: 5,
      from: apple,
      bodyStructure: invoice,
      date: new Date('2026-09-03'),
    });
    return mail;
  }

  it('résout tous les dossiers sélectionnables, hors corbeille et indésirables', async () => {
    const folders = await listFoldersOn(account().asImapFlow(), false);
    assert.deepEqual(searchableFolderPaths(folders), ['INBOX', 'Archive', 'Factures']);
    assert.deepEqual(searchableFolderPaths(folders, true), [
      'INBOX',
      'Archive',
      'Factures',
      'Deleted Messages',
      'Junk',
    ]);
  });

  it('liste les factures PDF Apple de tous les dossiers', async () => {
    const mail = account();
    const paths = searchableFolderPaths(await listFoldersOn(mail.asImapFlow(), false));
    const result = await searchMessagesAcross(
      paths,
      { from: 'apple.com', hasAttachment: true, attachmentType: 'application/pdf', limit: 50 },
      withMailboxOn(mail),
    );
    assert.deepEqual(
      result.messages.map((m) => [m.folder, m.uid]),
      [
        ['INBOX', 1],
        ['Archive', 3],
      ],
    );
    assert.equal(result.errors, undefined);
  });
});

describe('fields', () => {
  const messages = [
    {
      uid: 7,
      folder: 'INBOX',
      subject: 'Facture',
      from: [{ address: 'no_reply@email.apple.com' }],
      to: [],
      date: '2026-09-01T00:00:00.000Z',
      seen: true,
      flagged: false,
      size: 1234,
    },
  ];

  it('ne garde que les champs demandés, plus uid et folder', () => {
    const projected = projectFields(messages, ['subject', 'date']);
    assert.deepEqual(projected, [
      { uid: 7, folder: 'INBOX', subject: 'Facture', date: '2026-09-01T00:00:00.000Z' },
    ]);
    assert.doesNotThrow(() => findMessagesResultSchema.parse({ messages: projected }));
  });

  it('en mono-dossier, aucun folder n’est inventé', () => {
    const mono = messages.map(({ folder: _folder, ...rest }) => rest);
    assert.deepEqual(projectFields(mono, ['flagged']), [{ uid: 7, flagged: false }]);
  });

  it('sans fields, renvoie les messages tels quels', () => {
    assert.equal(projectFields(messages, undefined), messages);
  });

  it('un message projeté sans uid reste invalide pour l’outputSchema', () => {
    assert.throws(() => findMessagesResultSchema.parse({ messages: [{ subject: 'x' }] }));
  });
});

describe('attachments et inline', () => {
  // Facture jointe + logo de signature intégré au HTML (Content-ID, disposition inline).
  const withLogo: MessageStructureObject = {
    type: 'multipart/mixed',
    childNodes: [
      {
        part: '1',
        type: 'multipart/related',
        childNodes: [
          { part: '1.1', type: 'text/html' },
          {
            part: '1.2',
            type: 'image/png',
            id: '<logo@apple.com>',
            disposition: 'inline',
            dispositionParameters: { filename: 'logo.png' },
            size: 2048,
          },
        ],
      },
      {
        part: '2',
        type: 'application/pdf',
        disposition: 'attachment',
        dispositionParameters: { filename: 'Facture.pdf' },
        size: 40960,
      },
    ],
  };

  it('décrit chaque pièce jointe du BODYSTRUCTURE et marque les parties intégrées', () => {
    assert.deepEqual(attachmentParts(withLogo), [
      { part: '1.2', contentType: 'image/png', filename: 'logo.png', size: 2048, inline: true },
      {
        part: '2',
        contentType: 'application/pdf',
        filename: 'Facture.pdf',
        size: 40960,
        inline: false,
      },
    ]);
  });

  it("numérote « 1 » le corps d'un message mono-partie (imapflow ne lui donne pas de part)", () => {
    const single: MessageStructureObject = {
      type: 'application/pdf',
      disposition: 'attachment',
      dispositionParameters: { filename: 'scan.pdf' },
    };
    assert.deepEqual(
      attachmentParts(single).map((p) => p.part),
      ['1'],
    );
    assert.equal(findStructurePart(single, '1'), single);
    assert.equal(findStructurePart(single, '2'), undefined);
  });

  it('findStructurePart retrouve une partie, conteneurs compris', () => {
    assert.equal(findStructurePart(withLogo, '1.2')?.type, 'image/png');
    assert.equal(findStructurePart(withLogo, '2')?.type, 'application/pdf');
    const container = findStructurePart(withLogo, '1');
    assert.equal(container?.type, 'multipart/related');
    assert.equal(isMultipartNode(container!), true);
    assert.equal(findStructurePart(withLogo, '3'), undefined);
    assert.equal(findStructurePart(undefined, '1'), undefined);
  });

  it('un Content-ID sans disposition vaut inline, sauf disposition attachment', () => {
    assert.equal(isInlinePart(undefined, '<img@x>'), true);
    assert.equal(isInlinePart('INLINE', undefined), true);
    assert.equal(isInlinePart('attachment', '<img@x>'), false);
    assert.equal(isInlinePart(undefined, undefined), false);
  });

  it('fetchPage ajoute attachments seulement quand un filtre pièces jointes est actif', async () => {
    const mail = new FakeMail().addMailbox('INBOX');
    mail.addMessage('INBOX', { uid: 1, subject: 'Facture', bodyStructure: withLogo });
    const client = mail.select('INBOX').asImapFlow();

    const filtered = await fetchPage(client, { hasAttachment: true }, 10);
    assert.deepEqual(
      filtered.messages[0]?.attachments?.map((a) => [a.part, a.contentType, a.inline]),
      [
        ['1.2', 'image/png', true],
        ['2', 'application/pdf', false],
      ],
    );
    assert.doesNotThrow(() => findMessagesResultSchema.parse({ messages: filtered.messages }));

    const plain = await fetchPage(client, { subject: 'facture' }, 10);
    assert.equal(plain.messages[0]?.attachments, undefined);
  });

  it('fields peut demander attachments', () => {
    const [message] = projectFields(
      [{ uid: 1, subject: 'x', attachments: attachmentParts(withLogo) }],
      ['attachments'],
    );
    assert.deepEqual(Object.keys(message ?? {}), ['uid', 'attachments']);
  });

  it('read_message : même règle inline à partir de mailparser', async () => {
    const raw = [
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
      'Content-Type: image/png; name="logo.png"',
      'Content-ID: <logo@apple.com>',
      'Content-Transfer-Encoding: base64',
      '',
      'iVBORw0KGgo=',
      '--rel--',
      '--mixed',
      'Content-Type: application/pdf; name="Facture.pdf"',
      'Content-Disposition: attachment; filename="Facture.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      'JVBERi0xLjQK',
      '--mixed--',
      '',
    ].join('\r\n');
    const parsed = await simpleParser(raw);
    assert.deepEqual(
      parsed.attachments.map((att) => [att.filename, isInlineAttachment(att)]),
      [
        ['logo.png', true],
        ['Facture.pdf', false],
      ],
    );
  });
});
