import path from 'node:path';
import type { Page } from 'playwright';
import { writeAtomic, id } from '../utils/fs.js';
import { pruneAgentFiles } from '../utils/retention.js';

/** Diagnostic metadata only: no prompt, page body, cookies, local storage, or form values. */
export async function saveBrowserDiagnostic(projectRoot: string | undefined, page: Page | undefined, code: string, detail: string): Promise<void> {
  if (!projectRoot) return;
  const directory = path.join(projectRoot, '.nova_agents', 'logs');
  const timestamp = new Date().toISOString();
  const file = path.join(directory, `browser-${timestamp.replace(/[:.]/g, '-')}-${id()}.json`);
  const record = {
    timestamp,
    code,
    detail: detail.slice(0, 1200),
    origin: page ? (() => { try { return new URL(page.url()).origin; } catch { return 'unknown'; } })() : 'unavailable',
    title: 'omitted for privacy',
    pageContent: 'not recorded',
  };
  await writeAtomic(file, `${JSON.stringify(record, null, 2)}\n`);
  await pruneAgentFiles(projectRoot, 'logs');
}
