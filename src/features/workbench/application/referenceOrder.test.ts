import { expect, it } from 'vitest';
import { rebaseWorkbenchReferenceTokens, workbenchSlotReferences } from './referenceOrder';
import type { WorkbenchReference } from '../domain/types';
const refs: WorkbenchReference[] = [{ id: 'a', kind: 'image', source: '/a' }, { id: 'v', kind: 'video', source: '/v' }, { id: 'b', kind: 'image', source: '/b' }];
it('keeps reference identities when image order changes around a video', () => {
  expect(rebaseWorkbenchReferenceTokens('用 @图1 的人物，@图2 的背景，参考 @视1', refs, [refs[2], refs[1], refs[0]])).toBe('用 @图2 的人物，@图1 的背景，参考 @视频1');
});
it('removes a deleted reference mention and renumbers the remaining one', () => {
  expect(rebaseWorkbenchReferenceTokens('@图1 与 @图2', refs, [refs[1], refs[2]])).toBe(' 与 @图1');
});
it('preserves video and audio identity when reordered and reads earlier short markers', () => {
  const media: WorkbenchReference[] = [
    { id: 'v1', kind: 'video', source: '/v1' }, { id: 'v2', kind: 'video', source: '/v2' },
    { id: 'a1', kind: 'audio', source: '/a1' }, { id: 'a2', kind: 'audio', source: '/a2' },
  ];
  expect(rebaseWorkbenchReferenceTokens('@视频1 @视2 @音频1 @音2 @图12', media, [media[1], media[3], media[2]]))
    .toBe(' @视频1 @音频2 @音频1 @图12');
});

it('rebases slot mentions by media identity after removing a leading frame', () => {
  const slots = [{ key: 'frames', kind: 'image' as const, label: 'Frames', min: 0, max: 3 }];
  const before = workbenchSlotReferences(slots, { frames: ['/a', '/b'] });
  const after = workbenchSlotReferences(slots, { frames: ['/b'] });
  expect(rebaseWorkbenchReferenceTokens('@图1 的人物 @图2 的背景', before, after)).toBe(' 的人物 @图1 的背景');
});
