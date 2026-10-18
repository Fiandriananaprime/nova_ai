import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { execa } from 'execa';
import { loadConfig } from '../config/loader.js';
import { restoreBackup, applyPreparedPatch } from '../patches/apply.js';
import { validatePatch } from '../patches/validator.js';
import { AuxiliaryGitRepository } from './git-repository.js';
import { saveReport, type OperationRecord } from './markdown-reports.js';
import { readOperations, upsertOperation } from './records.js';
import { sha256 } from '../utils/fs.js';
import { NovaError } from '../utils/errors.js';
import { assertSafeAgentPath, assertSafeOperationId, resolveAgentStorePath } from '../security/agent-files.js';
import { assertAllowedProjectPath } from '../security/permissions.js';

export async function applyOperation(projectRoot: string, record: OperationRecord, patchInput?: string, onStage?: (stage: 'RUNNING_TESTS' | 'RECORDING_HISTORY') => Promise<void>): Promise<OperationRecord> {
  assertSafeOperationId(record.id);
  if (record.status !== 'PREPARED') throw new NovaError(`L'opération ${record.id} n'est pas en statut PREPARED.`, 'OPERATION_NOT_PREPARED');
  let patch = patchInput ?? '';
  if (patchInput === undefined && record.patchPath) {
    const patchPath = resolveAgentStorePath(projectRoot, record.patchPath, 'patches');
    await assertSafeAgentPath(patchPath);
    patch = await readFile(patchPath, 'utf8');
  }
  const readHashes = Object.fromEntries(Object.entries(record.originalHashes).filter(([, hash]) => hash !== null)) as Record<string, string>;
  const config = await loadConfig(projectRoot);
  const prepared = await validatePatch(projectRoot, patch, readHashes, config.patches.maxPatchBytes);
  for (const [file, hash] of Object.entries(record.originalHashes)) {
    if (prepared.originalHashes[file] !== hash) throw new NovaError(`L'état original a changé depuis la préparation : ${file}`, 'PATCH_STALE_SOURCE');
  }
  if (record.filesChanged.some((file) => !prepared.files.some((item) => item.path === file))) {
    throw new NovaError('La liste des fichiers a changé depuis la préparation.', 'PATCH_METADATA_MISMATCH');
  }

  const repo = new AuxiliaryGitRepository(projectRoot, config.history.directory);
  record.gitBefore = config.history.enabled ? await repo.head() : null;
  let applied;
  try {
    record.status = 'APPLIED';
    applied = await applyPreparedPatch(projectRoot, record.id, patch, prepared);
    record.afterHashes = applied.afterHashes;
    record.rollback = { status: 'AVAILABLE' };
  } catch (error) {
    record.status = 'FAILED';
    record.errors.push(error instanceof Error ? error.message : String(error));
    await saveReport(projectRoot, record);
    await upsertOperation(projectRoot, record);
    throw error;
  }

  // Only explicitly configured commands are executed. Model-suggested commands remain suggestions.
  await onStage?.('RUNNING_TESTS');
  for (const test of config.tests) {
    record.tests.push({ command: [test.command, ...test.args].join(' '), result: 'EN COURS' });
    try {
      const result = await execa(test.command, test.args, { cwd: projectRoot, reject: false, timeout: 120000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
      const last = record.tests.at(-1)!;
      last.result = result.exitCode === 0 ? `RÉUSSI (code ${result.exitCode})` : `ÉCHEC (code ${result.exitCode}) : ${(result.stderr || result.stdout).slice(0, 1500)}`;
    } catch (error) {
      record.tests.at(-1)!.result = `ERREUR : ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  try {
    await onStage?.('RECORDING_HISTORY');
    if (config.history.enabled) {
      if (!(await repo.exists())) throw new NovaError('Dépôt Git auxiliaire absent ou inaccessible ; la sauvegarde existe, mais l’application est annulée pour préserver la traçabilité.', 'AUX_GIT_UNAVAILABLE');
      const commit = await repo.commitFiles(prepared.files.map((item) => item.path), `agent: ${record.summary.slice(0, 60)}`);
      record.gitBefore = commit.before;
      record.gitCommit = commit.after;
    }
  } catch (error) {
    // Keep the source tree consistent if history recording fails.
    if (applied) await restoreBackup(projectRoot, applied.backupPath, true, applied.afterHashes).catch(() => undefined);
    record.status = 'FAILED';
    record.rollback = { status: 'AUTO_RESTORED_AFTER_HISTORY_FAILURE', date: new Date().toISOString() };
    record.errors.push(error instanceof Error ? error.message : String(error));
    await saveReport(projectRoot, record);
    await upsertOperation(projectRoot, record);
    throw error;
  }
  record.status = 'APPLIED';
  await saveReport(projectRoot, record);
  await upsertOperation(projectRoot, record);
  return record;
}

export async function undoLastOperation(projectRoot: string): Promise<OperationRecord> {
  const records = await readOperations(projectRoot);
  const record = [...records].reverse().find((item) => item.status === 'APPLIED' && item.rollback?.status !== 'UNDONE');
  if (!record) throw new NovaError('Aucune opération appliquée et encore annulable.', 'UNDO_NOTHING_TO_DO');
  assertSafeOperationId(record.id);
  for (const file of record.filesChanged) await assertAllowedProjectPath(projectRoot, file, 'write', true);
  const config = await loadConfig(projectRoot);
  const backupPath = path.join(projectRoot, '.nova_agents', 'backups', `${record.id}.json`);
  if (!record.afterHashes) throw new NovaError('Le rapport ne contient pas les empreintes après application ; annulation refusée.', 'UNDO_METADATA_MISSING');

  const repo = new AuxiliaryGitRepository(projectRoot, config.history.directory);
  if (config.history.enabled && !(await repo.exists())) {
    throw new NovaError('Historique Git auxiliaire absent ou inaccessible ; annulation refusée avant toute restauration.', 'AUX_GIT_UNAVAILABLE');
  }
  // restoreBackup validates every current hash before touching any file.
  await restoreBackup(projectRoot, backupPath, true, record.afterHashes);
  if (config.history.enabled) {
    const commit = await repo.commitFiles(record.filesChanged, `agent: undo ${record.id}`);
    record.gitUndoCommit = commit.after;
  }
  record.status = 'UNDONE';
  record.rollback = { status: 'UNDONE', date: new Date().toISOString(), note: 'Restauration vérifiée à partir de la sauvegarde locale.' };
  await saveReport(projectRoot, record);
  await upsertOperation(projectRoot, record);
  return record;
}

export async function operationDiff(projectRoot: string): Promise<{ record: OperationRecord; patch: string } | undefined> {
  const records = await readOperations(projectRoot);
  const record = [...records].reverse().find((item) => item.status === 'PREPARED' || item.status === 'APPLIED' || item.status === 'UNDONE');
  if (!record?.patchPath) return undefined;
  const patchFile = resolveAgentStorePath(projectRoot, record.patchPath, 'patches');
  await assertSafeAgentPath(patchFile);
  const patch = await readFile(patchFile, 'utf8').catch(() => record.unifiedDiff);
  return { record, patch };
}

export async function verifyFileHashes(projectRoot: string, hashes: Record<string, string | null>): Promise<string[]> {
  const conflicts: string[] = [];
  for (const [relative, expected] of Object.entries(hashes)) {
    const absolute = path.resolve(projectRoot, relative);
    const bytes = await readFile(absolute).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    const actual = bytes ? sha256(bytes) : null;
    if (actual !== expected) conflicts.push(relative);
  }
  return conflicts;
}
