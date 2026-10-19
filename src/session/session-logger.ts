import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFile, mkdir, stat } from 'node:fs/promises';
import { assertSafeAgentPath } from '../security/agent-files.js';
import { pruneAgentFiles } from '../utils/retention.js';

const loggerStorage = new AsyncLocalStorage<SessionLogger>();
const MAX_SESSION_LOG_BYTES = 5 * 1024 * 1024;
const MAX_LOG_RECORD_BYTES = 32 * 1024;
const PRUNE_EVERY_RECORDS = 10;

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
  private recordsSincePrune = 0;
  private limitReached = false;

  constructor(private readonly projectRoot: string, private readonly sessionId: string) {
    const date = new Date().toISOString().slice(0, 10);
    this.filePath = path.join(projectRoot, '.nova_agents', 'logs', `log_${sessionId}_${date}.jsonl`);
  }

  record(stage: string, details: Record<string, unknown> = {}): void {
    const at = new Date().toISOString();
    const fullLine = JSON.stringify({ at, sessionId: this.sessionId, stage, ...details });
    const fullLineBytes = Buffer.byteLength(fullLine, 'utf8');
    const line = fullLineBytes > MAX_LOG_RECORD_BYTES
      ? JSON.stringify({ at, sessionId: this.sessionId, stage, truncated: true, originalBytes: fullLineBytes })
      : fullLine;
    this.queue = this.queue.then(async () => {
      if (this.limitReached) return;
      await assertSafeAgentPath(this.filePath, true);
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const currentBytes = await stat(this.filePath)
        .then((info) => info.size)
        .catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
          throw error;
        });
      const nextBytes = Buffer.byteLength(`${line}\n`, 'utf8');
      if (currentBytes + nextBytes > MAX_SESSION_LOG_BYTES) {
        this.limitReached = true;
        const marker = JSON.stringify({ at, sessionId: this.sessionId, stage: 'logging.limit_reached', maxBytes: MAX_SESSION_LOG_BYTES });
        const markerBytes = Buffer.byteLength(`${marker}\n`, 'utf8');
        if (currentBytes + markerBytes <= MAX_SESSION_LOG_BYTES) {
          await appendFile(this.filePath, `${marker}\n`, { encoding: 'utf8', flag: 'a', mode: 0o600 });
        }
      } else {
        await appendFile(this.filePath, `${line}\n`, { encoding: 'utf8', flag: 'a', mode: 0o600 });
        this.recordsSincePrune += 1;
      }
      if (!this.hasLogged || this.recordsSincePrune >= PRUNE_EVERY_RECORDS || this.limitReached) {
        this.hasLogged = true;
        this.recordsSincePrune = 0;
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

