import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pruneAgentFiles } from '../src/utils/retention.js';

let root = '';
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
});

async function makeLogs(count: number, bytesPerFile: number): Promise<string[]> {
  const directory = path.join(root, '.nova_agents', 'logs');
  await mkdir(directory, { recursive: true });
  const names: string[] = [];
  const baseTime = new Date('2025-01-01T00:00:00.000Z').getTime();
  for (let index = 0; index < count; index += 1) {
    const name = `log-${String(index).padStart(2, '0')}.jsonl`;
    const file = path.join(directory, name);
    await writeFile(file, 'x'.repeat(bytesPerFile));
    const time = new Date(baseTime + index * 1000);
    await utimes(file, time, time);
    names.push(name);
  }
  return names;
}

describe('Nova Agent log retention', () => {
  it('keeps at most 10 log files and removes the oldest first', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'nova-retention-count-'));
    const names = await makeLogs(12, 1024);
    const removed = await pruneAgentFiles(root, 'logs');
    expect(removed).toContain(path.join('.nova_agents', 'logs', names[0]!));
    expect(removed).toContain(path.join('.nova_agents', 'logs', names[1]!));
    expect(await readdir(path.join(root, '.nova_agents', 'logs'))).toHaveLength(10);
  });

  it('keeps the total logs directory at or below 5 MiB', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'nova-retention-size-'));
    await makeLogs(8, 900_000);
    await pruneAgentFiles(root, 'logs');
    const directory = path.join(root, '.nova_agents', 'logs');
    const names = await readdir(directory);
    const sizes = await Promise.all(names.map(async name => stat(path.join(directory, name))));
    expect(sizes.reduce((total, info) => total + info.size, 0)).toBeLessThanOrEqual(5 * 1024 * 1024);
    expect(names).toHaveLength(5);
  });
});
