import { z } from 'zod';

export const ConfigSchema = z.object({
  version: z.literal(1).default(1),
  defaultProvider: z.enum(['chatgpt-web', 'claude-web', 'gemini-web', 'mock']).default('chatgpt-web'),
  projectRoot: z.string().default('.'),
  browser: z.object({
    channel: z.literal('msedge').default('msedge'),
    headless: z.boolean().default(false),
    persistentProfile: z.boolean().default(true),
    timeoutMs: z.number().int().min(5000).max(300000).default(120000),
  }).default({}),
  protocol: z.object({
    version: z.literal('nova-agent/1').default('nova-agent/1'),
    maxCycles: z.number().int().min(1).max(20).default(6),
    maxFilesPerRequest: z.number().int().min(1).max(50).default(15),
    maxFileSizeBytes: z.number().int().min(1024).max(10 * 1024 * 1024).default(1024 * 1024),
    maxTotalFileBytes: z.number().int().min(1024).max(32 * 1024 * 1024).default(4 * 1024 * 1024),
    maxContextChars: z.number().int().min(4000).max(500000).default(60000),
    maxResponseBytes: z.number().int().min(1024).max(8 * 1024 * 1024).default(2 * 1024 * 1024),
    timeoutMs: z.number().int().min(5000).max(300000).default(120000),
  }).default({}),
  patches: z.object({
    requireConfirmation: z.boolean().default(true),
    backupBeforeApply: z.boolean().default(true),
    maxPatchBytes: z.number().int().min(1024).max(8 * 1024 * 1024).default(2 * 1024 * 1024),
  }).default({}),
  history: z.object({
    enabled: z.boolean().default(true),
    directory: z.string().default('.nova_agents/history.git'),
    reportsDirectory: z.string().default('.nova_agents/diff'),
  }).default({}),
  tests: z.array(z.object({ command: z.string().min(1), args: z.array(z.string()).default([]) })).default([]),
}).strict();

export type NovaConfig = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG: NovaConfig = ConfigSchema.parse({});
