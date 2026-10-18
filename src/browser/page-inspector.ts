import type { Page } from 'playwright';
import { CHATGPT_SELECTORS } from './selectors/chatgpt.js';
import { NovaError } from '../utils/errors.js';

export async function findFirstVisible(page: Page, selectors: string[]) {
  for (const selector of selectors) {
    const locator = page.locator(selector).last();
    try { if (await locator.isVisible({ timeout: 500 })) return locator; }
    catch { /* try the next documented selector */ }
  }
  return undefined;
}

export async function findUsableComposer(page: Page, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of CHATGPT_SELECTORS.composer) {
      const locator = page.locator(selector).last();
      try {
        if (await locator.isVisible({ timeout: 300 }) && await locator.isEnabled() && await locator.isEditable()) return locator;
      } catch { /* ChatGPT may replace the composer during a render; try again. */ }
    }
    await page.waitForTimeout(300);
  }
  return undefined;
}

export async function inspectChatGPTPage(page: Page): Promise<{ authenticated: boolean; usable: boolean; detail: string }> {
  const url = page.url();
  if (/\/auth\/login|\/login/i.test(url)) return { authenticated: false, usable: false, detail: 'La page demande une connexion.' };
  const bodyText = (await page.locator('body').innerText().catch(() => '')).slice(0, 4000);
  if (/log in|sign up|se connecter|créer un compte/i.test(bodyText) && !/message/i.test(bodyText)) {
    return { authenticated: false, usable: false, detail: 'Aucune session authentifiée détectée.' };
  }
  const composer = await findUsableComposer(page);
  if (!composer) return { authenticated: true, usable: false, detail: 'Champ de conversation introuvable : l’interface a peut-être changé.' };
  return { authenticated: true, usable: true, detail: 'Interface de conversation détectée.' };
}

export async function requireComposer(page: Page) {
  const locator = await findFirstVisible(page, CHATGPT_SELECTORS.composer);
  if (!locator) throw new NovaError('Champ ChatGPT introuvable. Un diagnostic local a été conservé ; vérifie l’interface avant de réessayer.', 'BROWSER_SELECTOR_MISMATCH');
  return locator;
}
