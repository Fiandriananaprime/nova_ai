import { describe, expect, it } from 'vitest';
import { parseAIResponse } from '../src/protocol/parser.js';
import { buildProviderMessage } from '../src/protocol/prompts.js';
import { validateRequestedFiles } from '../src/protocol/validator.js';
import { parsePatch } from '../src/patches/parser.js';

const protocol = 'nova-agent/1';

describe('protocol parser', () => {
  it('parses a valid JSON response', () => {
    expect(parseAIResponse(JSON.stringify({ protocol, acknowledgedMessageId: 'msg-1', status: 'DONE', reason: 'No changes needed.' })).status).toBe('DONE');
  });

  it('allows TRANSFER_STOP metadata recovery only as a standalone status', () => {
    const stop = parseAIResponse(JSON.stringify({ protocol, acknowledgedMessageId: 'msg-1', status: 'TRANSFER_STOP', transferReason: 'Enough information.' }));
    expect(stop.status).toBe('TRANSFER_STOP');
    expect(() => parseAIResponse(JSON.stringify({ protocol, acknowledgedMessageId: 'msg-1', status: 'FILE_RECEIVED', nextStatus: 'TRANSFER_STOP' }))).toThrow(/FILE_RECEIVED exige receivedFile et chunkIndex/);
  });

  it('accepts one fenced JSON object, but not extra prose', () => {
    expect(parseAIResponse('```json\n{"protocol":"nova-agent/1","acknowledgedMessageId":"msg-1","status":"DONE"}\n```').status).toBe('DONE');
    expect(() => parseAIResponse('Here is the answer: {"protocol":"nova-agent/1","acknowledgedMessageId":"msg-1","status":"DONE"}')).toThrow();
  });

  it('rejects the non-canonical protocol alias outside the browser compatibility layer', () => {
    expect(() => parseAIResponse(JSON.stringify({ protocol: 'nova-agent/v1', acknowledgedMessageId: 'msg-1', status: 'DONE' }))).toThrow();
  });

  it('rejects unknown status and NEED_INFO without a question', () => {
    expect(() => parseAIResponse('{"protocol":"nova-agent/1","acknowledgedMessageId":"msg-1","status":"MAGIC"}')).toThrow();
    expect(() => parseAIResponse('{"protocol":"nova-agent/1","acknowledgedMessageId":"msg-1","status":"NEED_INFO"}')).toThrow();
  });

  it('normalizes requested file paths and rejects path traversal', () => {
    const response = parseAIResponse(JSON.stringify({ protocol, acknowledgedMessageId: 'msg-1', status: 'NEED_FILES', files: ['src\\auth.ts'] }));
    expect(validateRequestedFiles(response, 5)).toEqual(['src/auth.ts']);
    const traversal = parseAIResponse(JSON.stringify({ protocol, acknowledgedMessageId: 'msg-1', status: 'NEED_FILES', files: ['../.env'] }));
    expect(() => validateRequestedFiles(traversal, 5)).toThrow();
  });
});

describe('provider prompt construction', () => {
  it('does not replace the example acknowledgement placeholder with the live message ID', () => {
    const messageId = 'current-message-123';
    const prompt = buildProviderMessage({
      taskId: 'task-1',
      messageId,
      message: 'hello',
      projectContext: 'test context',
      includeGeneralPrompt: true,
    });
    const exampleStart = prompt.indexOf('Example:');
    const exampleEnd = prompt.indexOf(' A file transfer', exampleStart);
    const example = prompt.slice(exampleStart, exampleEnd < 0 ? undefined : exampleEnd);

    expect(example).toContain('"acknowledgedMessageId":"<current messageId>"');
    expect(example).not.toContain('"acknowledgedMessageId":"current-message-123"');
    expect(prompt).toContain('PATCH_READY patch must be a complete, syntactically valid unified Git diff');
    expect(prompt).toContain('oldCount equals context lines plus removed lines');
    expect(prompt).toContain('do not turn them into \\<, \\>, or \\*');
    expect(prompt).toContain('Never emit a standalone TRANSFER_STOP for a delivered segment');
    expect(prompt).toContain('exact receivedFile and chunkIndex');
  });
});

describe('unified patch parser', () => {
  it('parses a standard modification patch', () => {
    const patch = [
      'diff --git a/src/app.ts b/src/app.ts',
      'index 1111111..2222222 100644',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1 +1 @@',
      '-const value = 1;',
      '+const value = 2;',
      '',
    ].join('\n');
    expect(parsePatch(patch)).toEqual([{ path: 'src/app.ts', oldPath: 'src/app.ts', newPath: 'src/app.ts', created: false, deleted: false }]);
  });

  it('recognizes file creation and refuses traversal or binary patches', () => {
    const create = 'diff --git a/src/new.ts b/src/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+export {}\n';
    expect(parsePatch(create)[0]?.created).toBe(true);
    const traversal = 'diff --git a/../evil.ts b/../evil.ts\n--- a/../evil.ts\n+++ b/../evil.ts\n@@ -1 +1 @@\n-a\n+b\n';
    expect(() => parsePatch(traversal)).toThrow();
    expect(() => parsePatch('GIT binary patch')).toThrow();
  });
});
