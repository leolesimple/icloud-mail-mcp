import './helpers/env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fetchPage } from '../src/imap/messages.js';
import type { SearchCriteria } from '../src/imap/search-query.js';
import { FakeMail } from './helpers/fake-imap.js';

/** Dossier INBOX peuplé d'UID contigus `first .. first+count-1`. */
function inbox(count: number, first = 1000): FakeMail {
  const mail = new FakeMail().addMailbox('INBOX');
  for (let i = 0; i < count; i += 1) {
    mail.addMessage('INBOX', {
      uid: first + i,
      subject: `Message ${first + i}`,
      date: new Date(Date.UTC(2026, 0, 1 + i)),
      from: [{ address: 'exp@example.com' }],
    });
  }
  return mail.select('INBOX');
}

const page = (mail: FakeMail, criteria: SearchCriteria, limit: number) =>
  fetchPage(mail.asImapFlow(), criteria, limit);

describe('fetchPage — pagination par curseur', () => {
  it('renvoie les plus récents en premier et un curseur = plus petit UID renvoyé', async () => {
    const result = await page(inbox(10), {}, 4);
    assert.deepEqual(
      result.messages.map((m) => m.uid),
      [1009, 1008, 1007, 1006],
    );
    assert.equal(result.nextCursor, 1006);
  });

  it('enchaîne les pages via beforeUid sans trou ni doublon', async () => {
    const mail = inbox(10);
    const seen: number[] = [];
    let cursor: number | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const result = await page(mail, { beforeUid: cursor }, 4);
      seen.push(...result.messages.map((m) => m.uid));
      if (result.nextCursor === undefined) break;
      cursor = result.nextCursor;
    }
    assert.deepEqual(seen, [1009, 1008, 1007, 1006, 1005, 1004, 1003, 1002, 1001, 1000]);
  });

  it('omet nextCursor sur la dernière page', async () => {
    const result = await page(inbox(6), { beforeUid: 1002 }, 4);
    assert.deepEqual(
      result.messages.map((m) => m.uid),
      [1001, 1000],
    );
    assert.equal(result.nextCursor, undefined);
  });

  it('omet nextCursor quand limit dépasse le nombre de messages', async () => {
    const result = await page(inbox(3), {}, 50);
    assert.equal(result.messages.length, 3);
    assert.equal(result.nextCursor, undefined);
  });

  it('renvoie exactement limit avec un curseur quand il reste pile un message', async () => {
    const result = await page(inbox(5), {}, 4);
    assert.equal(result.messages.length, 4);
    assert.equal(result.nextCursor, 1001);
    const next = await page(inbox(5), { beforeUid: 1001 }, 4);
    assert.deepEqual(
      next.messages.map((m) => m.uid),
      [1000],
    );
    assert.equal(next.nextCursor, undefined);
  });

  it('court-circuite sans commande IMAP quand le curseur a atteint le début', async () => {
    const mail = inbox(5);
    const before = mail.counters.search;
    const result = await page(mail, { beforeUid: 1 }, 4);
    assert.deepEqual(result, { messages: [] });
    assert.equal(mail.counters.search, before, 'aucun SEARCH ne doit partir');
  });

  it('combine un filtre et la pagination', async () => {
    const mail = inbox(10);
    mail.messagesIn('INBOX')[0]!.flags.add('\\Seen');
    mail.messagesIn('INBOX')[1]!.flags.add('\\Seen');
    const result = await page(mail, { unreadOnly: true }, 4);
    // UID 1000 et 1001 sont lus : ils sortent du résultat.
    assert.deepEqual(
      result.messages.map((m) => m.uid),
      [1009, 1008, 1007, 1006],
    );
    assert.equal(result.nextCursor, 1006);
  });
});
