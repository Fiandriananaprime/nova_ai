import { appendFile, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { NovaError } from '../utils/errors.js';
import { assertSafeAgentPath } from '../security/agent-files.js';
import { renderStatus } from '../cli/terminal-ui.js';
import type { PersistedSession } from './persistence.js';

export function steeringQueuePath(projectRoot: string, sessionId: string): string {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(sessionId)) throw new NovaError('Identifiant de session invalide.', 'SESSION_ID_INVALID');
  return path.join(projectRoot, '.nova_agents', 'sessions', `${sessionId}.steer.jsonl`);
}

export async function appendSteeringMessage(projectRoot: string, sessionId: string, text: string): Promise<void> {
  const message = text.trim();
  if (!message) throw new NovaError('Le message de steering ne peut pas être vide.', 'STEERING_MESSAGE_EMPTY');
  if (message.length > 10000) throw new NovaError('Le message de steering dépasse 10 000 caractères.', 'STEERING_MESSAGE_TOO_LARGE');
  const filePath = steeringQueuePath(projectRoot, sessionId);
  await assertSafeAgentPath(filePath, true);
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify({ at: new Date().toISOString(), text: message })}\n`, 'utf8');
}

export async function consumeSteeringMessages(session: PersistedSession): Promise<string[]> {
  const filePath = steeringQueuePath(session.projectRoot, session.id);
  await assertSafeAgentPath(filePath);
  let content: string;
  try { content = await readFile(filePath, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const completeLines = content.split('\n');
  if (completeLines.at(-1) === '') completeLines.pop();
  const cursor = session.steeringCursor ?? 0;
  const messages = completeLines.slice(cursor).map((line) => {
    try {
      const item = JSON.parse(line) as { text?: unknown };
      if (typeof item.text !== 'string' || !item.text.trim()) throw new Error('missing text');
      return item.text.trim();
    } catch {
      throw new NovaError('La file de steering de la session contient une entrée invalide.', 'STEERING_QUEUE_INVALID');
    }
  });
  session.steeringCursor = completeLines.length;
  return messages;
}

/** Accepts /steer lines while the provider is waiting; other lines are left for the next prompt. */
export function captureInteractiveSteering(projectRoot: string, sessionId: string): () => Promise<void> {
  if (!process.stdin.isTTY) return async () => undefined;
  const input = createInterface({ input: process.stdin, terminal: false });
  const writes: Promise<void>[] = [];
  input.on('line', (line) => {
    const match = line.trim().match(/^\/steer\s+(.+)$/i);
    if (!match?.[1]) return;
    const write = appendSteeringMessage(projectRoot, sessionId, match[1])
      .then(() => renderStatus('STEER', match[1]!))
      .catch((error: unknown) => renderStatus('ERROR', error instanceof Error ? error.message : String(error)));
    writes.push(write);
  });
  return async () => {
    input.close();
    await Promise.all(writes);
  };
}

export function formatSteering(messages: string[]): string {
  return `\n\nNouvelle(s) consigne(s) utilisateur reçue(s) pendant ta réponse :\n${messages.map((message, index) => `${index + 1}. ${message}`).join('\n')}\nIntègre ces consignes à la tâche en cours avant de répondre. Réévalue toute proposition de patch ou de fin que tu étais en train de préparer. Elles ne remplacent pas les fichiers ni le protocole.`;
}
