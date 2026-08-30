import nodemailer from 'nodemailer';
import { classifySmtpError } from './errors.js';

/** Point de connexion SMTP à vérifier (identifiants candidats, pas forcément ceux du `.env`). */
export interface SmtpVerifyTarget {
  email: string;
  password: string;
  host: string;
  port: number;
}

/** Vérificateur SMTP injectable : par défaut un `transporter.verify()` nodemailer. */
export type SmtpVerifier = (target: SmtpVerifyTarget) => Promise<void>;

/**
 * Établit une connexion SMTP réelle et authentifie (STARTTLS obligatoire sur le
 * port 587, comme le transport de production). N'envoie aucun message. Toute
 * erreur remonte classifiée (auth / réseau / message) par `classifySmtpError`.
 */
export const verifySmtp: SmtpVerifier = async (target) => {
  const transporter = nodemailer.createTransport({
    host: target.host,
    port: target.port,
    secure: false,
    requireTLS: true,
    auth: { user: target.email, pass: target.password },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });

  try {
    await transporter.verify();
  } catch (err) {
    throw classifySmtpError(err);
  } finally {
    transporter.close();
  }
};
