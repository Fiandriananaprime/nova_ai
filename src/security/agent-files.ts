import path from 'node:path';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { NovaError } from '../utils/errors.js';

const AGENT_SUBDIRECTORIES = new Set(['patches', 'backups', 'sessions', 'diff', 'logs', 'output', 'history.git']);

function agentPathParts(absolutePath: string): { root: string; parts: string[]; agentIndex: number } | undefined {
  const resolved = path.resolve(absolutePath);
  const root = path.parse(resolved).root;
  const parts = path.relative(root, resolved).split(path.sep).filter(Boolean);
  const agentIndex = parts.findIndex((part) => part.toLowerCase() === '.nova_agents');
  return agentIndex < 0 ? undefined : { root, parts, agentIndex };
}

/** Validate/create the directory chain beneath .nova_agents without following symlinks. */
export async function assertSafeAgentDirectory(directoryPath: string, createMissing = false): Promise<void> {
  const parsed = agentPathParts(directoryPath);
  if (!parsed) return;
  const anchorPath = path.resolve(parsed.root, ...parsed.parts.slice(0, parsed.agentIndex));
  let anchorReal: string;
  try { anchorReal = await realpath(anchorPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new NovaError(`Le dossier parent de l’état Nova Agent n’existe pas : ${anchorPath}`, 'AGENT_STORE_PARENT_MISSING');
    }
    throw error;
  }
  let current = anchorPath;
  for (const component of parsed.parts.slice(parsed.agentIndex)) {
    current = path.join(current, component);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !createMissing) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      try { await mkdir(current); }
      catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
      }
      info = await lstat(current);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new NovaError(`Le chemin interne n’est pas un dossier local sûr : ${current}`, 'AGENT_STORE_SYMLINK_FORBIDDEN');
    }
    const currentReal = await realpath(current);
    const relativeReal = path.relative(anchorReal, currentReal);
    if (relativeReal === '..' || relativeReal.startsWith(`..${path.sep}`) || path.isAbsolute(relativeReal)) {
      throw new NovaError(`Le dossier interne sort de la racine du projet : ${current}`, 'AGENT_STORE_OUTSIDE_PROJECT');
    }
  }
}

/** Check the .nova_agents ancestry and reject a symlink at the target itself. */
export async function assertSafeAgentPath(targetPath: string, createParentDirectories = false): Promise<void> {
  const absolute = path.resolve(targetPath);
  const parsed = agentPathParts(absolute);
  if (!parsed) return;
  await assertSafeAgentDirectory(path.dirname(absolute), createParentDirectories);
  try {
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new NovaError(`Un lien symbolique interne est interdit : ${absolute}`, 'AGENT_STORE_SYMLINK_FORBIDDEN');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** Resolve a path supplied by local agent metadata without allowing it to escape its assigned store. */
export function resolveAgentStorePath(projectRoot: string, relativePath: string, expectedDirectory: string): string {
  if (!AGENT_SUBDIRECTORIES.has(expectedDirectory)) {
    throw new NovaError(`Dossier interne non reconnu : ${expectedDirectory}`, 'AGENT_STORE_INVALID');
  }
  const normalized = relativePath.replaceAll('\\', '/');
  const prefix = `.nova_agents/${expectedDirectory}/`;
  if (path.isAbsolute(relativePath) || /^[A-Za-z]:/.test(normalized) || !normalized.startsWith(prefix)) {
    throw new NovaError(`Chemin interne invalide : ${relativePath}`, 'AGENT_STORE_PATH_INVALID');
  }
  const parts = normalized.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new NovaError(`Chemin interne invalide : ${relativePath}`, 'AGENT_STORE_PATH_INVALID');
  }
  const base = path.resolve(projectRoot, '.nova_agents', expectedDirectory);
  const absolute = path.resolve(projectRoot, ...parts);
  const relative = path.relative(base, absolute);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new NovaError(`Chemin interne sortant du dossier autorisé : ${relativePath}`, 'AGENT_STORE_PATH_INVALID');
  }
  return absolute;
}

export function assertSafeOperationId(operationId: string): void {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(operationId)) {
    throw new NovaError('Identifiant d’opération invalide ; aucune sauvegarde ne sera écrite.', 'OPERATION_ID_INVALID');
  }
}
