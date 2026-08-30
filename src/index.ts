import { createHttpServer } from './http/server.js';
import { imapPool } from './imap/pool.js';
import { closeSmtp } from './smtp/client.js';
import { config } from './config.js';
import { logger } from './logger.js';

const http = createHttpServer();

const server = http.app.listen(config.PORT, '0.0.0.0', () => {
  logger.info({ port: config.PORT }, 'mail-mcp http server listening');
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down');
  server.close();
  await http.close();
  await imapPool.close();
  closeSmtp();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
