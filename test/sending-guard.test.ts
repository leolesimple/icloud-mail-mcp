import './helpers/env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sendMail } from '../src/smtp/client.js';
import { sendNewMessage } from '../src/smtp/send.js';
import { SmtpMessageError } from '../src/smtp/errors.js';
import { config, parseList } from '../src/config.js';
import { checkSendAllowed, isRecipientAllowed, recipientsOutsideAllowlist } from '../src/smtp/guards.js';
import type { GuardConfig, GuardContext, GuardMessage } from '../src/smtp/guards.js';

/**
 * Garde-fous d'envoi. Deux niveaux :
 *
 * - `checkSendAllowed` : module pur, décision à trois issues, testé ci-dessous
 *   sur la matrice complète des cinq règles avec une config et un quota injectés.
 * - `sendMail` / `sendNewMessage` : filet de sécurité au niveau du transport —
 *   même un appel forgé ne peut pas émettre. L'environnement de test force
 *   `ENABLE_SENDING=false` (voir test/helpers/env.ts).
 */

function context(cfg: Partial<GuardConfig> = {}, quotaExceeded = false): GuardContext {
  return {
    config: {
      UNRESTRICTED: false,
      ENABLE_SENDING: true,
      DRAFTS_ONLY: false,
      ALLOWED_RECIPIENTS_LIST: [],
      ...cfg,
    },
    quota: { wouldExceed: () => quotaExceeded, max: 5 },
  };
}

const msg = (over: Partial<GuardMessage> = {}): GuardMessage => ({ to: ['dest@example.com'], ...over });
const reasonOf = (d: { action: string }): string => (d as unknown as { reason: string }).reason;

describe('ENABLE_SENDING=false (transport)', () => {
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

describe('checkSendAllowed — matrice des cinq règles', () => {
  it('autorise quand tout est permissif', () => {
    assert.deepEqual(checkSendAllowed(msg(), context()), { action: 'allow' });
  });

  describe('1. UNRESTRICTED prime sur toutes les autres règles', () => {
    it('passe même avec ENABLE_SENDING=false, DRAFTS_ONLY=true, allowlist violée et quota dépassé', () => {
      const decision = checkSendAllowed(
        msg({ to: ['interdit@ailleurs.com'] }),
        context(
          {
            UNRESTRICTED: true,
            ENABLE_SENDING: false,
            DRAFTS_ONLY: true,
            ALLOWED_RECIPIENTS_LIST: ['@example.com'],
          },
          true,
        ),
      );
      assert.deepEqual(decision, { action: 'allow' });
    });
  });

  describe('2. ENABLE_SENDING=false', () => {
    it('refuse, en nommant la variable et .env', () => {
      const decision = checkSendAllowed(msg(), context({ ENABLE_SENDING: false }));
      assert.equal(decision.action, 'deny');
      assert.match(reasonOf(decision), /ENABLE_SENDING=false/);
      assert.match(reasonOf(decision), /\.env/);
    });

    it('prime sur DRAFTS_ONLY (ordre strict)', () => {
      const decision = checkSendAllowed(msg(), context({ ENABLE_SENDING: false, DRAFTS_ONLY: true }));
      assert.equal(decision.action, 'deny');
    });
  });

  describe('3. DRAFTS_ONLY=true', () => {
    it('renvoie la décision draft — ce n’est pas une erreur', () => {
      assert.deepEqual(checkSendAllowed(msg(), context({ DRAFTS_ONLY: true })), { action: 'draft' });
    });

    it('prime sur l’allowlist et le quota', () => {
      const decision = checkSendAllowed(
        msg({ to: ['interdit@ailleurs.com'] }),
        context({ DRAFTS_ONLY: true, ALLOWED_RECIPIENTS_LIST: ['@example.com'] }, true),
      );
      assert.deepEqual(decision, { action: 'draft' });
    });
  });

  describe('4. ALLOWED_RECIPIENTS', () => {
    it('autorise une adresse exacte listée', () => {
      const decision = checkSendAllowed(
        msg({ to: ['ami@example.com'] }),
        context({ ALLOWED_RECIPIENTS_LIST: ['ami@example.com', 'autre@example.com'] }),
      );
      assert.equal(decision.action, 'allow');
    });

    it('autorise via un domaine @exemple.com', () => {
      const decision = checkSendAllowed(
        msg({ to: ['nimporte-qui@example.com'] }),
        context({ ALLOWED_RECIPIENTS_LIST: ['@example.com'] }),
      );
      assert.equal(decision.action, 'allow');
    });

    it('refuse une adresse hors liste et la nomme', () => {
      const decision = checkSendAllowed(
        msg({ to: ['intrus@ailleurs.com'] }),
        context({ ALLOWED_RECIPIENTS_LIST: ['@example.com'] }),
      );
      assert.equal(decision.action, 'deny');
      assert.match(reasonOf(decision), /intrus@ailleurs\.com/);
    });

    it('refuse un destinataire fautif en cc et le nomme', () => {
      const decision = checkSendAllowed(
        msg({ to: ['ok@example.com'], cc: ['fuite@ailleurs.com'] }),
        context({ ALLOWED_RECIPIENTS_LIST: ['@example.com'] }),
      );
      assert.equal(decision.action, 'deny');
      assert.match(reasonOf(decision), /fuite@ailleurs\.com/);
    });

    it('refuse un destinataire fautif en bcc et le nomme', () => {
      const decision = checkSendAllowed(
        msg({ to: ['ok@example.com'], bcc: ['cachee@ailleurs.com'] }),
        context({ ALLOWED_RECIPIENTS_LIST: ['@example.com'] }),
      );
      assert.equal(decision.action, 'deny');
      assert.match(reasonOf(decision), /cachee@ailleurs\.com/);
    });

    it('nomme tous les destinataires fautifs, et seulement eux', () => {
      const decision = checkSendAllowed(
        msg({ to: ['a@ailleurs.com'], cc: ['b@example.com'], bcc: ['c@encore-ailleurs.com'] }),
        context({ ALLOWED_RECIPIENTS_LIST: ['@example.com'] }),
      );
      assert.equal(decision.action, 'deny');
      assert.match(reasonOf(decision), /a@ailleurs\.com/);
      assert.match(reasonOf(decision), /c@encore-ailleurs\.com/);
      assert.doesNotMatch(reasonOf(decision), /b@example\.com/);
    });

    it('prime sur le quota (ordre strict)', () => {
      const decision = checkSendAllowed(
        msg({ to: ['intrus@ailleurs.com'] }),
        context({ ALLOWED_RECIPIENTS_LIST: ['@example.com'] }, true),
      );
      assert.equal(decision.action, 'deny');
      assert.match(reasonOf(decision), /ALLOWED_RECIPIENTS/);
    });
  });

  describe('5. MAX_SENDS_PER_DAY', () => {
    it('refuse au-delà du quota, en nommant la variable', () => {
      const decision = checkSendAllowed(msg(), context({}, true));
      assert.equal(decision.action, 'deny');
      assert.match(reasonOf(decision), /MAX_SENDS_PER_DAY/);
    });

    it('autorise tant que le quota n’est pas atteint', () => {
      assert.equal(checkSendAllowed(msg(), context({}, false)).action, 'allow');
    });
  });
});

describe('helpers d’allowlist', () => {
  it('parseList normalise, découpe et ignore le vide', () => {
    assert.deepEqual(parseList(' A@X.com , @Y.COM ,, '), ['a@x.com', '@y.com']);
  });

  it('isRecipientAllowed : liste vide = tout autorisé', () => {
    assert.equal(isRecipientAllowed('qui@que.com', []), true);
  });

  it('isRecipientAllowed : adresse exacte, insensible à la casse', () => {
    assert.equal(isRecipientAllowed('Ami@Example.com', ['ami@example.com']), true);
    assert.equal(isRecipientAllowed('autre@example.com', ['ami@example.com']), false);
  });

  it('isRecipientAllowed : domaine @exemple.com ne matche pas un sous-domaine', () => {
    assert.equal(isRecipientAllowed('x@example.com', ['@example.com']), true);
    assert.equal(isRecipientAllowed('x@mail.example.com', ['@example.com']), false);
  });

  it('recipientsOutsideAllowlist : liste vide => aucun fautif', () => {
    assert.deepEqual(recipientsOutsideAllowlist({ to: ['a@b.com'], cc: ['c@d.com'] }, []), []);
  });
});
