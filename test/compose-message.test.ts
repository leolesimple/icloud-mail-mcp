import './helpers/env.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { planCompose } from '../src/mcp/compose-plan.js';
import type { ComposeRequest } from '../src/mcp/compose-plan.js';
import { connectClient, firstText } from './helpers/mcp-client.js';

/**
 * Validation des combinaisons de compose_message. `planCompose` est pur ; les
 * appels via le client MCP ne vont jamais jusqu'au réseau, puisque toutes les
 * combinaisons testées par ce biais sont refusées avant IMAP/SMTP.
 */

const BODY = { text: 'Bonjour' };
const ORIGINAL = { folder: 'INBOX', uid: 42 };
const TO = { to: ['alice@example.com'] };

function plan(request: Partial<ComposeRequest>) {
  return planCompose({ mode: 'new', deliver: 'send', ...request });
}

function expectOperation(request: Partial<ComposeRequest>, operation: string) {
  assert.deepEqual(plan(request), { ok: true, operation });
}

function expectError(request: Partial<ComposeRequest>, pattern: RegExp) {
  const result = plan(request);
  assert.equal(result.ok, false, JSON.stringify(request));
  if (!result.ok) assert.match(result.error, pattern);
}

describe('planCompose : routage vers les opérations existantes', () => {
  it('new + send → sendNewMessage', () => {
    expectOperation({ ...TO, subject: 'Objet', ...BODY }, 'send_new');
  });

  it('reply et reply_all + send → sendReply', () => {
    expectOperation({ mode: 'reply', ...ORIGINAL, ...BODY }, 'send_reply');
    expectOperation({ mode: 'reply_all', ...ORIGINAL, ...BODY }, 'send_reply');
  });

  it('forward + send → sendForward, corps facultatif', () => {
    expectOperation({ mode: 'forward', ...ORIGINAL, ...TO }, 'send_forward');
  });

  it('new / reply + draft → saveDraft', () => {
    expectOperation({ deliver: 'draft', ...TO, subject: 'Objet', ...BODY }, 'save_draft');
    expectOperation({ mode: 'reply', deliver: 'draft', ...ORIGINAL, ...BODY }, 'save_draft');
  });

  it('draftUid + draft → updateDraft', () => {
    expectOperation({ deliver: 'draft', draftUid: 7, ...TO, subject: 'Objet', ...BODY }, 'update_draft');
    expectOperation({ mode: 'reply', deliver: 'draft', draftUid: 7, ...ORIGINAL, ...BODY }, 'update_draft');
  });

  it('accepte un sujet de remplacement sur une réponse en brouillon', () => {
    expectOperation({ mode: 'reply', deliver: 'draft', subject: 'Autre', ...ORIGINAL, ...BODY }, 'save_draft');
  });

  it('accepte uid sans folder (INBOX par défaut)', () => {
    expectOperation({ mode: 'reply', uid: 42, ...BODY }, 'send_reply');
  });
});

describe('planCompose : combinaisons incohérentes', () => {
  it('refuse draftUid avec deliver send', () => {
    expectError({ draftUid: 7, ...TO, subject: 'Objet', ...BODY }, /draftUid.*deliver: "draft".*send_draft/);
  });

  it('refuse un nouveau message sans destinataire', () => {
    expectError({ subject: 'Objet', ...BODY }, /destinataire/);
    expectError({ to: [], subject: 'Objet', ...BODY }, /destinataire/);
  });

  it('refuse un nouveau message sans sujet', () => {
    expectError({ ...TO, ...BODY }, /sujet/);
  });

  it('refuse folder ou uid en mode new', () => {
    expectError({ ...TO, subject: 'Objet', ...BODY, uid: 1 }, /folder et uid/);
    expectError({ ...TO, subject: 'Objet', ...BODY, folder: 'INBOX' }, /folder et uid/);
  });

  for (const mode of ['reply', 'reply_all', 'forward'] as const) {
    it(`refuse ${mode} sans uid`, () => {
      expectError({ mode, folder: 'INBOX', ...TO, ...BODY }, new RegExp(`"${mode}" exige l'uid`));
    });
  }

  it('refuse forward sans destinataire', () => {
    expectError({ mode: 'forward', ...ORIGINAL, ...BODY }, /transfert exige au moins un destinataire/);
  });

  it('refuse un message sans corps (hors transfert)', () => {
    expectError({ ...TO, subject: 'Objet' }, /corps/);
    expectError({ mode: 'reply', ...ORIGINAL }, /corps/);
  });

  it('refuse un sujet sur une réponse ou un transfert envoyés', () => {
    expectError({ mode: 'reply', subject: 'X', ...ORIGINAL, ...BODY }, /sujet est dérivé/);
    expectError({ mode: 'forward', subject: 'X', ...ORIGINAL, ...TO }, /sujet est dérivé/);
  });

  it('refuse le transfert en brouillon (aucun équivalent)', () => {
    expectError({ mode: 'forward', deliver: 'draft', ...ORIGINAL, ...TO }, /transfert en brouillon/);
  });

  it('refuse la réponse à tous en brouillon (aucun équivalent)', () => {
    expectError({ mode: 'reply_all', deliver: 'draft', ...ORIGINAL, ...BODY }, /réponse à tous en brouillon/);
  });
});

describe('outils : refus avant tout accès réseau', () => {
  let client: Client;
  before(async () => {
    client = await connectClient();
  });
  after(() => client.close());

  async function expectToolError(name: string, args: Record<string, unknown>, pattern: RegExp) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, `${name} ${JSON.stringify(args)}`);
    assert.match(firstText(result), pattern);
  }

  it('compose_message renvoie l’erreur de planCompose', async () => {
    await expectToolError(
      'compose_message',
      { mode: 'forward', deliver: 'draft', uid: 3, to: ['a@example.com'] },
      /transfert en brouillon/,
    );
    await expectToolError('compose_message', { to: ['a@example.com'], text: 'x' }, /sujet/);
  });

  it('organize_messages exige destination pour move, et seulement pour move', async () => {
    await expectToolError('organize_messages', { folder: 'INBOX', uids: [1], action: 'move' }, /destination/);
    await expectToolError(
      'organize_messages',
      { folder: 'INBOX', uids: [1], action: 'trash', destination: 'Archive' },
      /"destination" ne s'utilise qu'avec/,
    );
  });

  it('organize_messages réserve keywords aux actions de flag', async () => {
    await expectToolError(
      'organize_messages',
      { folder: 'INBOX', uids: [1], action: 'trash', keywords: ['$Label1'] },
      /keywords/,
    );
  });

  it('organize_messages plafonne le nombre d’UID', async () => {
    const uids = Array.from({ length: 201 }, (_, i) => i + 1);
    const result = await client.callTool({
      name: 'organize_messages',
      arguments: { folder: 'INBOX', uids, action: 'read' },
    });
    assert.equal(result.isError, true);
  });

  it('manage_folders valide path / newPath selon l’action', async () => {
    await expectToolError('manage_folders', { action: 'create' }, /exige le chemin/);
    await expectToolError('manage_folders', { action: 'rename', path: 'A' }, /newPath/);
    await expectToolError('manage_folders', { action: 'delete', path: 'A', newPath: 'B' }, /rename/);
    await expectToolError('manage_folders', { action: 'list', path: 'A' }, /"list" ne prend/);
  });

  it('find_messages exige un critère pour une recherche multi-dossiers', async () => {
    await expectToolError('find_messages', { folders: ['INBOX', 'Archive'] }, /au moins un critère/);
  });
});
