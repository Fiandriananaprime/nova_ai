import type { Browser, BrowserContext, Page } from 'playwright';
import { launchEdge } from './edge.js';
import { inspectChatGPTPage } from './page-inspector.js';
import { NovaError } from '../utils/errors.js';

export class EdgeSession {
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  private page: Page | undefined;
  constructor(private readonly channel = 'msedge', private readonly timeoutMs = 120000) {}

  async openProvider(url = 'https://chatgpt.com/'): Promise<Page> {
    const launched = await launchEdge({ channel: this.channel, timeoutMs: this.timeoutMs, url });
    this.browser = launched.browser;
    this.context = launched.context;
    this.page = launched.page;
    return launched.page;
  }

  async openChatGPT(url = 'https://chatgpt.com/'): Promise<Page> {
    return this.openProvider(url);
  }

  async assertReady(): Promise<Page> {
    if (!this.page) await this.openChatGPT();
    const page = this.page!;
    await page.waitForLoadState('domcontentloaded', { timeout: this.timeoutMs }).catch(() => undefined);
    const state = await inspectChatGPTPage(page);
    if (!state.authenticated) throw new NovaError('Session ChatGPT non authentifiée. Connecte-toi manuellement dans Edge, puis relance la commande.', 'BROWSER_NOT_AUTHENTICATED');
    if (!state.usable) throw new NovaError(`${state.detail} Aucun message n’a été envoyé.`, 'BROWSER_SELECTOR_MISMATCH');
    return page;
  }

  get currentPage(): Page | undefined { return this.page; }
  async close(terminateEdge = false): Promise<void> {
    const browser = this.browser;
    if (terminateEdge && browser) {
      try {
        const session = await browser.newBrowserCDPSession();
        await session.send('Browser.close');
        await session.detach().catch(() => undefined);
      } catch { /* Edge may already have been closed by the user. */ }
    }
    await browser?.close().catch(() => undefined);
    this.browser = undefined;
    this.context = undefined;
    this.page = undefined;
  }
}
