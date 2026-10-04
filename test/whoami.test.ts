import './helpers/env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { buildWhoami } from '../src/mcp/whoami.js';
import { buildInboxOverview } from '../src/mcp/overview.js';
import type { InboxOverviewDeps } from '../src/mcp/overview.js';
import type { FolderInfo } from '../src/imap/folders.js';
import type { MessageSummary } from '../src/imap/messages.js';

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
        assert.ok(
          !json.includes(APP_PASSWORD),
          'le mot de passe d’application ne doit pas apparaître',
        );
        assert.ok(!json.includes(BEARER_TOKEN), 'le bearer token ne doit pas apparaître');
      }
    });
  });
});

// --- inbox_overview ---------------------------------------------------------

function summary(uid: number, seen: boolean): MessageSummary {
  return { uid, subject: `Message ${uid}`, from: [], to: [], seen, flagged: false };
}

function folder(
  path: string,
  counts: { messages?: number; unseen?: number } = {},
  specialUse?: string,
): FolderInfo {
  return {
    path,
    name: path,
    delimiter: '/',
    parentPath: '',
    flags: [],
    subscribed: true,
    specialUse,
    ...counts,
  };
}

/** Dépendances factices : aucune connexion IMAP, sonde comprise. */
function overviewDeps(
  overrides: Partial<InboxOverviewDeps> = {},
): InboxOverviewDeps & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    listInbox: async (opts) => {
      calls.push(opts);
      return opts.unreadOnly
        ? { messages: [summary(9, false), summary(7, false)].slice(0, opts.limit) }
        : {
            messages: [summary(10, true), summary(9, false), summary(8, true)].slice(0, opts.limit),
          };
    },
    listFolders: async () => [
      folder('INBOX', { messages: 120, unseen: 14 }),
      folder('Sent Messages', { messages: 30, unseen: 0 }, '\\Sent'),
      folder('Projets'),
    ],
    whoami: (probe) =>
      buildWhoami(probe, { poolStats: noPool, probe: async () => ({ folderCount: 3 }) }),
    ...overrides,
  };
}

describe('buildInboxOverview', () => {
  it('résume l’INBOX : compteurs STATUS, derniers non lus et derniers messages', async () => {
    const deps = overviewDeps();
    const overview = await buildInboxOverview({ limit: 2, includeDiagnostics: false }, deps);

    assert.equal(overview.account.email, 'test@example.com');
    assert.equal(overview.inbox.folder, 'INBOX');
    assert.equal(overview.inbox.total, 120);
    assert.equal(overview.inbox.unread, 14);
    assert.deepEqual(
      overview.inbox.recentUnread.map((m) => m.uid),
      [9, 7],
    );
    assert.deepEqual(
      overview.inbox.recent.map((m) => m.uid),
      [10, 9],
    );
    assert.deepEqual(deps.calls, [{ unreadOnly: true, limit: 2 }, { limit: 2 }]);
  });

  it('donne les compteurs de chaque dossier, sans les champs absents', async () => {
    const overview = await buildInboxOverview(
      { limit: 10, includeDiagnostics: false },
      overviewDeps(),
    );
    assert.deepEqual(overview.folders, [
      { path: 'INBOX', messages: 120, unseen: 14 },
      { path: 'Sent Messages', specialUse: '\\Sent', messages: 30, unseen: 0 },
      { path: 'Projets' },
    ]);
  });

  it('n’annonce pas la taille de la page comme total quand d’autres non lus existent', async () => {
    const overview = await buildInboxOverview(
      { limit: 2, includeDiagnostics: false },
      overviewDeps({
        listFolders: async () => [folder('INBOX')],
        listInbox: async (opts) => ({
          messages: [summary(9, false), summary(7, false)],
          ...(opts.unreadOnly ? { nextCursor: 7 } : {}),
        }),
      }),
    );
    assert.equal(overview.inbox.unread, undefined);
    assert.equal(overview.inbox.recentUnread.length, 2);
  });

  it('retombe sur le nombre de non lus renvoyés si l’INBOX n’a pas de STATUS', async () => {
    const overview = await buildInboxOverview(
      { limit: 10, includeDiagnostics: false },
      overviewDeps({ listFolders: async () => [folder('INBOX')] }),
    );
    assert.equal(overview.inbox.unread, 2);
    assert.equal(overview.inbox.total, undefined);
  });

  it('expose les garde-fous actifs, comme whoami', async () => {
    const overview = await buildInboxOverview(
      { limit: 10, includeDiagnostics: false },
      overviewDeps(),
    );
    assert.equal(overview.guardrails.sendingEnabled, config.ENABLE_SENDING);
    assert.equal(overview.guardrails.draftsOnly, config.DRAFTS_ONLY);
    assert.equal(overview.guardrails.allowlistActive, config.ALLOWED_RECIPIENTS_LIST.length > 0);
    assert.equal(overview.guardrails.maxSendsPerDay, config.MAX_SENDS_PER_DAY);
  });

  it('ne sonde pas et n’inclut pas de diagnostics par défaut', async () => {
    let probed = false;
    const overview = await buildInboxOverview(
      { limit: 10, includeDiagnostics: false },
      overviewDeps({
        whoami: (probe) => {
          probed = probe;
          return buildWhoami(probe, { poolStats: noPool });
        },
      }),
    );
    assert.equal(probed, false);
    assert.equal(overview.diagnostics, undefined);
  });

  it('inclut la sonde et l’état du pool avec includeDiagnostics', async () => {
    const overview = await buildInboxOverview(
      { limit: 10, includeDiagnostics: true },
      overviewDeps(),
    );
    assert.deepEqual(overview.diagnostics?.probe, { attempted: true, ok: true, folderCount: 3 });
    assert.deepEqual(overview.diagnostics?.imapPool, { open: 0, inUse: 0, max: 2 });
  });

  it('ne laisse sortir aucun secret, diagnostics et sonde en échec compris', async () => {
    const failingProbe = overviewDeps({
      whoami: (probe) =>
        buildWhoami(probe, {
          poolStats: noPool,
          probe: async () => {
            throw new Error(`échec avec ${APP_PASSWORD} et ${BEARER_TOKEN}`);
          },
        }),
    });
    const overviews = await Promise.all([
      buildInboxOverview({ limit: 10, includeDiagnostics: false }, overviewDeps()),
      buildInboxOverview({ limit: 10, includeDiagnostics: true }, overviewDeps()),
      buildInboxOverview({ limit: 10, includeDiagnostics: true }, failingProbe),
    ]);

    for (const overview of overviews) {
      const json = JSON.stringify(overview);
      assert.ok(
        !json.includes(APP_PASSWORD),
        'le mot de passe d’application ne doit pas apparaître',
      );
      assert.ok(!json.includes(BEARER_TOKEN), 'le bearer token ne doit pas apparaître');
    }
  });
});
