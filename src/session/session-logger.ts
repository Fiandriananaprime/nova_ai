import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFile, mkdir } from 'node:fs/promises';
import { assertSafeAgentPath } from '../security/agent-files.js';
import { pruneAgentFiles } from '../utils/retention.js';

const loggerStorage = new AsyncLocalStorage<SessionLogger>();

export function withSessionLogger<T>(logger: SessionLogger, task: () => Promise<T>): Promise<T> {
  return loggerStorage.run(logger, task);
}

export function recordCurrentSessionLog(stage: string, details: Record<string, unknown> = {}): void {
  loggerStorage.getStore()?.record(stage, details);
}

export class SessionLogger {
  private readonly filePath: string;
  private queue: Promise<void> = Promise.resolve();
  private hasLogged = false;

  constructor(private readonly projectRoot: string, private readonly sessionId: string) {
    const date = new Date().toISOString().slice(0, 10);
    this.filePath = path.join(projectRoot, '.nova_agents', 'logs', `log_${sessionId}_${date}.jsonl`);
  }

  record(stage: string, details: Record<string, unknown> = {}): void {
    const line = JSON.stringify({ at: new Date().toISOString(), sessionId: this.sessionId, stage, ...details });
    this.queue = this.queue.then(async () => {
      await assertSafeAgentPath(this.filePath, true);
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, `${line}\n`, { encoding: 'utf8', flag: 'a', mode: 0o600 });
      if (!this.hasLogged) {
        this.hasLogged = true;
        await pruneAgentFiles(this.projectRoot, 'logs');
      }
    }).catch((error: unknown) => {
      console.error(`Écriture du journal Nova impossible (${this.filePath}) : ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  async flush(): Promise<void> {
    await this.queue;
  }

  get relativePath(): string {
    return path.relative(this.projectRoot, this.filePath);
  }
}

