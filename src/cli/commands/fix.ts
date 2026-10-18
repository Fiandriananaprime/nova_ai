import path from 'node:path';
import { runFix } from '../../session/orchestrator.js';
import { renderBrand } from '../terminal-ui.js';

export async function fixCommand(problem: string, options: { project?: string; provider?: string; maxCycles?: string; dryRun?: boolean; noApply?: boolean }): Promise<void> {
  if (!problem?.trim()) throw new Error('Indique une description du problème entre guillemets.');
  renderBrand(path.resolve(options.project ?? '.'));
  await runFix({
    projectRoot: path.resolve(options.project ?? '.'),
    problem,
    ...(options.provider ? { providerId: options.provider } : {}),
    ...(options.maxCycles ? { maxCycles: Number(options.maxCycles) } : {}),
    ...(options.dryRun ? { dryRun: true } : {}),
    ...(options.noApply ? { noApply: true } : {}),
  });
}
