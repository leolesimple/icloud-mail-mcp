import type { ImapFlow } from 'imapflow';
import { imapPool } from './pool.js';
import { findSpecialFolder } from './special-folders.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'imap-sent' });

/** Dossier « Sent » du compte, résolu par son flag `\Sent`, repli sur `'Sent Messages'`. */
export async function resolveSentFolder(client: ImapFlow): Promise<string> {
  return (await findSpecialFolder(client, '\\Sent')) ?? 'Sent Messages';
}

/**
 * APPEND du message envoyé (buffer RFC 5322 bit-pour-bit) dans le dossier
 * « Sent », marqué `\Seen`. Prend le client en paramètre : testable directement.
 * Renvoie le chemin du dossier utilisé.
 */
export async function appendToSentFolder(client: ImapFlow, raw: Buffer): Promise<string> {
  const path = await resolveSentFolder(client);
  await client.append(path, raw, ['\\Seen']);
  return path;
}

/** Exécuteur de connexion IMAP, injectable pour les tests (défaut : le pool partagé). */
type WithConnection = <T>(fn: (client: ImapFlow) => Promise<T>) => Promise<T>;

/**
 * Archive un message envoyé dans « Sent ». Non bloquant : un échec logue un
 * `warn` et renvoie `false` — l'envoi SMTP reste un succès, on ne ment jamais
 * sur le fait que le mail est bien parti.
 */
export async function saveToSent(
  raw: Buffer,
  withConnection: WithConnection = (fn) => imapPool.withConnection(fn),
): Promise<boolean> {
  try {
    const path = await withConnection((client) => appendToSentFolder(client, raw));
    log.debug({ path }, 'sent message appended to Sent folder');
    return true;
  } catch (err) {
    log.warn(
      { reason: err instanceof Error ? err.message : String(err) },
      'could not append sent message to Sent folder',
    );
    return false;
  }
}
