import path from 'node:path';
import { runFix } from '../../session/orchestrator.js';
import { isInteractive } from '../../utils/fs.js';
import { ask } from '../prompts.js';
import { statusCommand } from './status.js';
import { renderBrand, renderStatus } from '../terminal-ui.js';
import { modelList, modelUse } from './model.js';

export async function interactiveCommand(projectInput = process.cwd()): Promise<void> {
  if (!isInteractive()) {
    console.log('L’interface interactive nécessite un terminal. Utilise : nova fix "ta demande"');
    return;
  }

  const projectRoot = path.resolve(projectInput);
  renderBrand(projectRoot);

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
      console.log('Écris une demande pour démarrer une session. /status affiche le projet, /model list liste les modèles, /model <nom> change de modèle, /exit ferme Nova. Pendant une approbation, tape approve all pour appliquer tous les fichiers du patch courant.');
      continue;
    }
    if (request === '/status') {
      await statusCommand(projectRoot);
      continue;
    }
    const modelCommand = request.match(/^\/model(?:\s+(.*))?$/i);
    if (modelCommand) {
      const modelName = modelCommand[1]?.trim();
      try {
        if (!modelName || modelName.toLowerCase() === 'list') await modelList(projectRoot);
        else await modelUse(projectRoot, modelName);
      } catch (error) {
        renderStatus('ERROR', error instanceof Error ? error.message : String(error));
      }
      continue;
    }

    try {
      await runFix({ projectRoot, problem: request });
    } catch {
      renderStatus('ERROR', 'session enregistrée · consulte /status ou relance la demande');
    }
  }
}
