import path from 'node:path';
import { writeAtomic, readOptional } from '../utils/fs.js';
import { pruneAgentFiles } from '../utils/retention.js';

export type OperationStatus = 'PREPARED' | 'APPLIED' | 'REJECTED' | 'FAILED' | 'UNDONE';
export interface OperationRecord {
  id: string;
  task: string;
  status: OperationStatus;
  date: string;
  provider: string;
  context: string;
  filesRequested: string[];
  filesChanged: string[];
  summary: string;
  originalHashes: Record<string, string | null>;
  afterHashes?: Record<string, string | null>;
  patchPath?: string;
  unifiedDiff: string;
  tests: Array<{ command: string; result: string }>;
  gitBefore?: string | null;
  gitCommit?: string | null;
  gitUndoCommit?: string | null;
  rollback?: { status: string; date?: string; note?: string };
  errors: string[];
  reportPath?: string;
}

export function reportFilename(record: OperationRecord): string {
  const date = new Date(record.date);
  const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}-${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}${String(date.getSeconds()).padStart(2, '0')}`;
  const slug = record.task.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 36) || 'operation';
  return `${stamp}-${slug}-${record.id.slice(0, 6)}.md`;
}

export function renderReport(record: OperationRecord): string {
  const tick = '`';
  const fence = '```';
  const tests = record.tests.length ? record.tests.map((item) => `- ${tick}${escapeInline(item.command)}${tick}: ${item.result}`).join('\n') : '- Aucun test exécuté.';
  const files = (items: string[]) => items.length ? items.map((item) => `- ${tick}${escapeInline(item)}${tick}`).join('\n') : '- Aucun';
  const errors = record.errors.length ? record.errors.map((item) => `- ${item}`).join('\n') : '- Aucune';
  const hashes = Object.entries(record.originalHashes).map(([file, hash]) => `- ${tick}${escapeInline(file)}${tick}: ${tick}${hash ?? 'ABSENT'}${tick}`).join('\n') || '- Aucun';
  const after = Object.entries(record.afterHashes ?? {}).map(([file, hash]) => `- ${tick}${escapeInline(file)}${tick}: ${tick}${hash ?? 'ABSENT'}${tick}`).join('\n') || '- Non appliqué';
  return `# Agent Operation: ${record.id}\n\n## Task\n${record.task}\n\n## Status\n${record.status}\n\n## Date\n${record.date}\n\n## Provider\n${record.provider}\n\n## Context\n${record.context || 'Aucun contexte additionnel.'}\n\n## Files Requested\n${files(record.filesRequested)}\n\n## Files Changed\n${files(record.filesChanged)}\n\n## Summary\n${record.summary || 'Aucun résumé.'}\n\n## Original State\n${hashes}\n\n## State After Application\n${after}\n\n## Patch\n${record.patchPath ? `${tick}${escapeInline(record.patchPath)}${tick}` : 'Aucun'}\n\n## Unified Diff\n${fence}diff\n${record.unifiedDiff || '(aucun diff)'}\n${fence}\n\n## Tests\n${tests}\n\n## Git History\n- Commit précédent : ${record.gitBefore ?? 'N/A'}\n- Commit de l'opération : ${record.gitCommit ?? 'N/A'}\n- Commit d'annulation : ${record.gitUndoCommit ?? 'N/A'}\n\n## Rollback\n${record.rollback ? `- Statut : ${record.rollback.status}\n- Date : ${record.rollback.date ?? 'N/A'}\n- Note : ${record.rollback.note ?? 'N/A'}` : '- Aucun rollback.'}\n\n## Errors and Warnings\n${errors}\n`;
}

function escapeInline(value: string): string { return value.replaceAll('`', "'").replaceAll('\n', ' '); }

export async function saveReport(projectRoot: string, record: OperationRecord): Promise<string> {
  const directory = path.resolve(projectRoot, '.nova_agents', 'diff');
  let reportPath: string;
  if (record.reportPath) {
    reportPath = path.resolve(record.reportPath);
    const relative = path.relative(directory, reportPath);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('Le chemin du rapport doit rester dans .nova_agents/diff/.');
    }
  } else {
    const base = path.join(directory, reportFilename(record));
    reportPath = base;
    let suffix = 2;
    const extension = path.extname(base);
    while (await readOptional(reportPath) !== undefined) {
      reportPath = `${base.slice(0, -extension.length)}-${suffix++}${extension}`;
    }
    record.reportPath = reportPath;
  }
  await writeAtomic(reportPath, renderReport(record));
  await pruneAgentFiles(projectRoot, 'diff');
  return reportPath;
}
