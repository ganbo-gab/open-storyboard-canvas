import { describe, expect, it } from 'vitest';

import { insertReferenceToken } from './referenceTokenEditing';

describe('insertReferenceToken in long prompts', () => {
  const longPrompt = Array.from(
    { length: 160 },
    (_, index) => `Shot ${index + 1}: the character crosses the frame.`,
  ).join('\n');

  it('inserts near the top without moving the caret to the prompt end', () => {
    const cursor = longPrompt.indexOf('character');
    const result = insertReferenceToken(longPrompt, cursor, '@图1');

    expect(result.nextText.slice(result.nextCursor)).toContain('character crosses the frame');
    expect(result.nextText.slice(0, result.nextCursor)).toContain('@图1');
    expect(result.nextCursor).toBeLessThan(result.nextText.length / 4);
  });

  it('inserts in the middle while preserving all text after the selection', () => {
    const cursor = longPrompt.indexOf('Shot 81');
    const suffix = longPrompt.slice(cursor);
    const result = insertReferenceToken(longPrompt, cursor, '@图2');

    expect(result.nextText.slice(result.nextCursor)).toBe(suffix);
    expect(result.nextText.slice(0, result.nextCursor)).toContain('@图2');
    expect(result.nextCursor).toBeLessThan(result.nextText.length);
  });
});
