import type { PersistedSession, SessionStatus } from './persistence.js';

export type NovaApprovalRequest =
  | { kind: 'command'; command: string; reason: string; cwd: string; sessionId: string }
  | { kind: 'patch'; operationId: string; summary: string; files: Array<{ path: string; additions: number; deletions: number }>; diff: string; reportPath: string; sessionId: string }
  | { kind: 'sensitive-file'; path: string; reason: string; sessionId: string };

export type NovaApprovalDecision = 'approve' | 'reject' | 'approve-session';

export type NovaCoreEvent =
  | { type: 'session'; session: PersistedSession }
  | { type: 'status'; sessionId: string; state: SessionStatus; detail: string; at: string }
  | { type: 'read'; sessionId: string; path: string }
  | { type: 'write'; sessionId: string; path: string }
  | { type: 'summary'; sessionId: string; text: string }
  | { type: 'patch-ready'; sessionId: string; operationId: string; summary: string; diff: string; reportPath: string; files: Array<{ path: string; additions: number; deletions: number }> }
  | { type: 'approval-request'; request: NovaApprovalRequest }
  | { type: 'question'; sessionId: string; question: string }
  | { type: 'error'; sessionId?: string; code: string; message: string }
  | { type: 'completed'; sessionId: string; state: SessionStatus };

export interface NovaCoreCallbacks {
  onEvent?: (event: NovaCoreEvent) => void;
  requestApproval?: (request: NovaApprovalRequest) => Promise<NovaApprovalDecision>;
  requestAnswer?: (question: string, sessionId: string) => Promise<string | null>;
  isCancelled?: () => boolean;
}

export function emitNovaEvent(callbacks: NovaCoreCallbacks | undefined, event: NovaCoreEvent): void {
  try { callbacks?.onEvent?.(event); } catch { /* UI listeners must not break core safety or persistence. */ }
}
