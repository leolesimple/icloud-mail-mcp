import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMailMcpServer } from '../../src/mcp/server.js';
import type { MailMcpServerOptions } from '../../src/mcp/server.js';

/**
 * Client MCP relié en mémoire à une instance du serveur : initialize,
 * tools/list et les appels d'outils qui échouent à la validation, sans aucun
 * accès réseau. Un outil qui irait jusqu'à IMAP ou SMTP, lui, tenterait de se
 * connecter : ne l'utiliser que pour des appels refusés en amont.
 */
export async function connectClient(options: MailMcpServerOptions = {}): Promise<Client> {
  const server = createMailMcpServer({ legacyTools: false, idleWatch: false, ...options });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/** Texte du premier bloc d'un résultat d'outil. */
export function firstText(result: object): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content;
  return content?.[0]?.text ?? '';
}
