import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addressList,
  buildReplyHeaders,
  forwardSubject,
  normalizeSubject,
  replyReferences,
  replySubject,
} from '../src/imap/threading.js';
import type { ThreadableMessage } from '../src/imap/threading.js';

function message(overrides: Partial<ThreadableMessage> = {}): ThreadableMessage {
  return {
    subject: 'Facture de juillet',
    messageId: '<original@icloud.com>',
    references: [],
    from: [{ name: 'Alice', address: 'alice@example.com' }],
    ...overrides,
  };
}

describe('replySubject', () => {
  it('préfixe un sujet simple', () => {
    assert.equal(replySubject('Facture'), 'Re: Facture');
  });

  it('ne double pas un préfixe existant, quelle que soit la casse', () => {
    assert.equal(replySubject('Re: Facture'), 'Re: Facture');
    assert.equal(replySubject('RE: Facture'), 'RE: Facture');
    assert.equal(replySubject('re: Facture'), 're: Facture');
  });

  it('retombe sur un sujet par défaut si le message n’en a pas', () => {
    assert.equal(replySubject(undefined), 'Re: (sans objet)');
  });

  it('ne confond pas un sujet qui commence par un mot en "re"', () => {
    assert.equal(replySubject('Rendez-vous demain'), 'Re: Rendez-vous demain');
    assert.equal(replySubject('Retard de livraison'), 'Re: Retard de livraison');
  });
});

describe('normalizeSubject', () => {
  it('retire un préfixe simple', () => {
    assert.equal(normalizeSubject('Re: Facture'), 'Facture');
    assert.equal(normalizeSubject('Fwd: Facture'), 'Facture');
  });

  it('retire les préfixes empilés en une passe', () => {
    assert.equal(normalizeSubject('Re: Re: Fwd: Facture de juillet'), 'Facture de juillet');
    assert.equal(normalizeSubject('RE: FW: RE: Rapport'), 'Rapport');
  });

  it('gère les compteurs "[2]" et les variantes de casse / langue', () => {
    assert.equal(normalizeSubject('Re[2]: Sujet'), 'Sujet');
    assert.equal(normalizeSubject('AW: WG: Betreff'), 'Betreff');
  });

  it('ne touche pas un sujet qui commence par un mot en "re"', () => {
    assert.equal(normalizeSubject('Rapport: bilan'), 'Rapport: bilan');
    assert.equal(normalizeSubject('Retard de livraison'), 'Retard de livraison');
  });

  it('renvoie une chaîne vide pour un sujet absent', () => {
    assert.equal(normalizeSubject(undefined), '');
    assert.equal(normalizeSubject(''), '');
  });

  it('normalise les espaces de bord', () => {
    assert.equal(normalizeSubject('  Re:   Sujet espacé  '), 'Sujet espacé');
  });
});

describe('forwardSubject', () => {
  it('préfixe un sujet simple', () => {
    assert.equal(forwardSubject('Facture'), 'Fwd: Facture');
  });

  it('ne double pas un préfixe existant, quelle que soit la casse', () => {
    assert.equal(forwardSubject('Fwd: Facture'), 'Fwd: Facture');
    assert.equal(forwardSubject('FWD: Facture'), 'FWD: Facture');
    assert.equal(forwardSubject('fwd: Facture'), 'fwd: Facture');
  });

  it('retombe sur un sujet par défaut si le message n’en a pas', () => {
    assert.equal(forwardSubject(undefined), 'Fwd: (sans objet)');
  });

  it('ne confond pas un sujet qui commence par un mot en "fw"', () => {
    assert.equal(forwardSubject('Fwuh, quelle semaine'), 'Fwd: Fwuh, quelle semaine');
  });
});

describe('addressList', () => {
  it('extrait les adresses', () => {
    assert.deepEqual(addressList([{ address: 'a@b.c' }, { address: 'd@e.f' }]), ['a@b.c', 'd@e.f']);
  });

  it('ignore les entrées sans adresse (groupes, en-têtes malformés)', () => {
    assert.deepEqual(addressList([{ name: 'Groupe sans adresse' }, { address: 'a@b.c' }]), ['a@b.c']);
  });

  it('renvoie une liste vide pour une liste vide', () => {
    assert.deepEqual(addressList([]), []);
  });
});

describe('replyReferences', () => {
  it('ajoute le Message-ID du message original à la fin de la chaîne', () => {
    const refs = replyReferences(message({ references: ['<premier@x>', '<second@x>'] }));
    assert.deepEqual(refs, ['<premier@x>', '<second@x>', '<original@icloud.com>']);
  });

  it('ne duplique pas un Message-ID déjà présent', () => {
    const refs = replyReferences(message({ references: ['<premier@x>', '<original@icloud.com>'] }));
    assert.deepEqual(refs, ['<premier@x>', '<original@icloud.com>']);
  });

  it('gère un message sans Message-ID', () => {
    assert.deepEqual(replyReferences(message({ messageId: undefined, references: ['<a@x>'] })), ['<a@x>']);
  });

  it('ne mute pas le tableau de références du message original', () => {
    const original = message({ references: ['<a@x>'] });
    replyReferences(original);
    assert.deepEqual(original.references, ['<a@x>']);
  });
});

describe('buildReplyHeaders', () => {
  it('construit des en-têtes de réponse complets', () => {
    const headers = buildReplyHeaders(message({ references: ['<a@x>'] }));
    assert.deepEqual(headers, {
      subject: 'Re: Facture de juillet',
      inReplyTo: '<original@icloud.com>',
      references: ['<a@x>', '<original@icloud.com>'],
      to: ['alice@example.com'],
    });
  });

  it('renvoie une liste de destinataires vide si le message original n’a pas de From exploitable', () => {
    assert.deepEqual(buildReplyHeaders(message({ from: [] })).to, []);
  });

  it('produit le même threading pour un envoi et pour un brouillon', () => {
    // sendReply (SMTP) et saveDraft (IMAP APPEND) partagent cette fonction :
    // ce test verrouille l'invariant qui justifie l'extraction.
    const original = message({ references: ['<a@x>', '<b@x>'] });
    assert.deepEqual(buildReplyHeaders(original), buildReplyHeaders(original));
  });
});

describe('buildReplyHeaders — replyAll', () => {
  const self = 'moi@icloud.com';

  function threadMessage(): ThreadableMessage {
    return message({
      from: [{ address: 'alice@example.com' }],
      to: [
        { address: 'moi@icloud.com' },
        { address: 'Bob@Example.com' },
        { address: 'alice@example.com' },
      ],
      cc: [{ address: 'carol@example.com' }, { address: 'MOI@icloud.com' }],
    });
  }

  it('sans replyAll : to = expéditeur, pas de cc', () => {
    const headers = buildReplyHeaders(threadMessage(), { selfAddress: self });
    assert.deepEqual(headers.to, ['alice@example.com']);
    assert.equal(headers.cc, undefined);
  });

  it('replyAll : self exclu de to et de cc, dédoublonnage insensible à la casse', () => {
    const headers = buildReplyHeaders(threadMessage(), { replyAll: true, selfAddress: self });
    // alice (from) + Bob (to), moi retiré, alice dédoublonnée
    assert.deepEqual(headers.to, ['alice@example.com', 'Bob@Example.com']);
    // carol seule : MOI@icloud.com retiré (self, casse ignorée)
    assert.deepEqual(headers.cc, ['carol@example.com']);
  });

  it('replyAll : une adresse déjà dans to n’est pas répétée dans cc', () => {
    const headers = buildReplyHeaders(
      message({
        from: [{ address: 'alice@example.com' }],
        to: [{ address: 'dan@example.com' }],
        cc: [{ address: 'DAN@example.com' }, { address: 'erin@example.com' }],
      }),
      { replyAll: true, selfAddress: self },
    );
    assert.deepEqual(headers.to, ['alice@example.com', 'dan@example.com']);
    assert.deepEqual(headers.cc, ['erin@example.com']);
  });

  it('un cc explicite l’emporte sur le cc déduit', () => {
    const headers = buildReplyHeaders(threadMessage(), {
      replyAll: true,
      selfAddress: self,
      cc: ['support@example.com'],
    });
    assert.deepEqual(headers.cc, ['support@example.com']);
  });

  it('un cc explicite vide neutralise le cc déduit', () => {
    const headers = buildReplyHeaders(threadMessage(), {
      replyAll: true,
      selfAddress: self,
      cc: [],
    });
    assert.equal(headers.cc, undefined);
  });

  it('ne vide jamais to, même si le message vient de nous', () => {
    const headers = buildReplyHeaders(
      message({ from: [{ address: 'moi@icloud.com' }] }),
      { selfAddress: self },
    );
    assert.deepEqual(headers.to, ['moi@icloud.com']);
  });
});
