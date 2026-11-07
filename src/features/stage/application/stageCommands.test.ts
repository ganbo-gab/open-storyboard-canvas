import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CANVAS_NODE_TYPES, type BlueprintNodeData, type DirectorActionClip } from '@/features/canvas/domain/canvasNodes';
import { createEmptyDirectorMotionProject, normalizeDirectorMotionProject, sampleDirectorMotion, splitDirectorMotionClip } from '@/features/canvas/application/directorMotion';
import { useCanvasStore } from '@/stores/canvasStore';
import { registerStageViewport, stageCommands, stageCommandSchema } from './stageCommands';
import { prepareStageCommands } from './stageOperations';
import { draftStageScene } from './stageDrafting';
import { channelProviderId, setChannelCredential, useChannelStore } from '@/features/channels/store/channelStore';
import { openAIStandardProfile } from '@/features/channels/presets/openai';
import { submitCustomChatCompletion } from '@/features/channels/runtime/channelChat';
import type * as ProviderGateway from '@/features/channels/runtime/channelChat';
import { getAssetPortableSource, resolveAsset } from '@/features/assets/application/assetCatalog';
vi.mock('@/features/assets/application/assetCatalog', () => ({ getAssetPortableSource: vi.fn(async (source: string) => source), resolveAsset: vi.fn(async () => null) }));
vi.mock('@/features/channels/runtime/channelChat', async (importOriginal) => ({ ...await importOriginal<typeof ProviderGateway>(), submitCustomChatCompletion: vi.fn() }));
import { useMemorySecretVault } from '@/features/secrets/testSupport';
import type { StageCommand } from '../domain/stage';
import { normalizeStageObjectFlags } from '../domain/objectFlags';
import { resolveStageSelection } from './stageSelection';

useMemorySecretVault();
const draftModelId = `custom:${channelProviderId('stage-chat', 'chat')}:gpt-stage`;
const person = { id: 'person', label: 'Actor', x: 260, y: 130, color: '#fff', category: 'person' as const, presetId: 'man' };
function scene(): BlueprintNodeData {
  const legacy: BlueprintNodeData = {
    mode: 'flat', aspectRatio: '16:9', items: [person], referenceImages: [],
    backgroundImageUrl: 'legacy-background.png', snapshotUrl: 'legacy-snapshot.png',
    customActionPresets: ['Legacy pose'], customActionPoses: { 'Legacy pose': { head: { y: 0.4 } } },
    legacyCustomField: { retained: true },
  };
  return { ...legacy, directorStudioProjects: [{ id: 'saved-scene', name: 'Old scene', createdAt: 1, updatedAt: 2, snapshot: structuredClone(legacy) }] };
}
const clip: DirectorActionClip = { id: 'gesture', name: 'Gesture', durationSeconds: 6, loop: false, keyframes: [
  { id: 'start', time: 0, easing: 'smooth', pose: { head: { y: 0 } } },
  { id: 'end', time: 6, easing: 'smooth', pose: { head: { y: 1 } } },
] };
beforeEach(async () => {
  const profile = { ...openAIStandardProfile, id: 'stage-chat', models: [{ id: 'gpt-stage', operations: ['chat' as const], params: openAIStandardProfile.models.find((model) => model.operations.includes('chat'))!.params }] };
  useChannelStore.setState({ channels: [{ profile, origin: 'native', migrationIssues: [], createdAt: 1, updatedAt: 1 }] });
  await setChannelCredential('stage-chat', 'stage-key');
  vi.mocked(resolveAsset).mockReset();
  vi.mocked(resolveAsset).mockResolvedValue(null);
  useCanvasStore.setState({ nodes: [{ id: 'stage', type: CANVAS_NODE_TYPES.blueprint, position: { x: 0, y: 0 }, data: scene() }], edges: [], revision: 0, selectedNodeId: 'stage', activeDirectorStudioNodeId: null, activeToolDialog: null, history: { past: [], future: [] }, dragHistorySnapshot: null });
});
describe('StageCommands transactions', () => {
  it('fails a multi-object edit atomically on a locked object, then allows explicit unlock', () => {
    stageCommands.execute('stage', [
      { type: 'object.add', item: { ...person, id: 'second' } },
      { type: 'object.update', itemId: person.id, patch: { locked: true } },
    ]);
    const before = useCanvasStore.getState();
    expect(() => stageCommands.executeSelection('stage', ['second', person.id], { type: 'update', patch: { pos3d: { x: 4, y: 0, z: 2 } } })).toThrow(/locked/);
    expect(useCanvasStore.getState().nodes).toBe(before.nodes);
    expect(useCanvasStore.getState().history.past).toBe(before.history.past);
    expect(() => stageCommands.execute('stage', { type: 'object.update', itemId: person.id, patch: { locked: false, label: 'Bypass' } })).toThrow(/locked/);
    stageCommands.execute('stage', [
      { type: 'object.update', itemId: person.id, patch: { locked: false } },
      { type: 'object.update', itemId: person.id, patch: { pos3d: { x: 4, y: 0, z: 2 } } },
    ]);
    expect(stageCommands.query('stage').data.items[0]).toMatchObject({ locked: false, pos3d: { x: 4, y: 0, z: 2 } });
  });
  it('persists hidden/locked flags through workspace and saved-scene reload, with explicit legacy defaults', () => {
    stageCommands.executeSelection('stage', [person.id], { type: 'update', patch: { hidden: true, locked: true } });
    const data = stageCommands.query('stage').data;
    data.directorStudioProjects![0].snapshot.items = structuredClone(data.items);
    const node = { id: 'stage', type: CANVAS_NODE_TYPES.blueprint, position: { x: 0, y: 0 }, data };
    useCanvasStore.getState().setCanvasData(JSON.parse(JSON.stringify([node])), []);
    const reloaded = stageCommands.query('stage').data;
    expect(reloaded.items[0]).toMatchObject({ hidden: true, locked: true });
    expect(reloaded.directorStudioProjects![0].snapshot.items[0]).toMatchObject({ hidden: true, locked: true });
    expect(normalizeStageObjectFlags(person)).toEqual({});
    expect(normalizeStageObjectFlags({ hidden: 'true', locked: 1 })).toEqual({ hidden: undefined, locked: undefined });
    expect(() => stageCommands.execute('stage', { type: 'object.remove', itemId: person.id })).toThrow(/locked/);
  });
  it('applies and undoes a multi-object selection once, including duplicate selection ids', () => {
    stageCommands.execute('stage', { type: 'object.add', item: { ...person, id: 'second' } });
    const before = stageCommands.query('stage');
    const historyDepth = useCanvasStore.getState().history.past.length;
    const result = stageCommands.executeSelection('stage', [person.id, 'second', person.id], { type: 'update', patch: { hidden: true } }, before.revision);
    expect(result.selection).toEqual({ itemIds: [person.id, 'second'], primaryItemId: 'second' });
    expect(result.data.items.every((item) => item.hidden === true)).toBe(true);
    expect(useCanvasStore.getState().history.past).toHaveLength(historyDepth + 1);
    expect(() => stageCommands.executeSelection('stage', [person.id], { type: 'remove' }, before.revision)).toThrow(/revision/);
    stageCommands.undo();
    expect(stageCommands.query('stage').data).toEqual(before.data);
    const removed = stageCommands.executeSelection('stage', [person.id, 'second'], { type: 'remove' });
    expect(removed.data.items).toEqual([]);
    expect(removed.selection).toEqual({ itemIds: [], primaryItemId: null });
  });
  it('shares one pure selection contract and restricts new hidden/locked selection to the outliner', () => {
    const items = [person, { ...person, id: 'hidden', hidden: true }, { ...person, id: 'locked', locked: true }];
    const viewport = resolveStageSelection(items, ['deleted'], { itemIds: ['person', 'hidden', 'locked'], mode: 'replace', source: 'viewport' });
    expect(viewport).toEqual({ itemIds: ['person'], primaryItemId: 'person' });
    const outliner = resolveStageSelection(items, viewport.itemIds, { itemIds: ['locked', 'hidden'], mode: 'add', source: 'outliner' });
    expect(outliner.itemIds).toEqual(['person', 'locked', 'hidden']);
    expect(resolveStageSelection(items, outliner.itemIds, { itemIds: ['person'], mode: 'toggle', source: 'timeline' }).itemIds).toEqual(['locked', 'hidden']);
    expect(() => resolveStageSelection(items, [], { itemIds: ['missing'], mode: 'replace', source: 'outliner' })).toThrow(/does not exist/);
  });
  it('protects locked people from pose/action/trajectory/keyframe and transitive library edits', () => {
    const nested = { ...clip, id: 'nested', keyframes: [{ id: 'ref', time: 0, easing: 'hold' as const, clipId: clip.id }] };
    stageCommands.execute('stage', [
      { type: 'clip.add', clip }, { type: 'clip.add', clip: nested },
      { type: 'keyframe.add', track: { kind: 'action', itemId: person.id }, keyframe: { id: 'placed', time: 0, easing: 'hold', clipId: nested.id } },
      { type: 'object.update', itemId: person.id, patch: { locked: true } },
    ]);
    const commands: StageCommand[] = [
      { type: 'object.remove', itemId: person.id },
      { type: 'person.pose', itemId: person.id, pose: { head: { y: 0.2 } } },
      { type: 'person.action', itemId: person.id, actionId: 'walk', start: 0, duration: 1 },
      { type: 'trajectory.set', targetId: person.id, method: 'line', points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }], start: 0, duration: 1 },
      { type: 'keyframe.remove', track: { kind: 'action', itemId: person.id }, keyframeId: 'placed' },
      { type: 'clip.update', clipId: clip.id, patch: { name: 'Changed' } },
      { type: 'clip.split', clipId: clip.id, clipStart: 0, time: 2 },
      { type: 'clip.delete', clipId: clip.id },
      { type: 'keyframe.remove', track: { kind: 'clip', clipId: clip.id, clipStart: 0 }, keyframeId: 'start' },
    ];
    const before = useCanvasStore.getState();
    for (const command of commands) expect(() => stageCommands.execute('stage', command)).toThrow(/locked/);
    expect(useCanvasStore.getState().nodes).toBe(before.nodes);
    expect(useCanvasStore.getState().history.past).toBe(before.history.past);
    // Reading a locked person as a camera target is not an edit of that person.
    expect(() => stageCommands.execute('stage', { type: 'camera.lookAt', time: 0, position: { x: 0, y: 2, z: 5 }, lookAt: { mode: 'target', targetId: person.id } })).not.toThrow();
  });
  it('aborts an unregistered capture generation and ignores its late result without removing the replacement', async () => {
    const gate = Promise.withResolvers<{ assetId: string }>();
    let capturedSignal: AbortSignal | undefined;
    const unregisterOld = registerStageViewport('stage', { capture: async (signal) => { capturedSignal = signal; return gate.promise; } });
    const pending = stageCommands.capture('stage');
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const unregisterNew = registerStageViewport('stage', { capture: async () => ({ assetId: 'replacement-image' }) });
    unregisterOld();
    expect(capturedSignal?.aborted).toBe(true);
    await expect(stageCommands.capture('stage')).rejects.toThrow(/in progress/);
    gate.resolve({ assetId: 'obsolete-image' });
    await rejected;
    vi.mocked(resolveAsset).mockResolvedValue({ id: 'replacement-image', kind: 'image', source: 'fixture:replacement', name: 'Fixture renderer image', origin: 'generated', createdAt: 1, favorite: false, metadata: {} });
    try {
      await expect(stageCommands.capture('stage')).resolves.toMatchObject({ assetId: 'replacement-image' });
    } finally { unregisterNew(); }
  });
  it('rejects missing exact/four-view bridge capabilities rather than using current or stale images', async () => {
    const capture = vi.fn(async () => ({ assetId: 'must-not-be-used' }));
    const unregister = registerStageViewport('stage', { capture });
    try {
      await expect(stageCommands.capture('stage', 0)).rejects.toThrow(/exact-time/);
      await expect(stageCommands.captureFourViews('stage')).rejects.toThrow(/four-view/);
      expect(capture).not.toHaveBeenCalled();
      expect(useCanvasStore.getState().history.past).toHaveLength(0);
    } finally { unregister(); }
  });
  it('accepts global capture IDs unchanged without forcing canvas-node creation', async () => {
    const state = useCanvasStore.getState();
    vi.mocked(resolveAsset).mockResolvedValue({ id: 'captured-global-image', kind: 'image', source: 'asset-media:capture', name: 'Stage capture', origin: 'generated', createdAt: 1, favorite: false, metadata: {} });
    const unregister = registerStageViewport('stage', { capture: async () => ({ assetId: 'captured-global-image' }) });
    try {
      await expect(stageCommands.capture('stage')).resolves.toEqual({ nodeId: 'stage', assetId: 'captured-global-image' });
      expect(useCanvasStore.getState().nodes).toBe(state.nodes);
      expect(useCanvasStore.getState().history.past).toHaveLength(0);
    } finally { unregister(); }
  });
  it('undoes a split and its rewritten placements as one transaction', () => {
    stageCommands.execute('stage', [
      { type: 'clip.add', clip },
      { type: 'keyframe.add', track: { kind: 'action', itemId: 'person' }, keyframe: { id: 'placed', time: 1, easing: 'linear', clipId: clip.id } },
    ]);
    const before = stageCommands.query('stage').data;
    const historyCount = useCanvasStore.getState().history.past.length;
    stageCommands.execute('stage', { type: 'clip.split', clipId: clip.id, clipStart: 1, time: 3 });
    expect(stageCommands.query('stage').data.motionProject!.customClips).toHaveLength(2);
    expect(useCanvasStore.getState().history.past).toHaveLength(historyCount + 1);
    stageCommands.undo();
    expect(stageCommands.query('stage').data).toEqual(before);
  });
  it('commits a batch once and undo restores the complete old static document', () => {
    const before = structuredClone(useCanvasStore.getState().nodes);
    stageCommands.execute('stage', [
      { type: 'object.update', itemId: person.id, patch: { label: 'Updated', pos3d: { x: 3, y: 0, z: 1 } } },
      { type: 'trajectory.set', targetId: person.id, method: 'line', points: [{ x: 3, y: 0, z: 1 }, { x: 5, y: 0, z: 1 }], start: 1, duration: 3 },
    ], 0);
    expect(useCanvasStore.getState().history.past).toHaveLength(1);
    expect(stageCommands.query('stage').data.legacyCustomField).toEqual({ retained: true });
    expect(stageCommands.query('stage').data.directorStudioProjects).toEqual(scene().directorStudioProjects);
    expect(stageCommands.query('stage').data.customActionPoses).toEqual(scene().customActionPoses);
    expect(stageCommands.query('stage').data.backgroundImageUrl).toBe('legacy-background.png');
    expect(stageCommands.undo()).toBe(true);
    expect(useCanvasStore.getState().nodes).toEqual(before);
    expect(stageCommands.query('stage').data.motionProject).toBeUndefined();
  });
  it('rolls back all preparation if a later command fails and rejects stale revisions', () => {
    const before = useCanvasStore.getState();
    expect(() => stageCommands.execute('stage', [{ type: 'object.update', itemId: person.id, patch: { label: 'Wrong' } }, { type: 'object.remove', itemId: 'missing' }])).toThrow();
    expect(useCanvasStore.getState().nodes).toBe(before.nodes);
    expect(useCanvasStore.getState().history.past).toHaveLength(0);
    expect(() => stageCommands.execute('stage', { type: 'object.remove', itemId: person.id }, -1)).toThrow(/revision/);
  });
  it('keeps clip keyframes local while every public keyframe time is absolute', () => {
    stageCommands.execute('stage', { type: 'clip.add', clip });
    stageCommands.execute('stage', { type: 'keyframe.add', track: { kind: 'clip', clipId: clip.id, clipStart: 10 }, keyframe: { id: 'middle', time: 12, easing: 'linear', pose: { head: { y: 0.5 } } } });
    let frames = stageCommands.query('stage').data.motionProject!.customClips[0].keyframes;
    expect(frames.find((frame) => frame.id === 'middle')?.time).toBe(2);
    stageCommands.execute('stage', { type: 'keyframe.update', track: { kind: 'clip', clipId: clip.id, clipStart: 10 }, keyframeId: 'middle', patch: { time: 13 } });
    frames = stageCommands.query('stage').data.motionProject!.customClips[0].keyframes;
    expect(frames.find((frame) => frame.id === 'middle')?.time).toBe(3);
    stageCommands.execute('stage', { type: 'keyframe.update', track: { kind: 'clip', clipId: clip.id, clipStart: 10 }, keyframeId: 'middle', patch: { easing: 'hold' } });
    expect(stageCommands.query('stage').data.motionProject!.customClips[0].keyframes.find((frame) => frame.id === 'middle')?.time).toBe(3);
  });
  it('does not clamp or silently truncate a timeline when shortening', () => {
    stageCommands.execute('stage', { type: 'camera.lookAt', time: 7, position: { x: 0, y: 2, z: 8 }, lookAt: { mode: 'target', targetId: 'person' } });
    expect(() => stageCommands.execute('stage', { type: 'playback.update', duration: 4 })).toThrow(/shortening/);
  });
  it('rejects shortening through an active camera rig without changing the graph', () => {
    const project = normalizeDirectorMotionProject({ durationSeconds: 8, cameraRigs: [{ id: 'follow', kind: 'follow', targetId: person.id, start: 1, end: 7 }] });
    const data = { ...scene(), motionProject: project };
    useCanvasStore.setState({ nodes: [{ id: 'stage', type: CANVAS_NODE_TYPES.blueprint, position: { x: 0, y: 0 }, data }] });
    const before = useCanvasStore.getState();
    expect(() => stageCommands.execute('stage', { type: 'playback.update', duration: 4 })).toThrow(/shortening/);
    expect(useCanvasStore.getState().nodes).toBe(before.nodes);
    expect(useCanvasStore.getState().history.past).toHaveLength(0);
  });
  it('rejects shortening through the remainder of a placed clip but allows an interrupted clip', () => {
    stageCommands.execute('stage', [
      { type: 'clip.add', clip },
      { type: 'keyframe.add', track: { kind: 'action', itemId: person.id }, keyframe: { id: 'placed', time: 1, easing: 'hold', clipId: clip.id } },
    ]);
    const before = useCanvasStore.getState();
    expect(() => stageCommands.execute('stage', { type: 'playback.update', duration: 4 })).toThrow(/shortening/);
    expect(useCanvasStore.getState().nodes).toBe(before.nodes);
    stageCommands.execute('stage', [
      { type: 'keyframe.add', track: { kind: 'action', itemId: person.id }, keyframe: { id: 'interrupt', time: 3, easing: 'hold', clipId: null } },
      { type: 'playback.update', duration: 4 },
    ]);
    expect(stageCommands.query('stage').data.motionProject!.durationSeconds).toBe(4);
  });
  it('free camera orientation clears target precedence and survives persisted normalization', () => {
    stageCommands.execute('stage', { type: 'camera.lookAt', time: 0, position: { x: 0, y: 2, z: 8 }, lookAt: { mode: 'target', targetId: 'person' } });
    stageCommands.execute('stage', { type: 'camera.lookAt', time: 0, lookAt: { mode: 'free', rotation: { x: 0, y: Math.PI / 2, z: 0.3 } } });
    const data = stageCommands.query('stage').data;
    const frame = sampleDirectorMotion(normalizeDirectorMotionProject(data.motionProject), 0, data.items).camera!;
    expect(frame.trackTargetId).toBeNull();
    expect(frame.freeRotation?.z).toBeCloseTo(0.3);
    expect(frame.target.x).toBeCloseTo(-1);
    expect(frame.target.z).toBeCloseTo(8);
    stageCommands.execute('stage', { type: 'camera.lookAt', time: 0, lookAt: { mode: 'point', point: { x: 1, y: 1, z: 1 } } });
    expect(stageCommands.query('stage').data.motionProject!.cameraTrack[0].freeRotation).toBeUndefined();
  });
  it('validates strict unknown fields, track-specific frames and dangling references', () => {
    expect(stageCommandSchema.safeParse({ type: 'object.remove', itemId: 'person', unexpected: true }).success).toBe(false);
    expect(() => stageCommands.execute('stage', { type: 'keyframe.add', track: { kind: 'camera' }, keyframe: { id: 'bad', time: 0, easing: 'linear' } })).toThrow();
    expect(() => stageCommands.execute('stage', { type: 'clip.add', clip: { ...clip, keyframes: [{ id: 'loop', time: 0, easing: 'linear', clipId: clip.id }] } })).toThrow(/recursively/);
  });
  it('adds only explicitly adopted draft portions and preserves existing people', () => {
    const draft = { version: 1 as const, description: 'Room', objects: [{ label: 'Table', category: 'object' as const, presetId: 'table', position: { x: 1, y: 0, z: 1 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }] };
    stageCommands.applyDraft('stage', draft, ['objects']);
    expect(stageCommands.query('stage').data.items).toHaveLength(2);
    expect(stageCommands.query('stage').data.items[0]).toEqual(person);
    stageCommands.undo();
    expect(stageCommands.query('stage').data.items).toEqual([person]);
  });
});
describe('split interpolation and identities', () => {
  it('preserves smooth interpolation, updates placements and assigns independent stable IDs', () => {
    const project = { ...createEmptyDirectorMotionProject(8), customClips: [clip], actionTracks: { person: [{ id: 'placed', time: 1, easing: 'linear' as const, clipId: clip.id }] } };
    const result = splitDirectorMotionClip(project, clip.id, 2);
    const [left, right] = result.project.customClips;
    expect(left.id).toBe(clip.id);
    expect(right.id).not.toBe(clip.id);
    expect(new Set([...left.keyframes, ...right.keyframes].map((frame) => frame.id)).size).toBe(left.keyframes.length + right.keyframes.length);
    expect(project.customClips[0]).toBe(clip);
    for (const time of [1, 1.5, 2.5, 3, 3.5, 5, 6.5, 7]) {
      const expected = sampleDirectorMotion(project, time).actions.person.pose?.head?.y;
      const actual = sampleDirectorMotion(normalizeDirectorMotionProject(result.project), time).actions.person.pose?.head?.y;
      expect(actual ?? 0).toBeCloseTo(expected ?? 0);
    }
  });
  it('preserves procedural action phase after splitting and absolute split uses clipStart', () => {
    const walking = { ...clip, keyframes: [{ id: 'walk', time: 0, easing: 'linear' as const, actionId: 'walk' }] };
    const data = { ...scene(), motionProject: { ...createEmptyDirectorMotionProject(), customClips: [walking], actionTracks: { person: [{ id: 'placed', time: 0, easing: 'linear' as const, clipId: clip.id }] } } };
    const prepared = prepareStageCommands(data, [{ type: 'clip.split', clipId: clip.id, clipStart: 10, time: 12 }]);
    expect(prepared.data.motionProject!.customClips[0].durationSeconds).toBe(2);
    for (const time of [2, 2.1, 4.5]) expect(sampleDirectorMotion(prepared.data.motionProject!, time).actions.person.pose).toEqual(sampleDirectorMotion(data.motionProject, time).actions.person.pose);
  });
});
describe('scene drafting model boundary', () => {
  it('materializes browser media handles from library and canvas image assets', async () => {
    await setChannelCredential('stage-chat', 'stage-key');
    vi.mocked(getAssetPortableSource).mockResolvedValue('data:image/png;base64,cGl4ZWw=');
    vi.mocked(resolveAsset).mockResolvedValue({ id: 'uploaded-image', kind: 'image', source: 'asset-media:library', name: 'Reference', origin: 'uploaded', createdAt: 1, favorite: false, metadata: {} });
    vi.mocked(submitCustomChatCompletion).mockResolvedValue({ text: JSON.stringify({ version: 1, description: 'Draft', objects: [], estimation: { uncertainty: ['Single-view depth and lens are ambiguous.'], scaleReference: 'man: 1.8m', cameraHeightM: 1.6, horizonNormalized: 0.5 } }), raw: {} });
    const modelId = draftModelId;
    await draftStageScene({ prompt: 'Room', modelId, images: ['uploaded-image'] });
    expect(getAssetPortableSource).toHaveBeenCalledWith('asset-media:library');
    useCanvasStore.setState({ nodes: [{ id: 'image', type: CANVAS_NODE_TYPES.upload, position: { x: 0, y: 0 }, data: { imageUrl: 'asset-media:canvas', aspectRatio: '1:1' } }] });
    await draftStageScene({ prompt: 'Room', modelId, images: ['image:image'] });
    expect(getAssetPortableSource).toHaveBeenCalledWith('asset-media:canvas');
    const payload = vi.mocked(submitCustomChatCompletion).mock.lastCall?.[1];
    expect(JSON.stringify(payload)).toContain('data:image/png;base64,cGl4ZWw=');
    expect(JSON.stringify(payload)).not.toContain('asset-media:');
    expect(JSON.stringify(payload)).toContain('horizonNormalized');
    expect(JSON.stringify(payload)).toContain('heightMeters');
    expect(JSON.stringify(payload)).toContain('vertical FOV');
  });
  it('does not send pre-cancelled requests or return late results after stopping', async () => {
    vi.mocked(submitCustomChatCompletion).mockClear();
    const controller = new AbortController();
    controller.abort();
    await expect(draftStageScene({ prompt: 'Room' }, controller.signal)).rejects.toThrow();
    expect(submitCustomChatCompletion).not.toHaveBeenCalled();
    await setChannelCredential('stage-chat', 'stage-key');
    const running = new AbortController();
    vi.mocked(submitCustomChatCompletion).mockImplementationOnce(async () => {
      running.abort();
      return { text: JSON.stringify({ version: 1, description: 'Room', objects: [] }), raw: {} };
    });
    await expect(draftStageScene({ prompt: 'Room', modelId: draftModelId }, running.signal)).rejects.toThrow();
    expect(useCanvasStore.getState().history.past).toHaveLength(0);
  });
  it('rejects unavailable models and malformed output without changing the graph', async () => {
    useChannelStore.setState({ channels: [] });
    await expect(draftStageScene({ prompt: 'A room' })).rejects.toThrow(/explicitly/);
    await expect(draftStageScene({ prompt: 'A room', modelId: 'missing-model' })).rejects.toThrow(/Configure/);
    const profile = { ...openAIStandardProfile, id: 'stage-chat', models: [{ id: 'gpt-stage', operations: ['chat' as const], params: openAIStandardProfile.models.find((model) => model.operations.includes('chat'))!.params }] };
    useChannelStore.setState({ channels: [{ profile, origin: 'native', migrationIssues: [], createdAt: 1, updatedAt: 1 }] });
    await setChannelCredential('stage-chat', 'stage-key');
    vi.mocked(submitCustomChatCompletion).mockResolvedValue({ text: '{"objects": [{"presetId":"invented-mesh"}]}', raw: {} });
    await expect(draftStageScene({ prompt: 'A room', modelId: draftModelId })).rejects.toThrow(/Invalid scene draft/);
    expect(useCanvasStore.getState().history.past).toHaveLength(0);
    expect(stageCommands.query('stage').data.items).toEqual([person]);
  });
  it('rejects image drafts without uncertainty or with contradictory metric camera height', async () => {
    vi.mocked(getAssetPortableSource).mockResolvedValue('data:image/png;base64,cGl4ZWw=');
    vi.mocked(resolveAsset).mockResolvedValue({ id: 'uploaded-image', kind: 'image', source: 'asset-media:library', name: 'Reference', origin: 'uploaded', createdAt: 1, favorite: false, metadata: {} });
    const request = { prompt: 'Room', modelId: draftModelId, images: ['uploaded-image'] };
    vi.mocked(submitCustomChatCompletion).mockResolvedValue({ text: JSON.stringify({ version: 1, description: 'Draft', objects: [] }), raw: {} });
    await expect(draftStageScene(request)).rejects.toThrow(/uncertainty/);
    vi.mocked(submitCustomChatCompletion).mockResolvedValue({ text: JSON.stringify({ version: 1, description: 'Draft', objects: [], camera: { position: { x: 0, y: 3, z: 6 }, target: { x: 0, y: 1, z: 0 }, fov: 45 }, estimation: { cameraHeightM: 1.6, uncertainty: ['Unknown lens'] } }), raw: {} });
    await expect(draftStageScene(request)).rejects.toThrow(/contradicts/);
    expect(useCanvasStore.getState().history.past).toHaveLength(0);
  });
});

describe('existing V1 timeline overlap and split contracts', () => {
  it('keeps latest-start camera rig priority, later array tie priority and rig-over-track precedence after reload', () => {
    const project = normalizeDirectorMotionProject({
      durationSeconds: 8,
      cameraTrack: [{ id: 'fixed', time: 0, easing: 'hold', position: { x: 9, y: 2, z: 9 }, target: { x: 0, y: 0, z: 0 }, fov: 45 }],
      cameraRigs: [
        { id: 'early', kind: 'follow', targetId: person.id, start: 1, end: 7 },
        { id: 'later', kind: 'follow', targetId: person.id, start: 2, end: 6 },
        { id: 'later-tie', kind: 'closeup', targetId: person.id, start: 2, end: 5 },
      ],
    });
    const reloaded = normalizeDirectorMotionProject(JSON.parse(JSON.stringify(project)));
    expect(sampleDirectorMotion(reloaded, 0, [person]).camera?.position.x).toBe(9);
    expect(sampleDirectorMotion(reloaded, 1.5, [person]).camera?.rigId).toBe('early');
    expect(sampleDirectorMotion(reloaded, 3, [person]).camera?.rigId).toBe('later-tie');
    expect(sampleDirectorMotion(reloaded, 5.5, [person]).camera?.rigId).toBe('later');
    expect(sampleDirectorMotion(reloaded, 6.5, [person]).camera?.rigId).toBe('early');
  });
  it('keeps later action placements authoritative when splitting an interrupted clip with a phase offset', () => {
    const project = { ...createEmptyDirectorMotionProject(8), customClips: [clip], actionTracks: { person: [
      { id: 'placed', time: 0, easing: 'hold' as const, clipId: clip.id, actionOffsetSeconds: 0.5 },
      { id: 'interrupt', time: 3, easing: 'hold' as const, pose: { head: { y: -0.4 } } },
    ] } };
    const result = splitDirectorMotionClip(project, clip.id, 2);
    const reloaded = normalizeDirectorMotionProject(JSON.parse(JSON.stringify(result.project)));
    for (const time of [0, 1, 1.5, 2.5, 3, 3.5, 7]) {
      expect(sampleDirectorMotion(reloaded, time).actions.person.pose?.head?.y)
        .toBeCloseTo(sampleDirectorMotion(project, time).actions.person.pose?.head?.y ?? 0, 7);
    }
    expect(sampleDirectorMotion(reloaded, 3).actions.person.pose?.head?.y).toBe(-0.4);
  });
  it('rejects a split of a placed looping clip without changing placements or history', () => {
    stageCommands.execute('stage', [
      { type: 'clip.add', clip: { ...clip, loop: true } },
      { type: 'keyframe.add', track: { kind: 'action', itemId: person.id }, keyframe: { id: 'placed', time: 0, easing: 'hold', clipId: clip.id } },
    ]);
    const before = useCanvasStore.getState();
    expect(() => stageCommands.execute('stage', { type: 'clip.split', clipId: clip.id, clipStart: 0, time: 2 })).toThrow(/Unloop/);
    expect(useCanvasStore.getState().nodes).toBe(before.nodes);
    expect(useCanvasStore.getState().history.past).toBe(before.history.past);
  });
  it('protects looping placement duration and allows shortening to a nonlooping offset clip end', () => {
    const project = { ...createEmptyDirectorMotionProject(8), customClips: [clip], actionTracks: { person: [{ id: 'placed', time: 1, easing: 'hold' as const, clipId: clip.id, actionOffsetSeconds: 2 }] } };
    const data = { ...scene(), motionProject: project };
    expect(() => prepareStageCommands(data, [{ type: 'playback.update', duration: 4.9 }])).toThrow(/shortening/);
    expect(prepareStageCommands(data, [{ type: 'playback.update', duration: 5 }]).data.motionProject!.durationSeconds).toBe(5);
    const looping = { ...data, motionProject: { ...project, customClips: [{ ...clip, loop: true }] } };
    expect(() => prepareStageCommands(looping, [{ type: 'playback.update', duration: 7 }])).toThrow(/shortening/);
    expect(() => prepareStageCommands(data, [{ type: 'clip.update', clipId: clip.id, patch: { durationSeconds: 3 } }])).toThrow(/Time/);
  });
});
