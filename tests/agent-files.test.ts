import { describe, expect, it } from 'vitest';
import { assertSafeOperationId, resolveAgentStorePath } from '../src/security/agent-files.js';

describe('protected Nova Agent storage paths', () => {
  it('resolves stored patches only inside the patch directory', () => {
    expect(resolveAgentStorePath('C:/project', '.nova_agents/patches/op.patch', 'patches')).toContain('op.patch');
    expect(() => resolveAgentStorePath('C:/project', '.nova_agents/patches/../../.env', 'patches')).toThrow();
    expect(() => resolveAgentStorePath('C:/project', 'src/app.ts', 'patches')).toThrow();
    expect(() => resolveAgentStorePath('C:/project', '.nova_agents/diff/report.md', 'patches')).toThrow();
  });

  it('rejects unsafe operation identifiers before creating backups', () => {
    expect(() => assertSafeOperationId('a81f2c')).not.toThrow();
    expect(() => assertSafeOperationId('../../outside')).toThrow();
    expect(() => assertSafeOperationId('id with spaces')).toThrow();
  });
});

import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { assertSafeAgentDirectory } from '../src/security/agent-files.js';

describe('protected Nova Agent storage filesystem checks', () => {
  it('creates storage directories and refuses a symlinked .nova_agents root', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'nova-agent-security-'));
    try {
      const project = path.join(temp, 'project');
      const outside = path.join(temp, 'outside');
      await mkdir(project);
      await mkdir(outside);
      await assertSafeAgentDirectory(path.join(project, '.nova_agents', 'patches'), true);
      const unsafeProject = path.join(temp, 'unsafe-project');
      await mkdir(unsafeProject);
      await symlink(outside, path.join(unsafeProject, '.nova_agents'), process.platform === 'win32' ? 'junction' : 'dir');
      await expect(assertSafeAgentDirectory(path.join(unsafeProject, '.nova_agents', 'sessions'), true)).rejects.toThrow();
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});
