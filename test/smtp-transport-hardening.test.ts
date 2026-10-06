import './helpers/env.js';
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
process.env.ENABLE_SENDING = 'true';
let sends = 0;
let sendError: Error | undefined;
let capturedRaw: Buffer | undefined;
mock.method(nodemailer, 'createTransport', () => ({
  sendMail: async (input: { raw: Buffer }) => {
    sends++;
    capturedRaw = input.raw;
    if (sendError) throw sendError;
    return { accepted: ['x@example.com'], rejected: [], messageId: '<x>' };
  },
  close() {},
}));
const { sendMail } = await import('../src/smtp/client.js');
const { sendDraftOn } = await import('../src/imap/drafts.js');
const { FakeMail } = await import('./helpers/fake-imap.js');
const raw = Buffer.from('To: x@example.com\r\nBcc: secret@example.com\r\nSubject: S\r\n\r\nBody');

describe('SMTP/draft hardening without network', () => {
  it('does not retry a network error with uncertain delivery', async () => {
    sends = 0;
    sendError = Object.assign(new Error('socket closed after DATA'), { code: 'ESOCKET' });
    await assert.rejects(() =>
      sendMail({ to: ['x@example.com'], subject: 'S', text: 'b' }, async () => true),
    );
    assert.equal(sends, 1);
    sendError = undefined;
  });
  it('preserves SMTP success even if archiving throws', async () => {
    const result = await sendMail({ to: ['x@example.com'], subject: 'S', text: 'b' }, async () => {
      throw new Error('append failed');
    });
    assert.equal(result.savedToSent, false);
    assert.equal(result.accepted.length, 1);
  });
  it('archives exactly once using the current connection and strips Bcc', async () => {
    const mail = new FakeMail().addMailbox('Drafts').addMailbox('Sent');
    mail.addMessage('Drafts', { uid: 501, source: raw });
    const result = await sendDraftOn(mail.asImapFlow(), 'Drafts', 'Sent', 501);
    assert.equal(result.draftDeleted, true);
    assert.equal(mail.counters.append, 1);
    assert.equal(mail.messagesIn('Sent').length, 1);
    assert.equal((await simpleParser(capturedRaw!)).bcc, undefined);
    await assert.rejects(
      () => sendDraftOn(mail.asImapFlow(), 'Drafts', 'Sent', 501),
      /introuvable/,
    );
  });
  it('allows only one concurrent send of the same draft', async () => {
    const mail = new FakeMail().addMailbox('Drafts').addMailbox('Sent');
    mail.addMessage('Drafts', { uid: 504, source: raw });
    const before = sends;
    const results = await Promise.allSettled([
      sendDraftOn(mail.asImapFlow(), 'Drafts', 'Sent', 504),
      sendDraftOn(mail.asImapFlow(), 'Drafts', 'Sent', 504),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
    assert.equal(sends, before + 1);
    assert.equal(mail.counters.append, 1);
  });

  it('keeps the sent draft as a recoverable copy when archiving fails', async () => {
    const mail = new FakeMail().addMailbox('Drafts').addMailbox('Sent');
    mail.addMessage('Drafts', { uid: 503, source: raw });
    mail.append = async () => {
      throw new Error('append failed');
    };
    const result = await sendDraftOn(mail.asImapFlow(), 'Drafts', 'Sent', 503);
    assert.ok(result.send);
    assert.equal(result.copiedToSent, false);
    assert.equal(result.draftDeleted, false);
    assert.equal(mail.messagesIn('Drafts').length, 1);
    await assert.rejects(
      () => sendDraftOn(mail.asImapFlow(), 'Drafts', 'Sent', 503),
      /déjà envoyé/,
    );
  });

  it('returns successful delivery after cleanup failure and prevents resend', async () => {
    const mail = new FakeMail().addMailbox('Drafts').addMailbox('Sent');
    mail.addMessage('Drafts', { uid: 502, source: raw });
    mail.messageDelete = async () => {
      throw new Error('delete failed');
    };
    const result = await sendDraftOn(mail.asImapFlow(), 'Drafts', 'Sent', 502);
    assert.ok(result.send);
    assert.equal(result.draftDeleted, false);
    const before = sends;
    await assert.rejects(() => sendDraftOn(mail.asImapFlow(), 'Drafts', 'Sent', 502));
    assert.equal(sends, before);
  });
});
