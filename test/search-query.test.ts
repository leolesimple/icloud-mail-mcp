import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSearchQuery,
  hasSearchCriteria,
  matchesLocalText,
  paginationExhausted,
  planSearch,
} from '../src/imap/search-query.js';

describe('buildSearchQuery', () => {
  it('part sur ALL quand aucun critère serveur n’est fourni', () => {
    assert.deepEqual(buildSearchQuery({}), { all: true });
  });

  it('n’envoie à SEARCH que body et text, jamais subject, from ni to', () => {
    assert.deepEqual(
      buildSearchQuery({ subject: 'facture', body: 'iban', from: 'banque', to: 'moi', text: 'urgent' }),
      { all: true, body: 'iban', text: 'urgent' },
    );
  });

  it('ignore les chaînes vides', () => {
    assert.deepEqual(buildSearchQuery({ body: '', text: 'x' }), { all: true, text: 'x' });
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
});

describe('planSearch', () => {
  it('sans critère local, pas de filtre local', () => {
    assert.deepEqual(planSearch({ body: 'iban', unreadOnly: true }), {
      query: { all: true, body: 'iban', seen: false },
    });
  });

  it('subject, from et to de premier niveau sont vérifiés localement', () => {
    assert.deepEqual(planSearch({ subject: 'facture', from: 'apple.com', to: 'moi', body: 'x' }), {
      query: { all: true, body: 'x' },
      local: { require: { subject: 'facture', from: 'apple.com', to: 'moi' } },
    });
  });

  describe('not', () => {
    it('reste un NOT serveur s’il ne contient que body/text', () => {
      assert.deepEqual(planSearch({ text: 'rapport', not: { body: 'brouillon' } }), {
        query: { all: true, text: 'rapport', not: { body: 'brouillon' } },
      });
    });

    it('devient une exclusion locale s’il contient un critère local', () => {
      assert.deepEqual(planSearch({ not: { from: 'noreply' } }), {
        query: { all: true },
        local: { require: {}, exclude: { text: { from: 'noreply' } } },
      });
    });

    it('mixte : la partie body/text devient un SEARCH dédié, borné par le curseur', () => {
      assert.deepEqual(planSearch({ beforeUid: 50, not: { from: 'noreply', body: 'pub' } }), {
        query: { all: true, uid: '1:49' },
        local: {
          require: {},
          exclude: { text: { from: 'noreply' }, server: { body: 'pub', uid: '1:49' } },
        },
      });
    });

    it('est ignoré si vide', () => {
      assert.deepEqual(planSearch({ text: 'x', not: {} }), { query: { all: true, text: 'x' } });
    });
  });

  describe('or', () => {
    it('reste un OR serveur quand toutes les branches ne contiennent que body/text', () => {
      assert.deepEqual(planSearch({ or: [{ body: 'alice' }, { text: 'bob' }] }), {
        query: { all: true, or: [{ body: 'alice' }, { text: 'bob' }] },
      });
    });

    it('est évalué localement dès qu’une branche contient un critère local', () => {
      assert.deepEqual(planSearch({ or: [{ from: 'alice' }, { body: 'bob' }] }), {
        query: { all: true },
        local: { require: {}, anyOf: [{ text: { from: 'alice' } }, { text: {}, server: { body: 'bob' } }] },
      });
    });

    it('une seule branche se replie en critère ET, réparti entre SEARCH et local', () => {
      assert.deepEqual(planSearch({ subject: 'x', or: [{ from: 'alice', body: 'devis' }] }), {
        query: { all: true, body: 'devis' },
        local: { require: { subject: 'x', from: 'alice' } },
      });
    });

    it('ignore les branches vides', () => {
      assert.deepEqual(planSearch({ or: [{ from: 'alice' }, {}] }), {
        query: { all: true },
        local: { require: { from: 'alice' } },
      });
    });
  });

  it('combine tout : texte, dates, flags, curseur, not et or', () => {
    const since = new Date('2026-01-01T00:00:00Z');
    assert.deepEqual(
      planSearch({
        subject: 'projet',
        body: 'budget',
        unreadOnly: true,
        since,
        beforeUid: 100,
        not: { from: 'spam' },
        or: [{ to: 'equipe' }, { to: 'direction' }],
      }),
      {
        query: { all: true, body: 'budget', seen: false, since, uid: '1:99' },
        local: {
          require: { subject: 'projet' },
          exclude: { text: { from: 'spam' } },
          anyOf: [{ text: { to: 'equipe' } }, { text: { to: 'direction' } }],
        },
      },
    );
  });
});

describe('matchesLocalText', () => {
  const envelope = {
    subject: 'Votre reçu d’Apple',
    from: [{ name: 'Apple', address: 'lesquatretemps@email.apple.com' }],
    to: [{ name: 'Léo', address: 'leo@icloud.com' }],
    cc: [{ address: 'compta@exemple.fr' }],
  };

  it('cherche une sous-chaîne sans casse dans l’adresse ou le nom affiché', () => {
    assert.equal(matchesLocalText(envelope, { from: 'APPLE.COM' }), true);
    assert.equal(matchesLocalText(envelope, { from: 'email.apple.com' }), true);
    assert.equal(matchesLocalText(envelope, { from: 'apple' }), true);
    assert.equal(matchesLocalText(envelope, { to: 'léo' }), true);
    assert.equal(matchesLocalText(envelope, { from: 'google' }), false);
  });

  it('to ne regarde que le champ To, comme SEARCH TO', () => {
    assert.equal(matchesLocalText(envelope, { to: 'compta' }), false);
  });

  it('compare le sujet décodé, quelle que soit la forme Unicode', () => {
    assert.equal(matchesLocalText(envelope, { subject: 'REÇU' }), true);
    assert.equal(matchesLocalText(envelope, { subject: 'rec\u0327u' }), true);
    assert.equal(matchesLocalText({}, { subject: 'reçu' }), false);
  });

  it('combine les critères en ET', () => {
    assert.equal(matchesLocalText(envelope, { from: 'apple', subject: 'reçu' }), true);
    assert.equal(matchesLocalText(envelope, { from: 'apple', subject: 'facture' }), false);
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
    // Vérifiés localement, ils restent des critères de recherche.
    assert.equal(hasSearchCriteria({ from: 'x' }), true);
    assert.equal(hasSearchCriteria({ to: 'x' }), true);
    assert.equal(hasSearchCriteria({ not: { subject: 'x' } }), true);
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
