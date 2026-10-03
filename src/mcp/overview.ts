import { account } from '../account.js';
import { listFolders } from '../imap/folders.js';
import type { FolderInfo } from '../imap/folders.js';
import { listMessages } from '../imap/messages.js';
import type { MessagePage, MessageSummary } from '../imap/messages.js';
import { buildWhoami } from './whoami.js';
import type { WhoamiGuardrails, WhoamiReport } from './whoami.js';

/**
 * Logique de l'outil `inbox_overview` : la vue d'ensemble que le client
 * appelle en premier (compte, non lus et derniers mails de l'INBOX, compteurs
 * par dossier, garde-fous actifs).
 *
 * Même règle que `whoami`, dont elle reprend le rapport : aucun secret ne sort
 * d'ici. Les diagnostics (sonde IMAP, état du pool, hôtes) ne sont inclus
 * qu'à la demande.
 */

const INBOX = 'INBOX';

export interface FolderCount {
  path: string;
  specialUse?: string;
  messages?: number;
  unseen?: number;
}

export interface InboxOverview {
  account: { email: string };
  inbox: {
    folder: string;
    /** Nombre total de messages, d'après STATUS. Absent si l'INBOX n'a pas été listée. */
    total?: number;
    /** Nombre de non lus, d'après STATUS (à défaut : ceux renvoyés dans `recentUnread`). */
    unread: number;
    /** Les `limit` derniers non lus, du plus récent au plus ancien. */
    recentUnread: MessageSummary[];
    /** Les `limit` derniers messages, lus ou non. */
    recent: MessageSummary[];
  };
  folders: FolderCount[];
  guardrails: WhoamiGuardrails;
  /** Rapport `whoami` complet avec sonde, seulement si `includeDiagnostics`. */
  diagnostics?: WhoamiReport;
}

export interface InboxOverviewOptions {
  limit: number;
  includeDiagnostics: boolean;
}

export interface InboxOverviewDeps {
  /** Une page de l'INBOX. Défaut : `listMessages('INBOX', ...)`. */
  listInbox?: (options: { unreadOnly?: boolean; limit: number }) => Promise<MessagePage>;
  /** Dossiers avec compteurs. Défaut : `listFolders(true)`. */
  listFolders?: () => Promise<FolderInfo[]>;
  /** Rapport de compte et garde-fous. Défaut : `buildWhoami`. */
  whoami?: (probe: boolean) => Promise<WhoamiReport>;
}

export async function buildInboxOverview(
  options: InboxOverviewOptions,
  deps: InboxOverviewDeps = {},
): Promise<InboxOverview> {
  const listInbox = deps.listInbox ?? ((opts) => listMessages(INBOX, opts));
  const folders = deps.listFolders ?? (() => listFolders(true));
  const whoami = deps.whoami ?? ((probe) => buildWhoami(probe));

  const [unreadPage, recentPage, folderList, report] = await Promise.all([
    listInbox({ unreadOnly: true, limit: options.limit }),
    listInbox({ limit: options.limit }),
    folders(),
    whoami(options.includeDiagnostics),
  ]);

  const inboxInfo = folderList.find((folder) => folder.path.toUpperCase() === INBOX);

  const overview: InboxOverview = {
    account: { email: account.email },
    inbox: {
      folder: inboxInfo?.path ?? INBOX,
      ...(inboxInfo?.messages !== undefined ? { total: inboxInfo.messages } : {}),
      unread: inboxInfo?.unseen ?? unreadPage.messages.length,
      recentUnread: unreadPage.messages,
      recent: recentPage.messages,
    },
    folders: folderList.map((folder) => ({
      path: folder.path,
      ...(folder.specialUse ? { specialUse: folder.specialUse } : {}),
      ...(folder.messages !== undefined ? { messages: folder.messages } : {}),
      ...(folder.unseen !== undefined ? { unseen: folder.unseen } : {}),
    })),
    guardrails: report.guardrails,
  };

  if (options.includeDiagnostics) {
    overview.diagnostics = report;
  }

  return overview;
}
