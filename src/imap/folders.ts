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
    subscribed: entry.subscribed,
  };
}

/**
 * Cœur testable : liste les dossiers, et si `includeStatus`, ajoute les
 * compteurs via une commande STATUS par dossier (~10 allers-retours sur un
 * compte iCloud typique — d'où l'option pour un listing rapide).
 */
export async function listFoldersOn(client: ImapFlow, includeStatus: boolean): Promise<FolderInfo[]> {
  const infos = (await client.list()).map(toFolderInfo);
  if (!includeStatus) return infos;

  for (const info of infos) {
    try {
      const status = await client.status(info.path, { messages: true, unseen: true });
      info.messages = status.messages;
      info.unseen = status.unseen;
    } catch {
      // Un conteneur \Noselect n'accepte pas STATUS : on le laisse sans compteurs.
    }
  }
  return infos;
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
      throw new ImapCommandError('Un chemin cible ("newPath") est requis pour renommer un dossier.');
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
