import './helpers/env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { buildWhoami } from '../src/mcp/whoami.js';

// Valeurs posées par test/helpers/env.ts — ce sont les « secrets » factices qui
// ne doivent jamais apparaître dans la sortie de whoami.
const APP_PASSWORD = process.env.ICLOUD_APP_PASSWORD as string;
const BEARER_TOKEN = process.env.MCP_BEARER_TOKEN as string;

const noPool = () => ({ open: 0, inUse: 0, max: 2 });

describe('buildWhoami', () => {
  it('décrit le compte, le serveur et le pool IMAP', async () => {
    const report = await buildWhoami(false, { poolStats: noPool });

    assert.equal(report.account.email, 'test@example.com');
    assert.equal(report.account.imap.host, 'imap.mail.me.com');
    assert.equal(report.account.imap.port, 993);
    assert.equal(report.account.smtp.host, 'smtp.mail.me.com');
    assert.equal(report.account.smtp.port, 587);
    assert.equal(report.server.name, 'icloud-mail');
    assert.match(report.server.version, /^\d+\.\d+\.\d+/);
    assert.deepEqual(report.imapPool, { open: 0, inUse: 0, max: 2 });
  });

  it('expose les identifiants comme des booléens « configuré », jamais leur valeur', async () => {
    const report = await buildWhoami(false, { poolStats: noPool });
    assert.equal(report.credentials.appPasswordConfigured, true);
    assert.equal(report.credentials.bearerTokenConfigured, true);
  });

  it('reflète ENABLE_SENDING (false dans l’environnement de test)', async () => {
    const report = await buildWhoami(false, { poolStats: noPool });
    assert.equal(report.guardrails.sendingEnabled, false);
  });

  it('rapporte tous les garde-fous, tels que la configuration validée les définit', async () => {
    const report = await buildWhoami(false, { poolStats: noPool });

    // Les clés viennent de src/config.ts : elles ont toujours une valeur, jamais undefined.
    assert.equal(report.guardrails.sendingEnabled, config.ENABLE_SENDING);
    assert.equal(report.guardrails.draftsOnly, config.DRAFTS_ONLY);
    assert.equal(report.guardrails.unrestricted, config.UNRESTRICTED);
    assert.equal(report.guardrails.maxSendsPerDay, config.MAX_SENDS_PER_DAY);
  });

  it('traite une allowlist vide comme inactive', async () => {
    const report = await buildWhoami(false, { poolStats: noPool });
    assert.equal(report.guardrails.allowlistActive, config.ALLOWED_RECIPIENTS_LIST.length > 0);
  });

  it('rapporte le quota d’envoi tel que le compte le module de quota', async () => {
    const report = await buildWhoami(false, {
      poolStats: noPool,
      quota: () => ({ windowHours: 24, limit: 50, unlimited: false, used: 3, remaining: 47 }),
    });
    assert.deepEqual(report.guardrails.quota, {
      windowHours: 24,
      limit: 50,
      unlimited: false,
      used: 3,
      remaining: 47,
    });
  });

  it('signale un quota illimité sans le confondre avec un quota épuisé', async () => {
    const report = await buildWhoami(false, {
      poolStats: noPool,
      quota: () => ({ windowHours: 24, limit: 0, unlimited: true, used: 12, remaining: null }),
    });
    assert.equal(report.guardrails.quota?.unlimited, true);
    assert.equal(report.guardrails.quota?.remaining, null);
  });

  it('rapporte le résultat d’une sonde de connexion réussie', async () => {
    const report = await buildWhoami(true, {
      poolStats: noPool,
      probe: async () => ({ folderCount: 12 }),
    });
    assert.deepEqual(report.probe, { attempted: true, ok: true, folderCount: 12 });
  });

  it('rapporte un échec de sonde sans propager l’erreur', async () => {
    const report = await buildWhoami(true, {
      poolStats: noPool,
      probe: async () => {
        throw Object.assign(new Error('Invalid credentials'), { authenticationFailed: true });
      },
    });
    assert.equal(report.probe?.attempted, true);
    assert.equal(report.probe?.ok, false);
    assert.match(report.probe?.error ?? '', /Authentification/);
  });

  it('ne sonde pas quand probe vaut false', async () => {
    let called = false;
    const report = await buildWhoami(false, {
      poolStats: noPool,
      probe: async () => {
        called = true;
        return { folderCount: 0 };
      },
    });
    assert.equal(called, false);
    assert.equal(report.probe, undefined);
  });

  describe('aucun secret dans la sortie sérialisée', () => {
    it('ni mot de passe d’application ni bearer token, sonde comprise', async () => {
      const reports = await Promise.all([
        buildWhoami(false, { poolStats: noPool }),
        buildWhoami(true, { poolStats: noPool, probe: async () => ({ folderCount: 3 }) }),
        buildWhoami(true, {
          poolStats: noPool,
          probe: async () => {
            throw new Error(`échec avec ${APP_PASSWORD}`);
          },
        }),
      ]);

      for (const report of reports) {
        const json = JSON.stringify(report);
        assert.ok(!json.includes(APP_PASSWORD), 'le mot de passe d’application ne doit pas apparaître');
        assert.ok(!json.includes(BEARER_TOKEN), 'le bearer token ne doit pas apparaître');
      }
    });
  });
});
