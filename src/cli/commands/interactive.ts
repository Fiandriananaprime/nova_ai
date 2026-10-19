import path from 'node:path';
import { runFix } from '../../session/orchestrator.js';
import { isInteractive } from '../../utils/fs.js';
import { ask } from '../prompts.js';
import { statusCommand } from './status.js';
import { renderBrand, renderStatus } from '../terminal-ui.js';
import { modelList, modelUse } from './model.js';
import type { ApprovalPolicy } from '../../session/persistence.js';
import { ensureProjectInitialized } from '../../context/project-setup.js';

export async function interactiveCommand(projectInput = process.cwd()): Promise<void> {
  if (!isInteractive()) {
    console.log('L’interface interactive nécessite un terminal. Utilise : nova fix "ta demande"');
    return;
  }

  const projectRoot = path.resolve(projectInput);
  await ensureProjectInitialized(projectRoot);
  const approvalPolicy: ApprovalPolicy = { read: false, write: false, commands: false };
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
      console.log('Écris une demande pour démarrer une session. /status affiche le projet ; /model list et /model <nom> gèrent le modèle. Pendant thinking, /steer <message> ajoute une consigne. /approve-read, /approve-write, /approve-command et /approve-all activent les autorisations automatiques pour les tâches lancées ensuite dans ce terminal ; /approve-none les désactive. /approve-all autorise aussi des commandes arbitraires sans confirmation. /exit ferme Nova.');
      continue;
    }
    const approvalCommand = request.toLowerCase();
    if (approvalCommand === '/approve-none') {
      approvalPolicy.read = false;
      approvalPolicy.write = false;
      approvalPolicy.commands = false;
      renderStatus('APPROVAL_POLICY', 'autorisations automatiques désactivées');
      continue;
    }
    if (['/approve-read', '/approve-write', '/approve-command', '/appove-command', '/approve-all'].includes(approvalCommand)) {
      if (approvalCommand === '/approve-all') {
        approvalPolicy.read = true;
        approvalPolicy.write = true;
        approvalPolicy.commands = true;
      } else if (approvalCommand === '/approve-read') approvalPolicy.read = true;
      else if (approvalCommand === '/approve-write') approvalPolicy.write = true;
      else approvalPolicy.commands = true;
      const label = approvalCommand === '/appove-command' ? 'approve-command' : approvalCommand.slice(1);
      const warning = approvalPolicy.commands ? ' · commandes exécutées sans confirmation' : '';
      renderStatus('APPROVAL_POLICY', `${label} activé pour les prochaines tâches de ce terminal${warning}`);
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
      await runFix({ projectRoot, problem: request, approvalPolicy });
    } catch (error) {
      renderStatus('ERROR', error instanceof Error ? error.message : String(error));
      renderStatus('ERROR', 'session enregistrée · consulte /status ou relance la demande');
    }
  }
}
