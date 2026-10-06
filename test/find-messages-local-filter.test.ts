import './helpers/env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ImapFlow, MessageStructureObject } from 'imapflow';
import { fetchPage, searchMessagesAcross } from '../src/imap/messages.js';
import { FakeMail } from './helpers/fake-imap.js';

const textOnly: MessageStructureObject = { type: 'text/plain', part: '1' };
const invoice: MessageStructureObject = {
  type: 'multipart/mixed',
  childNodes: [
    textOnly,
    {
      part: '2',
      type: 'application/pdf',
      disposition: 'attachment',
      dispositionParameters: { filename: 'Facture.pdf' },
    },
  ],
};

/** True si une requête SEARCH (ou l'un de ses not / or) porte subject, from ou to. */
function sendsLocalCriteria(query: Record<string, unknown>): boolean {
  if (['subject', 'from', 'to'].some((key) => key in query)) return true;
  const nested = [query.not, ...((query.or as unknown[] | undefined) ?? [])];
  return nested.some(
    (sub) => sub !== undefined && sendsLocalCriteria(sub as Record<string, unknown>),
  );
}

/** Dossier « Apple » tel qu'observé sur iCloud : SEARCH FROM "apple.com" rate certains expéditeurs. */
function appleFolder(): FakeMail {
  const mail = new FakeMail().addMailbox('Apple');
  const add = (uid: number, address: string, bodyStructure = invoice): void => {
    mail.addMessage('Apple', {
      uid,
      from: [{ name: 'Apple', address }],
      subject: `Reçu ${uid}`,
      bodyStructure,
      date: new Date(Date.UTC(2026, 0, 1) + uid * 86_400_000),
    });
  };
  add(269, 'parly2@email.apple.com');
  add(300, 'no_reply@email.apple.com', textOnly);
  add(371, 'EMEA_Invoicing@email.apple.com');
  add(384, 'lesquatretemps@email.apple.com');
  add(417, 'champs-elysees@email.apple.com');
  add(418, 'champs-elysees@email.apple.com');
  add(420, 'facturation@edf.fr');
  for (const address of [
    'lesquatretemps@email.apple.com',
    'emea_invoicing@email.apple.com',
    'champs-elysees@email.apple.com',
  ]) {
    mail.fromBlindSpots.add(address);
  }
  return mail.select('Apple');
}

describe('from / to / subject vérifiés localement (SEARCH FROM d’iCloud non fiable)', () => {
  it('reproduit le défaut : le faux serveur, comme iCloud, rate des expéditeurs en SEARCH FROM', async () => {
    const mail = appleFolder();
    const uids = await mail.search({ from: 'apple.com' });
    assert.deepEqual(uids.sort(), [269, 300]);
  });

  it('retrouve toutes les factures PDF Apple malgré le SEARCH défaillant', async () => {
    const mail = appleFolder();
    const page = await fetchPage(
      mail.asImapFlow(),
      { from: 'apple.com', attachmentType: 'application/pdf' },
      50,
    );
    assert.deepEqual(
      page.messages.map((m) => m.uid),
      [418, 417, 384, 371, 269],
    );
    assert.equal(page.nextCursor, undefined);
    assert.ok(page.messages.every((m) => m.attachments?.[0]?.contentType === 'application/pdf'));
    assert.ok(!mail.searches.some((query) => sendsLocalCriteria(query as Record<string, unknown>)));
  });

  it('sans critère serveur, part de SEARCH ALL borné par le curseur', async () => {
    const mail = appleFolder();
    await fetchPage(mail.asImapFlow(), { from: 'apple.com', beforeUid: 400 }, 50);
    assert.deepEqual(mail.searches, [{ all: true, uid: '1:399' }]);
  });

  it('lit ENVELOPE et BODYSTRUCTURE en une seule passe, sans FETCH supplémentaire', async () => {
    const mail = appleFolder();
    await fetchPage(mail.asImapFlow(), { from: 'apple.com', hasAttachment: true }, 50);
    assert.equal(mail.fetches.length, 1);
    assert.equal(mail.fetches[0]?.query.envelope, true);
    assert.equal(mail.fetches[0]?.query.bodyStructure, true);
  });

  it('sans filtre pièces jointes, ne lit pas le BODYSTRUCTURE ni n’expose attachments', async () => {
    const mail = appleFolder();
    const page = await fetchPage(mail.asImapFlow(), { from: 'edf' }, 50);
    assert.deepEqual(
      page.messages.map((m) => m.uid),
      [420],
    );
    assert.equal(page.messages[0]?.attachments, undefined);
    assert.deepEqual(mail.bodyStructureFetches, []);
  });

  it('subject : sous-chaîne sans casse dans le sujet ; to : champ To seulement', async () => {
    const mail = new FakeMail().addMailbox('INBOX');
    mail.addMessage('INBOX', {
      uid: 1,
      subject: 'Votre REÇU',
      to: [{ address: 'leo@icloud.com' }],
    });
    mail.addMessage('INBOX', {
      uid: 2,
      subject: 'Autre',
      to: [{ address: 'equipe@exemple.fr' }],
      cc: [{ address: 'leo@icloud.com' }],
    });
    const client = mail.select('INBOX').asImapFlow();
    assert.deepEqual(
      (await fetchPage(client, { subject: 'reçu' }, 10)).messages.map((m) => m.uid),
      [1],
    );
    assert.deepEqual(
      (await fetchPage(client, { to: 'leo@' }, 10)).messages.map((m) => m.uid),
      [1],
    );
  });

  describe('or', () => {
    it('branches purement locales', async () => {
      const mail = appleFolder();
      const page = await fetchPage(
        mail.asImapFlow(),
        { or: [{ from: 'lesquatretemps' }, { from: 'edf.fr' }] },
        50,
      );
      assert.deepEqual(
        page.messages.map((m) => m.uid),
        [420, 384],
      );
      assert.equal(mail.searches.length, 1);
    });

    it('branche mixte : la partie body passe par un SEARCH dédié', async () => {
      const mail = new FakeMail().addMailbox('INBOX');
      const alice = [{ address: 'alice@exemple.fr' }];
      mail.addMessage('INBOX', { uid: 1, from: alice, body: 'devis signé' });
      mail.addMessage('INBOX', { uid: 2, from: alice, body: 'bonjour' });
      mail.addMessage('INBOX', { uid: 3, subject: 'Relance', body: 'rien' });
      mail.addMessage('INBOX', { uid: 4, body: 'devis' });
      const page = await fetchPage(
        mail.select('INBOX').asImapFlow(),
        { or: [{ from: 'alice', body: 'devis' }, { subject: 'relance' }] },
        50,
      );
      assert.deepEqual(
        page.messages.map((m) => m.uid),
        [3, 1],
      );
      assert.deepEqual(mail.searches, [{ all: true }, { body: 'devis' }]);
    });

    it('branches body/text seulement : reste un OR serveur', async () => {
      const mail = new FakeMail().addMailbox('INBOX');
      mail.addMessage('INBOX', { uid: 1, body: 'alpha' });
      mail.addMessage('INBOX', { uid: 2, body: 'beta' });
      mail.addMessage('INBOX', { uid: 3, body: 'gamma' });
      const page = await fetchPage(
        mail.select('INBOX').asImapFlow(),
        { or: [{ body: 'alpha' }, { body: 'gamma' }] },
        50,
      );
      assert.deepEqual(
        page.messages.map((m) => m.uid),
        [3, 1],
      );
      assert.deepEqual(mail.searches, [{ all: true, or: [{ body: 'alpha' }, { body: 'gamma' }] }]);
    });
  });

  describe('not', () => {
    it('exclut localement un expéditeur que SEARCH aurait raté', async () => {
      const mail = appleFolder();
      const page = await fetchPage(mail.asImapFlow(), { not: { from: 'apple.com' } }, 50);
      assert.deepEqual(
        page.messages.map((m) => m.uid),
        [420],
      );
    });

    it('mixte : n’exclut que les messages qui satisfont toute la négation', async () => {
      const mail = new FakeMail().addMailbox('INBOX');
      const shop = [{ address: 'news@boutique.fr' }];
      mail.addMessage('INBOX', { uid: 1, from: shop, body: 'promo -50 %' });
      mail.addMessage('INBOX', { uid: 2, from: shop, body: 'votre commande' });
      mail.addMessage('INBOX', { uid: 3, from: [{ address: 'ami@exemple.fr' }], body: 'promo' });
      const page = await fetchPage(
        mail.select('INBOX').asImapFlow(),
        { not: { from: 'boutique', body: 'promo' } },
        50,
      );
      assert.deepEqual(
        page.messages.map((m) => m.uid),
        [3, 2],
      );
    });
  });

  describe('pagination', () => {
    // 250 messages, un sur trois d'Apple (adresse ignorée par SEARCH FROM) : plusieurs lots de 100.
    function bigFolder(): { mail: FakeMail; apple: number[] } {
      const mail = new FakeMail().addMailbox('INBOX');
      const apple: number[] = [];
      for (let uid = 1; uid <= 250; uid += 1) {
        const fromApple = uid % 3 === 0;
        if (fromApple) apple.unshift(uid);
        mail.addMessage('INBOX', {
          uid,
          from: [{ address: fromApple ? 'champs-elysees@email.apple.com' : `x${uid}@exemple.fr` }],
        });
      }
      mail.fromBlindSpots.add('champs-elysees@email.apple.com');
      return { mail: mail.select('INBOX'), apple };
    }

    it('pagine sans trou, sans doublon ni page vide derrière un curseur', async () => {
      const { mail, apple } = bigFolder();
      const seen: number[] = [];
      let beforeUid: number | undefined;
      do {
        const page = await fetchPage(mail.asImapFlow(), { from: 'apple.com', beforeUid }, 30);
        assert.ok(page.messages.length > 0, 'aucune page vide derrière un curseur');
        seen.push(...page.messages.map((m) => m.uid));
        beforeUid = page.nextCursor;
      } while (beforeUid !== undefined);
      assert.deepEqual(seen, apple);
    });

    it('pas de curseur quand la dernière correspondance tombe pile sur limit', async () => {
      const { mail, apple } = bigFolder();
      const page = await fetchPage(mail.asImapFlow(), { from: 'apple.com' }, apple.length);
      assert.equal(page.messages.length, apple.length);
      assert.equal(page.nextCursor, undefined);
    });

    it('s’arrête dès limit + 1 correspondances', async () => {
      const { mail } = bigFolder();
      await fetchPage(mail.asImapFlow(), { from: 'apple.com' }, 10);
      assert.deepEqual(
        mail.fetches.map((f) => f.size),
        [100],
      );
    });
  });

  it('folders: "*" retrouve les factures dans chaque dossier', async () => {
    const mail = appleFolder().addMailbox('INBOX');
    mail.addMessage('INBOX', {
      uid: 5,
      from: [{ address: 'lesquatretemps@email.apple.com' }],
      bodyStructure: invoice,
      date: new Date('2028-01-01'),
    });
    const withMailbox = async <T>(folder: string, fn: (client: ImapFlow) => Promise<T>) => {
      await mail.getMailboxLock(folder);
      return fn(mail.asImapFlow());
    };
    const result = await searchMessagesAcross(
      ['INBOX', 'Apple'],
      { from: 'apple.com', attachmentType: 'application/pdf', limit: 50 },
      withMailbox,
    );
    assert.deepEqual(
      result.messages.map((m) => [m.folder, m.uid]),
      [
        ['INBOX', 5],
        ['Apple', 418],
        ['Apple', 417],
        ['Apple', 384],
        ['Apple', 371],
        ['Apple', 269],
      ],
    );
  });
});
