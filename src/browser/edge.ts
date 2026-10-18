import os from 'node:os';
import path from 'node:path';
import { access, mkdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { NovaError } from '../utils/errors.js';

export function getEdgeProfilePath(): string {
  return path.join(os.homedir(), '.nova-agent', 'edge-profile');
}

function edgeExecutableCandidates(): string[] {
  const roots = [process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES, process.env.LOCALAPPDATA]
    .filter((root): root is string => Boolean(root));
  return roots.map((root) => path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
}

async function findEdgeExecutable(): Promise<string> {
  for (const candidate of edgeExecutableCandidates()) {
    try {
      await access(candidate);
      return candidate;
    } catch { /* Check the next standard Edge installation path. */ }
  }
  throw new NovaError('Microsoft Edge est introuvable dans son emplacement Windows standard.', 'BROWSER_LAUNCH_FAILED');
}

async function waitForDevTools(profilePath: string, timeoutMs: number): Promise<string> {
  const activePortFile = path.join(profilePath, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const [portLine] = (await readFile(activePortFile, 'utf8')).split(/\r?\n/);
      const port = Number(portLine);
      if (Number.isInteger(port) && port > 0 && port <= 65535) {
        const endpoint = `http://127.0.0.1:${port}`;
        const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) return endpoint;
      }
    } catch { /* Edge may still be starting or its previous port file may be stale. */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new NovaError('Edge n’a pas exposé son endpoint local de reprise à temps.', 'BROWSER_LAUNCH_FAILED');
}

let shutdownHandlersInstalled = false;

async function terminatePersistentEdge(): Promise<void> {
  let browser: Browser | undefined;
  try {
    const endpoint = await waitForDevTools(getEdgeProfilePath(), 1000);
    browser = await chromium.connectOverCDP(endpoint, { timeout: 2000 });
    const session = await browser.newBrowserCDPSession();
    await session.send('Browser.close');
    await session.detach().catch(() => undefined);
  } catch { /* Edge may already be closed or the terminal may be shutting down. */ }
  await browser?.close().catch(() => undefined);
}

function installShutdownHandlers(): void {
  if (shutdownHandlersInstalled) return;
  shutdownHandlersInstalled = true;
  const shutdown = (signal: NodeJS.Signals): void => {
    void terminatePersistentEdge().finally(() => {
      process.exitCode = signal === 'SIGINT' ? 130 : 0;
      process.exit();
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.once('SIGBREAK', shutdown);
  process.once('SIGHUP', shutdown);
}

async function attachToEdge(options: { timeoutMs: number; url?: string }): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  const profilePath = getEdgeProfilePath();
  await mkdir(profilePath, { recursive: true });
  const timeoutMs = options.timeoutMs;
  try {
    let endpoint: string;
    try {
      endpoint = await waitForDevTools(profilePath, 1000);
    } catch {
      const executable = await findEdgeExecutable();
      const child = spawn(executable, [
        `--user-data-dir=${profilePath}`,
        '--remote-debugging-port=0',
        '--no-first-run',
        '--disable-features=Translate',
        options.url ?? 'https://chatgpt.com/',
      ], { stdio: 'ignore', windowsHide: true });
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      child.unref();
      endpoint = await waitForDevTools(profilePath, timeoutMs);
    }

    const browser = await chromium.connectOverCDP(endpoint, { timeout: timeoutMs });
    installShutdownHandlers();
    const context = browser.contexts()[0];
    if (!context) throw new NovaError('Aucun contexte Edge disponible sur le profil Nova.', 'BROWSER_LAUNCH_FAILED');
    const page = context.pages()[0] ?? await context.newPage();
    if (options.url && !new URL(page.url()).hostname.endsWith('chatgpt.com')) {
      await page.goto(options.url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    }
    return { browser, context, page };
  } catch (error) {
    if (error instanceof NovaError) throw error;
    throw new NovaError(`Impossible de se connecter à Microsoft Edge. Vérifie Edge et son profil Nova : ${error instanceof Error ? error.message : String(error)}`, 'BROWSER_LAUNCH_FAILED', { cause: error });
  }
}

export async function launchEdge(options: { channel?: string; timeoutMs?: number; url?: string } = {}): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  return attachToEdge({ timeoutMs: options.timeoutMs ?? 30000, ...(options.url ? { url: options.url } : {}) });
}
