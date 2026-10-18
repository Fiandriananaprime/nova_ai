import path from 'node:path';
import { operationDiff } from '../../history/operation-service.js';

export async function diffCommand(projectInput = '.'): Promise<void> {
  const result = await operationDiff(path.resolve(projectInput));
  if (!result) {
    console.log('Aucun patch préparé ou appliqué disponible.');
    return;
  }
  console.log(`Opération ${result.record.id} — ${result.record.status}\n${result.record.summary}\nFichiers : ${result.record.filesChanged.join(', ')}\n`);
  console.log(result.patch);
}
