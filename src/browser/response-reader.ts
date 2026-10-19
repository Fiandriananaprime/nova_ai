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

/** Consecutive identical polls (~700 ms each) after which a valid reply is accepted even if the stop button never disappears. */
const STABLE_POLLS_WITH_STOP_VISIBLE = 6;
/** Consecutive polls showing a reply for another message id before failing fast instead of waiting for the timeout. */
const STABLE_POLLS_FOR_WRONG_ACK = 4;
/** Max assistant nodes read per poll, newest first, to keep each poll cheap. */
const MAX_ASSISTANT_NODES_READ = 5;
/** Max `{` positions tried before one `"protocol"` key (the key is not always the first one in the object). */
const MAX_OBJECT_START_CANDIDATES = 40;

/** Returns the balanced `{…}` object starting at `start` and the index just after it, ignoring braces inside strings. */
function readBalancedObject(text: string, start: number): { json: string; end: number } | undefined {
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
    else if (char === '}' && --depth === 0) return { json: text.slice(start, index + 1), end: index + 1 };
  }
  return undefined;
}

function parseProtocolObject(json: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)
      && 'protocol' in value && value.protocol === 'nova-agent/1'
      && 'status' in value && typeof value.status === 'string' && STATUSES.has(value.status)) return value as Record<string, unknown>;
  } catch { /* Not a complete protocol object; the caller tries another candidate. */ }
  return undefined;
}

/**
 * Finds the latest complete nova-agent/1 object in rendered page text.
 * Walks back from each `"protocol"` key over every enclosing `{`, so the reply is found
 * even when `protocol` is not the first key or nested objects precede it.
 */
export function extractProtocolResponse(text: string, expectedMessageId?: string): string {
  let searchFrom = text.length;
  while (searchFrom >= 0) {
    const protocolKey = text.lastIndexOf('"protocol"', searchFrom);
    if (protocolKey < 0) return '';
    let start = text.lastIndexOf('{', protocolKey);
    for (let tries = 0; start >= 0 && tries < MAX_OBJECT_START_CANDIDATES; tries += 1) {
      const object = readBalancedObject(text, start);
      if (object && object.end > protocolKey) {
        const value = parseProtocolObject(object.json);
        if (value && (!expectedMessageId || value.acknowledgedMessageId === expectedMessageId)) return object.json;
      }
      start = start === 0 ? -1 : text.lastIndexOf('{', start - 1);
    }
    if (protocolKey === 0) return '';
    searchFrom = protocolKey - 1;
  }
  return '';
}

function extractAcknowledgedMessageId(text: string): string | undefined {
  const response = extractProtocolResponse(text);
  if (!response) return undefined;
  const value = parseProtocolObject(response);
  return typeof value?.acknowledgedMessageId === 'string' ? value.acknowledgedMessageId : undefined;
}

async function readPageText(page: Page, timeout?: number): Promise<string> {
  const main = await page.locator('main').innerText(timeout ? { timeout } : undefined).catch(() => '');
  if (main.trim()) return main;
  return page.locator('body').innerText(timeout ? { timeout } : undefined).catch(() => '');
}

/**
 * Read newly added assistant nodes, then the latest assistant node for virtualised chat
 * lists. Never scrape the whole page: it contains the outgoing prompt and protocol examples.
 */
async function readResponseCandidates(
  page: Page,
  assistant: Locator | undefined,
  beforeAssistantCount: number,
): Promise<string[]> {
  const candidates: string[] = [];
  if (assistant) {
    const count = await assistant.count().catch(() => beforeAssistantCount);
    if (count > beforeAssistantCount) {
      const parts: string[] = [];
      for (let index = Math.max(beforeAssistantCount, count - MAX_ASSISTANT_NODES_READ); index < count; index += 1) {
        parts.push(await assistant.nth(index).innerText({ timeout: 1000 }).catch(() => ''));
      }
      const joined = parts.join('\n').trim();
      if (joined) candidates.push(joined);
    }
    if (count > 0) {
      const latest = await assistant.last().innerText({ timeout: 1000 }).catch(() => '');
      if (latest.trim()) candidates.push(latest);
    }
  }
  return candidates;
}


/** Do not use unanchored fallback text once the current outgoing user message was found. */
export async function selectResponseCandidates(
  userMessageFound: boolean,
  anchoredCandidates: string[],
  readFallbackCandidates: () => Promise<string[]>,
): Promise<string[]> {
  if (userMessageFound) return anchoredCandidates;
  return readFallbackCandidates();
}


interface AnchoredResponseSnapshot {
  userMessageFound: boolean;
  assistantTexts: string[];
  protocolTexts: string[];
  followingTurnTexts: string[];
}

/**
 * Locate the exact outgoing user message by its message ID, then read only assistant
 * nodes that follow it in DOM order. This prevents a previous assistant turn from
 * being mistaken for the answer to the current request.
 */
async function readAssistantMessagesAfterOutgoingMessage(
  page: Page,
  selectors: WebProviderSelectors,
  expectedMessageId: string,
): Promise<AnchoredResponseSnapshot> {
  const userSelectors = selectors.userMessage
    ? Array.isArray(selectors.userMessage) ? selectors.userMessage : [selectors.userMessage]
    : [];
  const assistantSelectors = selectors.assistantMessage
    ? Array.isArray(selectors.assistantMessage) ? selectors.assistantMessage : [selectors.assistantMessage]
    : [];

  return page.locator('body').evaluate((body, options) => {
    const main = body.querySelector('main');
    const root = main ?? body;
    const scopes: ParentNode[] = root === body ? [body] : [root, body];
    const textOf = (element: Element): string => {
      const html = element as HTMLElement;
      return (html.innerText || element.textContent || '').trim();
    };
    const queryNodes = (items: string[]): Element[] => {
      const found = new Set<Element>();
      for (const scope of scopes) {
        for (const selector of items) {
          try {
            scope.querySelectorAll(selector).forEach((element) => found.add(element));
          } catch {
            // One provider selector can become invalid after a UI update; try the rest.
          }
        }
      }
      return Array.from(found).sort((left, right) => {
        if (left === right) return 0;
        const position = left.compareDocumentPosition(right);
        if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
        if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
        return 0;
      });
    };
    const userNodes = queryNodes(options.userSelectors);
    let outgoing = userNodes.filter((element) => textOf(element).includes(options.expectedMessageId)).at(-1);
    const matchedUserSelector = Boolean(outgoing);

    // Provider selectors are best-effort. If they miss the user bubble, anchor to the
    // smallest rendered element containing the ID sent in this request.
    if (!outgoing) {
      const genericMatches = Array.from(root.querySelectorAll('*')).filter((element) => {
        if (element.matches('input, textarea, [contenteditable="true"]')) return false;
        const html = element as HTMLElement;
        return html.getClientRects().length > 0 && textOf(element).includes(options.expectedMessageId);
      });
      genericMatches.sort((left, right) => textOf(left).length - textOf(right).length);
      outgoing = genericMatches[0];
    }
    if (!outgoing) return { userMessageFound: false, assistantTexts: [], protocolTexts: [], followingTurnTexts: [] };

    const followsOutgoingMessage = (element: Element): boolean => {
      if (element === outgoing || outgoing!.contains(element)) return false;
      const position = outgoing!.compareDocumentPosition(element);
      return Boolean(position & Node.DOCUMENT_POSITION_FOLLOWING)
        && !Boolean(position & Node.DOCUMENT_POSITION_CONTAINED_BY);
    };
    // Provider-specific selectors can be transient (for example, a streaming-only
    // selector disappears as soon as generation finishes). Include semantic and common
    // rendered-response selectors as independent fallbacks.
    const allAssistantSelectors = [
      ...options.assistantSelectors,
      '[data-message-author-role="assistant"]',
      '[data-message-author-role="model"]',
      '[data-is-streaming]',
      'model-response',
      '[data-testid*="assistant"]',
      '[data-testid*="response"]',
      '.markdown',
    ];
    const assistantTexts = queryNodes(allAssistantSelectors)
      .filter(followsOutgoingMessage)
      .map(textOf)
      .filter(Boolean)
      .slice(-12);

    // Also inspect the conversation turn immediately after the anchored user turn.
    // This handles providers whose rendered assistant content has no stable role selector.
    let followingTurnTexts: string[] = [];
    const turnSelector = '[data-testid^="conversation-turn-"], [data-testid*="conversation-turn"]';
    const outgoingTurn = outgoing!.closest(turnSelector)
      ?? outgoing!.closest('article')
      ?? outgoing!.closest('[data-message-id]')
      ?? outgoing!;
    const parent = outgoingTurn.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children);
      const anchorIndex = siblings.indexOf(outgoingTurn);
      for (const sibling of siblings.slice(anchorIndex + 1, anchorIndex + 6)) {
        if (sibling.querySelector(options.userSelectors.join(','))) break;
        const value = textOf(sibling);
        if (value && !sibling.querySelector('textarea, input, [contenteditable="true"]')) {
          followingTurnTexts.push(value);
        }
      }
    }

    // Only scan protocol-bearing nodes after a provider-matched user bubble. A generic
    // fallback anchor can be a descendant of the prompt itself, whose remaining text may
    // contain protocol examples rather than an assistant reply.
    let protocolTexts: string[] = [];
    if (matchedUserSelector) {
      const hasProtocolFields = (element: Element): boolean => {
        const value = textOf(element);
        return value.includes('"protocol"') && value.includes('"acknowledgedMessageId"');
      };
      const protocolNodes = Array.from(root.querySelectorAll('*'))
        .filter(followsOutgoingMessage)
        .filter(hasProtocolFields);
      const leafNodes = protocolNodes.filter((element) =>
        !Array.from(element.children).some((child) => hasProtocolFields(child)));
      protocolTexts = (leafNodes.length ? leafNodes : protocolNodes)
        .map(textOf)
        .filter(Boolean)
        .slice(-12);
    }

    return { userMessageFound: true, assistantTexts, protocolTexts, followingTurnTexts };
  }, { userSelectors, assistantSelectors, expectedMessageId });
}

/** Extract the latest matching protocol object from assistant messages after an outgoing user message. */
export function extractProtocolResponseAfterOutgoingMessage(
  assistantMessagesAfterOutgoingMessage: string[],
  expectedMessageId: string,
): string {
  for (let index = assistantMessagesAfterOutgoingMessage.length - 1; index >= 0; index -= 1) {
    const candidate = assistantMessagesAfterOutgoingMessage[index] ?? '';
    const response = extractProtocolResponse(candidate, expectedMessageId);
    if (response) return response;
  }
  return '';
}

export async function sendAndReadLastAssistant(
  page: Page,
  message: string,
  expectedMessageId: string,
  selectors: WebProviderSelectors = CHATGPT_SELECTORS,
  timeoutMs = 120000,
  maxResponseBytes = 2 * 1024 * 1024,
  signal?: AbortSignal,
  onTrace?: (stage: string, details?: Record<string, unknown>) => void,
): Promise<string> {
  const trace = (stage: string, details: Record<string, unknown> = {}): void => {
    try { onTrace?.(stage, details); }
    catch (error) { console.error(`Échec du trace Nova (${stage}) : ${error instanceof Error ? error.message : String(error)}`); }
  };
  trace('browser.request.start', { expectedMessageId, url: page.url(), messageBytes: Buffer.byteLength(message, 'utf8') });
  await throwIfAborted(page, selectors, signal);
  let composer = await findUsableComposer(page, selectors.composer, 15000);
  if (!composer) throw new NovaError('Champ de saisie du fournisseur introuvable.', 'BROWSER_SELECTOR_MISMATCH');
  trace('browser.composer.ready');

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
  trace('browser.previous_generation.finished');

  const assistant = selectors.assistantMessage ? page.locator(selectors.assistantMessage) : undefined;
  const beforeAssistantCount = assistant ? await assistant.count() : 0;
  const beforeLatestAssistantText = assistant
    ? await assistant.last().innerText({ timeout: 1000 }).catch(() => '')
    : '';
  const userMessages = selectors.userMessage ? page.locator(selectors.userMessage) : undefined;
  const beforeUserCount = userMessages ? await userMessages.count() : 0;
  const beforeMainText = await readPageText(page);
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
  trace('browser.message.filled', { expectedMessageId, messageBytes: Buffer.byteLength(message, 'utf8') });
  let submitted = false;
  let lastSendError: unknown;
  for (let attempt = 1; attempt <= 3 && !submitted; attempt += 1) {
    await throwIfAborted(page, selectors, signal);
    trace('browser.message.submit_attempt', { expectedMessageId, attempt });
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
    const mainText = await readPageText(page);
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
  trace('browser.message.confirmed', { expectedMessageId });

  // The timeout is an inactivity limit: it restarts while the provider is generating or the page is
  // still changing, so long answers are not cut off. A hard cap still bounds the total wait.
  const hardDeadline = Date.now() + Math.max(timeoutMs * 5, 10 * 60 * 1000);
  let lastActivity = Date.now();
  let lastSignature = '';
  let responseStarted = false;
  let unacknowledgedMessageId: string | undefined;
  let wrongAckPolls = 0;
  let previous = '';
  let stableCount = 0;
  let previousInvalidReply = '';
  let stableInvalidReplyCount = 0;
  let anchorLogged = false;

  while (Date.now() < hardDeadline && Date.now() - lastActivity < timeoutMs) {
    await throwIfAborted(page, selectors, signal);
    const anchored = await readAssistantMessagesAfterOutgoingMessage(page, selectors, expectedMessageId);
    if (anchored.userMessageFound && !anchorLogged) {
      trace('browser.message.anchor_found', {
        expectedMessageId,
        assistantMessagesAfterAnchor: anchored.assistantTexts.length,
        protocolCandidatesAfterAnchor: anchored.protocolTexts.length,
        followingTurnsAfterAnchor: anchored.followingTurnTexts.length,
      });
      anchorLogged = true;
    }

    const anchoredCandidates = [
      ...anchored.assistantTexts.slice().reverse(),
      ...anchored.protocolTexts.slice().reverse(),
      ...anchored.followingTurnTexts.slice().reverse(),
    ];
    // Once the outgoing message is located, only inspect nodes after that anchor.
    // Whole-page text can include JSON examples from the user's own prompt.
    const candidates = await selectResponseCandidates(
      anchored.userMessageFound,
      anchoredCandidates,
      () => readResponseCandidates(page, assistant, beforeAssistantCount),
    );
    const latestAssistantText = anchored.userMessageFound
      ? anchored.assistantTexts.at(-1) ?? anchored.protocolTexts.at(-1) ?? anchored.followingTurnTexts.at(-1) ?? ''
      : assistant
        ? await assistant.last().innerText({ timeout: 1000 }).catch(() => '')
        : '';
    const assistantReplyChanged = Boolean(latestAssistantText.trim())
      && latestAssistantText !== beforeLatestAssistantText;
    let text = anchored.userMessageFound
      ? extractProtocolResponseAfterOutgoingMessage(anchored.assistantTexts, expectedMessageId)
        || extractProtocolResponseAfterOutgoingMessage(anchored.protocolTexts, expectedMessageId)
      : '';
    if (!text) {
      for (const candidate of candidates) {
        text = extractProtocolResponse(candidate, expectedMessageId);
        if (text) break;
      }
    }
    let wrongAck: string | undefined;
    if (!text && assistantReplyChanged) {
      const protocolCandidates = anchored.userMessageFound
        ? anchoredCandidates
        : [latestAssistantText];
      for (const candidate of protocolCandidates) {
        const latestProtocolResponse = extractProtocolResponse(candidate);
        if (!latestProtocolResponse) continue;
        const acknowledged = extractAcknowledgedMessageId(latestProtocolResponse);
        if (acknowledged && acknowledged !== expectedMessageId) wrongAck = acknowledged;
        break;
      }
    }
    responseStarted ||= Boolean(text);
    const stop = Boolean(await findFirstVisible(page, selectors.stopButton));

    // A completed assistant turn that changed but contains no protocol object is
    // a protocol violation. Return it to the orchestrator so it can ask the model
    // to correct the same request instead of waiting for the full response timeout.
    if (!text && assistantReplyChanged && !stop) {
      if (latestAssistantText === previousInvalidReply) stableInvalidReplyCount += 1;
      else {
        previousInvalidReply = latestAssistantText;
        stableInvalidReplyCount = 1;
      }
      if (stableInvalidReplyCount >= 3) {
        throw new NovaError('Réponse incompatible avec nova-agent/1 : aucun objet JSON de protocole valide détecté.', 'AI_PROTOCOL_INVALID');
      }
    } else {
      previousInvalidReply = '';
      stableInvalidReplyCount = 0;
    }

    // Track actual rendered content, not merely the stop-button visibility. Some sites
    // leave a stale stop control in the DOM; that must never extend the wait indefinitely.
    const signature = `${candidates.map((candidate) => candidate.length).join(',')}:${candidates.join('').slice(-4000)}:${text.length}:${stop}`;
    if (signature !== lastSignature) lastActivity = Date.now();
    lastSignature = signature;

    // The provider can briefly expose the previous assistant turn after submission.
    // Keep polling for the current request's acknowledgement instead of failing on stale UI text.
    if (text && text === previous) stableCount += 1;
    else stableCount = 0;

    // A complete, valid protocol object for this message is the real end-of-reply signal.
    // The stop button only speeds things up; if its selector is stuck we still accept after a longer stable period.
    if (text && (stableCount >= 2 && !stop || stableCount >= STABLE_POLLS_WITH_STOP_VISIBLE)) {
      if (Buffer.byteLength(text, 'utf8') > maxResponseBytes) {
        throw new NovaError(`Réponse du fournisseur trop volumineuse (limite ${maxResponseBytes} octets).`, 'AI_RESPONSE_TOO_LARGE');
      }
      trace('browser.assistant.protocol_selected', { expectedMessageId, response: text, stableCount, stopVisible: stop });
      return text;
    }

    // The provider answered, but acknowledged another message id: fail now with the precise error.
    wrongAckPolls = wrongAck && wrongAck === unacknowledgedMessageId && !stop ? wrongAckPolls + 1 : 0;
    if (wrongAck) unacknowledgedMessageId = wrongAck;
    if (wrongAckPolls >= STABLE_POLLS_FOR_WRONG_ACK) {
      throw new NovaError(`Accuse de message invalide : Nova attendait ${expectedMessageId}, mais le fournisseur a repondu pour ${unacknowledgedMessageId}.`, 'AI_MESSAGE_ACK_INVALID');
    }

    previous = text;
    await page.waitForTimeout(700);
  }

  if (!responseStarted) {
    if (unacknowledgedMessageId) {
      throw new NovaError(`Accuse de message invalide : Nova attendait ${expectedMessageId}, mais le fournisseur a repondu pour ${unacknowledgedMessageId}.`, 'AI_MESSAGE_ACK_INVALID');
    }
    trace('browser.assistant.response_missing', { expectedMessageId, unacknowledgedMessageId });
    throw new NovaError('Le message a été envoyé, mais aucune nouvelle réponse détectable n’est apparue. Vérifie Edge avant toute nouvelle tentative.', 'BROWSER_RESPONSE_TIMEOUT');
  }
  trace('browser.assistant.response_truncated', { expectedMessageId, previousResponse: previous });
  throw new NovaError('La réponse ChatGPT semble tronquée ou la génération n’a pas pris fin.', 'BROWSER_RESPONSE_TRUNCATED');
}
