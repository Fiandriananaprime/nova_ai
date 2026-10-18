import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { readOperations, upsertOperation } from '../../history/records.js';
import { saveReport } from '../../history/markdown-reports.js';
import { applyOperation } from '../../history/operation-service.js';
import { approveOrReject } from '../prompts.js';
import { renderPatchPreview } from '../patch-preview.js';
import { parsePatch } from '../../patches/parser.js';
import { isInteractive } from '../../utils/fs.js';
import { assertSafeAgentPath, resolveAgentStorePath } from '../../security/agent-files.js';

export async function applyCommand(projectInput = '.'): Promise<void> {
  const root = path.resolve(projectInput);
  const records = await readOperations(root);
  const record = [...records].reverse().find((item) => item.status === 'PREPARED');
  if (!record?.patchPath) throw new Error('Aucun patch valide en attente. Utilise `nova-agent fix` pour en préparer un.');
  const patchPath = resolveAgentStorePath(root, record.patchPath, 'patches');
  await assertSafeAgentPath(patchPath);
  const patch = await readFile(patchPath, 'utf8');
  const reportPath = await saveReport(root, record);
  await upsertOperation(root, record);
  console.log(`Opération ${record.id}: ${record.summary}\n${renderPatchPreview(root, parsePatch(patch), patch, reportPath)}`);
  if (!isInteractive()) {
    console.log('Mode non interactif : aucun patch appliqué. Relance depuis un terminal pour confirmer.');
    return;
  }
  if (!await approveOrReject('Appliquer ce patch ?')) {
    record.status = 'REJECTED';
    record.errors.push('Patch refusé dans la commande apply ; sources inchangées.');
    await saveReport(root, record);
    await upsertOperation(root, record);
    console.log('Patch refusé.');
    return;
  }
  await applyOperation(root, record, patch);
  console.log(`Patch appliqué et enregistré : ${record.id}`);
}
