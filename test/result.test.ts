import './helpers/env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { errorResult, jsonResult, listResult } from '../src/mcp/result.js';
import { listMessagesResultSchema, moveResultSchema } from '../src/mcp/schemas.js';

describe('jsonResult', () => {
  const data = { uid: 42, from: 'INBOX', to: 'Archive', newUid: 7 };

  it('sérialise toujours les données dans un bloc texte', () => {
    const result = jsonResult(data);
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0]?.type, 'text');
    assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text), data);
  });

  it("n'attache pas de structuredContent sans schéma", () => {
    assert.equal(jsonResult(data).structuredContent, undefined);
  });

  it('attache structuredContent quand un schéma est fourni', () => {
    const result = jsonResult(data, moveResultSchema);
    assert.deepEqual(result.structuredContent, data);
  });

  it('produit un structuredContent qui valide contre son outputSchema', () => {
    const result = jsonResult(data, moveResultSchema);
    assert.doesNotThrow(() => moveResultSchema.parse(result.structuredContent));
  });

  it('conserve le bloc texte ET le structuré en parallèle', () => {
    const result = jsonResult(data, moveResultSchema);
    assert.ok(result.content[0]);
    assert.ok(result.structuredContent);
  });

  it('laisse le SDK détecter un structuredContent non conforme au schéma', () => {
    const strict = z.object({ a: z.number() });
    const result = jsonResult({ a: 'pas un nombre' }, strict);
    assert.throws(() => strict.parse(result.structuredContent));
  });
});

describe('listResult', () => {
  const items = [{ uid: 1 }, { uid: 2 }];
  const textOf = (r: ReturnType<typeof listResult>) => JSON.parse((r.content[0] as { text: string }).text);

  it('bloc texte = tableau nu par défaut (contrat historique)', () => {
    assert.deepEqual(textOf(listResult('messages', items)), items);
  });

  it('structuredContent = toujours enveloppé (objet exigé par le protocole)', () => {
    assert.deepEqual(listResult('messages', items).structuredContent, { messages: items });
  });

  it('envelope: true enveloppe aussi le bloc texte', () => {
    assert.deepEqual(textOf(listResult('messages', items, { envelope: true })), { messages: items });
  });

  it('un nextCursor force l’enveloppe du bloc texte, même sans envelope', () => {
    const result = listResult('messages', items, { nextCursor: 'abc' });
    assert.deepEqual(textOf(result), { messages: items, nextCursor: 'abc' });
    assert.deepEqual(result.structuredContent, { messages: items, nextCursor: 'abc' });
  });

  it('la forme enveloppée valide contre son outputSchema', () => {
    const result = listResult('messages', [], { envelope: true });
    assert.doesNotThrow(() => listMessagesResultSchema.parse(result.structuredContent));
  });
});

describe('errorResult', () => {
  it('pose isError et le message utilisateur en texte', () => {
    const result = errorResult('Dossier introuvable.');
    assert.equal(result.isError, true);
    assert.equal((result.content[0] as { text: string }).text, 'Dossier introuvable.');
  });

  it("n'attache jamais de structuredContent", () => {
    assert.equal(errorResult('bang').structuredContent, undefined);
  });
});
