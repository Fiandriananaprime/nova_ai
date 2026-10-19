import path from 'node:path';
import { writeAtomic, id } from '../utils/fs.js';
import { validatePatch } from './validator.js';
import type { PreparedPatch } from './validator.js';

export interface StoredPatch { id: string; relativePath: string; absolutePath: string; prepared: PreparedPatch; }

export async function prepareAndStorePatch(projectRoot: string, patch: string, fileHashes: Record<string, string>, maxBytes: number, operationId = id()): Promise<StoredPatch> {
  const prepared = await validatePatch(projectRoot, patch, fileHashes, maxBytes);
  const relativePath = path.posix.join('.nova_agents', 'patches', `${operationId}.patch`);
  const absolutePath = path.join(projectRoot, '.nova_agents', 'patches', `${operationId}.patch`);
  await writeAtomic(absolutePath, prepared.diff);
  return { id: operationId, relativePath, absolutePath, prepared };
}
