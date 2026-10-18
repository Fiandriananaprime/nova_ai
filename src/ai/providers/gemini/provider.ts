import { NovaError } from '../../../utils/errors.js';
import type { AIProvider, AIRequest, AIResponse } from '../../../protocol/schema.js';

export class GeminiWebProvider implements AIProvider {
  readonly id = 'gemini-web';
  readonly description = 'Adaptateur réservé — interface Gemini non vérifiée dans cette version';
  readonly available = false;
  async send(_request: AIRequest): Promise<AIResponse> {
    throw new NovaError('Gemini Web n’est pas encore implémenté ni vérifié. Sélectionne un fournisseur pris en charge explicitement.', 'PROVIDER_NOT_IMPLEMENTED');
  }
  async close(): Promise<void> {}
}
