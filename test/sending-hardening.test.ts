import './helpers/env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SendQuota } from '../src/smtp/quota.js';
import { composeRaw } from '../src/smtp/compose.js';
import { simpleParser } from 'mailparser';
import { confirmToolAction } from '../src/mcp/confirm-flow.js';
import { flagMessagesOn } from '../src/imap/mutations.js';
import { FakeMail } from './helpers/fake-imap.js';

describe('sending hardening', () => {
  it('reserves a single place atomically, including concurrent callers', async () => {
    const quota = new SendQuota(1);
    let started = 0;
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, async () => {
        quota.reserve();
        started++;
        await Promise.resolve();
      }),
    );
    assert.equal(started, 1);
    assert.equal(results.filter((r) => r.status === 'rejected').length, 4);
    assert.equal(quota.count(), 1);
  });
  it('releases a known failure once and retains uncertain sends', () => {
    const quota = new SendQuota(1);
    const place = quota.reserve();
    place.release();
    place.release();
    assert.equal(quota.count(), 0);
    quota.reserve();
    assert.throws(() => quota.reserve(), /Quota/);
  });
  it('keeps Bcc on stored drafts and strips it from outgoing MIME', async () => {
    const input = { to: ['to@example.com'], bcc: ['secret@example.com'], subject: 's', text: 'x' };
    const draft = await simpleParser(await composeRaw({ ...input, keepBcc: true }));
    assert.ok(draft.bcc);
    const outgoing = await simpleParser(await composeRaw(input));
    assert.equal(outgoing.bcc, undefined);
  });
  it('requires a server token, binds content, and consumes it once', async () => {
    let calls = 0;
    const host = {
      getClientCapabilities: () => undefined,
      elicitInput: async () => ({ action: 'cancel' as const }),
    };
    const execute = async () => {
      calls++;
      return { content: [] };
    };
    const input = { to: ['x@example.com'], text: 'original' };
    const first = await confirmToolAction(host, 'send', input, execute);
    assert.equal(calls, 0);
    const token = first.structuredContent?.confirmToken;
    assert.equal(typeof token, 'string');
    await assert.rejects(() =>
      confirmToolAction(host, 'send', { ...input, text: 'changed', confirmToken: token }, execute),
    );
    await confirmToolAction(host, 'send', { ...input, confirmToken: token }, execute);
    assert.equal(calls, 1);
    await assert.rejects(() =>
      confirmToolAction(host, 'send', { ...input, confirmToken: token }, execute),
    );
    assert.equal(calls, 1);
  });
  it('rejects injected system flags before issuing IMAP mutations', async () => {
    const mail = new FakeMail().addMailbox('INBOX');
    await assert.rejects(
      () => flagMessagesOn(mail.asImapFlow(), 'INBOX', [1], ['read'], ['\\Deleted']),
      /keywords/,
    );
  });
});
