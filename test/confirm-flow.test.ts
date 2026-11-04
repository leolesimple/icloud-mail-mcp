import './helpers/env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ElicitRequestSchema,
  type ClientCapabilities,
  type ElicitRequestFormParams,
  type ElicitResult,
} from '@modelcontextprotocol/sdk/types.js';
import { ConfirmTokenError, createConfirmTokenService } from '../src/confirm.js';
import {
  confirmationResult,
  runConfirmFlow,
  supportsFormElicitation,
  type ElicitationHost,
} from '../src/mcp/confirm-flow.js';

const BINDING = { folder: 'Junk', uidValidity: 42n, params: { uids: [1, 2] } };
const SUMMARY = 'vider « Junk » (2 messages)';

function host(capabilities: ClientCapabilities | undefined, answer?: ElicitResult) {
  const requests: ElicitRequestFormParams[] = [];
  const h: ElicitationHost = {
    getClientCapabilities: () => capabilities,
    elicitInput: async (params) => {
      requests.push(params);
      if (!answer) throw new Error('elicitInput inattendu');
      return answer;
    },
  };
  return { host: h, requests };
}

function counter() {
  let calls = 0;
  return {
    execute: async () => {
      calls += 1;
      return { deleted: 2 };
    },
    get calls() {
      return calls;
    },
  };
}

function tokens() {
  return createConfirmTokenService({ secret: 'secret-de-test-0123456789abcdef-0123456789' });
}

describe('supportsFormElicitation', () => {
  const cases: [ClientCapabilities | undefined, boolean][] = [
    [undefined, false],
    [{}, false],
    [{ elicitation: {} }, true],
    [{ elicitation: { form: {} } }, true],
    [{ elicitation: { form: {}, url: {} } }, true],
    [{ elicitation: { url: {} } }, false],
  ];
  for (const [caps, expected] of cases) {
    it(`${JSON.stringify(caps)} → ${expected}`, () => {
      assert.equal(supportsFormElicitation(host(caps).host), expected);
    });
  }
});

describe('runConfirmFlow de bout en bout (client MCP en mémoire)', () => {
  async function connect(capabilities: ClientCapabilities, answer: ElicitResult) {
    const server = new Server({ name: 'test', version: '0' }, { capabilities: {} });
    const client = new Client({ name: 'client', version: '0' }, { capabilities });
    const messages: string[] = [];
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      messages.push(request.params.message);
      return answer;
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    return { server, client, messages };
  }

  for (const caps of [{ elicitation: {} }, { elicitation: { form: {} } }] as ClientCapabilities[]) {
    it(`${JSON.stringify(caps)} : demande à l'utilisateur puis exécute`, async () => {
      const { server, client, messages } = await connect(caps, {
        action: 'accept',
        content: { confirm: true },
      });
      try {
        const exec = counter();
        const outcome = await runConfirmFlow({
          host: server,
          operation: 'empty_folder',
          binding: BINDING,
          summary: SUMMARY,
          execute: exec.execute,
          tokens: tokens(),
        });
        assert.equal(outcome.status, 'executed');
        assert.equal(exec.calls, 1);
        assert.equal(messages.length, 1);
        assert.match(messages[0] ?? '', /Junk/);
      } finally {
        await client.close();
      }
    });
  }

  it('un refus côté client ne déclenche rien', async () => {
    const { server, client } = await connect({ elicitation: {} }, { action: 'decline' });
    try {
      const exec = counter();
      const outcome = await runConfirmFlow({
        host: server,
        operation: 'empty_folder',
        binding: BINDING,
        summary: SUMMARY,
        execute: exec.execute,
      });
      assert.equal(outcome.status, 'declined');
      assert.equal(exec.calls, 0);
    } finally {
      await client.close();
    }
  });
});

describe('runConfirmFlow', () => {
  it('le Server du SDK satisfait ElicitationHost', () => {
    const server = new Server({ name: 't', version: '0' }, { capabilities: {} });
    const h: ElicitationHost = server;
    assert.equal(typeof h.elicitInput, 'function');
  });

  describe('client avec elicitation', () => {
    const caps: ClientCapabilities = { elicitation: { form: {} } };

    it('exécute après acceptation, en résumant l’opération', async () => {
      const { host: h, requests } = host(caps, { action: 'accept', content: { confirm: true } });
      const exec = counter();
      const outcome = await runConfirmFlow({
        host: h,
        operation: 'empty_folder',
        binding: BINDING,
        summary: SUMMARY,
        execute: exec.execute,
        tokens: tokens(),
      });
      assert.deepEqual(outcome, { status: 'executed', via: 'elicitation', result: { deleted: 2 } });
      assert.equal(exec.calls, 1);
      assert.equal(requests.length, 1);
      assert.match(requests[0]!.message, /Junk/);
      assert.match(requests[0]!.message, /2 messages/);
    });

    for (const [label, answer] of [
      ['decline', { action: 'decline' }],
      ['accept sans la case cochée', { action: 'accept', content: { confirm: false } }],
      ['accept sans contenu', { action: 'accept' }],
    ] as [string, ElicitResult][]) {
      it(`refuse sur ${label}`, async () => {
        const { host: h } = host(caps, answer);
        const exec = counter();
        const outcome = await runConfirmFlow({
          host: h,
          operation: 'empty_folder',
          binding: BINDING,
          summary: SUMMARY,
          execute: exec.execute,
        });
        assert.equal(outcome.status, 'declined');
        assert.equal(exec.calls, 0);
      });
    }

    it('annule sur cancel', async () => {
      const { host: h } = host(caps, { action: 'cancel' });
      const exec = counter();
      const outcome = await runConfirmFlow({
        host: h,
        operation: 'empty_folder',
        binding: BINDING,
        summary: SUMMARY,
        execute: exec.execute,
      });
      assert.equal(outcome.status, 'cancelled');
      assert.equal(exec.calls, 0);
    });

    it('ignore un confirmToken et demande quand même', async () => {
      const t = tokens();
      const { token } = t.issue('empty_folder', BINDING);
      const { host: h, requests } = host(caps, { action: 'decline' });
      const exec = counter();
      const outcome = await runConfirmFlow({
        host: h,
        operation: 'empty_folder',
        binding: BINDING,
        summary: SUMMARY,
        confirmToken: token,
        execute: exec.execute,
        tokens: t,
      });
      assert.equal(outcome.status, 'declined');
      assert.equal(requests.length, 1);
      assert.equal(exec.calls, 0);
    });
  });

  describe('client sans elicitation', () => {
    for (const [label, caps] of [
      ['aucune capacité', undefined],
      ['elicitation URL seule', { elicitation: { url: {} } }],
    ] as [string, ClientCapabilities | undefined][]) {
      it(`${label} : jeton puis exécution`, async () => {
        const { host: h, requests } = host(caps);
        const t = tokens();
        const exec = counter();
        const base = {
          host: h,
          operation: 'empty_folder',
          binding: BINDING,
          summary: SUMMARY,
          execute: exec.execute,
          tokens: t,
        };

        const first = await runConfirmFlow(base);
        assert.equal(first.status, 'confirmation_required');
        assert.equal(exec.calls, 0);
        if (first.status !== 'confirmation_required') return;
        assert.equal(first.summary, SUMMARY);
        assert.ok(!Number.isNaN(Date.parse(first.expiresAt)));

        const second = await runConfirmFlow({ ...base, confirmToken: first.confirmToken });
        assert.deepEqual(second, { status: 'executed', via: 'token', result: { deleted: 2 } });
        assert.equal(exec.calls, 1);
        assert.equal(requests.length, 0);
      });
    }

    it('refuse un mauvais jeton sans exécuter', async () => {
      const { host: h } = host(undefined);
      const t = tokens();
      const exec = counter();
      const base = {
        host: h,
        operation: 'empty_folder',
        binding: BINDING,
        summary: SUMMARY,
        execute: exec.execute,
        tokens: t,
      };
      const first = await runConfirmFlow(base);
      assert.equal(first.status, 'confirmation_required');
      if (first.status !== 'confirmation_required') return;

      // Binding différent (UIDVALIDITY changée entre les deux appels).
      await assert.rejects(
        runConfirmFlow({
          ...base,
          binding: { ...BINDING, uidValidity: 43n },
          confirmToken: first.confirmToken,
        }),
        (err: unknown) => err instanceof ConfirmTokenError && err.code === 'mismatch',
      );
      await assert.rejects(
        runConfirmFlow({ ...base, confirmToken: 'nimporte-quoi' }),
        (err: unknown) => err instanceof ConfirmTokenError && err.code === 'malformed',
      );
      assert.equal(exec.calls, 0);

      // Rejeu après une exécution réussie.
      await runConfirmFlow({ ...base, confirmToken: first.confirmToken });
      await assert.rejects(
        runConfirmFlow({ ...base, confirmToken: first.confirmToken }),
        (err: unknown) => err instanceof ConfirmTokenError && err.code === 'replayed',
      );
      assert.equal(exec.calls, 1);
    });
  });
});

describe('confirmationResult', () => {
  it('renvoie un résultat non-erreur avec le jeton', () => {
    const result = confirmationResult({
      status: 'confirmation_required',
      operation: 'empty_folder',
      summary: SUMMARY,
      confirmToken: 'abc',
      expiresAt: '2026-01-01T00:00:00.000Z',
    });
    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent?.confirmToken, 'abc');
    assert.equal(result.structuredContent?.executed, false);
  });

  for (const status of ['declined', 'cancelled'] as const) {
    it(`renvoie un résultat non-erreur pour ${status}`, () => {
      const result = confirmationResult({ status, operation: 'empty_folder', summary: SUMMARY });
      assert.notEqual(result.isError, true);
      assert.equal(result.structuredContent?.status, status);
      assert.equal(result.structuredContent?.executed, false);
    });
  }
});

describe('runConfirmFlow : client qui annonce l’elicitation sans répondre', () => {
  /** Client en mémoire dont le formulaire ne reçoit jamais de réponse. */
  async function silentClient() {
    const server = new Server({ name: 'test', version: '0' }, { capabilities: {} });
    const client = new Client(
      { name: 'client', version: '0' },
      { capabilities: { elicitation: { form: {} } } },
    );
    let requests = 0;
    client.setRequestHandler(ElicitRequestSchema, () => {
      requests += 1;
      return new Promise<ElicitResult>(() => {});
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    return {
      server,
      client,
      get requests() {
        return requests;
      },
    };
  }

  it('bascule sur le jeton au timeout, puis ne redemande plus de formulaire', async () => {
    const c = await silentClient();
    try {
      const t = tokens();
      const exec = counter();
      const base = {
        host: c.server,
        operation: 'send',
        binding: BINDING,
        summary: SUMMARY,
        execute: exec.execute,
        tokens: t,
        elicitation: 'auto' as const,
        elicitationTimeoutMs: 50,
      };

      const first = await runConfirmFlow(base);
      assert.equal(first.status, 'confirmation_required');
      assert.equal(exec.calls, 0);
      assert.equal(c.requests, 1);
      if (first.status !== 'confirmation_required') return;

      const started = Date.now();
      const second = await runConfirmFlow({ ...base, confirmToken: first.confirmToken });
      assert.deepEqual(second, { status: 'executed', via: 'token', result: { deleted: 2 } });
      assert.equal(exec.calls, 1);
      // Pas de second formulaire ni de second timeout pour cette session.
      assert.equal(c.requests, 1);
      assert.ok(Date.now() - started < 50);
    } finally {
      await c.client.close();
    }
  });

  it('une annulation de l’appel interrompt l’attente sans exécuter ni basculer', async () => {
    const c = await silentClient();
    try {
      const exec = counter();
      const controller = new AbortController();
      const base = {
        host: c.server,
        operation: 'send',
        binding: BINDING,
        summary: SUMMARY,
        execute: exec.execute,
        tokens: tokens(),
        elicitation: 'auto' as const,
        elicitationTimeoutMs: 10_000,
      };
      setTimeout(() => controller.abort(new Error('annulé par le client')), 20);
      await assert.rejects(runConfirmFlow({ ...base, signal: controller.signal }));
      assert.equal(exec.calls, 0);

      // La session n'est pas marquée muette : un nouvel appel redemande le formulaire.
      const again = new AbortController();
      setTimeout(() => again.abort(), 20);
      await assert.rejects(runConfirmFlow({ ...base, signal: again.signal }));
      assert.equal(c.requests, 2);
    } finally {
      await c.client.close();
    }
  });
});

describe('runConfirmFlow : ELICITATION', () => {
  it('off : jeton directement, même si le client annonce l’elicitation', async () => {
    const { host: h, requests } = host(
      { elicitation: { form: {} } },
      { action: 'accept', content: { confirm: true } },
    );
    const exec = counter();
    const outcome = await runConfirmFlow({
      host: h,
      operation: 'send',
      binding: BINDING,
      summary: SUMMARY,
      execute: exec.execute,
      tokens: tokens(),
      elicitation: 'off',
    });
    assert.equal(outcome.status, 'confirmation_required');
    assert.equal(requests.length, 0);
    assert.equal(exec.calls, 0);
  });

  it('auto : une erreur autre qu’un timeout remonte sans repli', async () => {
    const h: ElicitationHost = {
      getClientCapabilities: () => ({ elicitation: { form: {} } }),
      elicitInput: async () => {
        throw new Error('transport fermé');
      },
    };
    const exec = counter();
    await assert.rejects(
      runConfirmFlow({
        host: h,
        operation: 'send',
        binding: BINDING,
        summary: SUMMARY,
        execute: exec.execute,
        tokens: tokens(),
        elicitation: 'auto',
      }),
      /transport fermé/,
    );
    assert.equal(exec.calls, 0);
  });

  it('auto : transmet le timeout et le signal à elicitInput', async () => {
    let seen: { timeout?: number; signal?: AbortSignal } | undefined;
    const controller = new AbortController();
    const h: ElicitationHost = {
      getClientCapabilities: () => ({ elicitation: { form: {} } }),
      elicitInput: async (_params, options) => {
        seen = options;
        return { action: 'decline' };
      },
    };
    await runConfirmFlow({
      host: h,
      operation: 'send',
      binding: BINDING,
      summary: SUMMARY,
      execute: counter().execute,
      elicitation: 'auto',
      elicitationTimeoutMs: 1234,
      signal: controller.signal,
    });
    assert.equal(seen?.timeout, 1234);
    assert.equal(seen?.signal, controller.signal);
  });
});
