export class ImapAuthError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ImapAuthError';
  }
}

export class ImapNetworkError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ImapNetworkError';
  }
}

export class ImapCommandError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ImapCommandError';
  }
}

// Codes imapflow utilise pour les échecs de connexion / réseau (voir lib/imap-flow.js).
const NETWORK_ERROR_CODES = new Set([
  'ENOTFOUND',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'EPIPE',
  'NoConnection',
  'EConnectionClosed',
  'CONNECT_TIMEOUT',
  'GREETING_TIMEOUT',
  'UPGRADE_TIMEOUT',
  'StateLogout',
]);

interface ImapFlowError extends Error {
  code?: string;
  // Propriété posée par imapflow sur sa classe interne AuthenticationFailure
  // (non exportée du package, donc pas d'instanceof possible).
  authenticationFailed?: boolean;
}

export function classifyImapError(err: unknown): Error {
  if (err instanceof ImapAuthError || err instanceof ImapNetworkError || err instanceof ImapCommandError) {
    return err;
  }

  if (!(err instanceof Error)) {
    return new ImapCommandError(`Erreur IMAP inconnue : ${String(err)}`);
  }

  const flowErr = err as ImapFlowError;

  if (flowErr.authenticationFailed) {
    return new ImapAuthError(
      `Authentification iCloud IMAP refusée — vérifier ICLOUD_EMAIL et ICLOUD_APP_PASSWORD ` +
        `(un mot de passe d'application est requis, pas le mot de passe principal Apple) : ${err.message}`,
      { cause: err },
    );
  }

  if (flowErr.code && NETWORK_ERROR_CODES.has(flowErr.code)) {
    return new ImapNetworkError(`Connexion au serveur IMAP iCloud impossible (${flowErr.code}) : ${err.message}`, {
      cause: err,
    });
  }

  return new ImapCommandError(err.message, { cause: err });
}
