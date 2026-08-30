import type { ListResponse } from 'imapflow';
import { imapPool } from './pool.js';
import { classifyImapError } from './errors.js';

export interface FolderInfo {
  path: string;
  name: string;
  delimiter: string;
  parentPath: string;
  specialUse?: string;
  flags: string[];
  subscribed: boolean;
}

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

export async function listFolders(): Promise<FolderInfo[]> {
  try {
    const list = await imapPool.withConnection((client) => client.list());
    return list.map(toFolderInfo);
  } catch (err) {
    throw classifyImapError(err);
  }
}
