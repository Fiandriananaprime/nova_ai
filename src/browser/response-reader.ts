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

const STABLE_POLLS_WITH_STOP_VISIBLE = 6;
const STABLE_POLLS_FOR_WRONG_ACK = 4;
const STABLE_POLLS_INVALID_REPLY_WITHOUT_STOP = 8;
const STABLE_POLLS_INVALID_REPLY_WITH_STOP = 12;
const MAX_ASSISTANT_NODES_READ = 5;
const MAX_OBJECT_START_CANDIDATES = 40;

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
      && 'protocol' in value && (value.protocol === 'nova-agent/1' || value.protocol === 'nova-agent/v1')
      && 'status' in value && typeof value.status === 'string' && STATUSES.has(value.status)) return value as Record<string, unknown>;
  } catch {}
  return undefined;
}

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
        if (value && (!expectedMessageId || value.acknowledgedMessageId === expectedMessageId)) {
          if (value.protocol === 'nova-agent/v1') return JSON.stringify({ ...value, protocol: 'nova-agent/1' });
          return object.json;
        }
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


export async function selectResponseCandidates(
  userMessageFound: boolean,
  anchoredCandidates: string[],
  readFallbackCandidates: () => Promise<string[]>,
): Promise<string[]> {
  if (userMessageFound) return anchoredCandidates;
  return readFallbackCandidates();
}

export function isCredibleInvalidReplyCandidate(text: string, hasDedicatedAssistantNode: boolean): boolean {
  return hasDedicatedAssistantNode && Boolean(text.trim());
}


interface AnchoredResponseSnapshot {
  userMessageFound: boolean;
  assistantTexts: string[];
  protocolTexts: string[];
  responseTurnTexts: string[];
  followingTurnTexts: string[];
}

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
    const maxAssistantNodesRead = 5;
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

    if (!outgoing) {
      const genericMatches = Array.from(root.querySelectorAll('*')).filter((element) => {
        if (element.matches('input, textarea, [contenteditable="true"]')) return false;
        const html = element as HTMLElement;
        return html.getClientRects().length > 0 && textOf(element).includes(options.expectedMessageId);
      });
      genericMatches.sort((left, right) => textOf(left).length - textOf(right).length);
      outgoing = genericMatches[0];
    }
    if (!outgoing) return { userMessageFound: false, assistantTexts: [], protocolTexts: [], responseTurnTexts: [], followingTurnTexts: [] };

    const outgoingRect = outgoing.getBoundingClientRect();
    const outgoingHasRect = outgoing.getClientRects().length > 0;
    const followsOutgoingMessage = (element: Element): boolean => {
      if (element === outgoing || outgoing!.contains(element) || element.contains(outgoing!)) return false;
      const position = outgoing!.compareDocumentPosition(element);
      const followsInDom = Boolean(position & Node.DOCUMENT_POSITION_FOLLOWING)
        && !Boolean(position & Node.DOCUMENT_POSITION_CONTAINED_BY);
      const candidateHasRect = element.getClientRects().length > 0;
      if (followsInDom) return true;
      if (outgoingHasRect && candidateHasRect) {
        const candidateRect = element.getBoundingClientRect();
        return candidateRect.top >= outgoingRect.bottom - 12;
      }
      return false;
    };
    const dedicatedAssistantNodes = queryNodes([
      ...options.assistantSelectors,
      '[data-message-author-role="assistant"]',
      '[data-message-author-role="model"]',
    ]).filter(followsOutgoingMessage);

    const keepOutermostNodes = (nodes: Element[]): Element[] =>
      nodes.filter((node) =>
        !nodes.some((other) => other !== node && other.contains(node)),
      );

    const dedicatedMessages = keepOutermostNodes(dedicatedAssistantNodes);

    const fallbackNodes = dedicatedMessages.length > 0
      ? []
      : queryNodes([
          'model-response',
          '[data-testid*="assistant"]',
          '[data-testid*="response"]',
          '[data-is-streaming]',
          '.markdown',
        ]).filter(followsOutgoingMessage);

    const assistantNodes = dedicatedMessages.length > 0
      ? dedicatedMessages
      : keepOutermostNodes(fallbackNodes);

    const assistantTexts = assistantNodes
      .map(textOf)
      .filter(Boolean)
      .slice(-maxAssistantNodesRead);

    let responseTurnTexts: string[] = [];
    let followingTurnTexts: string[] = [];
    const turnSelector = '[data-testid^="conversation-turn-"], [data-testid*="conversation-turn"]';
    const conversationTurns = queryNodes([turnSelector])
      .sort((left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top);
    const outgoingConversationTurn = conversationTurns
      .filter((turn) => turn === outgoing || turn.contains(outgoing))
      .sort((left, right) => textOf(left).length - textOf(right).length)[0];
    const outgoingTurn = outgoingConversationTurn
      ?? outgoing!.closest(turnSelector)
      ?? outgoing!.closest('article')
      ?? outgoing!.closest('[data-message-id]')
      ?? outgoing!;
    const nextConversationTurns = outgoingConversationTurn
      ? conversationTurns.filter((turn) => turn !== outgoingTurn && followsOutgoingMessage(turn)).slice(0, 6)
      : [];
    for (const turn of nextConversationTurns) {
      if (options.userSelectors.length && (turn.matches(options.userSelectors.join(',')) || turn.querySelector(options.userSelectors.join(',')))) break;
      const value = textOf(turn);
      if (value && !turn.querySelector('textarea, input, [contenteditable="true"]')) {
        responseTurnTexts.push(value);
        followingTurnTexts.push(value);
      }
    }
    if (!followingTurnTexts.length) {
      const parent = outgoingTurn.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children)
          .filter((sibling) => sibling !== outgoingTurn && followsOutgoingMessage(sibling))
          .sort((left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top)
          .slice(0, 6);
        for (const sibling of siblings) {
          if (options.userSelectors.length && (sibling.matches(options.userSelectors.join(',')) || sibling.querySelector(options.userSelectors.join(',')))) break;
          const value = textOf(sibling);
          if (value && !sibling.querySelector('textarea, input, [contenteditable="true"]')) {
            followingTurnTexts.push(value);
            const trustedTurn = sibling.matches('article, [role="article"], [data-message-id], [data-message-author-role="assistant"], [data-testid*="conversation-turn"], [data-testid*="assistant"]');
            if (trustedTurn) responseTurnTexts.push(value);
          }
        }
      }
    }

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

    return { userMessageFound: true, assistantTexts, protocolTexts, responseTurnTexts, followingTurnTexts };
  }, { userSelectors, assistantSelectors, expectedMessageId });
}

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
      } catch {}
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
        responseTurnsAfterAnchor: anchored.responseTurnTexts.length,
        followingTurnsAfterAnchor: anchored.followingTurnTexts.length,
      });
      anchorLogged = true;
    }

    const anchoredCandidates = [
      ...anchored.assistantTexts.slice().reverse(),
      ...anchored.protocolTexts.slice().reverse(),
      ...anchored.followingTurnTexts.slice().reverse(),
    ];
    const candidates = await selectResponseCandidates(
      anchored.userMessageFound,
      anchoredCandidates,
      () => readResponseCandidates(page, assistant, beforeAssistantCount),
    );
    const latestAssistantText = anchored.userMessageFound
      ? anchored.assistantTexts.at(-1) ?? anchored.protocolTexts.at(-1) ?? anchored.responseTurnTexts.at(-1) ?? ''
      : assistant
        ? await assistant.last().innerText({ timeout: 1000 }).catch(() => '')
        : '';
    const latestCandidateText = anchored.userMessageFound
      ? anchored.assistantTexts.at(-1) ?? anchored.protocolTexts.at(-1) ?? anchored.responseTurnTexts.at(-1) ?? anchored.followingTurnTexts.at(-1) ?? ''
      : latestAssistantText;
    const candidateChanged = Boolean(latestCandidateText.trim())
      && latestCandidateText !== beforeLatestAssistantText;
    const assistantReplyChanged = Boolean(latestAssistantText.trim())
      && latestAssistantText !== beforeLatestAssistantText;
    const hasDedicatedAssistantNode = Boolean(anchored.assistantTexts.at(-1)?.trim() || anchored.protocolTexts.at(-1)?.trim() || anchored.responseTurnTexts.at(-1)?.trim() || latestAssistantText.trim());
    const credibleInvalidReply = isCredibleInvalidReplyCandidate(latestAssistantText, hasDedicatedAssistantNode);
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
    if (!text && candidateChanged) {
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

    if (!text && assistantReplyChanged && credibleInvalidReply) {
      if (latestAssistantText === previousInvalidReply) stableInvalidReplyCount += 1;
      else {
        previousInvalidReply = latestAssistantText;
        stableInvalidReplyCount = 1;
      }
      const requiredStablePolls = stop
        ? STABLE_POLLS_INVALID_REPLY_WITH_STOP
        : STABLE_POLLS_INVALID_REPLY_WITHOUT_STOP;
      if (stableInvalidReplyCount >= requiredStablePolls) {
        trace('browser.assistant.invalid_reply_stable', {
          expectedMessageId,
          stableInvalidReplyCount,
          stopVisible: stop,
          replyCharacters: latestAssistantText.length,
          candidateSource: anchored.userMessageFound && !hasDedicatedAssistantNode ? 'generic-following-turn-only' : 'assistant-node',
        });
        throw new NovaError('Réponse incompatible avec nova-agent/1 : une réponse assistant est apparue, mais aucun objet JSON de protocole valide ne correspond à la demande.', 'AI_PROTOCOL_INVALID');
      }
    } else {
      previousInvalidReply = '';
      stableInvalidReplyCount = 0;
    }

    const signature = `${candidates.map((candidate) => candidate.length).join(',')}:${candidates.join('').slice(-4000)}:${text.length}:${stop}`;
    if (signature !== lastSignature) lastActivity = Date.now();
    lastSignature = signature;

    if (text && text === previous) stableCount += 1;
    else stableCount = 0;

    if (text && (stableCount >= 2 && !stop || stableCount >= STABLE_POLLS_WITH_STOP_VISIBLE)) {
      if (Buffer.byteLength(text, 'utf8') > maxResponseBytes) {
        throw new NovaError(`Réponse du fournisseur trop volumineuse (limite ${maxResponseBytes} octets).`, 'AI_RESPONSE_TOO_LARGE');
      }
      trace('browser.assistant.protocol_selected', { expectedMessageId, responseBytes: Buffer.byteLength(text, 'utf8'), stableCount, stopVisible: stop });
      return text;
    }

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
  trace('browser.assistant.response_truncated', { expectedMessageId, previousResponseBytes: Buffer.byteLength(previous, 'utf8') });
  throw new NovaError('La réponse ChatGPT semble tronquée ou la génération n’a pas pris fin.', 'BROWSER_RESPONSE_TRUNCATED');
}
