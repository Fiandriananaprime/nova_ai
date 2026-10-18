import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { OperationRecord } from './markdown-reports.js';
import { writeJson } from '../utils/fs.js';
import { assertSafeAgentPath } from '../security/agent-files.js';

export const historyFile = (root: string) => path.join(root, '.nova_agents', 'operations.json');

export async function readOperations(root: string): Promise<OperationRecord[]> {
  try {
    await assertSafeAgentPath(historyFile(root));
    const data: unknown = JSON.parse(await readFile(historyFile(root), 'utf8'));
    return Array.isArray(data) ? data as OperationRecord[] : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function writeOperations(root: string, records: OperationRecord[]): Promise<void> {
  await writeJson(historyFile(root), records);
}

export async function upsertOperation(root: string, record: OperationRecord): Promise<void> {
  const operations = await readOperations(root);
  const index = operations.findIndex((item) => item.id === record.id);
  if (index >= 0) operations[index] = record;
  else operations.push(record);
  operations.sort((a, b) => a.date.localeCompare(b.date));
  await writeOperations(root, operations);
}
