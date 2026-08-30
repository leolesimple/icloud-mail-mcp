import { randomUUID } from 'node:crypto';
import express from 'express';
import type { Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMailMcpServer } from '../mcp/server.js';
import { bearerAuth } from './auth.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'http' });

const transports = new Map<string, StreamableHTTPServerTransport>();

async function handlePost(req: Request, res: Response): Promise<void> {
  const sessionId = req.headers['mcp-session-id'];
  const existing = typeof sessionId === 'string' ? transports.get(sessionId) : undefined;

  try {
    let transport = existing;

    if (!transport) {
      if (sessionId || !isInitializeRequest(req.body)) {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: no valid session ID provided' },
          id: null,
        });
        return;
      }

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          transports.set(newSessionId, transport!);
          log.info({ sessionId: newSessionId }, 'mcp session initialized');
        },
        onsessionclosed: (closedSessionId) => {
          transports.delete(closedSessionId);
          log.info({ sessionId: closedSessionId }, 'mcp session closed');
        },
      });

      const server = createMailMcpServer();
      await server.connect(transport);
    }

    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    log.error({ err }, 'error handling mcp request');
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
}

async function handleSessionRequest(req: Request, res: Response): Promise<void> {
  const sessionId = req.headers['mcp-session-id'];
  const transport = typeof sessionId === 'string' ? transports.get(sessionId) : undefined;
  if (!transport) {
    res.status(400).send('Invalid or missing session ID');
    return;
  }
  await transport.handleRequest(req, res);
}

export function createHttpServer(): express.Express {
  const app = express();
  app.use(express.json());

  app.post('/mcp', bearerAuth, handlePost);
  app.get('/mcp', bearerAuth, handleSessionRequest);
  app.delete('/mcp', bearerAuth, handleSessionRequest);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  return app;
}

export async function closeAllSessions(): Promise<void> {
  for (const [sessionId, transport] of transports) {
    try {
      await transport.close();
    } catch (err) {
      log.warn({ err, sessionId }, 'error closing mcp session');
    }
  }
  transports.clear();
}
