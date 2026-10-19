import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validatePatch } from '../src/patches/validator.js';
import { applyPreparedPatch, restoreBackup } from '../src/patches/apply.js';
import { sha256 } from '../src/utils/fs.js';
import { DEFAULT_NOVAIGNORE } from '../src/context/ignore.js';

let root = '';
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ''; });

const patchFor = (relative: string, before: string, after: string) => [
  `diff --git a/${relative} b/${relative}`,
  'index 1111111..2222222 100644',
  `--- a/${relative}`,
  `+++ b/${relative}`,
  '@@ -1 +1 @@',
  `-${before}`,
  `+${after}`,
  '',
].join('\n');

async function setup(): Promise<{ file: string; hash: string }> {
  root = await mkdtemp(path.join(os.tmpdir(), 'nova-agent-patch-'));
  await writeFile(path.join(root, '.novaignore'), DEFAULT_NOVAIGNORE);
  await mkdir(path.join(root, 'src'), { recursive: true });
  const file = path.join(root, 'src', 'value.ts');
  await writeFile(file, 'export const value = 1;\n');
  return { file, hash: sha256(await readFile(file)) };
}

describe('patch validation and reversible application', () => {
  it('applies a checked patch and restores the exact original bytes', async () => {
    const { file, hash } = await setup();
    const patch = patchFor('src/value.ts', 'export const value = 1;', 'export const value = 2;');
    const prepared = await validatePatch(root, patch, { 'src/value.ts': hash });
    const applied = await applyPreparedPatch(root, 'operation-test', patch, prepared);
    expect(await readFile(file, 'utf8')).toBe('export const value = 2;\n');
    await restoreBackup(root, applied.backupPath, true, applied.afterHashes);
    expect(await readFile(file, 'utf8')).toBe('export const value = 1;\n');
  });

  it('rejects stale files and writes to files not explicitly read', async () => {
    const { file, hash } = await setup();
    const patch = patchFor('src/value.ts', 'export const value = 1;', 'export const value = 2;');
    await writeFile(file, 'export const value = 3;\n');
    await expect(validatePatch(root, patch, { 'src/value.ts': hash })).rejects.toThrow(/a changé depuis sa lecture/i);
    await expect(validatePatch(root, patch, {})).rejects.toThrow(/n'a pas été explicitement lu/i);
  });

  it('repairs incorrect unified-diff hunk counts before git validation', async () => {
    const { hash } = await setup();
    const patch = patchFor('src/value.ts', 'export const value = 1;', 'export const value = 2;')
      .replace('@@ -1 +1 @@', '@@ -1,99 +1,99 @@');
    const prepared = await validatePatch(root, patch, { 'src/value.ts': hash });
    expect(prepared.diff).toContain('@@ -1,1 +1,1 @@');
    expect(prepared.diff).not.toContain('@@ -1,99 +1,99 @@');
  });

  it('rejects attempts to patch ignored files', async () => {
    const { hash } = await setup();
    const patch = patchFor('.env', 'password=x', 'password=y');
    await expect(validatePatch(root, patch, { '.env': hash })).rejects.toThrow();
  });
});
