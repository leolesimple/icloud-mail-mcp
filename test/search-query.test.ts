import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchQuery, hasSearchCriteria, paginationExhausted } from '../src/imap/search-query.js';

describe('buildSearchQuery', () => {
  it('part sur ALL quand aucun critère texte n’est fourni', () => {
    assert.deepEqual(buildSearchQuery({}), { all: true });
  });

  it('reporte les critères texte tels quels', () => {
    assert.deepEqual(buildSearchQuery({ subject: 'facture', body: 'iban', from: 'banque', to: 'moi', text: 'urgent' }), {
      all: true,
      subject: 'facture',
      body: 'iban',
      from: 'banque',
      to: 'moi',
      text: 'urgent',
    });
  });

  it('ignore les chaînes vides', () => {
    assert.deepEqual(buildSearchQuery({ subject: '', from: 'x' }), { all: true, from: 'x' });
  });

  it('traduit unreadOnly en SEEN=false et flagged en FLAGGED=true', () => {
    assert.deepEqual(buildSearchQuery({ unreadOnly: true, flagged: true }), {
      all: true,
      seen: false,
      flagged: true,
    });
  });

  it('reporte les bornes de date', () => {
    const since = new Date('2026-07-01T00:00:00Z');
    const before = new Date('2026-08-01T00:00:00Z');
    assert.deepEqual(buildSearchQuery({ since, before }), { all: true, since, before });
  });

  describe('curseur beforeUid', () => {
    it('devient une plage UID « 1:(n-1) »', () => {
      assert.equal(buildSearchQuery({ beforeUid: 500 }).uid, '1:499');
    });

    it('est ignoré au-delà du début du dossier (beforeUid ≤ 1)', () => {
      assert.equal(buildSearchQuery({ beforeUid: 1 }).uid, undefined);
      assert.equal(buildSearchQuery({ beforeUid: 0 }).uid, undefined);
    });

    it('beforeUid = 2 ne renvoie que l’UID 1', () => {
      assert.equal(buildSearchQuery({ beforeUid: 2 }).uid, '1:1');
    });
  });

  describe('not', () => {
    it('devient un sous-objet SearchObject à exclure', () => {
      assert.deepEqual(buildSearchQuery({ subject: 'rapport', not: { from: 'noreply' } }), {
        all: true,
        subject: 'rapport',
        not: { from: 'noreply' },
      });
    });

    it('est ignoré si vide', () => {
      assert.deepEqual(buildSearchQuery({ subject: 'x', not: {} }), { all: true, subject: 'x' });
    });
  });

  describe('or', () => {
    it('devient un tableau de branches quand il y en a au moins deux', () => {
      assert.deepEqual(buildSearchQuery({ or: [{ from: 'alice' }, { from: 'bob' }] }), {
        all: true,
        or: [{ from: 'alice' }, { from: 'bob' }],
      });
    });

    it('une seule branche se replie en critère ET', () => {
      assert.deepEqual(buildSearchQuery({ subject: 'x', or: [{ from: 'alice' }] }), {
        all: true,
        subject: 'x',
        from: 'alice',
      });
    });

    it('ignore les branches vides', () => {
      assert.deepEqual(buildSearchQuery({ or: [{ from: 'alice' }, {}] }), { all: true, from: 'alice' });
    });
  });

  it('combine tout : texte, dates, flags, curseur, not et or', () => {
    const since = new Date('2026-01-01T00:00:00Z');
    assert.deepEqual(
      buildSearchQuery({
        subject: 'projet',
        unreadOnly: true,
        since,
        beforeUid: 100,
        not: { from: 'spam' },
        or: [{ to: 'equipe' }, { to: 'direction' }],
      }),
      {
        all: true,
        subject: 'projet',
        seen: false,
        since,
        uid: '1:99',
        not: { from: 'spam' },
        or: [{ to: 'equipe' }, { to: 'direction' }],
      },
    );
  });
});

describe('hasSearchCriteria', () => {
  it('est faux pour un objet vide ou réduit à la pagination', () => {
    assert.equal(hasSearchCriteria({}), false);
    assert.equal(hasSearchCriteria({ beforeUid: 42, limit: 50 } as never), false);
  });

  it('est vrai dès qu’un critère texte est fourni', () => {
    assert.equal(hasSearchCriteria({ subject: 'x' }), true);
    assert.equal(hasSearchCriteria({ text: 'x' }), true);
  });

  it('est vrai pour les critères non textuels', () => {
    assert.equal(hasSearchCriteria({ unreadOnly: true }), true);
    assert.equal(hasSearchCriteria({ flagged: true }), true);
    assert.equal(hasSearchCriteria({ since: new Date() }), true);
    assert.equal(hasSearchCriteria({ before: new Date() }), true);
  });

  it('est vrai pour un not ou un or non vide, faux sinon', () => {
    assert.equal(hasSearchCriteria({ not: { from: 'x' } }), true);
    assert.equal(hasSearchCriteria({ or: [{ from: 'x' }] }), true);
    assert.equal(hasSearchCriteria({ not: {} }), false);
    assert.equal(hasSearchCriteria({ or: [{}] }), false);
  });
});

describe('paginationExhausted', () => {
  it('est faux tant qu’aucun curseur n’est posé', () => {
    assert.equal(paginationExhausted(undefined), false);
  });

  it('devient vrai à partir de beforeUid ≤ 1', () => {
    assert.equal(paginationExhausted(2), false);
    assert.equal(paginationExhausted(1), true);
    assert.equal(paginationExhausted(0), true);
  });
});
