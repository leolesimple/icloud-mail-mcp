import './helpers/env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SendQuota } from '../src/smtp/quota.js';
import type { Clock } from '../src/smtp/quota.js';

/**
 * Quota d'envoi glissant sur 24 h. Module pur : l'horloge est injectée, aucun
 * test n'attend réellement.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Horloge manuelle : `at` fixe l'instant courant. */
function fakeClock(start = 0): Clock & { at: (t: number) => void } {
  let current = start;
  return {
    now: () => current,
    at: (t: number) => {
      current = t;
    },
  };
}

describe('SendQuota', () => {
  it('0 = illimité : ne refuse jamais, quel que soit le nombre d’envois', () => {
    const clock = fakeClock();
    const quota = new SendQuota(0, clock);
    for (let i = 0; i < 1000; i += 1) {
      assert.equal(quota.wouldExceed(), false);
      quota.record();
    }
    assert.equal(quota.wouldExceed(), false);
  });

  it('une limite négative est aussi traitée comme illimitée', () => {
    const quota = new SendQuota(-1, fakeClock());
    quota.record();
    assert.equal(quota.wouldExceed(), false);
  });

  it('refuse une fois la limite atteinte', () => {
    const clock = fakeClock();
    const quota = new SendQuota(3, clock);

    assert.equal(quota.wouldExceed(), false);
    quota.record();
    quota.record();
    assert.equal(quota.wouldExceed(), false, '2 < 3');
    quota.record();
    assert.equal(quota.wouldExceed(), true, '3 >= 3');
    assert.equal(quota.count(), 3);
  });

  it('libère un créneau quand un envoi sort de la fenêtre de 24 h', () => {
    const clock = fakeClock(1_000);
    const quota = new SendQuota(2, clock);

    quota.record(); // t = 1_000
    clock.at(61_000);
    quota.record(); // t = 61_000
    assert.equal(quota.wouldExceed(), true);

    // Juste avant que le premier envoi ne sorte de la fenêtre : toujours bloqué.
    clock.at(1_000 + DAY_MS - 1);
    assert.equal(quota.wouldExceed(), true);
    assert.equal(quota.count(), 2);

    // Le premier envoi (t=1_000) est maintenant hors fenêtre de 24 h.
    clock.at(1_000 + DAY_MS + 1);
    assert.equal(quota.count(), 1);
    assert.equal(quota.wouldExceed(), false);

    // Le second envoi expire à son tour.
    clock.at(61_000 + DAY_MS + 1);
    assert.equal(quota.count(), 0);
  });

  it('expose la limite configurée via max', () => {
    assert.equal(new SendQuota(42, fakeClock()).max, 42);
  });

  describe('status() — lecture seule', () => {
    it('ne consomme rien (appels répétés sans effet)', () => {
      const quota = new SendQuota(3, fakeClock());
      quota.record();
      quota.status();
      quota.status();
      assert.equal(quota.count(), 1, 'status() ne doit pas incrémenter le compteur');
      assert.equal(quota.status().remaining, 2);
    });

    it('illimité : unlimited=true et remaining=null (pas 0 ambigu)', () => {
      const quota = new SendQuota(0, fakeClock());
      quota.record();
      const s = quota.status();
      assert.equal(s.unlimited, true);
      assert.equal(s.remaining, null);
      assert.equal(s.used, 1);
      assert.equal(s.limit, 0);
    });

    it('donne resetsAt = plus ancien envoi + 24 h', () => {
      const clock = fakeClock(1_000);
      const quota = new SendQuota(5, clock);
      assert.equal(quota.status().resetsAt, undefined);
      quota.record(); // t = 1_000
      clock.at(5_000);
      quota.record(); // t = 5_000
      assert.equal(quota.status().resetsAt?.getTime(), 1_000 + DAY_MS);
    });
  });
});
