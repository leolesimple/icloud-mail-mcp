import { randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, writeFileSync } from 'node:fs';
import { ImapAuthError, ImapNetworkError } from '../imap/errors.js';
import { SmtpAuthError, SmtpNetworkError } from '../smtp/errors.js';

/**
 * Logique pure du CLI `npm run auth`. Le flux interactif (saisie masquée) et
 * les vérifications réseau IMAP/SMTP vivent dans `auth.ts` et sont injectés :
 * rien ici n'ouvre de connexion ni ne lit stdin, donc tout est testable.
 */

/** Retire les espaces et remet un mot de passe d'application au format `xxxx-xxxx-xxxx-xxxx`. */
export function normalizeAppPassword(raw: string): string {
  const compact = raw.replace(/\s+/g, '');
  const letters = compact.replace(/-/g, '');
  if (/^[a-z0-9]{16}$/i.test(letters)) {
    return (letters.toLowerCase().match(/.{1,4}/g) ?? []).join('-');
  }
  // Format inattendu : on retire au moins les espaces, la vérification IMAP tranchera.
  return compact;
}

export type RandomBytesFn = (size: number) => Buffer;

/**
 * Génère un `MCP_BEARER_TOKEN` : 32 octets aléatoires en base64url (~43
 * caractères, bien au-dessus du minimum de 16 exigé par `src/config.ts`).
 */
export function generateBearerToken(rng: RandomBytesFn = randomBytes, size = 32): string {
  return rng(size).toString('base64url');
}

export interface EnvFileValues {
  email: string;
  appPassword: string;
  bearerToken: string;
  imapHost?: string;
  imapPort?: number;
  smtpHost?: string;
  smtpPort?: number;
  /** Défaut : `false` — on démarre coupe-circuit fermé, comme le recommande la doc sécurité. */
  enableSending?: boolean;
}

/** Rend un fichier `.env` complet et déterministe. Aucun secret dans les commentaires. */
export function renderEnvFile(values: EnvFileValues): string {
  return (
    [
      '# Généré par `npm run auth`. Ne jamais committer ce fichier (voir .gitignore).',
      '',
      '# --- Identifiants iCloud ---',
      `ICLOUD_EMAIL=${values.email}`,
      `ICLOUD_APP_PASSWORD=${values.appPassword}`,
      '',
      '# --- Connexion IMAP ---',
      `IMAP_HOST=${values.imapHost ?? 'imap.mail.me.com'}`,
      `IMAP_PORT=${values.imapPort ?? 993}`,
      'IMAP_POOL_SIZE=2',
      '',
      '# --- Connexion SMTP ---',
      `SMTP_HOST=${values.smtpHost ?? 'smtp.mail.me.com'}`,
      `SMTP_PORT=${values.smtpPort ?? 587}`,
      'SMTP_POOL_SIZE=2',
      '',
      '# --- Serveur HTTP MCP ---',
      'PORT=3000',
      `MCP_BEARER_TOKEN=${values.bearerToken}`,
      '',
      "# Coupe-circuit d'envoi : démarrer à false, réactiver après avoir observé le comportement.",
      `ENABLE_SENDING=${values.enableSending ? 'true' : 'false'}`,
      '',
      '# --- Cloudflare Tunnel (service docker-compose uniquement) ---',
      'TUNNEL_TOKEN=',
      '',
      '# --- Logs ---',
      'LOG_LEVEL=info',
    ].join('\n') + '\n'
  );
}

export interface EnvWritePlan {
  write: boolean;
  backup: boolean;
  needsConfirmation: boolean;
}

/** Décide quoi faire face à un `.env` (absent → écrire ; présent → confirmer puis sauvegarder). */
export function planEnvWrite(opts: { exists: boolean; confirmed: boolean }): EnvWritePlan {
  if (!opts.exists) return { write: true, backup: false, needsConfirmation: false };
  if (!opts.confirmed) return { write: false, backup: false, needsConfirmation: true };
  return { write: true, backup: true, needsConfirmation: false };
}

/** Écrit le `.env` en `chmod 600`, avec sauvegarde `.env.bak` préalable si demandé. */
export function writeEnvFile(path: string, content: string, opts: { backup: boolean }): void {
  if (opts.backup) {
    copyFileSync(path, `${path}.bak`);
    chmodSync(`${path}.bak`, 0o600);
  }
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export type VerifyStage = 'IMAP' | 'SMTP';

/**
 * Message d'échec de vérification, destiné à l'utilisateur. Distingue les cas
 * qui ne se corrigent pas de la même façon : mot de passe d'application invalide
 * (régénérer) vs. serveur injoignable (réseau). Rappelle systématiquement
 * qu'aucun fichier n'a été écrit.
 */
export function describeVerifyFailure(stage: VerifyStage, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  const nothingWritten = "Aucun fichier n'a été écrit.";

  if (err instanceof ImapAuthError || err instanceof SmtpAuthError) {
    return (
      `Vérification ${stage} : authentification refusée. Le mot de passe d'application est ` +
      `probablement invalide ou révoqué — générez-en un nouveau sur https://appleid.apple.com/ ` +
      `(Connexion et sécurité → Mots de passe pour applications). ${nothingWritten}\n${detail}`
    );
  }

  if (err instanceof ImapNetworkError || err instanceof SmtpNetworkError) {
    return (
      `Vérification ${stage} : serveur injoignable (réseau, DNS ou pare-feu). Les identifiants ` +
      `n'ont pas pu être testés — réessayez plus tard. ${nothingWritten}\n${detail}`
    );
  }

  return `Vérification ${stage} échouée. ${nothingWritten}\n${detail}`;
}
