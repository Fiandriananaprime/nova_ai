import type { Page } from 'playwright';
import { CHATGPT_SELECTORS } from './selectors/chatgpt.js';
import { findFirstVisible, findUsableComposer } from './page-inspector.js';
import { NovaError } from '../utils/errors.js';
import type { WebProviderSelectors } from './selectors/web-providers.js';

const STATUSES = new Set(['NEED_FILES', 'FILE_RECEIVED', 'TRANSFER_STOP', 'NEED_INFO', 'RUN_COMMAND', 'PATCH_READY', 'DONE']);

function extractProtocolResponse(text: string): string {
  let searchFrom = text.length;
  while (searchFrom > 0) {
    const protocolKey = text.lastIndexOf('"protocol"', searchFrom);
    if (protocolKey < 0) return '';
    const start = text.lastIndexOf('{', protocolKey);
    if (start < 0) return '';

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') depth += 1;
      else if (char === '}' && --depth === 0) {
        const candidate = text.slice(start, index + 1);
        try {
          const value: unknown = JSON.parse(candidate);
          if (typeof value === 'object' && value !== null
            && 'protocol' in value && value.protocol === 'nova-agent/1'
            && 'status' in value && typeof value.status === 'string' && STATUSES.has(value.status)) return candidate;
        } catch { /* Try an earlier protocol key in the conversation text. */ }
        break;
      }
    }
    searchFrom = protocolKey - 1;
  }
  return '';
}

export async function sendAndReadLastAssistant(
  page: Page,
  message: string,
  selectors: WebProviderSelectors = CHATGPT_SELECTORS,
  timeoutMs = 120000,
  maxResponseBytes = 2 * 1024 * 1024,
): Promise<string> {
  let composer = await findUsableComposer(page, selectors.composer, 15000);
  if (!composer) throw new NovaError('Champ de saisie du fournisseur introuvable.', 'BROWSER_SELECTOR_MISMATCH');

  const assistant = selectors.assistantMessage ? page.locator(selectors.assistantMessage) : undefined;
  const beforeCount = assistant ? await assistant.count() : 0;
  const beforeText = assistant && beforeCount ? (await assistant.last().innerText().catch(() => '')).trim() : '';
  const beforeMainText = await page.locator('main').innerText().catch(() => '');
  const beforeProtocol = extractProtocolResponse(beforeMainText);
  let filled = false;
  for (let attempt = 0; attempt < 3 && !filled; attempt += 1) {
    try {
      await composer.fill(message, { timeout: 5000 });
      filled = true;
    } catch {
      const refreshed = await findUsableComposer(page, selectors.composer, 3000);
      if (!refreshed) break;
      try {
        await refreshed.fill(message, { timeout: 5000 });
        filled = true;
      } catch { /* Reacquire once more after the next UI render. */ }
    }
  }
  if (!filled) throw new NovaError('Le champ de saisie a changé pendant son activation. Aucun message envoyé.', 'BROWSER_SELECTOR_MISMATCH');
  let submitted = false;
  let lastSendError: unknown;
  for (let attempt = 1; attempt <= 3 && !submitted; attempt += 1) {
    try {
      const send = await findFirstVisible(page, selectors.sendButton);
      if (send) await send.click({ timeout: 10000 });
      else await composer.press('Enter', { timeout: 10000 });
      submitted = true;
    } catch (error) {
      lastSendError = error;
      const currentComposer = await findUsableComposer(page, selectors.composer, 2000).catch(() => undefined);
      const composerText = currentComposer
        ? await currentComposer.inputValue().catch(() => currentComposer.innerText().catch(() => ''))
        : '';
      const stop = await findFirstVisible(page, selectors.stopButton).catch(() => undefined);
      const assistantStarted = assistant ? (await assistant.count().catch(() => beforeCount)) > beforeCount : false;
      // A click can time out after the provider accepted it. Never resend once the composer cleared or a reply started.
      if (!composerText || !composerText.trim() || !composerText.includes(message) || stop || assistantStarted) {
        submitted = true;
        break;
      }
      if (attempt < 3) {
        console.log(`retrying send ${attempt + 1}/3…`);
        await page.waitForTimeout(attempt * 800);
        const refreshed = await findUsableComposer(page, selectors.composer, 3000);
        if (refreshed) composer = refreshed;
      }
    }
  }
  if (!submitted) {
    throw new NovaError(`Le clic d’envoi a échoué après 3 tentatives ; le message est resté dans le champ. ${lastSendError instanceof Error ? lastSendError.message : ''}`, 'BROWSER_SEND_FAILED', { cause: lastSendError });
  }

  const deadline = Date.now() + timeoutMs;
  let responseStarted = false;
  let previous = '';
  let stableCount = 0;

  while (Date.now() < deadline) {
    const count = assistant ? await assistant.count() : 0;
    const assistantText = assistant && count ? (await assistant.last().innerText({ timeout: 1000 }).catch(() => '')).trim() : '';
    const mainText = await page.locator('main').innerText({ timeout: 1000 }).catch(() => '');
    const protocolText = extractProtocolResponse(mainText);
    const newMessageProtocol = mainText.startsWith(beforeMainText)
      ? extractProtocolResponse(mainText.slice(beforeMainText.length))
      : '';
    const assistantChanged = Boolean(assistantText && assistantText !== beforeText);
    const protocolChanged = Boolean(protocolText && protocolText !== beforeProtocol);
    const text = assistantChanged ? assistantText : newMessageProtocol || (protocolChanged ? protocolText : '');
    responseStarted ||= count > beforeCount || assistantChanged || protocolChanged || Boolean(newMessageProtocol);
    const stop = await findFirstVisible(page, selectors.stopButton);

    if (responseStarted && text && text === previous && !stop) stableCount += 1;
    else stableCount = 0;

    if (text && stableCount >= 2) {
      if (Buffer.byteLength(text, 'utf8') > maxResponseBytes) {
        throw new NovaError(`Réponse du fournisseur trop volumineuse (limite ${maxResponseBytes} octets).`, 'AI_RESPONSE_TOO_LARGE');
      }
      return text;
    }

    previous = text;
    await page.waitForTimeout(700);
  }

  if (!responseStarted) {
    throw new NovaError('Le message a été envoyé, mais aucune nouvelle réponse détectable n’est apparue. Vérifie Edge avant toute nouvelle tentative.', 'BROWSER_RESPONSE_TIMEOUT');
  }
  throw new NovaError('La réponse ChatGPT semble tronquée ou la génération n’a pas pris fin.', 'BROWSER_RESPONSE_TRUNCATED');
}
