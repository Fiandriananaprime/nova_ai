import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadSession, saveSession, sessionPath, type PersistedSession } from '../src/session/persistence.js';

let root = '';
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ''; });

function sampleSession(projectRoot: string): PersistedSession {
  return {
    id: 'a81f2c', projectRoot, problem: 'Investigate login', providerId: 'mock', state: 'PAUSED', cycle: 1,
    createdAt: '2026-10-18T16:00:00.000Z', updatedAt: '2026-10-18T16:00:00.000Z', exchanges: [],
    requestedFiles: ['src/auth.ts'], fileHashes: { 'src/auth.ts': 'current-hash' },
    transmittedFileHashes: {}, pendingFilePaths: ['src/auth.ts'], pendingMessage: 'Continue with this file.',
    fileRequestSignatures: [], answers: [], contextSent: true,
  };
}

describe('session persistence', () => {
  it('persists pending paths and hashes without storing source contents', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'nova-agent-session-'));
    const session = sampleSession(root);
    await saveSession(session);
    const restored = await loadSession(root, session.id);
    expect(restored.pendingFilePaths).toEqual(['src/auth.ts']);
    expect(restored.pendingMessage).toBe('Continue with this file.');
    expect(restored.fileHashes['src/auth.ts']).toBe('current-hash');
    const raw = await readFile(sessionPath(root, session.id), 'utf8');
    expect(raw).not.toContain('source-code-content');
  });

  it('refuses traversal in session identifiers', () => {
    expect(() => sessionPath('C:/project', '../../outside')).toThrow();
    expect(() => sessionPath('C:/project', 'a81f2c')).not.toThrow();
  });
});
