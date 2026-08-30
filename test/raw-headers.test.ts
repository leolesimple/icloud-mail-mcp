import './helpers/env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractRawHeaders } from '../src/mcp/message-content.js';

describe('extractRawHeaders', () => {
  it('coupe au premier CRLF CRLF et exclut le corps', () => {
    const source = 'From: a@x\r\nSubject: Salut\r\n\r\nCorps du message\r\navec suite';
    assert.equal(extractRawHeaders(source), 'From: a@x\r\nSubject: Salut');
  });

  it('gère les séparateurs LF LF (messages non normalisés)', () => {
    const source = 'From: a@x\nSubject: Salut\n\nCorps';
    assert.equal(extractRawHeaders(source), 'From: a@x\nSubject: Salut');
  });

  it('accepte un Buffer', () => {
    const source = Buffer.from('List-Unsubscribe: <https://x/u>\r\n\r\nbody', 'utf8');
    assert.equal(extractRawHeaders(source), 'List-Unsubscribe: <https://x/u>');
  });

  it('renvoie tout le contenu quand il n’y a pas de corps', () => {
    assert.equal(extractRawHeaders('From: a@x\r\nSubject: rien'), 'From: a@x\r\nSubject: rien');
  });

  it('préfère le séparateur CRLF CRLF quand les deux styles cohabitent', () => {
    const source = 'A: 1\r\nB: 2\r\n\r\nligne\n\nautre';
    assert.equal(extractRawHeaders(source), 'A: 1\r\nB: 2');
  });
});
