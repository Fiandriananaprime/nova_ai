#!/usr/bin/env node
import { Command } from 'commander';
import path from 'node:path';
import { initProject } from './commands/init.js';
import { contextCommand } from './commands/context.js';
import { statusCommand } from './commands/status.js';
import { browserCommand } from './commands/browser.js';
import { modelList, modelUse } from './commands/model.js';
import { fixCommand } from './commands/fix.js';
import { diffCommand } from './commands/diff.js';
import { applyCommand } from './commands/apply.js';
import { undoCommand } from './commands/undo.js';
import { historyCommand } from './commands/history.js';
import { resumeCommand } from './commands/resume.js';
import { interactiveCommand } from './commands/interactive.js';
import { steerCommand } from './commands/steer.js';
import { NOVA_VERSION } from '../version.js';
import { NovaError, asNovaError } from '../utils/errors.js';
import { isInteractive } from '../utils/fs.js';

const program = new Command();
program
  .name('nova')
  .description('Agent de développement local : contexte, IA via navigateur, patchs contrôlés et rollback.')
  .version(NOVA_VERSION)
  .showHelpAfterError()
  .showSuggestionAfterError();

program.command('init')
  .description('Initialise Nova Agent dans un projet sans écraser les fichiers existants.')
  .argument('[project]', 'chemin du projet cible', '.')
  .option('--add-gitignore', 'autoriser explicitement l’ajout de .nova_agents/ au .gitignore principal')
  .action(async (project: string, options: { addGitignore?: boolean }) => initProject(project, options));

program.command('browser')
  .description('Ouvre ChatGPT dans un profil Microsoft Edge dédié et vérifie la session.')
  .option('-p, --project <path>', 'projet cible', '.')
  .action(async (options: { project: string }) => browserCommand(path.resolve(options.project)));

program.command('status')
  .description('Affiche le fournisseur, le contexte, la session, les patchs en attente et l’historique.')
  .option('-p, --project <path>', 'projet cible', '.')
  .action(async (options: { project: string }) => statusCommand(options.project));

const context = program.command('context').description('Gère le contexte du projet.');
context.command('tree').description('Régénère et affiche l’arborescence filtrée.').option('-p, --project <path>', 'projet cible', '.')
  .action(async (options: { project: string }) => contextCommand(options.project, 'tree'));
context.command('show').description('Affiche project-context.md.').option('-p, --project <path>', 'projet cible', '.')
  .action(async (options: { project: string }) => contextCommand(options.project, 'show'));
context.command('refresh').description('Actualise le tree et affiche les statistiques de scan.').option('-p, --project <path>', 'projet cible', '.')
  .action(async (options: { project: string }) => contextCommand(options.project, 'refresh'));

program.command('fix')
  .description('Diagnostique un problème et prépare un patch soumis à validation.')
  .argument('<problem>', 'description du problème à corriger')
  .option('-p, --project <path>', 'projet cible', '.')
  .option('--provider <id>', 'chatgpt-web, claude-web, gemini-web ou mock')
  .option('--max-cycles <number>', 'limite facultative du nombre d’échanges (1 à 20)')
  .option('--dry-run', 'prépare et valide le patch sans modifier les sources')
  .option('--no-apply', 'prépare le patch mais ne l’applique jamais')
  .action(async (problem: string, options: { project: string; provider?: string; maxCycles?: string; dryRun?: boolean; apply?: boolean }) => {
    const cycles = options.maxCycles === undefined ? undefined : Number(options.maxCycles);
    if (cycles !== undefined && (!Number.isInteger(cycles) || cycles < 1 || cycles > 20)) throw new NovaError('--max-cycles doit être un entier compris entre 1 et 20.', 'INVALID_MAX_CYCLES');
    await fixCommand(problem, { ...options, ...(cycles === undefined ? {} : { maxCycles: String(cycles) }), noApply: options.apply === false });
  });

program.command('diff').description('Affiche le dernier patch en attente ou appliqué.')
  .option('-p, --project <path>', 'projet cible', '.')
  .action(async (options: { project: string }) => diffCommand(options.project));

program.command('apply').description('Valide et applique un patch préalablement préparé, après confirmation.')
  .option('-p, --project <path>', 'projet cible', '.')
  .action(async (options: { project: string }) => applyCommand(options.project));

program.command('undo').description('Annule la dernière opération Nova Agent, sans écraser les modifications externes.')
  .option('-p, --project <path>', 'projet cible', '.')
  .action(async (options: { project: string }) => undoCommand(options.project));

program.command('history').description('Liste les opérations, leurs rapports et les commits auxiliaires.')
  .option('-p, --project <path>', 'projet cible', '.')
  .action(async (options: { project: string }) => historyCommand(options.project));

program.command('resume')
  .description('Reprend une session persistée.')
  .argument('<session-id>', 'identifiant affiché par fix/status')
  .option('-p, --project <path>', 'projet cible', '.')
  .option('--provider <id>', 'changer explicitement de fournisseur')
  .action(async (sessionId: string, options: { project: string; provider?: string }) => resumeCommand(sessionId, options.project, options.provider));

program.command('steer')
  .description('Ajoute une consigne à une session Nova en cours.')
  .argument('<message>', 'consigne à intégrer à la tâche active')
  .option('-p, --project <path>', 'projet cible', '.')
  .option('--session <session-id>', 'identifiant de session ; par défaut la session courante du projet')
  .action(async (message: string, options: { project: string; session?: string }) => steerCommand(message, options.project, options.session));

const model = program.command('model').description('Liste et sélectionne les fournisseurs IA.');
model.command('list').description('Liste les modèles intégrés et le modèle actif.').option('-p, --project <path>', 'projet cible', '.')
  .action(async (options: { project: string }) => modelList(path.resolve(options.project)));
model.command('use <provider-id>').description('Sélectionne le fournisseur par défaut.').option('-p, --project <path>', 'projet cible', '.')
  .action(async (providerId: string, options: { project: string }) => modelUse(path.resolve(options.project), providerId));

program.addHelpText('after', `\nExemples PowerShell :\n  npm run dev -- init .\n  npm run dev -- browser\n  npm run dev -- fix "Le login retourne 401" --provider chatgpt-web --no-apply\n  npm run dev -- context tree\n  npm run dev -- apply\n  npm run dev -- undo\n`);

try {
  if (process.argv.length <= 2 && isInteractive()) await interactiveCommand(process.cwd());
  else await program.parseAsync(process.argv);
} catch (error) {
  const issue = asNovaError(error);
  console.error(`ERROR ${issue.code}: ${issue.message}`);
  process.exitCode = 1;
}
