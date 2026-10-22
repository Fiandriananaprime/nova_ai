import path from 'node:path';
import { lstat, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { writeJson, readJson, sha256 } from '../utils/fs.js';
import { NovaError } from '../utils/errors.js';
import { assertNoSymlinkEscape, resolveInside } from '../security/paths.js';
import { assertSafeOperationId } from '../security/agent-files.js';
import type { PreparedPatch } from './validator.js';
import { runPatchInNormalizedWorkspace } from './git-apply.js';

interface BackupEntry { path: string; contentBase64: string | null; sha256: string | null; }
interface BackupFile { operationId: string; createdAt: string; files: BackupEntry[]; }
export interface AppliedPatch { backupPath: string; afterHashes: Record<string, string | null>; }

async function currentBytes(filePath: string): Promise<Buffer | null> {
  try {
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new NovaError(`Fichier modifié n'est plus un fichier ordinaire : ${filePath}`, 'PATCH_TARGET_INVALID');
    return await readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function applyPreparedPatch(projectRoot: string, operationId: string, patch: string, prepared: PreparedPatch): Promise<AppliedPatch> {
  assertSafeOperationId(operationId);
  const files = prepared.files;
  const backup: BackupFile = { operationId, createdAt: new Date().toISOString(), files: [] };
  for (const item of files) {
    await assertNoSymlinkEscape(projectRoot, item.path, item.created);
    const absolute = resolveInside(projectRoot, item.path);
    const bytes = await currentBytes(absolute);
    const actualHash = bytes ? sha256(bytes) : null;
    if (actualHash !== prepared.originalHashes[item.path]) throw new NovaError(`Le fichier a changé juste avant l'application : ${item.path}. Aucun patch appliqué.`, 'PATCH_STALE_SOURCE');
    backup.files.push({ path: item.path, contentBase64: bytes?.toString('base64') ?? null, sha256: actualHash });
  }
  const backupPath = path.join(projectRoot, '.nova_agents', 'backups', `${operationId}.json`);
  await mkdir(path.dirname(backupPath), { recursive: true });
  await writeJson(backupPath, backup);
  const apply = await runPatchInNormalizedWorkspace(projectRoot, patch, files, false);
  if (apply.exitCode !== 0 || !apply.outputs) {
    await restoreBackup(projectRoot, backupPath, false).catch(() => undefined);
    throw new NovaError(`L'application du patch a échoué : ${(apply.stderr || apply.stdout).trim()}`, 'PATCH_APPLY_FAILED');
  }
  try {
    for (const item of files) {
      const absolute = resolveInside(projectRoot, item.path);
      const output = apply.outputs.get(item.path);
      if (output === undefined) throw new NovaError(`Résultat absent pour le fichier patché : ${item.path}`, 'PATCH_APPLY_FAILED');
      if (output === null) await rm(absolute, { force: true });
      else {
        await mkdir(path.dirname(absolute), { recursive: true });
        await writeFile(absolute, output);
      }
    }
  } catch (error) {
    await restoreBackup(projectRoot, backupPath, false).catch(() => undefined);
    throw error;
  }
  const afterHashes: Record<string, string | null> = {};
  for (const item of files) {
    const absolute = resolveInside(projectRoot, item.path);
    const bytes = await currentBytes(absolute);
    afterHashes[item.path] = bytes ? sha256(bytes) : null;
  }
  return { backupPath, afterHashes };
}

export async function restoreBackup(projectRoot: string, backupPath: string, verifyCurrent = true, expectedAfter?: Record<string, string | null>): Promise<void> {
  const backup = await readJson<BackupFile>(backupPath);
  const current = new Map<string, string | null>();
  for (const item of backup.files) {
    await assertNoSymlinkEscape(projectRoot, item.path, true);
    const absolute = resolveInside(projectRoot, item.path);
    const bytes = await currentBytes(absolute);
    const actual = bytes ? sha256(bytes) : null;
    current.set(item.path, actual);
    if (verifyCurrent && expectedAfter && actual !== expectedAfter[item.path]) {
      throw new NovaError(`Rollback refusé : ${item.path} a été modifié depuis l'opération. Les changements externes sont préservés.`, 'UNDO_CONFLICT');
    }
  }
  // Validation of all files happens before any restore, avoiding a silent partial rollback.
  for (const item of backup.files) {
    const absolute = resolveInside(projectRoot, item.path);
    if (item.contentBase64 === null) await rm(absolute, { force: true });
    else {
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, Buffer.from(item.contentBase64, 'base64'));
    }
    const restored = await currentBytes(absolute);
    const restoredHash = restored ? sha256(restored) : null;
    if (restoredHash !== item.sha256) throw new NovaError(`Vérification de restauration échouée : ${item.path}`, 'UNDO_RESTORE_VERIFY_FAILED');
  }
}
