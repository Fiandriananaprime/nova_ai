import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertSafeAgentPath } from '../security/agent-files.js';

export const id = (): string => randomUUID().replaceAll('-', '').slice(0, 12);
export const sha256 = (value: string | Buffer): string =>
  createHash('sha256').update(value).digest('hex');

export async function exists(filePath: string): Promise<boolean> {
  try { await readFile(filePath); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EISDIR') return true;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function writeAtomic(filePath: string, content: string | Buffer): Promise<void> {
  await assertSafeAgentPath(filePath, true);
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${id()}.tmp`;
  await writeFile(temporary, content, { flag: 'wx' });
  try { await rename(temporary, filePath); }
  catch (error) {
    const { rm } = await import('node:fs/promises');
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function readJson<T>(filePath: string): Promise<T> {
  await assertSafeAgentPath(filePath);
  return JSON.parse(await readFile(filePath, 'utf8')) as T;
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readOptional(filePath: string): Promise<string | undefined> {
  await assertSafeAgentPath(filePath);
  try { return await readFile(filePath, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export const isInteractive = (): boolean => Boolean(process.stdin.isTTY && process.stdout.isTTY);
