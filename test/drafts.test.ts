import './helpers/env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sendDraftOn, updateDraftOn } from '../src/imap/drafts.js';
import { SmtpMessageError } from '../src/smtp/errors.js';
import { FakeMail } from './helpers/fake-imap.js';

function rawDraft(lines: string[]): Buffer {
  return Buffer.from([...lines, '', 'Corps du brouillon.', ''].join('\r\n'));
}

describe('updateDraftOn (B3)', () => {
  it('APPEND de la nouvelle version puis suppression de l’ancienne', async () => {
    const mail = new FakeMail().addMailbox('Drafts', { specialUse: '\\Drafts' });
    mail.addMessage('Drafts', { uid: 100, subject: 'v1', flags: ['\\Draft'] });

    const result = await updateDraftOn(mail.asImapFlow(), 'Drafts', 100, {
      to: ['dest@example.com'],
      subject: 'v2',
      text: 'nouveau corps',
    });

    assert.equal(result.replacedUid, 100);
    assert.equal(result.folder, 'Drafts');
    assert.notEqual(result.uid, 100);

    const drafts = mail.messagesIn('Drafts');
    assert.equal(drafts.length, 1, 'exactement un brouillon reste');
    assert.equal(drafts[0]!.uid, result.uid);
    assert.match(drafts[0]!.source!.toString('utf8'), /Subject: v2/i);
    assert.equal(mail.counters.append, 1);
  });

  it('l’écriture précède la suppression : un doublon transitoire, jamais une perte', async () => {
    const mail = new FakeMail().addMailbox('Drafts', { specialUse: '\\Drafts' });
    mail.addMessage('Drafts', { uid: 7, subject: 'ancien', flags: ['\\Draft'] });

    // messageDelete instrumenté : on capture l'état du dossier au moment de la suppression.
    const realDelete = mail.messageDelete.bind(mail);
    let countAtDelete = -1;
    mail.messageDelete = async (range) => {
      countAtDelete = mail.messagesIn('Drafts').length;
      return realDelete(range);
    };

    await updateDraftOn(mail.asImapFlow(), 'Drafts', 7, {
      to: ['dest@example.com'],
      subject: 'récent',
      text: 'x',
    });

    assert.equal(countAtDelete, 2, 'la nouvelle version est déjà en place quand l’ancienne est supprimée');
  });
});

describe('sendDraftOn (B3)', () => {
  it('respecte le coupe-circuit ENABLE_SENDING et laisse le brouillon intact', async () => {
    const mail = new FakeMail()
      .addMailbox('Drafts', { specialUse: '\\Drafts' })
      .addMailbox('Sent Messages', { specialUse: '\\Sent' });
    mail.addMessage('Drafts', {
      uid: 200,
      flags: ['\\Draft'],
      source: rawDraft(['From: test@example.com', 'To: dest@example.com', 'Subject: Prêt', 'Message-ID: <d@x>']),
    });

    await assert.rejects(
      () => sendDraftOn(mail.asImapFlow(), 'Drafts', 'Sent Messages', 200),
      (err: Error) => err instanceof SmtpMessageError && /ENABLE_SENDING=false/.test(err.message),
    );

    assert.equal(mail.messagesIn('Drafts').length, 1, 'brouillon conservé quand l’envoi échoue');
    assert.equal(mail.messagesIn('Sent Messages').length, 0, 'rien n’est copié dans Sent');
  });

  it('échoue proprement si le brouillon est introuvable', async () => {
    const mail = new FakeMail().addMailbox('Drafts', { specialUse: '\\Drafts' });
    await assert.rejects(
      () => sendDraftOn(mail.asImapFlow(), 'Drafts', undefined, 999),
      /introuvable/,
    );
  });

  it('refuse un brouillon sans destinataire avant toute tentative d’envoi', async () => {
    const mail = new FakeMail().addMailbox('Drafts', { specialUse: '\\Drafts' });
    mail.addMessage('Drafts', {
      uid: 300,
      flags: ['\\Draft'],
      source: rawDraft(['From: test@example.com', 'Subject: Sans destinataire', 'Message-ID: <e@x>']),
    });

    await assert.rejects(
      () => sendDraftOn(mail.asImapFlow(), 'Drafts', undefined, 300),
      /destinataire/,
    );
    assert.equal(mail.messagesIn('Drafts').length, 1);
  });
});
