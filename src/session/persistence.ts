import path from 'node:path';
import { readJson, writeJson } from '../utils/fs.js';
import { NovaError } from '../utils/errors.js';

export type SessionStatus = 'IDLE' | 'ANALYZING_CONTEXT' | 'SENDING_PROMPT' | 'WAITING_FOR_RESPONSE' | 'PARSING_RESPONSE' | 'READING_FILES' | 'WAITING_FOR_USER' | 'VALIDATING_PATCH' | 'PREVIEWING_DIFF' | 'WAITING_FOR_APPROVAL' | 'APPLYING_PATCH' | 'RUNNING_TESTS' | 'RECORDING_HISTORY' | 'DONE' | 'ERROR' | 'PAUSED';
export interface SessionExchange { at: string; state: string; detail: string; }
export interface PersistedSession {
  id: string;
  projectRoot: string;
  problem: string;
  providerId: string;
  state: SessionStatus;
  cycle: number;
  createdAt: string;
  updatedAt: string;
  exchanges: SessionExchange[];
  requestedFiles: string[];
  /** Latest SHA-256 observed for each authorized source file. */
  fileHashes: Record<string, string>;
  /** Hashes known to have been included in a request that returned successfully. */
  transmittedFileHashes?: Record<string, string>;
  /** Hashes of sensitive file contents explicitly approved for transmission. */
  approvedSensitiveFiles?: Record<string, string>;
  /** Local paths to re-read if a process stopped while a request was in flight. */
  pendingFilePaths?: string[];
  /** Remaining one-by-one file transfer handshake state. */
  fileTransferQueue?: string[];
  fileTransferHashes?: Record<string, string>;
  fileTransferTotal?: number;
  fileTransferCurrentPath?: string;
  fileTransferChunkIndex?: number;
  fileTransferChunkTotal?: number;
  fileTransferActive?: boolean;
  fileTransferSummary?: string;
  /** Text of the request that may need a user-confirmed retry after an interruption. */
  pendingMessage?: string;
  fileRequestSignatures: string[];
  answers: string[];
  contextSent: boolean;
  /** Whether the general system prompt and protocol were sent in this provider conversation. */
  generalPromptSent?: boolean;
  providerState?: string;
  pendingOperationId?: string;
  error?: string;
}

export function sessionPath(projectRoot: string, sessionId: string): string {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(sessionId)) throw new NovaError('Identifiant de session invalide.', 'SESSION_ID_INVALID');
  return path.join(projectRoot, '.nova_agents', 'sessions', `${sessionId}.json`);
}

export async function saveSession(session: PersistedSession): Promise<void> {
  session.updatedAt = new Date().toISOString();
  await writeJson(sessionPath(session.projectRoot, session.id), session);
  await writeJson(path.join(session.projectRoot, '.nova_agents', 'session.json'), { currentSessionId: session.id, updatedAt: session.updatedAt });
}

export async function loadSession(projectRoot: string, sessionId: string): Promise<PersistedSession> {
  return readJson<PersistedSession>(sessionPath(projectRoot, sessionId));
}
