import type { AIProvider, AIRequest, AIResponse } from '../../../protocol/schema.js';
import { EdgeSession, isNewProviderConversation } from '../../../browser/session.js';
import { inspectWebProviderPage } from '../../../browser/page-inspector.js';
import { sendAndReadLastAssistant } from '../../../browser/response-reader.js';
import { GEMINI_SELECTORS } from '../../../browser/selectors/web-providers.js';
import { parseAIResponse } from '../../../protocol/parser.js';
import { buildProviderMessage } from '../../../protocol/prompts.js';
import { NovaError, asNovaError } from '../../../utils/errors.js';
import { saveBrowserDiagnostic } from '../../../browser/diagnostics.js';

const PROVIDER_URL = 'https://gemini.google.com/app';
const PROVIDER_HOST = 'gemini.google.com';

export class GeminiWebProvider implements AIProvider {
  readonly id = 'gemini-web';
  readonly description = 'Gemini via Edge et Playwright (connexion manuelle requise)';
  readonly available = true;
  private session: EdgeSession | undefined;
  private turn = 0;
  private restoredUrl: string | undefined;

  constructor(private readonly channel = 'msedge', private readonly timeoutMs = 120000, private readonly projectRoot?: string, private readonly maxResponseBytes = 2 * 1024 * 1024) {}

  async send(request: AIRequest): Promise<AIResponse> {
    if (!this.session) this.session = new EdgeSession(this.channel, this.timeoutMs);
    let page;
    try {
      request.onTrace?.('provider.send.start', { providerId: this.id, taskId: request.taskId, messageId: request.messageId, userMessage: request.message, fileMetadata: request.files?.map(({ path, sha256, content }) => ({ path, sha256, bytes: Buffer.byteLength(content, 'utf8') })) ?? [] });
      page = this.session.currentPage ?? await this.session.openProvider(this.restoredUrl ?? PROVIDER_URL);
      const state = await inspectWebProviderPage(page, PROVIDER_HOST, GEMINI_SELECTORS);
      if (!state.authenticated) throw new NovaError('Session Gemini non authentifiée. Connecte-toi manuellement dans Edge puis relance la tâche.', 'BROWSER_NOT_AUTHENTICATED');
      if (!state.usable) throw new NovaError(`${state.detail} Aucun message n’a été envoyé.`, 'BROWSER_SELECTOR_MISMATCH');
      const newConversation = isNewProviderConversation(this.restoredUrl, page.url(), PROVIDER_HOST);
      const message = buildProviderMessage({ ...request, forceInitialPrompt: request.forceInitialPrompt || newConversation, message: `${request.message}\n\nExchange number: ${++this.turn}` });
      request.onTrace?.('provider.prompt.prepared', { messageId: request.messageId, conversationUrl: page.url(), includeGeneralPrompt: request.forceInitialPrompt || request.includeGeneralPrompt !== false, promptBytes: Buffer.byteLength(message, 'utf8'), prompt: message, projectContextBytes: Buffer.byteLength(request.projectContext, 'utf8'), treeBytes: Buffer.byteLength(request.tree ?? '', 'utf8') });
      const raw = await sendAndReadLastAssistant(page, message, request.messageId, GEMINI_SELECTORS, this.timeoutMs, this.maxResponseBytes, request.signal, request.onTrace);
      request.onTrace?.('provider.response.raw', { messageId: request.messageId, response: raw });
      this.restoredUrl = page.url();
      const response = parseAIResponse(raw, request.messageId);
      request.onTrace?.('provider.response.parsed', { messageId: request.messageId, response });
      return response;
    } catch (error) {
      const issue = asNovaError(error);
      request.onTrace?.('provider.send.error', { providerId: this.id, messageId: request.messageId, code: issue.code, message: issue.message, stack: issue.stack, conversationUrl: page?.url() ?? this.restoredUrl });
      await saveBrowserDiagnostic(this.projectRoot, page ?? this.session.currentPage, issue.code, issue.message).catch(() => undefined);
      this.restoredUrl = page?.url() ?? this.restoredUrl;
      throw issue;
    }
  }

  restoreState(state: string | undefined): void {
    if (!state) { this.restoredUrl = undefined; return; }
    try {
      const url = new URL(state);
      this.restoredUrl = url.protocol === 'https:' && url.hostname === PROVIDER_HOST && !url.username && !url.password ? url.toString() : undefined;
    } catch { this.restoredUrl = undefined; }
  }

  getState(): string | undefined { return this.session?.currentPage?.url() ?? this.restoredUrl; }

  async close(options: { terminateBrowser?: boolean } = {}): Promise<void> {
    this.restoredUrl = this.getState();
    await this.session?.close(options.terminateBrowser ?? false);
    this.session = undefined;
  }
}
