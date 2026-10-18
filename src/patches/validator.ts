import path from 'node:path';
import { lstat, readFile } from 'node:fs/promises';
import { execa } from 'execa';
import { assertAllowedProjectPath } from '../security/permissions.js';
import { assertNoPotentialSecret } from '../security/secrets.js';
import { sha256 } from '../utils/fs.js';
import { NovaError } from '../utils/errors.js';
import { parsePatch, type PatchFile } from './parser.js';

export interface PreparedPatch { files: PatchFile[]; diff: string; originalHashes: Record<string, string | null>; }

export async function validatePatch(projectRoot: string, patch: string, readHashes: Record<string, string>, maxBytes = 2 * 1024 * 1024): Promise<PreparedPatch> {
  if (Buffer.byteLength(patch, 'utf8') > maxBytes) throw new NovaError(`Patch trop volumineux (limite ${maxBytes} octets).`, 'PATCH_TOO_LARGE');
  assertNoPotentialSecret(patch, 'patch proposé');
  const files = parsePatch(patch);
  const originalHashes: Record<string, string | null> = {};

  for (const file of files) {
    const { absolutePath: absolute } = await assertAllowedProjectPath(projectRoot, file.path, 'write', file.created);
    let info;
    try { info = await lstat(absolute); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      info = undefined;
    }
    if (file.created) {
      if (info) throw new NovaError(`Le patch déclare une création, mais le fichier existe déjà : ${file.path}`, 'PATCH_CREATE_CONFLICT');
      originalHashes[file.path] = null;
      continue;
    }
    if (!info?.isFile() || info.isSymbolicLink()) throw new NovaError(`Le fichier cible n'est pas un fichier ordinaire : ${file.path}`, 'PATCH_TARGET_INVALID');
    if (!(file.path in readHashes)) throw new NovaError(`L'IA tente de modifier un fichier qui n'a pas été explicitement lu par Nova Agent : ${file.path}`, 'PATCH_TARGET_NOT_READ');
    const original = await readFile(absolute);
    const actualHash = sha256(original);
    if (actualHash !== readHashes[file.path]) throw new NovaError(`Le fichier a changé depuis sa lecture par Nova Agent : ${file.path}. Relance le diagnostic pour éviter d'écraser des modifications locales.`, 'PATCH_STALE_SOURCE');
    originalHashes[file.path] = actualHash;
  }

  const check = await execa('git', ['-c', 'core.autocrlf=false', 'apply', '--check', '--whitespace=nowarn', '-'], {
    cwd: path.resolve(projectRoot), input: patch, reject: false, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
  });
  if (check.exitCode !== 0) throw new NovaError(`Patch non applicable sans conflit : ${(check.stderr || check.stdout).trim()}`, 'PATCH_APPLY_CHECK_FAILED');
  return { files, diff: patch, originalHashes };
}
