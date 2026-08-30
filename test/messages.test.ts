import './helpers/env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FetchMessageObject } from 'imapflow';
import type { AddressObject } from 'mailparser';
import { toAddressList, toReferencesList, toSummary } from '../src/imap/messages.js';

function fetched(overrides: Partial<FetchMessageObject> = {}): FetchMessageObject {
  return {
    uid: 42,
    flags: new Set<string>(),
    size: 1024,
    envelope: {
      subject: 'Bonjour',
      from: [{ name: 'Alice', address: 'alice@example.com' }],
      to: [{ name: 'Bob', address: 'bob@example.com' }],
      date: new Date('2026-07-14T09:30:00.000Z'),
    },
    ...overrides,
  } as unknown as FetchMessageObject;
}

function addressObject(values: { name: string; address: string }[]): AddressObject {
  return { value: values, html: '', text: '' } as AddressObject;
}

describe('toSummary', () => {
  it('projette les champs d’enveloppe utiles', () => {
    const summary = toSummary(fetched());
    assert.equal(summary.uid, 42);
    assert.equal(summary.subject, 'Bonjour');
    assert.equal(summary.size, 1024);
    assert.deepEqual(summary.from, [{ name: 'Alice', address: 'alice@example.com' }]);
  });

  it('normalise la date en ISO 8601 UTC', () => {
    assert.equal(toSummary(fetched()).date, '2026-07-14T09:30:00.000Z');
  });

  it('laisse la date indéfinie si l’enveloppe n’en a pas', () => {
    const summary = toSummary(fetched({ envelope: { subject: 'Sans date' } as never }));
    assert.equal(summary.date, undefined);
  });

  it('traduit les flags IMAP en booléens', () => {
    const summary = toSummary(fetched({ flags: new Set(['\\Seen', '\\Flagged']) }));
    assert.equal(summary.seen, true);
    assert.equal(summary.flagged, true);
  });

  it('considère un message sans flag comme non lu et non favori', () => {
    const summary = toSummary(fetched());
    assert.equal(summary.seen, false);
    assert.equal(summary.flagged, false);
  });

  it('ignore les flags non pertinents', () => {
    const summary = toSummary(fetched({ flags: new Set(['\\Answered', '\\Draft']) }));
    assert.equal(summary.seen, false);
    assert.equal(summary.flagged, false);
  });

  it('survit à une enveloppe absente', () => {
    const summary = toSummary(fetched({ envelope: undefined }));
    assert.deepEqual(summary.from, []);
    assert.deepEqual(summary.to, []);
    assert.equal(summary.subject, undefined);
  });

  it('survit à un jeu de flags absent', () => {
    const summary = toSummary(fetched({ flags: undefined }));
    assert.equal(summary.seen, false);
  });
});

describe('toAddressList', () => {
  it('aplatit un objet d’adresses unique', () => {
    const list = toAddressList(addressObject([{ name: 'Alice', address: 'alice@example.com' }]));
    assert.deepEqual(list, [{ name: 'Alice', address: 'alice@example.com' }]);
  });

  it('aplatit un tableau d’objets d’adresses', () => {
    const list = toAddressList([
      addressObject([{ name: 'Alice', address: 'alice@example.com' }]),
      addressObject([{ name: 'Bob', address: 'bob@example.com' }]),
    ]);
    assert.equal(list.length, 2);
    assert.equal(list[1]?.address, 'bob@example.com');
  });

  it('renvoie une liste vide pour undefined', () => {
    assert.deepEqual(toAddressList(undefined), []);
  });
});

describe('toReferencesList', () => {
  it('normalise une référence unique en tableau', () => {
    assert.deepEqual(toReferencesList('<a@x>'), ['<a@x>']);
  });

  it('laisse un tableau inchangé', () => {
    assert.deepEqual(toReferencesList(['<a@x>', '<b@x>']), ['<a@x>', '<b@x>']);
  });

  it('renvoie une liste vide pour undefined', () => {
    assert.deepEqual(toReferencesList(undefined), []);
  });
});
