import './helpers/env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SlidingWindowRateLimiter } from '../src/http/rate-limit.js';
import type { Clock } from '../src/http/rate-limit.js';

/**
 * Limiteur de débit à fenêtre glissante. Module pur : horloge injectée, aucune
 * dépendance à Express ni au réseau.
 */

function fakeClock(start = 0): Clock & { at: (t: number) => void } {
  let current = start;
  return {
    now: () => current,
    at: (t: number) => {
      current = t;
    },
  };
}

describe('SlidingWindowRateLimiter', () => {
  it('autorise jusqu’à la limite, puis refuse', () => {
    const limiter = new SlidingWindowRateLimiter(3, 60_000, fakeClock());
    assert.equal(limiter.allow('ip'), true);
    assert.equal(limiter.allow('ip'), true);
    assert.equal(limiter.allow('ip'), true);
    assert.equal(limiter.allow('ip'), false);
    assert.equal(limiter.allow('ip'), false);
  });

  it('une requête refusée ne repousse pas la fenêtre', () => {
    const clock = fakeClock(0);
    const limiter = new SlidingWindowRateLimiter(1, 1_000, clock);

    assert.equal(limiter.allow('ip'), true); // hit à t=0
    clock.at(500);
    assert.equal(limiter.allow('ip'), false); // refusée, non comptée
    clock.at(1_001);
    // Seul le hit de t=0 comptait : il est sorti de la fenêtre.
    assert.equal(limiter.allow('ip'), true);
  });

  it('la fenêtre glisse : les hits anciens sont oubliés', () => {
    const clock = fakeClock(0);
    const limiter = new SlidingWindowRateLimiter(2, 1_000, clock);

    assert.equal(limiter.allow('ip'), true); // t=0
    clock.at(400);
    assert.equal(limiter.allow('ip'), true); // t=400
    clock.at(500);
    assert.equal(limiter.allow('ip'), false); // 2 hits dans [−500, 500]

    clock.at(1_001);
    assert.equal(limiter.allow('ip'), true, 'le hit de t=0 est hors fenêtre');
    clock.at(1_100);
    assert.equal(limiter.allow('ip'), false, 'hits de t=400 et t=1001 encore là');
  });

  it('isole les compteurs par clé (IP)', () => {
    const limiter = new SlidingWindowRateLimiter(1, 60_000, fakeClock());
    assert.equal(limiter.allow('10.0.0.1'), true);
    assert.equal(limiter.allow('10.0.0.1'), false);
    assert.equal(limiter.allow('10.0.0.2'), true, 'une autre IP a son propre budget');
    assert.equal(limiter.allow('10.0.0.2'), false);
  });

  it('sweep() retire les clés sans hit récent', () => {
    const clock = fakeClock(0);
    const limiter = new SlidingWindowRateLimiter(5, 1_000, clock);

    limiter.allow('a');
    limiter.allow('b');
    assert.equal(limiter.size, 2);

    clock.at(2_000);
    limiter.allow('b'); // b a un hit récent
    limiter.sweep();
    assert.equal(limiter.size, 1, 'a est purgée, b conservée');
  });
});
