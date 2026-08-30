import './helpers/env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ImapFlow } from 'imapflow';
import { addAnsweredFlag, markAnswered } from '../src/imap/answered.js';
import { FakeImapClient } from './helpers/fake-imap.js';

function on(fake: FakeImapClient) {
  return (_folder: string, fn: (client: ImapFlow) => Promise<void>): Promise<void> => fn(fake.asImapFlow());
}

describe('addAnsweredFlag', () => {
  it('pose \\Answered sur le bon UID', async () => {
    const fake = new FakeImapClient();
    await addAnsweredFlag(fake.asImapFlow(), 4242);
    assert.deepEqual(fake.flagsAddCalls, [
      { range: 4242, flags: ['\\Answered'], options: { uid: true } },
    ]);
  });
});

describe('markAnswered', () => {
  it('renvoie true et pose le flag sur le message d’origine', async () => {
    const fake = new FakeImapClient();
    assert.equal(await markAnswered('INBOX', 7, on(fake)), true);
    assert.deepEqual(fake.flagsAddCalls[0]?.flags, ['\\Answered']);
    assert.equal(fake.flagsAddCalls[0]?.range, 7);
  });

  it('renvoie false sans lever quand le serveur refuse le flag', async () => {
    const fake = new FakeImapClient();
    fake.flagsAddError = new Error('permission refusée sur ce dossier');
    assert.equal(await markAnswered('Archive', 9, on(fake)), false);
  });

  it('renvoie false sans lever quand la boîte est inaccessible', async () => {
    assert.equal(
      await markAnswered('INBOX', 1, () => {
        throw new Error('dossier introuvable');
      }),
      false,
    );
  });
});
