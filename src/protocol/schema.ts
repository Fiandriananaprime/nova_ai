import { z } from 'zod';

export const AIStatusSchema = z.enum(['NEED_FILES', 'FILE_RECEIVED', 'TRANSFER_STOP', 'NEED_INFO', 'RUN_COMMAND', 'PATCH_READY', 'DONE']);
export const AINextStatusSchema = z.enum(['NEED_FILES', 'TRANSFER_STOP', 'NEED_INFO', 'RUN_COMMAND', 'PATCH_READY', 'DONE']);
export const AIResponseSchema = z.object({
  protocol: z.literal('nova-agent/1'),
  acknowledgedMessageId: z.string().min(1).max(100),
  status: AIStatusSchema,
  nextStatus: AINextStatusSchema.optional(),
  reason: z.string().max(10000).optional(),
  files: z.array(z.string().min(1).max(1000)).max(50).optional(),
  receivedFile: z.string().min(1).max(1000).optional(),
  chunkIndex: z.number().int().positive().optional(),
  transferReason: z.string().max(1000).optional(),
  question: z.string().max(10000).optional(),
  command: z.string().trim().min(1).max(4000).optional(),
  commandReason: z.string().max(1000).optional(),
  summary: z.string().max(10000).optional(),
  patch: z.string().max(8 * 1024 * 1024).optional(),
  tests: z.array(z.string().max(2000)).max(50).optional(),
}).strip().superRefine((value, ctx) => {
  if (value.nextStatus && value.status !== 'FILE_RECEIVED') ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'nextStatus est uniquement autorisé après FILE_RECEIVED.' });
  const effectiveStatus = value.nextStatus ?? value.status;
  if (effectiveStatus === 'NEED_FILES' && (!value.files || value.files.length === 0)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'NEED_FILES exige au moins un chemin dans files.' });
  if (value.status === 'FILE_RECEIVED' && (!value.receivedFile?.trim() || !value.chunkIndex)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'FILE_RECEIVED exige receivedFile et chunkIndex.' });
  // A standalone TRANSFER_STOP may omit chunk metadata; the orchestrator fills it from the active local transfer.
  // FILE_RECEIVED (including FILE_RECEIVED + nextStatus TRANSFER_STOP) still requires explicit metadata.
  if (effectiveStatus === 'NEED_INFO' && !value.question?.trim()) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'NEED_INFO exige une question.' });
  if (effectiveStatus === 'RUN_COMMAND' && !value.command?.trim()) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'RUN_COMMAND exige une commande non vide.' });
  if (effectiveStatus === 'RUN_COMMAND' && !value.commandReason?.trim()) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'RUN_COMMAND exige un motif.' });
  if (effectiveStatus === 'PATCH_READY' && !value.patch?.trim()) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'PATCH_READY exige un patch non vide.' });
  if (effectiveStatus === 'PATCH_READY' && !value.summary?.trim()) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'PATCH_READY exige un résumé.' });
});

export type AIStatus = z.infer<typeof AIStatusSchema>;
export type AIResponse = z.infer<typeof AIResponseSchema>;

export interface AIRequest {
  taskId: string;
  messageId: string;
  message: string;
  /** Include the general system and protocol instructions only on the session's first exchange. */
  includeGeneralPrompt?: boolean;
  projectContext: string;
  tree?: string;
  files?: Array<{ path: string; content: string; sha256: string }>;
  signal?: AbortSignal;
  forceInitialPrompt?: boolean;
  /** Internal diagnostic hook; never serialized into the provider prompt. */
  onTrace?: (stage: string, details?: Record<string, unknown>) => void;
}

export interface AIProvider {
  readonly id: string;
  readonly description: string;
  readonly available: boolean;
  send(request: AIRequest): Promise<AIResponse>;
  close(options?: { terminateBrowser?: boolean }): Promise<void>;
  restoreState?(state: string | undefined): void;
  getState?(): string | undefined;
}
