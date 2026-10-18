import path from 'node:path';
import { rollbackLatest } from '../../history/rollback.js';

export async function undoCommand(projectInput = '.'): Promise<void> {
  const record = await rollbackLatest(path.resolve(projectInput));
  console.log(`Opération ${record.id} annulée. Les fichiers ont été restaurés après vérification des empreintes.`);
  console.log(`État : ${record.status} | Commit de rollback : ${record.gitUndoCommit ?? 'non utilisé'}`);
}
