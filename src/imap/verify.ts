import { ImapFlow } from 'imapflow';
import { classifyImapError } from './errors.js';

/** Point de connexion IMAP à vérifier (identifiants candidats, pas forcément ceux du `.env`). */
export interface ImapVerifyTarget {
  email: string;
  password: string;
  host: string;
  port: number;
}

export interface ImapVerifyResult {
  folderCount: number;
  folders: string[];
}

/** Sous-ensemble d'`ImapFlow` manipulé ici. Permet d'injecter un faux client en test. */
export interface VerifiableImapClient {
  connect(): Promise<void>;
  list(): Promise<Array<{ path: string }>>;
  logout(): Promise<void>;
  close(): void;
}

export type ImapClientBuilder = (target: ImapVerifyTarget) => VerifiableImapClient;

const buildImapClient: ImapClientBuilder = (target) =>
  new ImapFlow({
    host: target.host,
    port: target.port,
    secure: true,
    auth: { user: target.email, pass: target.password },
    logger: false,
  }) as unknown as VerifiableImapClient;

/**
 * Ouvre une connexion IMAP réelle, liste les dossiers, se déconnecte. Toute
 * erreur remonte classifiée (auth / réseau / commande) par `classifyImapError`,
 * de sorte que l'appelant peut distinguer « mot de passe d'application invalide »
 * de « serveur injoignable ». Le constructeur de client est injectable : les
 * tests passent un faux client et n'ouvrent aucune connexion.
 *
 * C'est la logique de vérification partagée entre `npm run verify:imap`,
 * `npm run auth` et l'outil `whoami --probe`.
 */
export async function verifyImap(
  target: ImapVerifyTarget,
  build: ImapClientBuilder = buildImapClient,
): Promise<ImapVerifyResult> {
  const client = build(target);

  try {
    await client.connect();
  } catch (err) {
    throw classifyImapError(err);
  }

  try {
    const list = await client.list();
    const folders = list.map((entry) => entry.path);
    return { folderCount: folders.length, folders };
  } catch (err) {
    throw classifyImapError(err);
  } finally {
    try {
      await client.logout();
    } catch {
      client.close();
    }
  }
}
