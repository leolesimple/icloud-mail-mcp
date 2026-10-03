import './helpers/env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ImapFlow } from 'imapflow';
import { searchMessagesAcross } from '../src/imap/messages.js';
import { ImapAuthError } from '../src/imap/errors.js';
import { FakeMail, authError } from './helpers/fake-imap.js';

/** Rejoue `withMailbox` sur un `FakeMail` unique, sans passer par le pool réel. */
function withMailboxOn(mail: FakeMail) {
  return async <T>(folder: string, fn: (client: ImapFlow) => Promise<T>): Promise<T> => {
    await mail.getMailboxLock(folder);
    return fn(mail.asImapFlow());
  };
}

function account(): FakeMail {
  const mail = new FakeMail().addMailbox('INBOX').addMailbox('Archive');
  mail.addMessage('INBOX', { uid: 1, subject: 'Bonjour', date: new Date('2026-01-02') });
  mail.addMessage('Archive', { uid: 2, subject: 'Bonjour aussi', date: new Date('2026-01-01') });
  return mail;
}

describe('searchMessagesAcross', () => {
  it('fusionne et étiquette les résultats de chaque dossier', async () => {
    const mail = account();
    const result = await searchMessagesAcross(
      ['INBOX', 'Archive'],
      { text: 'bonjour', limit: 50 },
      withMailboxOn(mail),
    );

    assert.deepEqual(
      result.messages.map((m) => [m.folder, m.uid]),
      [
        ['INBOX', 1],
        ['Archive', 2],
      ],
    );
    assert.equal(result.errors, undefined);
  });

  it('écarte un dossier introuvable et le reporte dans errors, sans faire échouer les autres', async () => {
    const mail = account();
    const result = await searchMessagesAcross(
      ['INBOX', 'Dossier Fantome', 'Archive'],
      { text: 'bonjour', limit: 50 },
      withMailboxOn(mail),
    );

    assert.deepEqual(
      result.messages.map((m) => m.folder),
      ['INBOX', 'Archive'],
    );
    assert.equal(result.errors?.length, 1);
    assert.equal(result.errors?.[0]?.folder, 'Dossier Fantome');
    assert.match(result.errors?.[0]?.error ?? '', /Dossier Fantome/);
  });

  it('propage une erreur d’authentification au lieu de l’avaler dossier par dossier', async () => {
    const mail = account();
    const withMailboxFn = async <T>(
      folder: string,
      fn: (client: ImapFlow) => Promise<T>,
    ): Promise<T> => {
      if (folder === 'INBOX') throw authError();
      return withMailboxOn(mail)(folder, fn);
    };

    await assert.rejects(
      () =>
        searchMessagesAcross(['INBOX', 'Archive'], { text: 'bonjour', limit: 50 }, withMailboxFn),
      ImapAuthError,
    );
  });
});
