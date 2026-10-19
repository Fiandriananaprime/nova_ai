import path from 'node:path';
import { readOptional } from '../../utils/fs.js';
import { NovaError } from '../../utils/errors.js';
import { loadSession } from '../../session/persistence.js';
import { appendSteeringMessage } from '../../session/steering.js';
import { renderStatus } from '../terminal-ui.js';

const STEERABLE_STATES = new Set(['SENDING_PROMPT', 'WAITING_FOR_RESPONSE']);

export async function steerCommand(message: string, projectInput: string, sessionIdInput?: string): Promise<void> {
  const projectRoot = path.resolve(projectInput);
  let sessionId = sessionIdInput;
  if (!sessionId) {
    const pointerPath = path.join(projectRoot, '.nova_agents', 'session.json');
    const pointerText = await readOptional(pointerPath);
    if (!pointerText) throw new NovaError('Aucune session Nova trouvée dans ce projet.', 'SESSION_NOT_FOUND');
    try {
      const pointer = JSON.parse(pointerText) as { currentSessionId?: unknown };
      if (typeof pointer.currentSessionId !== 'string') throw new Error('invalid pointer');
      sessionId = pointer.currentSessionId;
    } catch {
      throw new NovaError('Le pointeur de session Nova est invalide.', 'SESSION_POINTER_INVALID');
    }
  }
  const session = await loadSession(projectRoot, sessionId);
  if (!STEERABLE_STATES.has(session.state)) {
    throw new NovaError(`La session ${session.id} n'accepte plus de steering (état ${session.state}).`, 'SESSION_NOT_ACTIVE');
  }
  await appendSteeringMessage(projectRoot, session.id, message);
  renderStatus('STEER', `consigne ajoutée à ${session.id}`);
}
