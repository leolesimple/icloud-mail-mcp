import pino from 'pino';
import { config } from './config.js';

/**
 * Descripteur de fichier vers lequel écrire les logs.
 *
 * En transport stdio, stdout porte le canal JSON-RPC : la moindre ligne de log
 * qui y atterrit casse le cadrage des messages et rend le serveur inutilisable
 * de façon difficile à diagnostiquer. Dès que stdio est actif (`stdio` ou
 * `both`), les logs partent donc sur stderr (fd 2).
 */
export function logStreamFd(transport: string): 1 | 2 {
  return transport === 'stdio' || transport === 'both' ? 2 : 1;
}

export const secretLogPaths = [
  'password',
  'pass',
  'token',
  'ICLOUD_APP_PASSWORD',
  'MCP_BEARER_TOKEN',
  'CONFIRM_SECRET',
  'DOWNLOAD_URL_SECRET',
  'headers.authorization',
  'headers.cookie',
  'req.headers.authorization',
  'req.headers.cookie',
  '*.password',
  '*.pass',
  '*.ICLOUD_APP_PASSWORD',
  '*.token',
  '*.CONFIRM_SECRET',
  '*.DOWNLOAD_URL_SECRET',
];

export const logger = pino(
  {
    level: config.LOG_LEVEL,
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: secretLogPaths,
      censor: '[redacted]',
    },
  },
  pino.destination(logStreamFd(config.MCP_TRANSPORT)),
);
