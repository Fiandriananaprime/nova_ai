import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { AuxiliaryGitRepository } from '../src/history/git-repository.js';

let root = '';
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ''; });

describe('auxiliary Git repository', () => {
  it('keeps auxiliary commits separate from the main repository HEAD', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'nova-agent-git-'));
    await writeFile(path.join(root, 'README.md'), 'before\n');
    await execa('git', ['init', '--quiet'], { cwd: root });
    await execa('git', ['config', 'user.name', 'Test'], { cwd: root });
    await execa('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
    await execa('git', ['add', '--', 'README.md'], { cwd: root });
    await execa('git', ['commit', '-m', 'main initial', '--quiet'], { cwd: root });
    const mainHead = (await execa('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();

    await mkdir(path.join(root, '.nova_agents'), { recursive: true });
    const repository = new AuxiliaryGitRepository(root);
    await repository.initialize();
    const snapshot = await repository.snapshot(['README.md']);
    expect(snapshot).toBeTruthy();
    await writeFile(path.join(root, 'README.md'), 'after\n');
    const commit = await repository.commitFiles(['README.md'], 'agent: test operation');
    expect(commit.after).toBeTruthy();
    expect(commit.after).not.toBe(snapshot);
    expect((await execa('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()).toBe(mainHead);
    expect(await readFile(path.join(root, 'README.md'), 'utf8')).toBe('after\n');
  });

  it('refuses to target the main .git directory as its auxiliary history', () => {
    expect(() => new AuxiliaryGitRepository('/tmp/project', '.git')).toThrow();
    expect(() => new AuxiliaryGitRepository('/tmp/project', '../.git')).toThrow();
  });
});
