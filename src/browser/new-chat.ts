import { EdgeSession } from './session.js';

const PROVIDER_NEW_CHAT_URLS: Record<string, string> = {
  'chatgpt-web': 'https://chatgpt.com/',
  'claude-web': 'https://claude.ai/new',
  'gemini-web': 'https://gemini.google.com/app',
};

export async function navigateToNewProviderChat(
  providerId: string,
  channel = 'msedge',
  timeoutMs = 120000,
): Promise<string | undefined> {
  const url = PROVIDER_NEW_CHAT_URLS[providerId];
  if (!url) return undefined;

  const session = new EdgeSession(channel, timeoutMs);
  try {
    const page = await session.openProvider(url);
    if (page.url() !== url) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    return page.url();
  } finally {
    await session.close(false);
  }
}
