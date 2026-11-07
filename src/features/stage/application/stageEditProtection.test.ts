import { expect, it } from 'vitest';
import { assertStageEditUnlocked } from './stageEditProtection';
import { createEmptyDirectorMotionProject } from '@/features/canvas/application/directorMotion';
import type { BlueprintNodeData } from '@/features/canvas/domain/canvasNodes';

const data: BlueprintNodeData = { mode: 'flat', aspectRatio: '16:9', referenceImages: [], items: [
  { id: 'locked', label: 'Actor', x: 0, y: 0, color: '#fff', locked: true },
  { id: 'free', label: 'Prop', x: 1, y: 0, color: '#fff' },
] };
it('rejects a mixed edit or delete touching a locked object and allows a standalone unlock', () => {
  expect(() => assertStageEditUnlocked(data, { items: [data.items[1]] })).toThrow('Actor');
  expect(() => assertStageEditUnlocked(data, { items: [{ ...data.items[0], locked: false, x: 8 }, data.items[1]] })).toThrow('Actor');
  expect(() => assertStageEditUnlocked(data, { items: [{ ...data.items[0], locked: false }, data.items[1]] })).not.toThrow();
  expect(() => assertStageEditUnlocked(data, { items: [data.items[0], { ...data.items[1], x: 9 }] })).not.toThrow();
});
it('blocks motion edits on a locked target without blocking unrelated camera edits', () => {
  const motion = createEmptyDirectorMotionProject();
  expect(() => assertStageEditUnlocked(data, { motionProject: { ...motion, actionTracks: { locked: [{ id: 'walk', time: 0, easing: 'hold', actionId: 'walk' }] } } })).toThrow();
  expect(() => assertStageEditUnlocked(data, { motionProject: { ...motion, loop: true } })).not.toThrow();
});
