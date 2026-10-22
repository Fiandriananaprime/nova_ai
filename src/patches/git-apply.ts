import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execa } from 'execa';
import type { PatchFile } from './parser.js';
import { resolveInside } from '../security/paths.js';

export interface PatchWorkspaceResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  outputs?: Map<string, Buffer | null>;
}

function canSafelyRetryWithZeroContext(
  patch: string,
  files: PatchFile[],
  sourceLines: Map<string, string[]>,
): boolean {
  const blocks = patch.replaceAll('\r\n', '\n').split(/(?=^diff --git )/m).filter((block) => block.startsWith('diff --git '));
  if (blocks.length !== files.length) return false;

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!;
    const file = files[index]!;
    const lines = block.split('\n');
    const hunks: string[][] = [];
    let current: string[] | undefined;
    for (const line of lines) {
      if (/^@@ /.test(line)) {
        current = [];
        hunks.push(current);
      } else if (current && (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-') || line.startsWith('\\ No newline'))) {
        current.push(line);
      } else if (line.startsWith('diff --git ')) {
        current = undefined;
      }
    }
    const source = sourceLines.get(file.path) ?? [];
    if (!hunks.length) return false;
    for (const hunk of hunks) {
      const anchors = hunk.filter((line) => line.startsWith(' ')).map((line) => line.slice(1));
      if (!anchors.length || !anchors.some((anchor) => source.filter((line) => line === anchor).length === 1)) return false;
    }
  }
  return true;
}

export async function runPatchInNormalizedWorkspace(
  projectRoot: string,
  patch: string,
  files: PatchFile[],
  checkOnly: boolean,
): Promise<PatchWorkspaceResult> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'nova-agent-patch-'));
  const sourceLines = new Map<string, string[]>();
  const lineEndings = new Map<string, string>();
  try {
    for (const file of files) {
      const sourcePath = resolveInside(projectRoot, file.path);
      const workspacePath = resolveInside(workspace, file.path);
      let source: Buffer | undefined;
      try { source = await readFile(sourcePath); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (!source) continue;
      const text = source.toString('utf8');
      if (!Buffer.from(text, 'utf8').equals(source)) {
        return { exitCode: 1, stdout: '', stderr: `Le fichier ${file.path} n'est pas un fichier texte UTF-8 pris en charge.` };
      }
      const eol = text.includes('\r\n') ? '\r\n' : '\n';
      lineEndings.set(file.path, eol);
      const normalized = text.replaceAll('\r\n', '\n');
      sourceLines.set(file.path, normalized.split('\n'));
      await mkdir(path.dirname(workspacePath), { recursive: true });
      await writeFile(workspacePath, normalized, 'utf8');
    }

    const run = async (args: string[]) => execa('git', args, {
      cwd: workspace,
      input: patch,
      reject: false,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    const checkArgs = ['apply', '--check', '--whitespace=nowarn', '-'];
    let check = await run(checkArgs);
    let useZeroContext = false;
    if (check.exitCode !== 0 && canSafelyRetryWithZeroContext(patch, files, sourceLines)) {
      check = await run(['apply', '--check', '--unidiff-zero', '--whitespace=nowarn', '-']);
      useZeroContext = check.exitCode === 0;
    }
    if (check.exitCode !== 0) {
      return { exitCode: check.exitCode ?? null, stdout: check.stdout, stderr: check.stderr };
    }
    if (checkOnly) return { exitCode: 0, stdout: check.stdout, stderr: check.stderr };

    const applied = await run(['apply', ...(useZeroContext ? ['--unidiff-zero'] : []), '--whitespace=nowarn', '-']);
    if (applied.exitCode !== 0) return { exitCode: applied.exitCode ?? null, stdout: applied.stdout, stderr: applied.stderr };

    const outputs = new Map<string, Buffer | null>();
    for (const file of files) {
      if (file.deleted) {
        outputs.set(file.path, null);
        continue;
      }
      const workspacePath = resolveInside(workspace, file.path);
      const result = await readFile(workspacePath);
      const eol = lineEndings.get(file.path) ?? '\n';
      const text = result.toString('utf8');
      outputs.set(file.path, Buffer.from(eol === '\r\n' ? text.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n') : text.replaceAll('\r\n', '\n'), 'utf8'));
    }
    return { exitCode: 0, stdout: applied.stdout, stderr: applied.stderr, outputs };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
