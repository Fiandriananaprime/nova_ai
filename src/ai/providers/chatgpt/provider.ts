import type { AIProvider, AIRequest, AIResponse } from '../../../protocol/schema.js';
import { EdgeSession, isNewProviderConversation } from '../../../browser/session.js';
import { inspectChatGPTPage } from '../../../browser/page-inspector.js';
import { sendAndReadLastAssistant } from '../../../browser/response-reader.js';
import { parseAIResponse } from '../../../protocol/parser.js';
import { buildProviderMessage } from '../../../protocol/prompts.js';
import { NovaError, asNovaError } from '../../../utils/errors.js';
import { saveBrowserDiagnostic } from '../../../browser/diagnostics.js';
import { CHATGPT_SELECTORS } from '../../../browser/selectors/chatgpt.js';

export class ChatGPTWebProvider implements AIProvider {
  readonly id = 'chatgpt-web';
  readonly description = 'ChatGPT Web via Microsoft Edge et Playwright (connexion manuelle requise)';
  readonly available = true;
  private session: EdgeSession | undefined;
  private turn = 0;
  private restoredUrl: string | undefined;

  constructor(private readonly channel = 'msedge', private readonly timeoutMs = 120000, private readonly projectRoot?: string, private readonly maxResponseBytes = 2 * 1024 * 1024) {}

  info() { return { id: this.id, description: this.description, available: this.available }; }

  async send(request: AIRequest): Promise<AIResponse> {
    if (!this.session) this.session = new EdgeSession(this.channel, this.timeoutMs);
    let page;
    try {
      page = this.session.currentPage ?? await this.session.openChatGPT(this.restoredUrl ?? 'https://chatgpt.com/');
      const state = await inspectChatGPTPage(page);
      if (!state.authenticated) throw new NovaError('Session ChatGPT non authentifiée. Connecte-toi manuellement dans Edge puis relance la tâche.', 'BROWSER_NOT_AUTHENTICATED');
      if (!state.usable) throw new NovaError(`${state.detail} Aucun message n’a été envoyé.`, 'BROWSER_SELECTOR_MISMATCH');
      const newConversation = isNewProviderConversation(this.restoredUrl, page.url(), 'chatgpt.com');
      const message = buildProviderMessage({ ...request, forceInitialPrompt: request.forceInitialPrompt || newConversation, message: `${request.message}\n\nExchange number: ${++this.turn}` });
      const raw = await sendAndReadLastAssistant(page, message, request.messageId, CHATGPT_SELECTORS, this.timeoutMs, this.maxResponseBytes, request.signal);
      this.restoredUrl = page.url();
      return parseAIResponse(raw, request.messageId);
    } catch (error) {
      const issue = asNovaError(error);
      await saveBrowserDiagnostic(this.projectRoot, page ?? this.session.currentPage, issue.code, issue.message).catch(() => undefined);
      this.restoredUrl = page?.url() ?? this.restoredUrl;
      throw issue;
    }
  }

  restoreState(state: string | undefined): void {
    if (!state) { this.restoredUrl = undefined; return; }
    try {
      const url = new URL(state);
      this.restoredUrl = url.protocol === 'https:' && url.hostname === 'chatgpt.com' && !url.username && !url.password
        ? url.toString()
        : undefined;
    } catch { this.restoredUrl = undefined; }
  }
  getState(): string | undefined { return this.session?.currentPage?.url() ?? this.restoredUrl; }
  async close(options: { terminateBrowser?: boolean } = {}): Promise<void> {
    this.restoredUrl = this.getState();
    await this.session?.close(options.terminateBrowser ?? false);
    this.session = undefined;
  }
}
