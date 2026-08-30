import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerListFoldersTool } from './tools/list-folders.js';
import { registerListMessagesTool } from './tools/list-messages.js';
import { registerSearchMessagesTool } from './tools/search-messages.js';
import { registerGetMessageTool } from './tools/get-message.js';
import { registerGetAttachmentTool } from './tools/get-attachment.js';
import { registerSendMessageTool } from './tools/send-message.js';
import { registerReplyMessageTool } from './tools/reply-message.js';
import { registerForwardMessageTool } from './tools/forward-message.js';
import { registerMoveMessageTool } from './tools/move-message.js';
import { registerDeleteMessageTool } from './tools/delete-message.js';
import { registerFlagMessageTool } from './tools/flag-message.js';
import { registerSaveDraftTool } from './tools/save-draft.js';
import { registerManageFolderTool } from './tools/manage-folder.js';
import { registerUpdateDraftTool } from './tools/update-draft.js';
import { registerSendDraftTool } from './tools/send-draft.js';
import { registerGetThreadTool } from './tools/get-thread.js';
import { registerWhoamiTool } from './tools/whoami.js';
import { serverVersion } from '../version.js';

export function createMailMcpServer(): McpServer {
  const server = new McpServer({
    name: 'icloud-mail',
    version: serverVersion,
  });

  registerListFoldersTool(server);
  registerListMessagesTool(server);
  registerSearchMessagesTool(server);
  registerGetMessageTool(server);
  registerGetAttachmentTool(server);
  registerSendMessageTool(server);
  registerReplyMessageTool(server);
  registerForwardMessageTool(server);
  registerMoveMessageTool(server);
  registerDeleteMessageTool(server);
  registerFlagMessageTool(server);
  registerSaveDraftTool(server);
  registerManageFolderTool(server);
  registerUpdateDraftTool(server);
  registerSendDraftTool(server);
  registerGetThreadTool(server);
  registerWhoamiTool(server);

  return server;
}
