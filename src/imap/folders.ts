import type { ImapFlow, ListResponse } from 'imapflow';
import { imapPool } from './pool.js';
import { classifyImapError, ImapCommandError } from './errors.js';

export interface FolderInfo {
  path: string;
  name: string;
  delimiter: string;
  parentPath: string;
  specialUse?: string;
  flags: string[];
  subscribed: boolean;
  /** Nombre total de messages. Absent quand `includeStatus` vaut false. */
  messages?: number;
  /** Nombre de messages non lus. Absent quand `includeStatus` vaut false. */
  unseen?: number;
}

/**
 * Rôles système IMAP. Un dossier qui en porte un (ou l'INBOX) ne peut être ni
 * renommé ni supprimé : la suppression d'un dossier IMAP est irréversible et
 * emporte tout son contenu.
 */
export const PROTECTED_SPECIAL_USE = new Set([
  '\\Inbox',
  '\\Sent',
  '\\Trash',
  '\\Drafts',
  '\\Archive',
  '\\Junk',
  '\\All',
  '\\Important',
  '\\Flagged',
]);

function toFolderInfo(entry: ListResponse): FolderInfo {
  return {
    path: entry.path,
    name: entry.name,
    delimiter: entry.delimiter,
    parentPath: entry.parentPath,
    specialUse: entry.specialUse,
    flags: Array.from(entry.flags),
    // imapflow : quand le serveur ne rapporte aucun état d'abonnement (ni LSUB, ni LIST RETURN
    // (SUBSCRIBED)), `subscribed` est absent et tout dossier est alors réputé abonné.
    subscribed: entry.subscribed ?? true,
  };
}

/**
 * Cœur testable : liste les dossiers, et si `includeStatus`, ajoute les
 * compteurs. Ils sont demandés avec le LIST lui-même (LIST-STATUS, RFC 5819,
 * annoncé par iCloud) : un seul aller-retour au lieu d'un STATUS par dossier.
 * Sur un serveur sans LIST-STATUS, imapflow retombe de lui-même sur un STATUS
 * par dossier.
 */
export async function listFoldersOn(
  client: ImapFlow,
  includeStatus: boolean,
): Promise<FolderInfo[]> {
  if (!includeStatus) return (await client.list()).map(toFolderInfo);

  const entries = await client.list({ statusQuery: { messages: true, unseen: true } });
  return entries.map((entry) => {
    const info = toFolderInfo(entry);
    // Absent pour un conteneur \Noselect ; `false` ou `{ error }` quand le serveur
    // refuse le STATUS de repli : on laisse alors le dossier sans compteurs.
    const status: unknown = entry.status;
    if (status && typeof status === 'object' && !('error' in status)) {
      const { messages, unseen } = status as { messages?: number; unseen?: number };
      info.messages = messages;
      info.unseen = unseen;
    }
    return info;
  });
}

export async function listFolders(includeStatus = true): Promise<FolderInfo[]> {
  try {
    return await imapPool.withConnection((client) => listFoldersOn(client, includeStatus));
  } catch (err) {
    throw classifyImapError(err);
  }
}

export type FolderAction = 'create' | 'rename' | 'delete';

export interface ManageFolderResult {
  action: FolderAction;
  path: string;
  newPath?: string;
}

/** Refuse de toucher un dossier système. `verb` est le participe passé français. */
async function assertMutable(client: ImapFlow, path: string, verb: string): Promise<void> {
  if (path.toUpperCase() === 'INBOX') {
    throw new ImapCommandError(`Le dossier INBOX ne peut pas être ${verb}.`);
  }
  const entry = (await client.list()).find((mailbox) => mailbox.path === path);
  if (entry?.specialUse && PROTECTED_SPECIAL_USE.has(entry.specialUse)) {
    throw new ImapCommandError(
      `Le dossier "${path}" a un rôle système (${entry.specialUse}) et ne peut pas être ${verb} : ` +
        `l'opération serait irréversible et emporterait son contenu.`,
    );
  }
}

export async function manageFolderOn(
  client: ImapFlow,
  action: FolderAction,
  path: string,
  newPath?: string,
): Promise<ManageFolderResult> {
  if (action === 'create') {
    await client.mailboxCreate(path);
    return { action, path };
  }

  if (action === 'rename') {
    if (!newPath) {
      throw new ImapCommandError(
        'Un chemin cible ("newPath") est requis pour renommer un dossier.',
      );
    }
    await assertMutable(client, path, 'renommé');
    await client.mailboxRename(path, newPath);
    return { action, path, newPath };
  }

  await assertMutable(client, path, 'supprimé');
  await client.mailboxDelete(path);
  return { action, path };
}

export async function manageFolder(
  action: FolderAction,
  path: string,
  newPath?: string,
): Promise<ManageFolderResult> {
  try {
    return await imapPool.withConnection((client) => manageFolderOn(client, action, path, newPath));
  } catch (err) {
    throw classifyImapError(err);
  }
}

/** Rôles exclus de la recherche « tous les dossiers » sauf demande explicite. */
export const TRASH_LIKE_SPECIAL_USE = new Set(['\\Trash', '\\Junk']);

/**
 * Dossiers fouillés par `folders: "*"` : tous les dossiers sélectionnables (un
 * conteneur \Noselect ou \NonExistent ne contient aucun message), hors
 * corbeille et indésirables sauf `includeTrash`.
 */
export function searchableFolderPaths(folders: FolderInfo[], includeTrash = false): string[] {
  return folders
    .filter((folder) => !folder.flags.some((flag) => /^\\(noselect|nonexistent)$/i.test(flag)))
    .filter(
      (folder) =>
        includeTrash || !folder.specialUse || !TRASH_LIKE_SPECIAL_USE.has(folder.specialUse),
    )
    .map((folder) => folder.path);
}
