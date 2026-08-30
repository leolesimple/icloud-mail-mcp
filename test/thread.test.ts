import './helpers/env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getThreadOn } from '../src/imap/thread.js';
import { FakeMail } from './helpers/fake-imap.js';

const ME = 'test@example.com'; // = config.ICLOUD_EMAIL sous test/helpers/env.ts
const OTHER = 'alice@example.com';

describe('getThreadOn (B7)', () => {
  it('reconstitue un fil via References / In-Reply-To sur INBOX + Sent', async () => {
    const mail = new FakeMail().addMailbox('INBOX').addMailbox('Sent', { specialUse: '\\Sent' });

    mail.addMessage('INBOX', {
      uid: 1,
      messageId: '<a@x>',
      subject: 'Question',
      date: new Date('2026-03-01T10:00:00Z'),
      from: [{ address: OTHER }],
    });
    mail.addMessage('Sent', {
      uid: 2,
      messageId: '<b@x>',
      inReplyTo: '<a@x>',
      references: ['<a@x>'],
      subject: 'Re: Question',
      date: new Date('2026-03-01T11:00:00Z'),
      from: [{ address: ME }],
    });
    mail.addMessage('INBOX', {
      uid: 3,
      messageId: '<c@x>',
      inReplyTo: '<b@x>',
      references: ['<a@x>', '<b@x>'],
      subject: 'Re: Re: Question',
      date: new Date('2026-03-01T12:00:00Z'),
      from: [{ address: OTHER }],
    });

    const thread = await getThreadOn(mail.asImapFlow(), ['Sent'], 'INBOX', 1);

    assert.equal(thread.subject, 'Question');
    assert.deepEqual(
      thread.messages.map((m) => [m.uid, m.folder, m.role]),
      [
        [1, 'INBOX', 'received'],
        [2, 'Sent', 'sent'],
        [3, 'INBOX', 'received'],
      ],
    );
  });

  it('replie sur le sujet normalisé quand les en-têtes de threading manquent', async () => {
    const mail = new FakeMail().addMailbox('INBOX').addMailbox('Archive', { specialUse: '\\Archive' });

    mail.addMessage('INBOX', {
      uid: 10,
      messageId: '<m10@x>',
      subject: 'Dossier client',
      date: new Date('2026-04-01T09:00:00Z'),
      from: [{ address: OTHER }],
    });
    mail.addMessage('Archive', {
      uid: 11,
      messageId: '<m11@x>',
      subject: 'Fwd: Dossier client',
      date: new Date('2026-04-02T09:00:00Z'),
      from: [{ address: ME }],
    });

    const thread = await getThreadOn(mail.asImapFlow(), ['Archive'], 'INBOX', 10);

    assert.equal(thread.subject, 'Dossier client');
    assert.deepEqual(
      thread.messages.map((m) => m.uid),
      [10, 11],
    );
  });

  it('déduplique un message présent dans deux dossiers, garde le premier balayé', async () => {
    const mail = new FakeMail().addMailbox('INBOX').addMailbox('Archive', { specialUse: '\\Archive' });
    const shared = {
      messageId: '<dup@x>',
      subject: 'Doublon',
      date: new Date('2026-05-01T09:00:00Z'),
      from: [{ address: OTHER }],
    };
    mail.addMessage('INBOX', { uid: 20, ...shared });
    mail.addMessage('Archive', { uid: 21, ...shared });

    const thread = await getThreadOn(mail.asImapFlow(), ['Archive'], 'INBOX', 20);

    assert.equal(thread.messages.length, 1);
    assert.deepEqual(
      thread.messages.map((m) => [m.uid, m.folder]),
      [[20, 'INBOX']],
    );
  });

  it('ignore le bruit ramené par la recherche sur sujet', async () => {
    const mail = new FakeMail().addMailbox('INBOX');
    mail.addMessage('INBOX', {
      uid: 30,
      messageId: '<root@x>',
      subject: 'Compte rendu',
      date: new Date('2026-06-01T09:00:00Z'),
      from: [{ address: OTHER }],
    });
    // Même sous-chaîne dans le sujet, mais fil différent → à exclure.
    mail.addMessage('INBOX', {
      uid: 31,
      messageId: '<autre@x>',
      subject: 'Compte rendu annuel 2025',
      date: new Date('2026-06-02T09:00:00Z'),
      from: [{ address: OTHER }],
    });

    const thread = await getThreadOn(mail.asImapFlow(), [], 'INBOX', 30);
    assert.deepEqual(
      thread.messages.map((m) => m.uid),
      [30],
    );
  });
});
