import './helpers/env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deleteMessagesOn, flagMessagesOn, moveMessagesOn } from '../src/imap/mutations.js';
import { FakeMail } from './helpers/fake-imap.js';

function account(): FakeMail {
  const mail = new FakeMail()
    .addMailbox('INBOX')
    .addMailbox('Archive', { specialUse: '\\Archive' })
    .addMailbox('Deleted Messages', { specialUse: '\\Trash' });
  for (const uid of [10, 11, 12, 13, 14]) {
    mail.addMessage('INBOX', { uid, subject: `n°${uid}`, from: [{ address: 'news@example.com' }] });
  }
  return mail.select('INBOX');
}

describe('moveMessagesOn (B1)', () => {
  it('déplace N messages en une seule commande IMAP', async () => {
    const mail = account();
    const results = await moveMessagesOn(mail.asImapFlow(), 'INBOX', [10, 11, 12, 13], 'Archive');

    assert.equal(mail.counters.move, 1, 'une seule commande MOVE pour 4 UID');
    assert.deepEqual(
      results.map((r) => [r.uid, r.ok]),
      [
        [10, true],
        [11, true],
        [12, true],
        [13, true],
      ],
    );
    assert.equal(mail.messagesIn('INBOX').length, 1);
    assert.equal(mail.messagesIn('Archive').length, 4);
  });

  it('signale un échec partiel par UID sans faire échouer le lot', async () => {
    const mail = account();
    const results = await moveMessagesOn(mail.asImapFlow(), 'INBOX', [10, 999, 12], 'Archive');

    assert.deepEqual(
      results.map((r) => [r.uid, r.ok]),
      [
        [10, true],
        [12, true],
        [999, false],
      ],
    );
    assert.match(results.find((r) => r.uid === 999)!.error!, /introuvable/);
    assert.equal(mail.counters.move, 1);
    assert.equal(mail.messagesIn('Archive').length, 2);
  });

  it('déduplique les UID fournis en double', async () => {
    const mail = account();
    const results = await moveMessagesOn(mail.asImapFlow(), 'INBOX', [10, 10, 11], 'Archive');
    assert.deepEqual(
      results.map((r) => r.uid),
      [10, 11],
    );
  });
});

describe('deleteMessagesOn (B1)', () => {
  it('déplace en masse vers la corbeille depuis un autre dossier', async () => {
    const mail = account();
    const outcome = await deleteMessagesOn(mail.asImapFlow(), 'INBOX', [10, 11, 12]);

    assert.equal(outcome.action, 'moved_to_trash');
    assert.equal(outcome.destination, 'Deleted Messages');
    assert.equal(mail.counters.move, 1, 'une seule commande pour 3 UID');
    assert.equal(mail.counters.delete, 0);
    assert.equal(mail.messagesIn('Deleted Messages').length, 3);
  });

  it('expurge en masse quand on est déjà dans la corbeille', async () => {
    const mail = account();
    mail.addMessage('Deleted Messages', { uid: 50 });
    mail.addMessage('Deleted Messages', { uid: 51 });

    const outcome = await deleteMessagesOn(mail.asImapFlow(), 'Deleted Messages', [50, 51]);

    assert.equal(outcome.action, 'expunged');
    assert.equal(outcome.destination, undefined);
    assert.equal(mail.counters.delete, 1, 'une seule commande EXPUNGE pour 2 UID');
    assert.equal(mail.counters.move, 0);
    assert.equal(mail.messagesIn('Deleted Messages').length, 0);
  });
});

describe('flagMessagesOn (B1)', () => {
  it('applique les ajouts de flags à N messages en une commande', async () => {
    const mail = account();
    const results = await flagMessagesOn(mail.asImapFlow(), 'INBOX', [10, 11, 12, 13, 14], ['read', 'flagged']);

    assert.equal(mail.counters.flagAdd, 1);
    assert.equal(results.length, 5);
    assert.ok(results.every((r) => r.ok));
    for (const message of mail.messagesIn('INBOX')) {
      assert.ok(message.flags.has('\\Seen'));
      assert.ok(message.flags.has('\\Flagged'));
    }
  });

  it('applique les ajouts avant les retraits, quel que soit l’ordre', async () => {
    const mail = account();
    await flagMessagesOn(mail.asImapFlow(), 'INBOX', [10], ['read', 'unread']);
    assert.equal(mail.counters.flagAdd, 1);
    assert.equal(mail.counters.flagRemove, 1);
    assert.equal(mail.messagesIn('INBOX')[0]!.flags.has('\\Seen'), false, 'le retrait gagne');
  });
});
