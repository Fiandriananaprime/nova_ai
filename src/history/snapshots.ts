import { scanProject } from '../context/scanner.js';
import { AuxiliaryGitRepository } from './git-repository.js';

export async function createInitialSnapshot(projectRoot: string, gitDirectory: string): Promise<{ commit: string | null; fileCount: number }> {
  const scan = await scanProject(projectRoot);
  const repository = new AuxiliaryGitRepository(projectRoot, gitDirectory);
  if (!(await repository.exists())) await repository.initialize();
  const commit = await repository.snapshot(scan.files.map((file) => file.path));
  if (!commit) throw new Error('Le snapshot initial n’a pas produit de commit Git auxiliaire.');
  return { commit, fileCount: scan.files.length };
}
