import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerListFoldersTool } from './list-folders.js';
import { registerListMessagesTool } from './list-messages.js';
import { registerSearchMessagesTool } from './search-messages.js';
import { registerGetMessageTool } from './get-message.js';
import { registerSendMessageTool } from './send-message.js';
import { registerReplyMessageTool } from './reply-message.js';
import { registerForwardMessageTool } from './forward-message.js';
import { registerMoveMessageTool } from './move-message.js';
import { registerDeleteMessageTool } from './delete-message.js';
import { registerFlagMessageTool } from './flag-message.js';
import { registerSaveDraftTool } from './save-draft.js';
import { registerManageFolderTool } from './manage-folder.js';
import { registerUpdateDraftTool } from './update-draft.js';
import { registerGetThreadTool } from './get-thread.js';
import { registerWhoamiTool } from './whoami.js';

/**
 * Anciens outils (avant le regroupement par intention), réenregistrés tels
 * quels quand `LEGACY_TOOLS=true`, le temps d'une version. Noms et contrats
 * inchangés ; seule la description est préfixée par « Deprecated: use X ».
 *
 * `get_attachment` et `send_draft` gardent leur nom dans la nouvelle surface :
 * ils ne figurent donc pas ici (un nom ne peut être enregistré qu'une fois).
 */
const LEGACY_TOOLS: [register: (server: McpServer) => void, replacement: string][] = [
  [registerListFoldersTool, 'manage_folders (action "list")'],
  [registerListMessagesTool, 'find_messages'],
  [registerSearchMessagesTool, 'find_messages'],
  [registerGetMessageTool, 'read_message'],
  [registerSendMessageTool, 'compose_message (mode "new")'],
  [registerReplyMessageTool, 'compose_message (mode "reply" / "reply_all")'],
  [registerForwardMessageTool, 'compose_message (mode "forward")'],
  [registerMoveMessageTool, 'organize_messages (action "move")'],
  [registerDeleteMessageTool, 'organize_messages (action "trash")'],
  [registerFlagMessageTool, 'organize_messages'],
  [registerSaveDraftTool, 'compose_message (deliver "draft")'],
  [registerManageFolderTool, 'manage_folders'],
  [registerUpdateDraftTool, 'compose_message (deliver "draft" + draftUid)'],
  [registerGetThreadTool, 'read_message (includeThread)'],
  [registerWhoamiTool, 'inbox_overview (includeDiagnostics)'],
];

type RegisterTool = (name: string, config: { description?: string }, callback: unknown) => unknown;

/** Vue de `server` dont `registerTool` préfixe la description par la mention de dépréciation. */
function deprecating(server: McpServer, replacement: string): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop !== 'registerTool') return Reflect.get(target, prop, receiver) as unknown;
      const register = target.registerTool.bind(target) as RegisterTool;
      const wrapped: RegisterTool = (name, config, callback) =>
        register(
          name,
          { ...config, description: `Deprecated: use ${replacement}. ${config.description ?? ''}` },
          callback,
        );
      return wrapped;
    },
  });
}

export function registerLegacyTools(server: McpServer): void {
  for (const [register, replacement] of LEGACY_TOOLS) {
    register(deprecating(server, replacement));
  }
}
