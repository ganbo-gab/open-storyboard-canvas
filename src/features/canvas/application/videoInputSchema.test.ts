import { describe, expect, it } from 'vitest';
import { MINIMAX_H3_INPUT_SCHEMA } from './minimaxH3';
import { DEFAULT_VIDEO_INPUT_SCHEMA, getVideoReferenceOverflow } from './videoInputSchema';

describe('video reference input limits', () => {
  it.each([
    ['images', 10, 9], ['video', 4, 3], ['audio', 4, 3],
  ] as const)('rejects excess %s before the canvas drops any connected input', (kind, count, max) => {
    expect(getVideoReferenceOverflow(MINIMAX_H3_INPUT_SCHEMA, { images: 0, video: 0, audio: 0, [kind]: count }))
      .toEqual({ kind, count, max });
  });
  it('accepts each individual boundary and leaves the combined limit to the composer', () => {
    expect(getVideoReferenceOverflow(MINIMAX_H3_INPUT_SCHEMA, { images: 9, video: 3, audio: 3 })).toBeNull();
  });
  it('uses the selected schema limits for other video providers', () => {
    expect(getVideoReferenceOverflow(DEFAULT_VIDEO_INPUT_SCHEMA, { images: 2, video: 0, audio: 0 }))
      .toEqual({ kind: 'images', count: 2, max: 1 });
  });
});
