import './helpers/env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { composeRaw } from '../src/smtp/compose.js';
import type { ComposeInput } from '../src/smtp/compose.js';

async function rawText(input: ComposeInput): Promise<string> {
  return (await composeRaw(input)).toString('utf8');
}

function headerValue(raw: string, name: string): string | undefined {
  // En-têtes potentiellement repliés sur plusieurs lignes (RFC 5322 §2.2.3).
  const match = raw.match(new RegExp(`^${name}:\\s*((?:.*(?:\\r?\\n[ \\t].*)*))`, 'im'));
  return match?.[1]?.replace(/\r?\n[ \t]/g, ' ').trim();
}

const base: ComposeInput = {
  to: ['alice@example.com'],
  subject: 'Compte rendu',
  text: 'Bonjour',
};

describe('composeRaw', () => {
  it('produit les en-têtes From/To/Cc/Subject', async () => {
    const raw = await rawText({
      ...base,
      to: ['alice@example.com', 'bob@example.com'],
      cc: ['carol@example.com'],
    });
    assert.equal(headerValue(raw, 'From'), 'test@example.com');
    assert.match(headerValue(raw, 'To') ?? '', /alice@example\.com/);
    assert.match(headerValue(raw, 'To') ?? '', /bob@example\.com/);
    assert.equal(headerValue(raw, 'Cc'), 'carol@example.com');
    assert.equal(headerValue(raw, 'Subject'), 'Compte rendu');
  });

  it("utilise le champ from fourni plutôt que l'adresse du compte", async () => {
    const raw = await rawText({ ...base, from: 'perso@example.net' });
    assert.equal(headerValue(raw, 'From'), 'perso@example.net');
  });

  it('pose In-Reply-To et References pour une réponse', async () => {
    const raw = await rawText({
      ...base,
      inReplyTo: '<original@example.com>',
      references: ['<ancetre@example.com>', '<original@example.com>'],
    });
    assert.equal(headerValue(raw, 'In-Reply-To'), '<original@example.com>');
    const references = headerValue(raw, 'References') ?? '';
    assert.match(references, /<ancetre@example\.com>/);
    assert.match(references, /<original@example\.com>/);
  });

  it('génère un Message-ID unique à chaque appel', async () => {
    const idOf = (raw: string) => raw.match(/^Message-ID:\s*<([^>]+)>/im)?.[1];
    const first = idOf(await rawText(base));
    const second = idOf(await rawText(base));
    assert.ok(first, 'Message-ID présent');
    assert.ok(second, 'Message-ID présent');
    assert.notEqual(first, second);
  });

  it('encode une pièce jointe', async () => {
    const raw = await rawText({
      ...base,
      attachments: [{ filename: 'note.txt', content: Buffer.from('hello world'), contentType: 'text/plain' }],
    });
    assert.match(raw, /Content-Disposition: attachment;[\s\S]*?filename=/i);
    assert.match(raw, /name="?note\.txt"?/i);
    // "hello world" encodé en base64.
    assert.match(raw, /aGVsbG8gd29ybGQ=/);
  });
});
