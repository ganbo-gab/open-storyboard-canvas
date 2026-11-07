import { expect, it } from 'vitest';
import { snapStageTimelineTime } from './timelineSnap';

it('snaps to tenths, nearby authored edges and playhead without crossing duration', () => {
  expect(snapStageTimelineTime(2.347, 12, 1200, [], 0)).toBe(2.3);
  expect(snapStageTimelineTime(2.347, 12, 1200, [2.375], 0)).toBe(2.375);
  expect(snapStageTimelineTime(4.99, 12, 1200, [], 5)).toBe(5);
  expect(snapStageTimelineTime(13, 12, 1200, [], 0)).toBe(12);
});
