export const CHATGPT_SELECTORS = {
  composer: [
    '#prompt-textarea',
    '[data-testid="composer-text-input"]',
    '[data-testid="prompt-textarea"]',
    'textarea[placeholder]',
    '[contenteditable="true"][data-placeholder]',
    '[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"]',
  ],
  sendButton: ['button[data-testid="send-button"]', 'button[data-testid="composer-submit-button"]', 'button[aria-label*="Send"]', 'button[aria-label*="Envoyer"]'],
  stopButton: ['button[data-testid="stop-button"]', 'button[aria-label*="Stop generating"]', 'button[aria-label*="Arrêter la génération"]'],
  assistantMessage: '[data-message-author-role="assistant"]',
  userMessage: '[data-message-author-role="user"]',
};
