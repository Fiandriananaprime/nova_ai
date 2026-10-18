import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { scanProject, renderTree, type ScanResult } from './scanner.js';
import { writeAtomic } from '../utils/fs.js';
import { assertSafeAgentPath } from '../security/agent-files.js';

export async function refreshTree(projectRoot: string): Promise<{ tree: string; scan: ScanResult }> {
  const scan = await scanProject(projectRoot);
  const tree = renderTree(path.basename(path.resolve(projectRoot)), scan.entries);
  await writeAtomic(path.join(projectRoot, '.nova_agents', 'project-tree.txt'), tree);
  return { tree, scan };
}

export async function readTree(projectRoot: string): Promise<string> {
  const treePath = path.join(projectRoot, '.nova_agents', 'project-tree.txt');
  await assertSafeAgentPath(treePath);
  return readFile(treePath, 'utf8');
}
