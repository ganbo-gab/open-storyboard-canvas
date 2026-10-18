import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CANVAS_NODE_TYPES, type BlueprintNodeData, type DirectorActionClip } from '@/features/canvas/domain/canvasNodes';
import { createEmptyDirectorMotionProject, normalizeDirectorMotionProject, sampleDirectorMotion, splitDirectorMotionClip } from '@/features/canvas/application/directorMotion';
import { useCanvasStore } from '@/stores/canvasStore';
import { registerStageViewport, stageCommands, stageCommandSchema } from './stageCommands';
import { prepareStageCommands } from './stageOperations';
import { draftStageScene } from './stageDrafting';
import { AGNES_PROVIDER_DEFAULTS, useCustomProvidersStore } from '@/stores/customProvidersStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { submitCustomChatCompletion } from '@/features/canvas/infrastructure/customProviderGateway';
import type * as ProviderGateway from '@/features/canvas/infrastructure/customProviderGateway';
import { getAssetPortableSource, resolveAsset } from '@/features/assets/application/assetCatalog';
vi.mock('@/features/assets/application/assetCatalog', () => ({ getAssetPortableSource: vi.fn(async (source: string) => source), resolveAsset: vi.fn(async () => null) }));
vi.mock('@/features/canvas/infrastructure/customProviderGateway', async (importOriginal) => ({ ...await importOriginal<typeof ProviderGateway>(), submitCustomChatCompletion: vi.fn() }));
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
beforeEach(() => {
  vi.mocked(resolveAsset).mockReset();
  vi.mocked(resolveAsset).mockResolvedValue(null);
  useCanvasStore.setState({ nodes: [{ id: 'stage', type: CANVAS_NODE_TYPES.blueprint, position: { x: 0, y: 0 }, data: scene() }], edges: [], revision: 0, selectedNodeId: 'stage', activeDirectorStudioNodeId: null, activeToolDialog: null, history: { past: [], future: [] }, dragHistorySnapshot: null });
});
describe('StageCommands transactions', () => {
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
      expect(actual).toBeCloseTo(expected!);
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
    useCustomProvidersStore.setState({ providers: [] });
    useSettingsStore.setState({ agnesApiKey: 'test-key' });
    vi.mocked(getAssetPortableSource).mockResolvedValue('data:image/png;base64,cGl4ZWw=');
    vi.mocked(resolveAsset).mockResolvedValue({ id: 'uploaded-image', kind: 'image', source: 'asset-media:library', name: 'Reference', origin: 'uploaded', createdAt: 1, favorite: false, metadata: {} });
    vi.mocked(submitCustomChatCompletion).mockResolvedValue({ text: JSON.stringify({ version: 1, description: 'Draft', objects: [] }), raw: {} });
    const modelId = `agnes:chat:${AGNES_PROVIDER_DEFAULTS.models.chat25Flash}`;
    await draftStageScene({ prompt: 'Room', modelId, images: ['uploaded-image'] });
    expect(getAssetPortableSource).toHaveBeenCalledWith('asset-media:library');
    useCanvasStore.setState({ nodes: [{ id: 'image', type: CANVAS_NODE_TYPES.upload, position: { x: 0, y: 0 }, data: { imageUrl: 'asset-media:canvas', aspectRatio: '1:1' } }] });
    await draftStageScene({ prompt: 'Room', modelId, images: ['image:image'] });
    expect(getAssetPortableSource).toHaveBeenCalledWith('asset-media:canvas');
    const payload = vi.mocked(submitCustomChatCompletion).mock.lastCall?.[1];
    expect(JSON.stringify(payload)).toContain('data:image/png;base64,cGl4ZWw=');
    expect(JSON.stringify(payload)).not.toContain('asset-media:');
  });
  it('does not send pre-cancelled requests or return late results after stopping', async () => {
    vi.mocked(submitCustomChatCompletion).mockClear();
    const controller = new AbortController();
    controller.abort();
    await expect(draftStageScene({ prompt: 'Room' }, controller.signal)).rejects.toThrow();
    expect(submitCustomChatCompletion).not.toHaveBeenCalled();
    useCustomProvidersStore.setState({ providers: [] });
    useSettingsStore.setState({ agnesApiKey: 'test-key' });
    const running = new AbortController();
    vi.mocked(submitCustomChatCompletion).mockImplementationOnce(async () => {
      running.abort();
      return { text: JSON.stringify({ version: 1, description: 'Room', objects: [] }), raw: {} };
    });
    await expect(draftStageScene({ prompt: 'Room', modelId: `agnes:chat:${AGNES_PROVIDER_DEFAULTS.models.chat25Flash}` }, running.signal)).rejects.toThrow();
    expect(useCanvasStore.getState().history.past).toHaveLength(0);
  });
  it('rejects unavailable models and malformed output without changing the graph', async () => {
    useCustomProvidersStore.setState({ providers: [] });
    useSettingsStore.setState({ agnesApiKey: '' });
    await expect(draftStageScene({ prompt: 'A room' })).rejects.toThrow(/explicitly/);
    await expect(draftStageScene({ prompt: 'A room', modelId: 'missing-model' })).rejects.toThrow(/Configure/);
    useSettingsStore.setState({ agnesApiKey: 'test-key' });
    vi.mocked(submitCustomChatCompletion).mockResolvedValue({ text: '{"objects": [{"presetId":"invented-mesh"}]}', raw: {} });
    await expect(draftStageScene({ prompt: 'A room', modelId: `agnes:chat:${AGNES_PROVIDER_DEFAULTS.models.chat25Flash}` })).rejects.toThrow(/Invalid scene draft/);
    expect(useCanvasStore.getState().history.past).toHaveLength(0);
    expect(stageCommands.query('stage').data.items).toEqual([person]);
  });
});
