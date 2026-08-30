import './helpers/env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { prepareMessageBody } from '../src/mcp/message-content.js';

const opts = (over: Partial<{ maxBodyChars: number; includeHtml: boolean }> = {}) => ({
  maxBodyChars: 20,
  includeHtml: false,
  ...over,
});

describe('prepareMessageBody — troncature', () => {
  it('ne tronque pas un corps pile à la limite', () => {
    const text = 'x'.repeat(20);
    const result = prepareMessageBody({ text, html: false }, opts());
    assert.equal(result.text, text);
    assert.equal(result.bodyTruncated, false);
  });

  it('tronque à la limite exacte et signale la troncature', () => {
    const result = prepareMessageBody({ text: 'x'.repeat(21), html: false }, opts());
    assert.equal(result.text?.length, 20);
    assert.equal(result.bodyTruncated, true);
  });

  it('ne signale jamais une troncature silencieuse', () => {
    const result = prepareMessageBody({ text: 'court', html: false }, opts({ maxBodyChars: 5 }));
    assert.equal(result.bodyTruncated, false);
  });
});

describe('prepareMessageBody — repli HTML → texte', () => {
  it('convertit le HTML en texte quand la partie texte est absente', () => {
    const result = prepareMessageBody(
      { text: undefined, html: '<p>Bonjour <b>Alice</b></p>' },
      opts({ maxBodyChars: 200 }),
    );
    assert.equal(result.text, 'Bonjour Alice');
  });

  it('tronque aussi le texte issu du HTML', () => {
    const result = prepareMessageBody(
      { text: undefined, html: `<p>${'a'.repeat(100)}</p>` },
      opts({ maxBodyChars: 10 }),
    );
    assert.equal(result.text?.length, 10);
    assert.equal(result.bodyTruncated, true);
  });

  it('préfère la partie texte quand elle existe', () => {
    const result = prepareMessageBody(
      { text: 'texte réel', html: '<p>html</p>' },
      opts({ maxBodyChars: 200 }),
    );
    assert.equal(result.text, 'texte réel');
  });

  it('laisse text indéfini quand il n’y a ni texte ni HTML', () => {
    const result = prepareMessageBody({ text: undefined, html: false }, opts());
    assert.equal(result.text, undefined);
    assert.equal(result.bodyTruncated, false);
  });
});

describe('prepareMessageBody — includeHtml', () => {
  it('omet le HTML par défaut (includeHtml: false)', () => {
    const result = prepareMessageBody({ text: 'corps', html: '<p>corps</p>' }, opts());
    assert.equal(result.html, false);
  });

  it('renvoie le HTML (tronqué) quand includeHtml est true', () => {
    const html = `<p>${'b'.repeat(100)}</p>`;
    const result = prepareMessageBody({ text: 'corps', html }, opts({ includeHtml: true, maxBodyChars: 15 }));
    assert.equal(result.html, html.slice(0, 15));
    assert.equal(result.bodyTruncated, true);
  });
});
