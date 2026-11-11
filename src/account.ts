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
  email: config.MAIL_EMAIL,
  password: config.MAIL_PASSWORD,
  imap: { host: config.MAIL_IMAP_HOST, port: config.MAIL_IMAP_PORT },
  smtp: { host: config.MAIL_SMTP_HOST, port: config.MAIL_SMTP_PORT },
};
