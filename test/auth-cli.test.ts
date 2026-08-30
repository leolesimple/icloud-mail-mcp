import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  describeVerifyFailure,
  generateBearerToken,
  normalizeAppPassword,
  planEnvWrite,
  renderEnvFile,
  writeEnvFile,
} from '../src/cli/auth-core.js';
import { ImapAuthError, ImapNetworkError } from '../src/imap/errors.js';
import { SmtpAuthError, SmtpNetworkError } from '../src/smtp/errors.js';

// Répertoire jetable : toute écriture de fichier de ce test y reste confinée,
// jamais sur le .env du dépôt.
const workdir = mkdtempSync(join(tmpdir(), 'mail-mcp-auth-'));
after(() => rmSync(workdir, { recursive: true, force: true }));

describe('normalizeAppPassword', () => {
  it('retire les espaces et regroupe en xxxx-xxxx-xxxx-xxxx', () => {
    assert.equal(normalizeAppPassword('abcd efgh ijkl mnop'), 'abcd-efgh-ijkl-mnop');
    assert.equal(normalizeAppPassword('  abcdefghijklmnop  '), 'abcd-efgh-ijkl-mnop');
    assert.equal(normalizeAppPassword('abcd-efgh-ijkl-mnop'), 'abcd-efgh-ijkl-mnop');
  });

  it('met en minuscules le format collé par Apple', () => {
    assert.equal(normalizeAppPassword('ABCD-EFGH-IJKL-MNOP'), 'abcd-efgh-ijkl-mnop');
  });

  it('sur un format inattendu, retire au moins les espaces', () => {
    assert.equal(normalizeAppPassword('  pas un mot de passe  '), 'pasunmotdepasse');
    assert.ok(!normalizeAppPassword('x y z').includes(' '));
  });
});

describe('generateBearerToken', () => {
  it('produit un token base64url d’au moins 16 caractères', () => {
    const token = generateBearerToken();
    assert.ok(token.length >= 16);
    assert.match(token, /^[A-Za-z0-9_-]+$/);
  });

  it('32 octets donnent 43 caractères', () => {
    assert.equal(generateBearerToken().length, 43);
  });

  it('utilise le générateur d’aléa fourni', () => {
    const token = generateBearerToken((size) => Buffer.alloc(size, 0));
    assert.match(token, /^A+$/);
    assert.equal(token.length, 43);
  });

  it('reste au-dessus du minimum même avec peu d’octets', () => {
    assert.ok(generateBearerToken((size) => Buffer.alloc(size, 0), 16).length >= 16);
  });
});

describe('renderEnvFile', () => {
  const rendered = renderEnvFile({
    email: 'moi@icloud.com',
    appPassword: 'abcd-efgh-ijkl-mnop',
    bearerToken: 'S3cr3t-t0k3n_value',
  });

  it('place chaque valeur sur sa clé', () => {
    assert.match(rendered, /^ICLOUD_EMAIL=moi@icloud\.com$/m);
    assert.match(rendered, /^ICLOUD_APP_PASSWORD=abcd-efgh-ijkl-mnop$/m);
    assert.match(rendered, /^MCP_BEARER_TOKEN=S3cr3t-t0k3n_value$/m);
  });

  it('démarre coupe-circuit fermé par défaut', () => {
    assert.match(rendered, /^ENABLE_SENDING=false$/m);
    assert.equal(renderEnvFile({ email: 'a@b.c', appPassword: 'p', bearerToken: 't', enableSending: true }).match(/^ENABLE_SENDING=(\S+)$/m)?.[1], 'true');
  });

  it('n’écrit aucun secret dans une ligne de commentaire', () => {
    for (const line of rendered.split('\n')) {
      if (line.startsWith('#')) {
        assert.ok(!line.includes('abcd-efgh-ijkl-mnop'));
        assert.ok(!line.includes('S3cr3t-t0k3n_value'));
      }
    }
  });

  it('ne contient que des lignes vides, des commentaires ou des CLE=valeur', () => {
    for (const line of rendered.split('\n')) {
      if (line === '' || line.startsWith('#')) continue;
      assert.match(line, /^[A-Z0-9_]+=.*$/);
    }
  });
});

describe('planEnvWrite', () => {
  it('écrit directement quand aucun .env n’existe', () => {
    assert.deepEqual(planEnvWrite({ exists: false, confirmed: false }), {
      write: true,
      backup: false,
      needsConfirmation: false,
    });
  });

  it('exige une confirmation quand un .env existe', () => {
    assert.deepEqual(planEnvWrite({ exists: true, confirmed: false }), {
      write: false,
      backup: false,
      needsConfirmation: true,
    });
  });

  it('sauvegarde puis écrit une fois la confirmation obtenue', () => {
    assert.deepEqual(planEnvWrite({ exists: true, confirmed: true }), {
      write: true,
      backup: true,
      needsConfirmation: false,
    });
  });
});

describe('writeEnvFile', () => {
  it('écrit le fichier en chmod 600 dans le répertoire jetable', () => {
    const target = join(mkdtempSync(join(workdir, 'write-')), '.env');
    writeEnvFile(target, 'ICLOUD_EMAIL=a@b.c\n', { backup: false });

    assert.equal(readFileSync(target, 'utf8'), 'ICLOUD_EMAIL=a@b.c\n');
    assert.equal(statSync(target).mode & 0o777, 0o600);
  });

  it('sauvegarde l’ancien contenu dans .env.bak avant d’écraser', () => {
    const dir = mkdtempSync(join(workdir, 'backup-'));
    const target = join(dir, '.env');
    writeFileSync(target, 'ANCIEN=1\n');

    writeEnvFile(target, 'NOUVEAU=2\n', { backup: true });

    assert.equal(readFileSync(target, 'utf8'), 'NOUVEAU=2\n');
    assert.equal(readFileSync(`${target}.bak`, 'utf8'), 'ANCIEN=1\n');
    assert.equal(statSync(`${target}.bak`).mode & 0o777, 0o600);
  });

  it('n’écrit jamais en dehors du répertoire jetable', () => {
    const dir = mkdtempSync(join(workdir, 'scope-'));
    mkdirSync(join(dir, 'sub'));
    const target = join(dir, 'sub', '.env');
    writeEnvFile(target, 'X=1\n', { backup: false });
    assert.ok(target.startsWith(workdir));
  });
});

describe('describeVerifyFailure', () => {
  it('sur un échec d’authentification, oriente vers un nouveau mot de passe d’application', () => {
    const message = describeVerifyFailure('IMAP', new ImapAuthError('bad'));
    assert.match(message, /authentification refusée/i);
    assert.match(message, /appleid\.apple\.com/);
    assert.match(message, /Aucun fichier n'a été écrit/);
  });

  it('sur un échec réseau, parle de connexion et pas de mot de passe', () => {
    const message = describeVerifyFailure('SMTP', new SmtpNetworkError('timeout'));
    assert.match(message, /injoignable|réseau/i);
    assert.match(message, /SMTP/);
    assert.match(message, /Aucun fichier n'a été écrit/);
  });

  it('gère aussi le cas SMTP auth et IMAP réseau', () => {
    assert.match(describeVerifyFailure('SMTP', new SmtpAuthError('x')), /authentification refusée/i);
    assert.match(describeVerifyFailure('IMAP', new ImapNetworkError('x')), /injoignable|réseau/i);
  });

  it('reste explicite sur une erreur non classifiée', () => {
    const message = describeVerifyFailure('IMAP', new Error('boom'));
    assert.match(message, /IMAP/);
    assert.match(message, /Aucun fichier n'a été écrit/);
  });
});
