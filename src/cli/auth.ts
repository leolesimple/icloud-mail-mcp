import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import {
  describeVerifyFailure,
  generateBearerToken,
  normalizeAppPassword,
  planEnvWrite,
  renderEnvFile,
  writeEnvFile,
} from './auth-core.js';
import { verifyImap } from '../imap/verify.js';
import { verifySmtp } from '../smtp/verify.js';

// `npm run auth`        — mise en route interactive : saisit les identifiants,
//                         vérifie IMAP + SMTP pour de vrai, puis écrit .env (600).
// `npm run auth:check`  — rejoue la seule vérification sur le .env existant,
//                         sans rien écrire.
//
// Ce fichier n'importe volontairement PAS `src/config.ts` (ni rien qui le charge)
// dans le flux de mise en route : on l'exécute justement quand il n'y a pas
// encore de configuration valide. La branche `--check` importe `account` à la
// demande.

const ENV_PATH = fileURLToPath(new URL('../../.env', import.meta.url));
const APPLE_ID_URL = 'https://appleid.apple.com/';
const IMAP_DEFAULT = { host: 'imap.mail.me.com', port: 993 };
const SMTP_DEFAULT = { host: 'smtp.mail.me.com', port: 587 };

const KEY_ENTER = ['\r', '\n', '\u0004']; // CR, LF, EOT
const KEY_CTRL_C = '\u0003';
const KEY_BACKSPACE = ['\u007f', '\b'];

function ask(query: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/** Lecture sans écho pour le mot de passe d'application. Retombe sur `ask` hors TTY. */
function askHidden(query: string): Promise<string> {
  const input = process.stdin;
  const output = process.stdout;

  if (!input.isTTY) {
    return ask(query);
  }

  return new Promise((resolve, reject) => {
    output.write(query);
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');

    let value = '';

    const finish = (): void => {
      input.removeListener('data', onData);
      input.setRawMode(Boolean(wasRaw));
      input.pause();
      output.write('\n');
    };

    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (KEY_ENTER.includes(ch)) {
          finish();
          resolve(value);
          return;
        }
        if (ch === KEY_CTRL_C) {
          finish();
          reject(new Error('Saisie interrompue.'));
          return;
        }
        if (KEY_BACKSPACE.includes(ch)) {
          value = value.slice(0, -1);
          continue;
        }
        if (ch >= ' ') {
          value += ch;
        }
      }
    };

    input.on('data', onData);
  });
}

interface VerifyTarget {
  email: string;
  password: string;
  imap: { host: string; port: number };
  smtp: { host: string; port: number };
}

/** Étape 4 : vérifie IMAP puis SMTP. Lève un message utilisateur explicite au premier échec. */
async function verifyBoth(target: VerifyTarget): Promise<void> {
  try {
    await verifyImap({ email: target.email, password: target.password, ...target.imap });
  } catch (err) {
    throw new Error(describeVerifyFailure('IMAP', err));
  }
  console.log('  ✓ IMAP');

  try {
    await verifySmtp({ email: target.email, password: target.password, ...target.smtp });
  } catch (err) {
    throw new Error(describeVerifyFailure('SMTP', err));
  }
  console.log('  ✓ SMTP');
}

async function runCheck(): Promise<void> {
  const { account } = await import('../account.js');
  console.log('Vérification de la configuration existante (aucune écriture)…\n');
  await verifyBoth({
    email: account.email,
    password: account.password,
    imap: account.imap,
    smtp: account.smtp,
  });
  console.log('\nConfiguration valide.');
}

async function runSetup(): Promise<void> {
  console.log('Configuration de mail-mcp\n');

  const email = (await ask('Adresse iCloud (Apple ID) : ')).trim();
  if (email === '') {
    throw new Error('Adresse vide, abandon.');
  }

  console.log(
    `\nUn mot de passe d'application est nécessaire (PAS le mot de passe principal Apple).\n` +
      `Générez-en un ici : ${APPLE_ID_URL}\n` +
      `  Connexion et sécurité -> Mots de passe pour applications -> Générer un mot de passe\n`,
  );

  const appPassword = normalizeAppPassword(await askHidden("Mot de passe d'application : "));
  if (appPassword === '') {
    throw new Error('Mot de passe vide, abandon.');
  }

  const bearerToken = generateBearerToken();

  console.log('\nVérification des identifiants auprès d’iCloud…');
  await verifyBoth({ email, password: appPassword, imap: IMAP_DEFAULT, smtp: SMTP_DEFAULT });

  const exists = existsSync(ENV_PATH);
  let confirmed = false;
  if (exists) {
    const answer = (await ask(`\n${ENV_PATH} existe déjà. L'écraser ? Une sauvegarde .env.bak sera créée. [o/N] `))
      .trim()
      .toLowerCase();
    confirmed = ['o', 'oui', 'y', 'yes'].includes(answer);
  }

  const plan = planEnvWrite({ exists, confirmed });
  if (!plan.write) {
    console.log('Abandon : le .env existant est conservé, rien n’a été écrit.');
    process.exitCode = 1;
    return;
  }

  writeEnvFile(ENV_PATH, renderEnvFile({ email, appPassword, bearerToken, enableSending: false }), {
    backup: plan.backup,
  });

  if (plan.backup) {
    console.log(`Sauvegarde de l'ancien fichier : ${ENV_PATH}.bak`);
  }
  console.log(
    `\n✓ ${ENV_PATH} écrit (chmod 600).\n` +
      `  ENABLE_SENDING=false par défaut : l'envoi reste coupé tant que vous ne le réactivez pas.\n` +
      `  Lancer le serveur : npm run dev`,
  );
}

async function main(): Promise<void> {
  if (process.argv.includes('--check')) {
    await runCheck();
  } else {
    await runSetup();
  }
}

main().catch((err: unknown) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
