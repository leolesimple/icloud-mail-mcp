export class SmtpAuthError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SmtpAuthError';
  }
}

export class SmtpNetworkError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SmtpNetworkError';
  }
}

export class SmtpMessageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SmtpMessageError';
  }
}

// Codes posés par nodemailer (lib/smtp-connection, lib/smtp-transport).
const AUTH_ERROR_CODES = new Set(['EAUTH', 'ENOAUTH']);
const NETWORK_ERROR_CODES = new Set(['ECONNECTION', 'EDNS', 'ETIMEDOUT', 'ESOCKET']);

interface NodemailerError extends Error {
  code?: string;
}

export function classifySmtpError(err: unknown): Error {
  if (err instanceof SmtpAuthError || err instanceof SmtpNetworkError || err instanceof SmtpMessageError) {
    return err;
  }

  if (!(err instanceof Error)) {
    return new SmtpMessageError(`Erreur SMTP inconnue : ${String(err)}`);
  }

  const smtpErr = err as NodemailerError;

  if (smtpErr.code && AUTH_ERROR_CODES.has(smtpErr.code)) {
    return new SmtpAuthError(
      `Authentification SMTP iCloud refusée — vérifier ICLOUD_EMAIL et ICLOUD_APP_PASSWORD : ${err.message}`,
      { cause: err },
    );
  }

  if (smtpErr.code && NETWORK_ERROR_CODES.has(smtpErr.code)) {
    return new SmtpNetworkError(`Connexion au serveur SMTP iCloud impossible (${smtpErr.code}) : ${err.message}`, {
      cause: err,
    });
  }

  return new SmtpMessageError(err.message, { cause: err });
}
