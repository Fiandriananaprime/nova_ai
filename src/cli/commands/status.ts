import path from 'node:path';
import { readOptional } from '../../utils/fs.js';
import { loadConfig } from '../../config/loader.js';
import { scanProject } from '../../context/scanner.js';
import { readOperations } from '../../history/records.js';
import { AuxiliaryGitRepository } from '../../history/git-repository.js';

export async function statusCommand(projectInput = '.'): Promise<void> {
  const root = path.resolve(projectInput);
  const config = await loadConfig(root);
  const scan = await scanProject(root);
  const records = await readOperations(root);
  const pending = records.filter((record) => record.status === 'PREPARED');
  const last = records.at(-1);
  const sessionText = await readOptional(path.join(root, '.nova_agents', 'session.json'));
  let sessionLabel = 'aucune session persistée';
  if (sessionText) {
    try { sessionLabel = JSON.parse(sessionText).currentSessionId ?? sessionLabel; } catch { sessionLabel = 'état de session illisible'; }
  }
  const repo = new AuxiliaryGitRepository(root, config.history.directory);
  const repoExists = config.history.enabled && await repo.exists();
  console.log(`Projet cible       : ${root}`);
  console.log(`Fournisseur        : ${config.defaultProvider}`);
  console.log(`Session            : ${sessionLabel}`);
  console.log(`Fichiers inclus    : ${scan.files.length}`);
  console.log(`Fichiers ignorés   : ${scan.ignored.length}`);
  console.log(`Historique auxiliaire : ${repoExists ? 'disponible' : config.history.enabled ? 'absent' : 'désactivé'}`);
  console.log(`Opérations en attente : ${pending.length}`);
  console.log(`Dernière opération : ${last ? `${last.id} (${last.status}) — ${last.summary}` : 'aucune'}`);
  if (pending.length) for (const record of pending) console.log(`  ${record.id} — ${record.task}`);
  if (repoExists) console.log(`État Git auxiliaire : ${(await repo.status()) || 'propre'}`);
}
