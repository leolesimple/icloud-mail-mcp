import './helpers/env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { listFoldersOn, manageFolderOn } from '../src/imap/folders.js';
import { ImapCommandError } from '../src/imap/errors.js';
import { FakeMail } from './helpers/fake-imap.js';

function account(): FakeMail {
  const mail = new FakeMail()
    .addMailbox('INBOX', { specialUse: '\\Inbox' })
    .addMailbox('Sent Messages', { specialUse: '\\Sent' })
    .addMailbox('Archive', { specialUse: '\\Archive' })
    .addMailbox('Deleted Messages', { specialUse: '\\Trash' })
    .addMailbox('Projets')
    .addMailbox('Conteneur', { noSelect: true });

  mail.addMessage('INBOX', { uid: 1 });
  mail.addMessage('INBOX', { uid: 2, flags: ['\\Seen'] });
  mail.addMessage('INBOX', { uid: 3 });
  mail.addMessage('Projets', { uid: 4, flags: ['\\Seen'] });
  return mail;
}

describe('listFoldersOn (B4)', () => {
  it('ajoute messages / unseen par dossier quand includeStatus est vrai', async () => {
    const mail = account();
    const folders = await listFoldersOn(mail.asImapFlow(), true);

    const inbox = folders.find((f) => f.path === 'INBOX')!;
    assert.equal(inbox.messages, 3);
    assert.equal(inbox.unseen, 2);

    const projets = folders.find((f) => f.path === 'Projets')!;
    assert.equal(projets.messages, 1);
    assert.equal(projets.unseen, 0);
  });

  it('n’émet aucun STATUS quand includeStatus est faux', async () => {
    const mail = account();
    const folders = await listFoldersOn(mail.asImapFlow(), false);

    assert.equal(mail.counters.status, 0);
    assert.ok(folders.every((f) => f.messages === undefined && f.unseen === undefined));
  });

  it('laisse un conteneur \\Noselect sans compteurs plutôt que d’échouer', async () => {
    const mail = account();
    const folders = await listFoldersOn(mail.asImapFlow(), true);

    const conteneur = folders.find((f) => f.path === 'Conteneur')!;
    assert.equal(conteneur.messages, undefined);
    assert.equal(conteneur.unseen, undefined);
  });
});

describe('manageFolderOn (B2)', () => {
  it('crée un dossier', async () => {
    const mail = account();
    const result = await manageFolderOn(mail.asImapFlow(), 'create', 'Factures');
    assert.deepEqual(result, { action: 'create', path: 'Factures' });
    assert.ok(mail.mailboxes.has('Factures'));
  });

  it('renomme un dossier ordinaire', async () => {
    const mail = account();
    const result = await manageFolderOn(mail.asImapFlow(), 'rename', 'Projets', 'Projets 2026');
    assert.deepEqual(result, { action: 'rename', path: 'Projets', newPath: 'Projets 2026' });
    assert.ok(mail.mailboxes.has('Projets 2026'));
    assert.ok(!mail.mailboxes.has('Projets'));
  });

  it('supprime un dossier ordinaire', async () => {
    const mail = account();
    const result = await manageFolderOn(mail.asImapFlow(), 'delete', 'Projets');
    assert.deepEqual(result, { action: 'delete', path: 'Projets' });
    assert.ok(!mail.mailboxes.has('Projets'));
  });

  it('refuse de renommer ou supprimer un dossier à rôle système', async () => {
    for (const path of ['Sent Messages', 'Archive', 'Deleted Messages']) {
      await assert.rejects(
        () => manageFolderOn(account().asImapFlow(), 'delete', path),
        (err: Error) => err instanceof ImapCommandError && /rôle système/.test(err.message),
      );
      await assert.rejects(
        () => manageFolderOn(account().asImapFlow(), 'rename', path, `${path} bis`),
        ImapCommandError,
      );
    }
  });

  it('refuse de toucher INBOX', async () => {
    await assert.rejects(
      () => manageFolderOn(account().asImapFlow(), 'delete', 'INBOX'),
      (err: Error) => err instanceof ImapCommandError && /INBOX/.test(err.message),
    );
  });

  it('exige un chemin cible pour renommer', async () => {
    await assert.rejects(
      () => manageFolderOn(account().asImapFlow(), 'rename', 'Projets'),
      (err: Error) => err instanceof ImapCommandError && /newPath/.test(err.message),
    );
  });

  it('ne supprime rien quand le garde-fou se déclenche', async () => {
    const mail = account();
    await assert.rejects(() => manageFolderOn(mail.asImapFlow(), 'delete', 'Archive'), ImapCommandError);
    assert.ok(mail.mailboxes.has('Archive'));
  });
});
