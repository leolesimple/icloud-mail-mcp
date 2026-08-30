import type { Server } from 'node:http';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createHttpServer } from './http/server.js';
import { createMailMcpServer } from './mcp/server.js';
import { imapPool } from './imap/pool.js';
import { closeSmtp } from './smtp/client.js';
import { config } from './config.js';
import { logger } from './logger.js';

// Transport MCP sélectionnable. Le montage HTTP est conditionnel : en `stdio`
// pur il n'y a ni serveur HTTP à démarrer, ni balayage de sessions à arrêter.
const useHttp = config.MCP_TRANSPORT === 'http' || config.MCP_TRANSPORT === 'both';
const useStdio = config.MCP_TRANSPORT === 'stdio' || config.MCP_TRANSPORT === 'both';

const cleanups: Array<() => void | Promise<void>> = [];

if (useHttp) {
  const http = createHttpServer();
  const httpServer: Server = http.app.listen(config.PORT, '0.0.0.0', () => {
    logger.info({ port: config.PORT }, 'mail-mcp http server listening');
  });
  cleanups.push(() => {
    httpServer.close();
  });
  // Ferme les sessions MCP encore ouvertes et arrête le balayage périodique
  // (l'intervalle est unref'd, mais on ne laisse pas de session pendante).
  cleanups.push(() => http.close());
}

if (useStdio) {
  const server = createMailMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  cleanups.push(() => transport.close());
  // stderr : en stdio, stdout est le canal JSON-RPC (voir src/logger.ts).
  logger.info('mail-mcp stdio server ready');
}

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down');
  for (const cleanup of cleanups) {
    await cleanup();
  }
  await imapPool.close();
  closeSmtp();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
