import { readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { assertSafeAgentDirectory, assertSafeAgentPath } from '../security/agent-files.js';
import { NovaError } from './errors.js';

const MAX_FILES_PER_DIRECTORY = 15;
type RetainedDirectory = 'diff' | 'logs' | 'output';

export async function pruneAgentFiles(projectRoot: string, directory: RetainedDirectory): Promise<string[]> {
  const absoluteDirectory = path.join(projectRoot, '.nova_agents', directory);
  await assertSafeAgentDirectory(absoluteDirectory);
  let names: string[];
  try { names = await readdir(absoluteDirectory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const files: Array<{ path: string; modifiedAt: number }> = [];
  for (const name of names) {
    const filePath = path.join(absoluteDirectory, name);
    await assertSafeAgentPath(filePath);
    let info;
    try { info = await stat(filePath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (info.isFile()) files.push({ path: filePath, modifiedAt: info.mtimeMs });
  }
  files.sort((left, right) => left.modifiedAt - right.modifiedAt || left.path.localeCompare(right.path));
  const excess = files.length - MAX_FILES_PER_DIRECTORY;
  if (excess <= 0) return [];
  const removed: string[] = [];
  for (const file of files.slice(0, excess)) {
    try {
      await unlink(file.path);
      removed.push(path.relative(projectRoot, file.path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new NovaError(`Impossible de supprimer l’ancien fichier Nova ${file.path} : ${error instanceof Error ? error.message : String(error)}`, 'AGENT_RETENTION_FAILED');
      }
    }
  }
  return removed;
}
