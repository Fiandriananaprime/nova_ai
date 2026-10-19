export interface WebProviderSelectors {
  composer: string[];
  sendButton: string[];
  stopButton: string[];
  assistantMessage?: string;
  userMessage?: string;
}

export const CLAUDE_SELECTORS: WebProviderSelectors = {
  composer: [
    'div[contenteditable="true"][data-placeholder]',
    'div.ProseMirror[contenteditable="true"]',
    '[contenteditable="true"][role="textbox"]',
    'textarea[placeholder]',
    '[contenteditable="true"]',
  ],
  sendButton: [
    'button[aria-label*="Send message"]',
    'button[aria-label*="Send"]',
    'button[aria-label*="Envoyer"]',
    'button[type="submit"]',
  ],
  stopButton: [
    'button[aria-label*="Stop"]',
    'button[aria-label*="Arrêter"]',
    'button[data-testid*="stop"]',
  ],
};

export const GEMINI_SELECTORS: WebProviderSelectors = {
  composer: [
    'rich-textarea [contenteditable="true"]',
    '.ql-editor[contenteditable="true"]',
    '[contenteditable="true"][role="textbox"]',
    'textarea[placeholder]',
    '[contenteditable="true"]',
  ],
  sendButton: [
    'button[aria-label*="Send"]',
    'button[aria-label*="Envoyer"]',
    'button[type="submit"]',
  ],
  stopButton: [
    'button[aria-label*="Stop"]',
    'button[aria-label*="Arrêter"]',
    'button[data-testid*="stop"]',
  ],
};
