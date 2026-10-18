import { lstat, readFile } from 'node:fs/promises';
import { assertAllowedProjectPath } from '../security/permissions.js';
import { assertNoPotentialSecret } from '../security/secrets.js';
import { NovaError } from '../utils/errors.js';
import { sha256 } from '../utils/fs.js';

export interface ProjectFile { path: string; content: string; sha256: string; bytes: number; }

export async function readProjectFile(
  projectRoot: string,
  inputPath: string,
  maxBytes = 1024 * 1024,
  options: { allowPotentialSecrets?: boolean } = {},
): Promise<ProjectFile> {
  const { relativePath, absolutePath } = await assertAllowedProjectPath(projectRoot, inputPath, 'read');
  let info;
  try { info = await lstat(absolutePath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new NovaError(`Fichier introuvable : ${relativePath}`, 'FILE_NOT_FOUND');
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new NovaError(`Le chemin ne désigne pas un fichier ordinaire : ${relativePath}`, 'FILE_NOT_REGULAR');
  if (info.size > maxBytes) throw new NovaError(`Fichier trop volumineux (${info.size} octets, limite ${maxBytes}) : ${relativePath}`, 'FILE_TOO_LARGE');
  const buffer = await readFile(absolutePath);
  if (buffer.includes(0)) throw new NovaError(`Fichier binaire non pris en charge : ${relativePath}`, 'FILE_BINARY');
  const content = buffer.toString('utf8');
  if (!options.allowPotentialSecrets) assertNoPotentialSecret(content, relativePath);
  return { path: relativePath, content, sha256: sha256(buffer), bytes: buffer.byteLength };
}
