import { describe, expect, it } from 'vitest';
import type { BlueprintItem, DirectorObjectKeyframe } from '@/features/canvas/domain/canvasNodes';
import { createEmptyDirectorMotionProject, sampleNormalizedDirectorMotion } from '@/features/canvas/application/directorMotion';
import { prepareStageCommands } from './stageOperations';
import { replaceStageTrackRange, sampleStageActionState, STAGE_RANGE_GUARD_SECONDS } from './stageRanges';

const item: BlueprintItem = { id: 'actor', label: 'Actor', x: 0, y: 0, pos3d: { x: 0, y: 0, z: 0 }, color: '#fff', category: 'person', presetId: 'man' };
const frames: DirectorObjectKeyframe[] = [
  { id: 'start', time: 0, easing: 'smooth', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
  { id: 'end', time: 8, easing: 'smooth', position: { x: 8, y: 0, z: 4 }, rotation: { x: 0, y: 1, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
];
const project = { ...createEmptyDirectorMotionProject(8), objectTracks: { actor: frames } };

describe('stage range replacement', () => {
  it('preserves smooth values outside both guards and holds exact interval endpoints', () => {
    const replacements = [2, 5].map((time, index) => ({ ...frames[index], id: `replace-${index}`, time, position: { x: 20 + index, y: 0, z: 0 } }));
    const result = replaceStageTrackRange(frames, 2, 5, replacements, 8, (time) => sampleNormalizedDirectorMotion(project, time, [item]).objects.actor);
    const modified = { ...project, objectTracks: { actor: result } };
    for (const time of [0, 0.3, 1.5, 2 - STAGE_RANGE_GUARD_SECONDS, 5 + STAGE_RANGE_GUARD_SECONDS, 5.5, 7, 8]) {
      const actual = sampleNormalizedDirectorMotion(modified, time, [item]).objects.actor;
      const expected = sampleNormalizedDirectorMotion(project, time, [item]).objects.actor;
      expect(actual.position.x).toBeCloseTo(expected.position.x, 8);
      expect(actual.position.z).toBeCloseTo(expected.position.z, 8);
      expect(actual.rotation.y).toBeCloseTo(expected.rotation.y, 8);
    }
    expect(sampleNormalizedDirectorMotion(modified, 2, [item]).objects.actor.position.x).toBe(20);
    expect(sampleNormalizedDirectorMotion(modified, 5, [item]).objects.actor.position.x).toBe(21);
  });
  it('creates no out-of-bounds guards at zero or the timeline end', () => {
    const result = replaceStageTrackRange(frames, 0, 8, frames.map((frame) => ({ ...frame, id: `new-${frame.id}` })), 8, () => { throw new Error('No outside sampling needed'); });
    expect(result.map((frame) => frame.time)).toEqual([0, 8]);
    expect(result[0].easing).toBe('hold');
    expect(() => replaceStageTrackRange(frames, 2, 2, frames, 8, () => frames[0])).toThrow(/interval/);
    expect(() => replaceStageTrackRange(frames, 2, 9, frames, 8, () => frames[0])).toThrow(/interval/);
    expect(() => replaceStageTrackRange(frames, 2, 5, frames, 8, () => frames[0])).toThrow(/inside/);
  });
  it('retains outside path-facing rotations when replacement changes neighboring points', () => {
    const curved: DirectorObjectKeyframe[] = [{ ...frames[0], orientToPath: true }, { ...frames[0], id: 'bend', time: 4, position: { x: 2, y: 0, z: 4 }, orientToPath: true }, { ...frames[1], orientToPath: true }];
    const original = { ...project, objectTracks: { actor: curved } };
    const replaced = replaceStageTrackRange(curved, 3, 5, [3, 5].map((time) => ({ ...frames[0], id: `new-${time}`, time, position: { x: 30, y: 0, z: 0 }, orientToPath: false })), 8, (time) => sampleNormalizedDirectorMotion(original, time, [item]).objects.actor);
    for (const time of [0, 1, 2.5, 5.5, 6, 8]) {
      expect(sampleNormalizedDirectorMotion({ ...original, objectTracks: { actor: replaced } }, time, [item]).objects.actor.rotation.y).toBeCloseTo(sampleNormalizedDirectorMotion(original, time, [item]).objects.actor.rotation.y, 7);
    }
  });
  it.each(['procedural', 'clip'] as const)('resumes %s action phase and keeps both boundary states', (kind) => {
    const old = { ...createEmptyDirectorMotionProject(8), actionTracks: { actor: [{ id: 'original', time: 0, easing: 'hold' as const, ...(kind === 'clip' ? { clipId: 'cycle' } : { actionId: 'walk' }), actionOffsetSeconds: 0.37 }] }, customClips: kind === 'clip' ? [{ id: 'cycle', name: 'Cycle', durationSeconds: 2, loop: true, keyframes: [{ id: 'nested', time: 0, easing: 'hold' as const, actionId: 'walk', actionOffsetSeconds: 0.2 }] }] : [] };
    const state = sampleStageActionState(old, item.id, 5, [item]);
    expect(state.actionOffsetSeconds).toBeCloseTo(5.37);
    const result = prepareStageCommands({ mode: 'flat', aspectRatio: '16:9', referenceImages: [], items: [item], motionProject: old }, [{ type: 'person.action', itemId: item.id, actionId: 'wave', start: 2, duration: 3 }]).data;
    for (const time of [0, 1.5, 2 - STAGE_RANGE_GUARD_SECONDS, 5, 5 + STAGE_RANGE_GUARD_SECONDS, 5.4, 7.5]) {
      expect(sampleNormalizedDirectorMotion(result.motionProject!, time, [item]).actions.actor.pose).toEqual(sampleNormalizedDirectorMotion(old, time, [item]).actions.actor.pose);
    }
    expect(sampleNormalizedDirectorMotion(result.motionProject!, 2, [item]).actions.actor.actionId).toBe('wave');
  });
  it('supports touching replacement ranges without duplicate boundary timestamps', () => {
    const data = { mode: 'flat' as const, aspectRatio: '16:9', referenceImages: [], items: [item], motionProject: project };
    const result = prepareStageCommands(data, [{ type: 'person.action', itemId: item.id, actionId: 'walk', start: 0, duration: 4 }, { type: 'person.action', itemId: item.id, actionId: 'wave', start: 4, duration: 4 }]).data.motionProject!;
    expect(sampleNormalizedDirectorMotion(result, 4, [item]).actions.actor.actionId).toBe('wave');
    expect(new Set(result.actionTracks.actor.map((frame) => frame.time)).size).toBe(result.actionTracks.actor.length);
  });
});
