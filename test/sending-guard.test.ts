import './helpers/env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sendMail } from '../src/smtp/client.js';
import { sendNewMessage } from '../src/smtp/send.js';
import { SmtpMessageError } from '../src/smtp/errors.js';
import { config } from '../src/config.js';

/**
 * Coupe-circuit ENABLE_SENDING : c'est la garantie qu'aucun mail ne peut partir
 * pendant les tests ou dans une instance volontairement bridée. Le refus doit
 * intervenir AVANT toute tentative de connexion SMTP.
 *
 * L'environnement de test force ENABLE_SENDING=false (voir test/helpers/env.ts).
 */
describe('ENABLE_SENDING=false', () => {
  it('est bien la configuration active des tests', () => {
    assert.equal(config.ENABLE_SENDING, false, "les tests ne doivent jamais pouvoir envoyer d'email réel");
  });

  it('bloque sendMail sans ouvrir de connexion SMTP', async () => {
    await assert.rejects(
      sendMail({ to: ['destinataire@example.com'], subject: 'Ne doit jamais partir', text: 'test' }),
      (err: Error) => {
        assert.ok(err instanceof SmtpMessageError);
        assert.match(err.message, /ENABLE_SENDING=false/);
        return true;
      },
    );
  });

  it('bloque send_message via sendNewMessage', async () => {
    await assert.rejects(
      sendNewMessage({ to: ['destinataire@example.com'], subject: 'Ne doit jamais partir', text: 'test' }),
      SmtpMessageError,
    );
  });

  it('renvoie un message d’erreur qui explique comment réactiver l’envoi', async () => {
    await assert.rejects(sendMail({ to: ['a@example.com'], subject: 's', text: 't' }), /\.env/);
  });
});
