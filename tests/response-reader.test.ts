import { describe, expect, it } from 'vitest';
import { extractProtocolResponse, extractProtocolResponseAfterOutgoingMessage, selectResponseCandidates } from '../src/browser/response-reader.js';

const reply = (extra: Record<string, unknown> = {}, id = 'msg-2') => JSON.stringify({
  protocol: 'nova-agent/1', status: 'DONE', acknowledgedMessageId: id, ...extra,
});

describe('extractProtocolResponse', () => {
  it('returns the reply for the expected message id and ignores a stale one', () => {
    const page = `${reply({}, 'msg-1')}\n---\n${reply({}, 'msg-2')}`;
    expect(JSON.parse(extractProtocolResponse(page, 'msg-2')).acknowledgedMessageId).toBe('msg-2');
    expect(extractProtocolResponse(reply({}, 'msg-1'), 'msg-2')).toBe('');
  });

  it('searches only the assistant messages after the outgoing message and accepts the matching ID', () => {
    const staleReply = reply({}, 'msg-1');
    const currentReply = reply({ summary: 'current response' }, 'msg-2');
    const result = extractProtocolResponseAfterOutgoingMessage(
      [staleReply, 'The assistant is still generating…', currentReply],
      'msg-2',
    );

    expect(JSON.parse(result).acknowledgedMessageId).toBe('msg-2');
    expect(extractProtocolResponseAfterOutgoingMessage([staleReply], 'msg-2')).toBe('');
  });

  it('extracts the current response from a following conversation turn when assistant selectors miss it', () => {
    const renderedTurn = 'Réponse:\\n' + reply({ summary: 'current turn' }, 'msg-2');
    const result = extractProtocolResponseAfterOutgoingMessage([renderedTurn], 'msg-2');

    expect(JSON.parse(result).acknowledgedMessageId).toBe('msg-2');
    expect(JSON.parse(result).summary).toBe('current turn');
  });

  it('never invokes unanchored page fallback after the outgoing message is located', async () => {
    const fallback = async () => ['{"protocol":"nova-agent/1","status":"FILE_RECEIVED","acknowledgedMessageId":"msg-2","patch":"<unified git patch>"}'];
    const result = await selectResponseCandidates(true, [], fallback);

    expect(result).toEqual([]);
  });

  it('finds the reply when "protocol" is not the first key and nested objects come before it', () => {
    const json = JSON.stringify({ message: 'ok', files: [{ path: 'a.ts', note: 'x' }], status: 'NEED_FILES', protocol: 'nova-agent/1', acknowledgedMessageId: 'msg-2' });
    expect(extractProtocolResponse(`Voici :\n${json}\nFin`, 'msg-2')).toBe(json);
  });

  it('ignores braces inside strings and surrounding prose', () => {
    const json = reply({ message: 'function f() { return "}"; }' });
    expect(extractProtocolResponse(`Texte avec { accolade\n${json}`, 'msg-2')).toBe(json);
  });

  it('returns nothing for a truncated reply still being streamed', () => {
    const json = reply({ message: 'long' });
    expect(extractProtocolResponse(json.slice(0, -5), 'msg-2')).toBe('');
  });

  it('does not loop forever when the text starts with the protocol key', () => {
    expect(extractProtocolResponse('"protocol" oops', 'msg-2')).toBe('');
  });
});
