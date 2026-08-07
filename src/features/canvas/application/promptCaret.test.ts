import { describe, expect, it } from 'vitest';

import { resolvePromptCaretScrollTop } from './promptCaret';

describe('resolvePromptCaretScrollTop', () => {
  it('preserves the viewport when a long-prompt insertion stays visible in the middle', () => {
    expect(resolvePromptCaretScrollTop({
      caretContentTop: 520,
      caretHeight: 24,
      previousScrollTop: 400,
      viewportHeight: 260,
      scrollHeight: 2_000,
    })).toBe(400);
  });

  it('scrolls upward only enough to reveal an insertion near the top', () => {
    expect(resolvePromptCaretScrollTop({
      caretContentTop: 120,
      caretHeight: 24,
      previousScrollTop: 400,
      viewportHeight: 260,
      scrollHeight: 2_000,
    })).toBe(116);
  });

  it('scrolls downward only enough to reveal an insertion below the visible band', () => {
    expect(resolvePromptCaretScrollTop({
      caretContentTop: 680,
      caretHeight: 24,
      previousScrollTop: 400,
      viewportHeight: 260,
      scrollHeight: 2_000,
    })).toBe(448);
  });

  it('clamps the restored viewport for a caret near the end of a long prompt', () => {
    expect(resolvePromptCaretScrollTop({
      caretContentTop: 1_990,
      caretHeight: 24,
      previousScrollTop: 1_600,
      viewportHeight: 260,
      scrollHeight: 2_000,
    })).toBe(1_740);
  });
});
