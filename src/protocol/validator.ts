import { NovaError } from '../utils/errors.js';
import { normalizeRelativePath } from '../security/paths.js';
import type { AIResponse } from './schema.js';

export function validateRequestedFiles(response: AIResponse, maxFiles: number): string[] {
  if (response.status !== 'NEED_FILES' || !response.files) return [];
  if (response.files.length > maxFiles) throw new NovaError(`L'IA demande ${response.files.length} fichiers, limite configurée : ${maxFiles}.`, 'TOO_MANY_FILES');
  const normalized = response.files.map(normalizeRelativePath);
  if (new Set(normalized).size !== normalized.length) throw new NovaError('La réponse demande plusieurs fois le même fichier.', 'REPEATED_FILE_REQUEST');
  return normalized;
}
