import { describe, expect, it } from 'vitest';
import { MockProvider } from '../src/ai/providers/mock/provider.js';

describe('MockProvider', () => {
  it('returns explicit deterministic DONE when no script is configured', async () => {
    const provider = new MockProvider();
    const response = await provider.send({ taskId: 't1', message: 'diagnostic', projectContext: '' });
    expect(response.status).toBe('DONE');
    expect(response.reason).toContain('MockProvider');
    expect(provider.requests).toHaveLength(1);
    await provider.close();
  });

  it('can replay scripted protocol responses in tests', async () => {
    const provider = new MockProvider([
      { protocol: 'nova-agent/1', status: 'NEED_INFO', question: 'Which environment?' },
      { protocol: 'nova-agent/1', status: 'DONE', reason: 'Explained.' },
    ]);
    expect((await provider.send({ taskId: 't1', message: 'first', projectContext: '' })).status).toBe('NEED_INFO');
    expect((await provider.send({ taskId: 't1', message: 'second', projectContext: '' })).status).toBe('DONE');
  });
});
