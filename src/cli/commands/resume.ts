import path from 'node:path';
import { loadSession, saveSession } from '../../session/persistence.js';
import { runFix } from '../../session/orchestrator.js';
import { readOperations } from '../../history/records.js';
import { ask, confirm } from '../prompts.js';
import { isInteractive } from '../../utils/fs.js';
import { renderBrand } from '../terminal-ui.js';

export async function resumeCommand(sessionId: string, projectInput = '.', providerId?: string): Promise<void> {
  const root = path.resolve(projectInput);
  renderBrand(root);
  const session = await loadSession(root, sessionId);
  const operations = await readOperations(root);
  const pending = session.pendingOperationId
    ? operations.find((record) => record.id === session.pendingOperationId && record.status === 'PREPARED')
    : undefined;
  if (pending) {
    console.log(`La session contient déjà un patch préparé (${pending.id}) : ${pending.summary}`);
    console.log(`Vérifie le diff puis applique-le explicitement : npm run dev -- apply --project "${root}"`);
    return;
  }

  if (session.error === 'NEED_INFO') {
    const question = [...session.exchanges].reverse().find((entry) => entry.state === 'WAITING_FOR_USER')?.detail;
    if (question && isInteractive()) {
      console.log(`Question en attente : ${question}`);
      const answer = await ask('Réponse (laisser vide pour interrompre) : ');
      if (!answer) return;
      session.answers.push(answer);
      delete session.error;
      session.state = 'PAUSED';
      session.exchanges.push({ at: new Date().toISOString(), state: 'PAUSED', detail: `Réponse ajoutée à la reprise : ${answer}` });
      await saveSession(session);
    } else {
      console.log(`Cette session attend une réponse utilisateur : ${question ?? '(question à relire dans session.json)'}`);
      console.log('Reprends cette commande depuis un terminal interactif.');
      return;
    }
  }

  const lastWaiting = [...session.exchanges].reverse().find((entry) => entry.state === 'WAITING_FOR_RESPONSE');
  const deliveryMayBeUncertain = session.state === 'WAITING_FOR_RESPONSE'
    || /SESSION_CANCELLED|BROWSER_RESPONSE_TIMEOUT|BROWSER_RESPONSE_TRUNCATED|BROWSER_SELECTOR_MISMATCH|AI_JSON_INVALID|AI_PROTOCOL_INVALID|AI_RESPONSE_EMPTY|AI_RESPONSE_TOO_LARGE/.test(session.error ?? '');
  if (lastWaiting && deliveryMayBeUncertain) {
    console.log('La dernière demande a peut-être été envoyée, mais sa réponse n’a pas été confirmée ou validée. Vérifie la fenêtre Edge pour éviter un doublon.');
    if (!await confirm('Continuer et renvoyer la requête en attente ?')) return;
  }
  console.log(`Reprise de la session ${session.id} (${session.state}), fournisseur ${providerId ?? session.providerId}.`);
  await runFix({ projectRoot: root, resumeSession: session, ...(providerId ? { providerId } : {}) });
}
