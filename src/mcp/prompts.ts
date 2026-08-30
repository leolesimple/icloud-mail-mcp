import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { completable } from '@modelcontextprotocol/sdk/server/completable.js';
import { completeFolder } from './folder-cache.js';

/**
 * Prompts MCP : des points de départ courts, en français, pour les tâches
 * courantes sur une boîte mail. Ils décrivent la marche à suivre avec les
 * outils du serveur ; ils ne font rien par eux-mêmes.
 */

// `completable()` marque le schéma en place (propriété non énumérable) et
// renvoie la même instance : toute méthode zod appelée ensuite (`.describe`…)
// en produit un clone qui perd la marque. On décrit donc AVANT d'envelopper.
const folderArg = (description: string) =>
  completable(z.string().describe(description), (value) => completeFolder(value));

function userText(text: string) {
  return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] };
}

export function registerMailPrompts(server: McpServer): void {
  server.registerPrompt(
    'triage-inbox',
    {
      title: 'Trier la boîte de réception',
      description: 'Passe en revue les messages non lus et propose une action pour chacun.',
      argsSchema: {
        folder: completable(z.string().optional(), (value) => completeFolder(value ?? '')),
      },
    },
    ({ folder }) =>
      userText(
        `Trie le dossier « ${folder ?? 'INBOX'} ».\n\n` +
          `1. Appelle list_messages avec unreadOnly: true.\n` +
          `2. Pour chaque message, résume-le en une phrase et recommande UNE action : ` +
          `répondre, archiver (move_message), supprimer (delete_message), ou laisser tel quel.\n` +
          `3. Présente le tout sous forme de tableau et attends ma validation avant toute modification.`,
      ),
  );

  server.registerPrompt(
    'summarize-thread',
    {
      title: 'Résumer un fil de discussion',
      description: 'Résume le fil auquel appartient un message donné.',
      argsSchema: {
        folder: folderArg('Dossier contenant le message'),
        uid: z.string().describe('UID IMAP du message'),
      },
    },
    ({ folder, uid }) =>
      userText(
        `Résume le fil de discussion contenant le message UID ${uid} du dossier « ${folder} ».\n\n` +
          `Récupère le message avec get_message. Si son champ References pointe vers d'autres messages ` +
          `du même dossier, récupère-les aussi via search_messages pour reconstituer le fil.\n` +
          `Donne-moi : les points clés, les décisions prises, et ce qui attend une réponse de ma part.`,
      ),
  );

  server.registerPrompt(
    'draft-reply',
    {
      title: 'Préparer une réponse',
      description: 'Rédige un brouillon de réponse à un message et l’enregistre (sans l’envoyer).',
      argsSchema: {
        folder: folderArg('Dossier contenant le message d’origine'),
        uid: z.string().describe('UID IMAP du message auquel répondre'),
        instructions: z.string().optional().describe('Consignes sur le ton ou le contenu de la réponse'),
      },
    },
    ({ folder, uid, instructions }) =>
      userText(
        `Prépare une réponse au message UID ${uid} du dossier « ${folder} ».\n\n` +
          `1. Lis le message avec get_message.\n` +
          `2. Rédige une réponse en français, concise et polie` +
          (instructions ? `, en tenant compte de : ${instructions}` : '') +
          `.\n` +
          `3. Enregistre-la avec save_draft en renseignant replyFolder et replyUid pour garder le fil. ` +
          `Ne l'envoie pas : je la relirai depuis mon client mail.`,
      ),
  );
}
