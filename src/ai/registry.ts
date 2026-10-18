import type { AIProvider } from '../protocol/schema.js';
import { MockProvider } from './providers/mock/provider.js';
import { ChatGPTWebProvider } from './providers/chatgpt/provider.js';
import { ClaudeWebProvider } from './providers/claude/provider.js';
import { GeminiWebProvider } from './providers/gemini/provider.js';
import type { NovaConfig } from '../config/schema.js';

export interface ProviderInfo { id: string; description: string; available: boolean; }
export function listProviders(): ProviderInfo[] {
  return [new ChatGPTWebProvider().info(), new ClaudeWebProvider(), new GeminiWebProvider(), new MockProvider()]
    .map((provider) => ({ id: provider.id, description: provider.description, available: provider.available }));
}

export function createProvider(providerId: string, config: NovaConfig, projectRoot?: string): AIProvider {
  switch (providerId) {
    case 'chatgpt-web': return new ChatGPTWebProvider(config.browser.channel, config.browser.timeoutMs, projectRoot, config.protocol.maxResponseBytes);
    case 'claude-web': return new ClaudeWebProvider();
    case 'gemini-web': return new GeminiWebProvider();
    case 'mock': return new MockProvider();
    default: throw new Error(`Fournisseur inconnu : ${providerId}`);
  }
}
