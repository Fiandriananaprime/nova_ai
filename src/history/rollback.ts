import { undoLastOperation } from './operation-service.js';
import type { OperationRecord } from './markdown-reports.js';

export async function rollbackLatest(projectRoot: string): Promise<OperationRecord> {
  return undoLastOperation(projectRoot);
}
