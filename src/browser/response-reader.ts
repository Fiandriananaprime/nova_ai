import type { Page } from 'playwright';
import type { Locator } from 'playwright';
import { CHATGPT_SELECTORS } from './selectors/chatgpt.js';
import { findFirstVisible, findUsableComposer } from './page-inspector.js';
import { NovaError } from '../utils/errors.js';
import type { WebProviderSelectors } from './selectors/web-providers.js';

const STATUSES = new Set(['NEED_FILES', 'FILE_RECEIVED', 'TRANSFER_STOP', 'NEED_INFO', 'RUN_COMMAND', 'PATCH_READY', 'DONE']);

async function throwIfAborted(page: Page, selectors: WebProviderSelectors, signal?: AbortSignal): Promise<void> {
  if (!signal?.aborted) return;
  const stop = await findFirstVisible(page, selectors.stopButton).catch(() => undefined);
  if (stop) await stop.click({ timeout: 1500 }).catch(() => undefined);
  throw new NovaError('La tâche a été arrêtée depuis Nova Desktop.', 'SESSION_CANCELLED');
}

function extractProtocolResponse(text: string, expectedMessageId?: string): string {
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
            && 'status' in value && typeof value.status === 'string' && STATUSES.has(value.status)
            && (!expectedMessageId || 'acknowledgedMessageId' in value && value.acknowledgedMessageId === expectedMessageId)) return candidate;
        } catch { /* Try an earlier protocol key in the conversation text. */ }
        break;
      }
    }
    searchFrom = protocolKey - 1;
  }
  return '';
}

function extractAcknowledgedMessageId(text: string): string | undefined {
  const response = extractProtocolResponse(text);
  if (!response) return undefined;
  try {
    const value: unknown = JSON.parse(response);
    return typeof value === 'object' && value !== null && 'acknowledgedMessageId' in value
      && typeof value.acknowledgedMessageId === 'string' ? value.acknowledgedMessageId : undefined;
  } catch { return undefined; }
}

async function readAssistantResponseText(
  page: Page,
  assistant: Locator | undefined,
  beforeAssistantCount: number,
): Promise<string> {
  if (assistant) {
    const count = await assistant.count().catch(() => beforeAssistantCount);
    if (count > beforeAssistantCount) {
      const latest = await assistant.last().innerText({ timeout: 1000 }).catch(() => '');
      if (latest.trim()) return latest;
    }
  }

  // Some providers render assistant turns outside their main landmark. Their
  // response selectors can be added without changing the send/read protocol.
  const mainText = await page.locator('main').innerText({ timeout: 1000 }).catch(() => '');
  if (mainText.trim()) return mainText;
  return page.locator('body').innerText({ timeout: 1000 }).catch(() => '');
}

export async function sendAndReadLastAssistant(
  page: Page,
  message: string,
  expectedMessageId: string,
  selectors: WebProviderSelectors = CHATGPT_SELECTORS,
  timeoutMs = 120000,
  maxResponseBytes = 2 * 1024 * 1024,
  signal?: AbortSignal,
): Promise<string> {
  await throwIfAborted(page, selectors, signal);
  let composer = await findUsableComposer(page, selectors.composer, 15000);
  if (!composer) throw new NovaError('Champ de saisie du fournisseur introuvable.', 'BROWSER_SELECTOR_MISMATCH');

  // A resumed session may reconnect while the provider is still answering the
  // previous request. Drain that generation before taking the response baseline.
  const readyDeadline = Date.now() + timeoutMs;
  while (await findFirstVisible(page, selectors.stopButton)) {
    await throwIfAborted(page, selectors, signal);
    if (Date.now() >= readyDeadline) {
      throw new NovaError('Une réponse précédente est toujours en cours. Aucun nouveau message n’a été envoyé.', 'BROWSER_RESPONSE_TIMEOUT');
    }
    await page.waitForTimeout(500);
  }

  const assistant = selectors.assistantMessage ? page.locator(selectors.assistantMessage) : undefined;
  const beforeAssistantCount = assistant ? await assistant.count() : 0;
  const userMessages = selectors.userMessage ? page.locator(selectors.userMessage) : undefined;
  const beforeUserCount = userMessages ? await userMessages.count() : 0;
  const beforeMainText = await page.locator('main').innerText().catch(() => '');
  const beforeAcknowledgedMessageId = extractAcknowledgedMessageId(beforeMainText);
  let filled = false;
  for (let attempt = 0; attempt < 3 && !filled; attempt += 1) {
    try {
      await composer.fill(message, { timeout: 15000 });
      filled = true;
    } catch {
      const refreshed = await findUsableComposer(page, selectors.composer, 3000);
      if (!refreshed) break;
      try {
        await refreshed.fill(message, { timeout: 15000 });
        filled = true;
      } catch { /* Reacquire once more after the next UI render. */ }
    }
  }
  if (!filled) throw new NovaError('Le champ de saisie a changé pendant son activation. Aucun message envoyé.', 'BROWSER_SELECTOR_MISMATCH');
  let submitted = false;
  let lastSendError: unknown;
  for (let attempt = 1; attempt <= 3 && !submitted; attempt += 1) {
    await throwIfAborted(page, selectors, signal);
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
      const assistantStarted = assistant ? (await assistant.count().catch(() => beforeAssistantCount)) > beforeAssistantCount : false;
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

  const sendDeadline = Date.now() + timeoutMs;
  let messageSent = false;
  while (Date.now() < sendDeadline) {
    await throwIfAborted(page, selectors, signal);
    const currentComposer = await findUsableComposer(page, selectors.composer, 1000).catch(() => undefined);
    if (currentComposer) composer = currentComposer;
    const composerText = currentComposer
      ? await currentComposer.inputValue().catch(() => currentComposer.innerText().catch(() => ''))
      : undefined;
    const messageAddedToHistory = userMessages
      ? await userMessages.count().catch(() => beforeUserCount) > beforeUserCount
      : false;
    const latestUserMessage = messageAddedToHistory
      ? await userMessages!.last().innerText().catch(() => '')
      : '';
    const mainText = await page.locator('main').innerText().catch(() => '');
    const outgoingMessageVisible = latestUserMessage.includes(expectedMessageId)
      || mainText.includes(expectedMessageId) && !beforeMainText.includes(expectedMessageId);
    const generationStarted = Boolean(await findFirstVisible(page, selectors.stopButton));
    const composerCleared = composerText !== undefined && !composerText.trim();
    messageSent = outgoingMessageVisible && (composerCleared || generationStarted);
    if (messageSent) break;
    await page.waitForTimeout(250);
  }
  if (!messageSent) {
    throw new NovaError('Le fournisseur n’a pas confirmé l’envoi : le champ contient encore le message et aucune génération n’a commencé.', 'BROWSER_SEND_FAILED');
  }

  const deadline = Date.now() + timeoutMs;
  let responseStarted = false;
  let unacknowledgedMessageId: string | undefined;
  let previous = '';
  let stableCount = 0;

  while (Date.now() < deadline) {
    await throwIfAborted(page, selectors, signal);
    const responseText = await readAssistantResponseText(page, assistant, beforeAssistantCount);
    const protocolText = extractProtocolResponse(responseText, expectedMessageId);
    if (!protocolText) {
      const latestAcknowledgedMessageId = extractAcknowledgedMessageId(responseText);
      if (latestAcknowledgedMessageId && latestAcknowledgedMessageId !== beforeAcknowledgedMessageId) {
        unacknowledgedMessageId = latestAcknowledgedMessageId;
      }
    }
    const text = protocolText;
    responseStarted ||= Boolean(text);
    const stop = await findFirstVisible(page, selectors.stopButton);
    if (unacknowledgedMessageId && !stop) {
      throw new NovaError(`Accuse de message invalide : Nova attendait ${expectedMessageId}, mais le fournisseur a repondu pour ${unacknowledgedMessageId}.`, 'AI_MESSAGE_ACK_INVALID');
    }

    if (responseStarted && text && text === previous && !stop) stableCount += 1;
    else stableCount = 0;

    if (text && stableCount >= 2 && !stop) {
      if (Buffer.byteLength(text, 'utf8') > maxResponseBytes) {
        throw new NovaError(`Réponse du fournisseur trop volumineuse (limite ${maxResponseBytes} octets).`, 'AI_RESPONSE_TOO_LARGE');
      }
      return text;
    }

    previous = text;
    await page.waitForTimeout(700);
  }

  if (!responseStarted) {
    if (unacknowledgedMessageId) {
      throw new NovaError(`Accuse de message invalide : Nova attendait ${expectedMessageId}, mais le fournisseur a repondu pour ${unacknowledgedMessageId}.`, 'AI_MESSAGE_ACK_INVALID');
    }
    throw new NovaError('Le message a été envoyé, mais aucune nouvelle réponse détectable n’est apparue. Vérifie Edge avant toute nouvelle tentative.', 'BROWSER_RESPONSE_TIMEOUT');
  }
  throw new NovaError('La réponse ChatGPT semble tronquée ou la génération n’a pas pris fin.', 'BROWSER_RESPONSE_TRUNCATED');
}
