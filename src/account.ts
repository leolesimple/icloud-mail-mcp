import { config } from './config.js';

/**
 * Compte mail unique dérivé de la configuration. Point d'accès unique aux
 * identifiants et aux serveurs, pour préparer un éventuel multi-compte sans
 * l'implémenter : rien n'expose de notion de compte aux outils MCP aujourd'hui.
 */
export interface MailAccount {
  email: string;
  password: string;
  imap: { host: string; port: number };
  smtp: { host: string; port: number };
}

export const account: MailAccount = {
  email: config.ICLOUD_EMAIL,
  password: config.ICLOUD_APP_PASSWORD,
  imap: { host: config.IMAP_HOST, port: config.IMAP_PORT },
  smtp: { host: config.SMTP_HOST, port: config.SMTP_PORT },
};
