import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanProject } from '../src/context/scanner.js';
import { renderTree } from '../src/context/scanner.js';
import { readProjectFile } from '../src/context/file-reader.js';
import { DEFAULT_NOVAIGNORE } from '../src/context/ignore.js';

let root = '';
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ''; });

async function fixture(): Promise<string> {
  root = await mkdtemp(path.join(os.tmpdir(), 'nova-agent-context-'));
  await writeFile(path.join(root, '.novaignore'), DEFAULT_NOVAIGNORE);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'node_modules', 'large-dependency'), { recursive: true });
  await mkdir(path.join(root, 'dist'), { recursive: true });
  await writeFile(path.join(root, 'src', 'index.ts'), 'export const value = 1;');
  await writeFile(path.join(root, 'node_modules', 'large-dependency', 'index.js'), 'must never appear');
  await writeFile(path.join(root, 'dist', 'bundle.js'), 'generated');
  await writeFile(path.join(root, '.env'), 'PASSWORD=not-a-real-value');
  return root;
}

describe('project context scanner', () => {
  it('excludes node_modules, build output, environment files and agent internals', async () => {
    const project = await fixture();
    await mkdir(path.join(project, '.nova_agents'), { recursive: true });
    await writeFile(path.join(project, '.nova_agents', 'secret.txt'), 'internal');
    const scan = await scanProject(project);
    const included = scan.files.map((file) => file.path);
    expect(included).toContain('src/index.ts');
    expect(included).not.toContain('node_modules/large-dependency/index.js');
    expect(included).not.toContain('dist/bundle.js');
    expect(included).not.toContain('.env');
    expect(included.some((file) => file.startsWith('.nova_agents/'))).toBe(false);
    expect(renderTree('fixture', scan.entries)).not.toContain('node_modules');
  });

  it('reads ordinary files but refuses excluded and secret-looking files', async () => {
    const project = await fixture();
    await expect(readProjectFile(project, 'src/index.ts')).resolves.toMatchObject({ path: 'src/index.ts' });
    await expect(readProjectFile(project, '.env')).rejects.toThrow();
    await writeFile(path.join(project, 'src', 'config.ts'), 'export const API_KEY = "a-very-long-literal-secret-value";');
    await expect(readProjectFile(project, 'src/config.ts')).rejects.toThrow();
  });
});
