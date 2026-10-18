import { describe, expect, it } from 'vitest';
import { normalizeRelativePath, resolveInside, isSecretPath } from '../src/security/paths.js';
import { containsPotentialSecret } from '../src/security/secrets.js';
import { assertTransition } from '../src/session/state-machine.js';

describe('security boundaries', () => {
  it('normalizes Windows paths and supports spaces', () => {
    expect(normalizeRelativePath('src\\my folder\\index.ts')).toBe('src/my folder/index.ts');
    expect(resolveInside('C:/project', 'src/my folder/index.ts')).toContain('my folder');
  });

  it('rejects absolute paths, traversal, and internal agent writes', () => {
    expect(() => normalizeRelativePath('../secrets.txt')).toThrow();
    expect(() => normalizeRelativePath('C:\\secrets.txt')).toThrow();
    expect(() => resolveInside('/project', '.nova_agents/session.json')).toThrow();
  });

  it('recognizes common secret file names and detects literal secret values', () => {
    expect(isSecretPath('.env.local')).toBe(true);
    expect(isSecretPath('.env.example')).toBe(false);
    expect(containsPotentialSecret('API_KEY = "sk_example_but_not_a_real_key"')).toBe(true);
    expect(containsPotentialSecret('const passwordHash = user.passwordHash;')).toBe(false);
    expect(containsPotentialSecret('password: process.env.PASSWORD')).toBe(false);
  });

  it('enforces valid state transitions', () => {
    expect(() => assertTransition('IDLE', 'ANALYZING_CONTEXT')).not.toThrow();
    expect(() => assertTransition('DONE', 'APPLYING_PATCH')).toThrow();
  });
});
