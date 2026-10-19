import { AIResponseSchema, type AIResponse } from './schema.js';
import { NovaError } from '../utils/errors.js';

export function extractJson(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new NovaError('La réponse du fournisseur est vide.', 'AI_RESPONSE_EMPTY');
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  if (!candidate.startsWith('{') || !candidate.endsWith('}')) {
    throw new NovaError('Réponse non conforme : un unique objet JSON est attendu.', 'AI_JSON_INVALID');
  }
  return candidate;
}

export function parseAIResponse(raw: string, expectedMessageId?: string): AIResponse {
  let parsed: unknown;
  try { parsed = JSON.parse(extractJson(raw)); }
  catch (error) {
    if (error instanceof NovaError) throw error;
    throw new NovaError(`JSON invalide dans la réponse IA : ${error instanceof Error ? error.message : String(error)}`, 'AI_JSON_INVALID', { cause: error });
  }
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && 'nextFiles' in parsed) {
    const response = parsed as Record<string, unknown>;
    if ('files' in response) {
      throw new NovaError('Ambiguous file list: use files or nextFiles, not both.', 'AI_PROTOCOL_INVALID');
    }
    response.files = response.nextFiles;
    delete response.nextFiles;
  }
  const result = AIResponseSchema.safeParse(parsed);
  if (!result.success) throw new NovaError(`Réponse incompatible avec nova-agent/1 : ${result.error.issues.map((issue: { message: string }) => issue.message).join('; ')}`, 'AI_PROTOCOL_INVALID');
  if (expectedMessageId && result.data.acknowledgedMessageId !== expectedMessageId) {
    throw new NovaError(`Accusé de message invalide : Nova attendait ${expectedMessageId}, mais a reçu ${result.data.acknowledgedMessageId}.`, 'AI_MESSAGE_ACK_INVALID');
  }
  return result.data;
}
