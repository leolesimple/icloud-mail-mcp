import './helpers/env.js';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SendQuota, fileStore, memoryStore, quotaStoreFor } from '../src/smtp/quota.js';
import type { Clock, QuotaStore } from '../src/smtp/quota.js';

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

describe('SendQuota — persistance (QUOTA_STATE_PATH)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quota-test-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  let n = 0;
  /** Chemin neuf, dans un sous-dossier inexistant pour vérifier le mkdir -p. */
  const freshPath = () => join(dir, `run-${(n += 1)}`, 'data', 'send-quota.json');
  const silent = () => {};

  it('le compteur survit à une nouvelle instance (redémarrage)', () => {
    const path = freshPath();
    const clock = fakeClock(1_000);
    const first = new SendQuota(3, clock, fileStore(path, silent));
    first.record();
    clock.at(2_000);
    first.record();
    assert.ok(existsSync(path), 'le dossier parent est créé et le fichier écrit');

    const second = new SendQuota(3, clock, fileStore(path, silent));
    assert.equal(second.count(), 2);
    second.record();
    assert.equal(second.wouldExceed(), true);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { sends: [1_000, 2_000, 2_000] });
  });

  it('la fenêtre de 24 h s’applique après rechargement', () => {
    const path = freshPath();
    const clock = fakeClock(1_000);
    const first = new SendQuota(2, clock, fileStore(path, silent));
    first.record(); // t = 1_000
    clock.at(61_000);
    first.record(); // t = 61_000

    // Redémarrage après expiration du premier envoi seulement.
    clock.at(1_000 + DAY_MS + 1);
    const second = new SendQuota(2, clock, fileStore(path, silent));
    assert.equal(second.count(), 1);
    assert.equal(second.wouldExceed(), false);
    assert.equal(second.status().resetsAt?.getTime(), 61_000 + DAY_MS);

    // Le prochain envoi réécrit le fichier sans l'horodatage expiré.
    second.record();
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
      sends: [61_000, 1_000 + DAY_MS + 1],
    });
  });

  it('fichier absent : état vide, sans avertissement', () => {
    const warnings: string[] = [];
    const quota = new SendQuota(
      1,
      fakeClock(),
      fileStore(freshPath(), (_o, m) => warnings.push(m)),
    );
    assert.equal(quota.count(), 0);
    assert.deepEqual(warnings, []);
  });

  for (const [label, content] of [
    ['JSON invalide', '{pas du json'],
    ['format inattendu', JSON.stringify({ sends: ['hier', 12] })],
    ['racine non objet', 'null'],
  ] as const) {
    it(`fichier corrompu (${label}) : warn et état vide, sans crash`, () => {
      const path = join(dir, `corrupt-${(n += 1)}.json`);
      writeFileSync(path, content);
      const warnings: string[] = [];
      const clock = fakeClock(1_000);
      const quota = new SendQuota(
        2,
        clock,
        fileStore(path, (_o, m) => warnings.push(m)),
      );
      assert.equal(quota.count(), 0);
      assert.equal(warnings.length, 1);

      // Le prochain envoi remplace le fichier corrompu par un état sain.
      quota.record();
      assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { sends: [1_000] });
    });
  }

  it('chemin vide : stockage mémoire, aucune écriture', () => {
    const store = quotaStoreFor('');
    assert.equal(store, memoryStore);

    const quota = new SendQuota(2, fakeClock(), store);
    quota.record();
    assert.equal(quota.count(), 1);
    assert.equal(
      new SendQuota(2, fakeClock(), quotaStoreFor('')).count(),
      0,
      'rien n’a été persisté',
    );
  });

  it('record() délègue la sauvegarde au stockage injecté', () => {
    const saves: number[][] = [];
    const spy: QuotaStore = {
      load: () => [],
      save: (sends) => {
        saves.push([...sends]);
      },
    };
    const quota = new SendQuota(2, fakeClock(5), spy);
    assert.deepEqual(saves, [], 'aucune écriture au chargement');
    quota.record();
    assert.deepEqual(saves, [[5]]);
  });
});
