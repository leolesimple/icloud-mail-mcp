import './helpers/env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ImapFlow } from 'imapflow';
import { appendToSentFolder, resolveSentFolder, saveToSent } from '../src/imap/sent.js';
import { FakeImapClient } from './helpers/fake-imap.js';

const RAW = Buffer.from('From: moi@icloud.com\r\nSubject: test\r\nMessage-ID: <a@icloud.com>\r\n\r\ncorps');

/** Exécuteur qui joue `fn` sur un client factice, sans passer par le pool réel. */
function on(fake: FakeImapClient) {
  return <T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> => fn(fake.asImapFlow());
}

describe('resolveSentFolder', () => {
  it('résout le dossier par son flag \\Sent', async () => {
    const fake = new FakeImapClient();
    fake.mailboxes = [{ path: 'INBOX' }, { path: 'Sent', specialUse: '\\Sent' }];
    assert.equal(await resolveSentFolder(fake.asImapFlow()), 'Sent');
  });

  it('retombe sur "Sent Messages" quand aucun dossier ne porte le flag', async () => {
    const fake = new FakeImapClient();
    fake.mailboxes = [{ path: 'INBOX' }];
    assert.equal(await resolveSentFolder(fake.asImapFlow()), 'Sent Messages');
  });
});

describe('appendToSentFolder', () => {
  it('APPEND le buffer exact dans le dossier Sent, marqué \\Seen', async () => {
    const fake = new FakeImapClient();
    fake.mailboxes = [{ path: 'Sent Messages', specialUse: '\\Sent' }];

    const path = await appendToSentFolder(fake.asImapFlow(), RAW);

    assert.equal(path, 'Sent Messages');
    assert.equal(fake.appendCalls.length, 1);
    assert.equal(fake.appendCalls[0]?.path, 'Sent Messages');
    assert.equal(fake.appendCalls[0]?.content, RAW);
    assert.deepEqual(fake.appendCalls[0]?.flags, ['\\Seen']);
  });

  it('propage une erreur d’APPEND', async () => {
    const fake = new FakeImapClient();
    fake.mailboxes = [{ path: 'Sent', specialUse: '\\Sent' }];
    fake.appendError = new Error('APPEND refusé par le serveur');

    await assert.rejects(appendToSentFolder(fake.asImapFlow(), RAW), /APPEND refusé/);
  });
});

describe('saveToSent', () => {
  it('renvoie true après un APPEND réussi', async () => {
    const fake = new FakeImapClient();
    fake.mailboxes = [{ path: 'Sent', specialUse: '\\Sent' }];

    assert.equal(await saveToSent(RAW, on(fake)), true);
    assert.equal(fake.appendCalls[0]?.path, 'Sent');
  });

  it('renvoie false sans lever quand l’APPEND échoue', async () => {
    const fake = new FakeImapClient();
    fake.mailboxes = [{ path: 'Sent', specialUse: '\\Sent' }];
    fake.appendError = new Error('quota dépassé');

    assert.equal(await saveToSent(RAW, on(fake)), false);
  });

  it('renvoie false sans lever quand la connexion IMAP est indisponible', async () => {
    assert.equal(
      await saveToSent(RAW, () => {
        throw new Error('pool de connexions IMAP fermé');
      }),
      false,
    );
  });
});
