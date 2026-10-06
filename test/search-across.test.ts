import './helpers/env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ImapFlow } from 'imapflow';
import { searchMessagesAcross } from '../src/imap/messages.js';
import { ImapAuthError } from '../src/imap/errors.js';
import { folderConcurrency, mapWithConcurrency } from '../src/imap/concurrency.js';
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Un `FakeMail` par dossier (une connexion IMAP n'a qu'une boîte sélectionnée à
 * la fois) et un faux `withMailbox` qui compte les dossiers fouillés en même
 * temps. `delays` fixe la durée de chaque dossier, pour croiser les fins.
 */
function parallelAccount(folders: Record<string, { uid: number; date?: string }[]>) {
  const mails = new Map<string, FakeMail>();
  for (const [folder, messages] of Object.entries(folders)) {
    const mail = new FakeMail().addMailbox(folder);
    for (const { uid, date } of messages) {
      mail.addMessage(folder, {
        uid,
        subject: 'Bonjour',
        ...(date ? { date: new Date(date) } : {}),
      });
    }
    mails.set(folder, mail);
  }
  const probe = { inFlight: 0, maxInFlight: 0, started: [] as string[] };
  const withMailboxFn =
    (delays: Record<string, number> = {}, failures: Record<string, Error> = {}) =>
    async <T>(folder: string, fn: (client: ImapFlow) => Promise<T>): Promise<T> => {
      probe.started.push(folder);
      probe.inFlight += 1;
      probe.maxInFlight = Math.max(probe.maxInFlight, probe.inFlight);
      try {
        await sleep(delays[folder] ?? 5);
        const failure = failures[folder];
        if (failure) throw failure;
        const mail = mails.get(folder);
        if (!mail) throw new Error(`Mailbox doesn't exist: ${folder}`);
        await mail.getMailboxLock(folder);
        return await fn(mail.asImapFlow());
      } finally {
        probe.inFlight -= 1;
      }
    };
  return { probe, withMailboxFn };
}

describe('searchMessagesAcross en parallèle', () => {
  const folders = {
    A: [
      { uid: 1, date: '2026-01-05' },
      { uid: 2, date: '2026-01-01' },
    ],
    B: [{ uid: 3, date: '2026-01-05' }],
    C: [{ uid: 4 }, { uid: 5, date: '2026-01-03' }],
    D: [{ uid: 6, date: '2026-01-04' }],
    E: [{ uid: 7, date: '2026-01-05' }],
    F: [{ uid: 8, date: '2026-01-02' }],
    G: [{ uid: 9, date: '2026-01-06' }],
  };
  const paths = ['A', 'B', 'Fantome', 'C', 'D', 'E', 'F', 'G'];

  it('ne fouille jamais plus de `concurrency` dossiers à la fois', async () => {
    const { probe, withMailboxFn } = parallelAccount(folders);
    await searchMessagesAcross(paths, { text: 'bonjour', limit: 50 }, withMailboxFn(), 3);

    assert.equal(probe.maxInFlight, 3);
    assert.equal(probe.inFlight, 0);
    assert.deepEqual(probe.started, paths, 'chaque dossier est fouillé une fois, dans l’ordre');
  });

  it('reste séquentiel avec une concurrence de 1', async () => {
    const { probe, withMailboxFn } = parallelAccount(folders);
    await searchMessagesAcross(paths, { text: 'bonjour', limit: 50 }, withMailboxFn(), 1);
    assert.equal(probe.maxInFlight, 1);
  });

  it('rend exactement le résultat séquentiel, quel que soit l’ordre de fin', async () => {
    // Les premiers dossiers finissent en dernier.
    const delays = { A: 40, B: 30, Fantome: 25, C: 20, D: 15, E: 10, F: 5, G: 1 };
    for (const limit of [50, 4, 1]) {
      const sequential = parallelAccount(folders);
      const parallel = parallelAccount(folders);
      const expected = await searchMessagesAcross(
        paths,
        { text: 'bonjour', limit },
        sequential.withMailboxFn(),
        1,
      );
      const actual = await searchMessagesAcross(
        paths,
        { text: 'bonjour', limit },
        parallel.withMailboxFn(delays),
        4,
      );
      assert.deepEqual(actual, expected, `limit ${limit}`);
    }
  });

  it('trie par date décroissante, ex aequo dans l’ordre des dossiers, puis tronque', async () => {
    const { withMailboxFn } = parallelAccount(folders);
    const result = await searchMessagesAcross(
      paths,
      { text: 'bonjour', limit: 5 },
      withMailboxFn({ A: 30, B: 20, E: 1 }),
      4,
    );
    assert.deepEqual(
      result.messages.map((m) => [m.folder, m.uid]),
      [
        ['G', 9],
        ['A', 1],
        ['B', 3],
        ['E', 7],
        ['D', 6],
      ],
    );
  });

  it('reporte les dossiers en échec dans l’ordre demandé, sans priver les autres', async () => {
    const { withMailboxFn } = parallelAccount(folders);
    const result = await searchMessagesAcross(
      ['Fantome', 'A', 'Inconnu'],
      { text: 'bonjour', limit: 50 },
      withMailboxFn({ Fantome: 30, Inconnu: 1 }),
      3,
    );
    assert.deepEqual(
      result.errors?.map((e) => e.folder),
      ['Fantome', 'Inconnu'],
    );
    assert.deepEqual(
      result.messages.map((m) => m.uid),
      [1, 2],
    );
  });

  it('propage une erreur d’authentification et ne lance plus de nouveau dossier', async () => {
    const { probe, withMailboxFn } = parallelAccount(folders);
    await assert.rejects(
      searchMessagesAcross(
        paths,
        { text: 'bonjour', limit: 50 },
        withMailboxFn({ A: 1, B: 50 }, { A: authError() }),
        2,
      ),
      ImapAuthError,
    );
    await sleep(60);
    assert.deepEqual(probe.started, ['A', 'B']);
  });
});

describe('folderConcurrency', () => {
  it('garde une connexion du pool libre, avec un minimum de 1', () => {
    assert.equal(folderConcurrency(4), 3);
    assert.equal(folderConcurrency(2), 1);
    assert.equal(folderConcurrency(1), 1);
  });
});

describe('mapWithConcurrency', () => {
  it('rend les résultats dans l’ordre des éléments', async () => {
    const result = await mapWithConcurrency([30, 1, 15, 5], 2, async (ms, index) => {
      await sleep(ms);
      return index;
    });
    assert.deepEqual(result, [0, 1, 2, 3]);
  });

  it('accepte une liste vide', async () => {
    assert.deepEqual(await mapWithConcurrency([], 3, async () => 1), []);
  });
});
