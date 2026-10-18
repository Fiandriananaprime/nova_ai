import path from 'node:path';
import { runFix } from '../../session/orchestrator.js';
import { isInteractive } from '../../utils/fs.js';
import { ask } from '../prompts.js';
import { statusCommand } from './status.js';

export async function interactiveCommand(projectInput = process.cwd()): Promise<void> {
  if (!isInteractive()) {
    console.log('L’interface interactive nécessite un terminal. Utilise : nova fix "ta demande"');
    return;
  }

  const projectRoot = path.resolve(projectInput);
  console.log(`Nova Agent · ${projectRoot}`);
  console.log('Décris une tâche, ou utilise /status, /help, /exit. Les commandes CLI restent disponibles.');

  while (true) {
    let input: string;
    try {
      input = await ask('nova › ');
    } catch {
      console.log('\nFin de la session Nova.');
      return;
    }

    const request = input.trim();
    if (!request) continue;
    if (['/exit', '/quit'].includes(request.toLowerCase())) return;
    if (request === '/help') {
      console.log('Écris une demande pour lancer une analyse. /status affiche le projet, /exit ferme Nova.');
      continue;
    }
    if (request === '/status') {
      await statusCommand(projectRoot);
      continue;
    }

    try {
      await runFix({ projectRoot, problem: request });
    } catch {
      console.log('La session est enregistrée ; utilise /status ou relance une nouvelle demande.');
    }
  }
}
