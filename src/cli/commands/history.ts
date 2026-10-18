import path from 'node:path';
import { readOperations } from '../../history/records.js';
import { loadConfig } from '../../config/loader.js';
import { AuxiliaryGitRepository } from '../../history/git-repository.js';

export async function historyCommand(projectInput = '.'): Promise<void> {
  const root = path.resolve(projectInput);
  const records = await readOperations(root);
  if (!records.length) console.log('Aucune opération enregistrée.');
  for (const record of records) {
    console.log(`${record.date} | ${record.id} | ${record.status} | ${record.summary}`);
    console.log(`  Projet : ${record.task.slice(0, 180)}`);
    console.log(`  Fichiers : ${record.filesChanged.join(', ') || '(aucun)'}`);
    console.log(`  Tests : ${record.tests.map((test) => `${test.command}: ${test.result}`).join('; ') || 'aucun'}`);
    console.log(`  Commit : ${record.gitCommit ?? 'N/A'} | Undo : ${record.gitUndoCommit ?? 'N/A'}`);
    console.log(`  Rapport : ${record.reportPath ?? 'N/A'}`);
  }
  const config = await loadConfig(root);
  if (config.history.enabled) {
    const repo = new AuxiliaryGitRepository(root, config.history.directory);
    if (await repo.exists()) {
      console.log('\nGit auxiliaire :');
      console.log((await repo.log(30)) || '(aucun commit)');
    }
  }
}
