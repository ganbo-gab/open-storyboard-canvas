import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { BlueprintNodeData, DirectorCameraKeyframe } from '@/features/canvas/domain/canvasNodes';
import { sampleNormalizedDirectorMotion } from '@/features/canvas/application/directorMotion';
import { samplePersonAction } from '@/features/canvas/application/personMotionLibrary';
import { compileStoryPlan, computeStoryFraming } from './storyCompiler';
import { storyPlanSchema, type StoryPlan, type StoryShot } from './storyPlan';
import { prepareStageCommands } from './stageOperations';

const origin = { x: 0, y: 0, z: 0 };
const data: BlueprintNodeData = { mode: 'flat', aspectRatio: '16:9', referenceImages: [], items: [{ id: 'actor', label: 'Actor', x: 0, y: 0, color: '#fff', category: 'person', presetId: 'man', pos3d: origin }] };
const shot: StoryShot = { start: 0, duration: 4, size: 'full', angle: 'eye', movement: 'static', subjectItemIds: ['actor'], transition: 'cut' };
function plan(patch: Partial<StoryPlan> = {}): StoryPlan { return { version: 1, duration: 8, cast: [{ kind: 'existing', itemId: 'actor' }], setObjects: [], beats: [], shots: [], ...patch }; }
function compile(input: StoryPlan) { return compileStoryPlan(input, { nodeId: 'stage', revision: 7, data }); }
function apply(input: StoryPlan) { return prepareStageCommands(data, compile(input).commands).data; }

describe('story framing', () => {
  const bounds = { min: { x: -0.2, y: 0, z: 0 }, max: { x: 0.2, y: 1.8, z: 0 } };
  it('derives a full shot distance from registered subject height and vertical FOV', () => {
    const fit = computeStoryFraming(bounds, 'full', 45, 16 / 9, 'eye');
    expect(fit.distance).toBeCloseTo(1.8 * 1.1 / (2 * Math.tan(Math.PI / 8)), 10);
    expect(fit.target.y).toBeCloseTo(0.9);
    expect(computeStoryFraming(bounds, 'wide', 45, 16 / 9, 'eye').distance).toBeGreaterThan(fit.distance);
    expect(computeStoryFraming(bounds, 'close', 45, 16 / 9, 'eye').target.y).toBeCloseTo(1.575);
    expect(computeStoryFraming(bounds, 'full', 25, 16 / 9, 'eye').distance).toBeGreaterThan(fit.distance);
  });
  it.each(['eye', 'high', 'low', 'overhead'] as const)('fits all bounds corners including depth in portrait %s', (angle) => {
    const box = { min: { x: -3, y: 0, z: -1 }, max: { x: 3, y: 2, z: 1 } };
    const fit = computeStoryFraming(box, 'full', 50, 9 / 16, angle, 0.4);
    const camera = new THREE.PerspectiveCamera(50, 9 / 16, 0.01, 1000);
    camera.position.set(fit.position.x, fit.position.y, fit.position.z);
    camera.lookAt(fit.target.x, fit.target.y, fit.target.z); camera.updateMatrixWorld();
    for (const x of [-3, 3]) for (const y of [0, 2]) for (const z of [-1, 1]) {
      const projected = new THREE.Vector3(x, y, z).project(camera);
      expect(Math.abs(projected.x)).toBeLessThanOrEqual(1.000001);
      expect(Math.abs(projected.y)).toBeLessThanOrEqual(1.000001);
    }
  });
});

describe('story compilation', () => {
  it('is deterministic, scales new cast by registered height, and updates catalog set objects', () => {
    const input = plan({ cast: [{ kind: 'new', itemId: 'new', presetId: 'woman', label: 'New', heightM: 1.9 }], setObjects: [{ itemId: 'desk', label: 'Desk', presetId: 'table', position: origin }], shots: [{ ...shot, subjectItemIds: ['new'] }] });
    expect(compile(input)).toEqual(compile(input));
    const result = apply(input);
    expect(result.items.find((item) => item.id === 'new')?.scale3d?.y).toBeCloseTo(1.9 / 1.7);
    const second = compileStoryPlan(plan({ setObjects: [{ itemId: 'desk', label: 'Desk moved', presetId: 'table', position: { x: 2, y: 0, z: 0 } }] }), { nodeId: 'stage', revision: 8, data: result });
    expect(second.commands.some((command) => command.type === 'object.update' && command.itemId === 'desk')).toBe(true);
  });
  it('derives walk arrival from distance / catalog speed and holds after arrival through later beats', () => {
    const input = plan({ beats: [{ start: 0, duration: 4, blocking: [{ itemId: 'actor', to: { x: 2.7, y: 0, z: 0 } }] }, { start: 4, duration: 2, blocking: [{ itemId: 'actor', facing: 0, poseId: 'stand-relaxed' }] }] });
    const preview = compile(input), route = preview.commands.find((command) => command.type === 'trajectory.set');
    expect(route?.type === 'trajectory.set' && route.duration).toBeCloseTo(2);
    const result = apply(input), project = result.motionProject!;
    for (const time of [2, 3, 4, 5, 7.5, 8]) expect(sampleNormalizedDirectorMotion(project, time, result.items).objects.actor.position.x).toBeCloseTo(2.7, 5);
    expect(sampleNormalizedDirectorMotion(project, 5, result.items).objects.actor.rotation.y).toBeCloseTo(0);
    expect(preview).toEqual(compile(input));
  });
  it('reports infeasible walking without silently shifting authored beat timing', () => {
    const preview = compile(plan({ beats: [{ start: 1, duration: 1, blocking: [{ itemId: 'actor', to: { x: 10, y: 0, z: 0 } }] }] }));
    expect(preview.warnings.some((warning) => warning.code === 'walk-too-fast')).toBe(true);
    const route = preview.commands.find((command) => command.type === 'trajectory.set');
    expect(route?.type === 'trajectory.set' && [route.start, route.duration]).toEqual([1, 1]);
  });
  it('resolves marks and actor-relative positions independently of cast/blocking order', () => {
    const input = plan({ cast: [{ kind: 'existing', itemId: 'actor' }, { kind: 'new', itemId: 'other', presetId: 'woman', label: 'Other', heightM: 1.7, position: { x: 3, y: 0, z: 0 } }], marks: [{ id: 'meeting', position: { x: 1, y: 0, z: 2 } }], beats: [{ start: 0, duration: 4, blocking: [{ itemId: 'actor', to: { actorId: 'other', offset: { x: -1, y: 0, z: 0 } } }, { itemId: 'other', to: { markId: 'meeting' } }] }] });
    const result = apply(input), state = sampleNormalizedDirectorMotion(result.motionProject!, 4, result.items);
    expect(state.objects.actor.position).toEqual({ x: 2, y: 0, z: 0 });
    expect(state.objects.other.position).toEqual({ x: 1, y: 0, z: 2 });
  });
  it('keeps procedural phase when gaze overlays are sampled and uses real pose ids', () => {
    const input = plan({ beats: [{ start: 0, duration: 4, blocking: [{ itemId: 'actor', actionId: 'wave', poseId: 'stand-neutral', lookAt: { x: 0.5, y: 1.6, z: 3 }, facing: 0 }] }] });
    const preview = compile(input), result = apply(input);
    expect(preview).toEqual(compile(input));
    for (const time of [0, 1.1, 2.3, 3.9]) {
      const actual = sampleNormalizedDirectorMotion(result.motionProject!, time, result.items).actions.actor;
      expect(actual.actionId).toBe('wave');
      expect(actual.pose?.rightUpperArm).toEqual(samplePersonAction('wave', time)?.rightUpperArm);
      expect(actual.pose?.head?.y).toBeGreaterThan(0);
    }
  });
  it('cuts exactly at a boundary without blending away the outgoing moving shot', () => {
    const input = plan({ shots: [{ ...shot, movement: 'push' }, { ...shot, start: 4, size: 'close', azimuth: Math.PI / 2 }] });
    const result = apply(input), project = result.motionProject!;
    const camera = (time: number) => sampleNormalizedDirectorMotion(project, time, result.items).camera!;
    const incoming = project.cameraTrack.find((frame) => frame.time === 4)!;
    expect(incoming.easing).toBe('hold');
    expect(camera(4).position).toEqual(incoming.position);
    expect(camera(4 - 1e-8).position.z).toBeGreaterThan(1);
    expect(camera(4).position.z).toBeCloseTo(0, 7);
    expect(camera(0).position.z).toBeGreaterThan(camera(3.9).position.z);
    expect(new Set(project.cameraTrack.map((frame) => frame.time)).size).toBe(project.cameraTrack.length);
  });
  it('blends from outgoing camera across the requested incoming interval', () => {
    const result = apply(plan({ shots: [shot, { ...shot, start: 4, azimuth: Math.PI / 2, transition: 'blend', blendSeconds: 0.4 }] }));
    const camera = (time: number) => sampleNormalizedDirectorMotion(result.motionProject!, time, result.items).camera!;
    expect(camera(4).position.z).toBeCloseTo(camera(3.99).position.z);
    expect(camera(4.2).position.x).toBeGreaterThan(camera(4).position.x);
    expect(camera(4.2).position.x).toBeLessThan(camera(4.4).position.x);
  });
  it.each(['static', 'push', 'pull', 'pan', 'orbit', 'track', 'crane'] as const)('compiles %s movement to finite real camera keyframes', (movement) => {
    const result = apply(plan({ shots: [{ ...shot, movement }], beats: [{ start: 0, duration: 4, blocking: [{ itemId: 'actor', to: { x: 2.7, y: 0, z: 0 } }] }] }));
    const frames: DirectorCameraKeyframe[] = result.motionProject!.cameraTrack;
    expect(frames.length).toBeGreaterThanOrEqual(2);
    expect(frames.every((frame) => Object.values(frame.position).every(Number.isFinite))).toBe(true);
    if (movement === 'static' || movement === 'pan') expect(frames[0].position).toEqual(frames.find((frame) => frame.time === 4)!.position);
    if (movement === 'track') expect(frames.find((frame) => frame.time === 4)!.position.x - frames[0].position.x).toBeCloseTo(2.7);
  });
  it('allows touching actor ranges and a complete 120 second timeline', () => {
    expect(() => compile(plan({ duration: 120, beats: [{ start: 0, duration: 60, blocking: [{ itemId: 'actor', poseId: 'stand-neutral' }] }, { start: 60, duration: 60, blocking: [{ itemId: 'actor', actionId: 'idle-breath' }] }], shots: [{ ...shot, duration: 120 }] }))).not.toThrow();
  });
  it('rejects overlapping ranges, unknown references, invalid catalogs and strict extra fields', () => {
    expect(() => compile(plan({ shots: [shot, { ...shot, start: 3 }] }))).toThrow(/Overlapping/);
    expect(() => compile(plan({ beats: [{ start: 0, duration: 2, blocking: [{ itemId: 'actor' }] }, { start: 1, duration: 2, blocking: [{ itemId: 'actor' }] }] }))).toThrow(/Overlapping/);
    expect(() => compile(plan({ shots: [{ ...shot, subjectItemIds: ['missing'] }] }))).toThrow(/subject/);
    expect(() => compile(plan({ beats: [{ start: 0, duration: 2, blocking: [{ itemId: 'actor', to: { markId: 'missing' } }] }] }))).toThrow(/reference/);
    expect(storyPlanSchema.safeParse({ ...plan(), extra: true }).success).toBe(false);
    expect(storyPlanSchema.safeParse(plan({ beats: [{ start: 0, duration: 2, blocking: [{ itemId: 'actor', actionId: 'invented-action' }] }] })).success).toBe(false);
    expect(storyPlanSchema.safeParse(plan({ beats: [{ start: 0, duration: 2, blocking: [{ itemId: 'actor', poseId: 'invented-pose' }] }] })).success).toBe(false);
    expect(storyPlanSchema.safeParse(plan({ duration: 121 })).success).toBe(false);
    expect(() => compile(plan({ cast: [{ kind: 'existing', itemId: 'missing' }] }))).toThrow(/existing person/);
  });
});
