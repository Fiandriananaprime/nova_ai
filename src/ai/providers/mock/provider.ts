import type { AIProvider, AIRequest, AIResponse } from '../../../protocol/schema.js';

/** Deterministic provider for local tests. It never impersonates a real model. */
export class MockProvider implements AIProvider {
  readonly id = 'mock';
  readonly description = 'Provider déterministe de test, sans navigateur ni réseau';
  readonly available = true;
  private index = 0;
  readonly requests: AIRequest[] = [];

  constructor(private readonly script: Array<AIResponse | ((request: AIRequest) => AIResponse | Promise<AIResponse>)> = []) {}

  async send(request: AIRequest): Promise<AIResponse> {
    this.requests.push(structuredClone(request));
    const item = this.script[this.index++];
    if (typeof item === 'function') {
      const response = await item(request);
      return { ...response, acknowledgedMessageId: response.acknowledgedMessageId ?? request.messageId ?? 'mock-message' };
    }
    if (item) {
      const response = structuredClone(item);
      return { ...response, acknowledgedMessageId: response.acknowledgedMessageId ?? request.messageId ?? 'mock-message' };
    }
    return { protocol: 'nova-agent/1', acknowledgedMessageId: request.messageId ?? 'mock-message', status: 'DONE', reason: 'MockProvider : aucune réponse de scénario configurée.' };
  }

  async close(): Promise<void> { /* no resources */ }
}
