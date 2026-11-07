import { describe, expect, it } from 'vitest';
import { CANVAS_CLIPBOARD_PREFIX, decodeCanvasClipboard, encodeCanvasClipboard } from './canvasClipboardFormat';
import { clipboardMaterialSources } from './clipboardIO';
import type { CanvasClipboardSnapshot } from './clipboardIO';
import { CANVAS_NODE_TYPES, type CanvasNodeType } from '../domain/canvasNodes';
import { getNodeDefinition } from '../domain/nodeRegistry';
const snapshot: CanvasClipboardSnapshot = { nodes: [{ id: 'a', type: 'imageNode', position: { x: 30, y: 40 }, width: 520, height: 300, data: { imageUrl: null, prompt: 'Editable', aspectRatio: '1:1', resolution: '2K', modelConfig: { entryId: 'test:model', ratio: '1:1' } } }], edges: [] };
function storedNode(type: CanvasNodeType, patch: Record<string, unknown>) {
  return CANVAS_CLIPBOARD_PREFIX + JSON.stringify({ version: 1, nodes: [{ id: 'node', type, position: { x: 0, y: 0 }, data: patch }], edges: [] });
}
describe('portable canvas clipboard format', () => {
  it('round-trips node configuration and dimensions without an in-memory snapshot', () => {
    const encoded = encodeCanvasClipboard(snapshot);
    expect(encoded.startsWith(CANVAS_CLIPBOARD_PREFIX)).toBe(true);
    expect(decodeCanvasClipboard(encoded)?.nodes[0]).toMatchObject(snapshot.nodes[0]);
    expect(decodeCanvasClipboard('ordinary outside text')).toBeNull();
  });
  it('rejects invalid versions, nonfinite geometry, unknown nodes, duplicated identities and cyclic groups', () => {
    const serialize = (value: unknown) => CANVAS_CLIPBOARD_PREFIX + JSON.stringify(value);
    for (const value of [
      { ...snapshot, version: 2 }, { version: 1, ...snapshot, nodes: [{ ...snapshot.nodes[0], position: { x: null, y: 0 } }] },
      { version: 1, nodes: [{ ...snapshot.nodes[0], type: 'injected' }], edges: [] },
      { version: 1, nodes: [snapshot.nodes[0], snapshot.nodes[0]], edges: [] },
      { version: 1, nodes: [{ ...snapshot.nodes[0], parentId: 'a' }], edges: [] },
    ]) expect(() => decodeCanvasClipboard(serialize(value))).toThrow();
  });
  it('recognizes native file paths and standalone media sources, preserving normal prose', () => {
    expect(clipboardMaterialSources(['/tmp/test.mov', 'C:\\Images\\ref.png', 'file:///tmp/test%20audio.wav'])).toEqual([
      { kind: 'video', source: '/tmp/test.mov', fileName: 'test.mov' },
      { kind: 'image', source: 'C:\\Images\\ref.png', fileName: 'ref.png' },
      { kind: 'audio', source: 'file:///tmp/test%20audio.wav', fileName: 'test audio.wav' },
    ]);
    expect(clipboardMaterialSources(['https://example.test/image.png?token=fixture'])[0]?.kind).toBe('image');
    expect(clipboardMaterialSources(['Draw a picture called test.png'])).toEqual([]);
  });

  it.each(Object.values(CANVAS_NODE_TYPES))('round-trips the current %s defaults, media and extension configuration', type => {
    const data = { ...getNodeDefinition(type).createDefaultData(),
      imageUrl: '/fixture.png', previewImageUrl: null, videoUrl: '/fixture.mp4', audioUrl: '/fixture.wav',
      prompt: 'Keep this draft @图1', extraParams: { nested: { arbitrary: [1, true, null] } },
      modelConfig: { entryId: 'custom:channel:model', ratio: 'auto', duration: '5', resolution: '1080p',
        multimodal: ['image', 'audio'], extraParams: { context: 1_000_000, providerSpecial: { enabled: true } } },
      extension: { frames: 17, items: null, referenceImages: 'these names inside metadata are arbitrary JSON' },
    };
    const original: CanvasClipboardSnapshot = { nodes: [{ id: 'node', type, position: { x: 30, y: 40 }, data }], edges: [] };
    const decoded = decodeCanvasClipboard(encodeCanvasClipboard(original));
    expect(JSON.parse(JSON.stringify(decoded?.nodes[0].data))).toEqual(JSON.parse(JSON.stringify(data)));
  });

  it.each([
    [CANVAS_NODE_TYPES.storyboardGen, { frames: 1 }],
    [CANVAS_NODE_TYPES.storyboardGen, { frames: null }],
    [CANVAS_NODE_TYPES.storyboardGen, { frames: [null] }],
    [CANVAS_NODE_TYPES.storyboardGen, { frames: [{ id: 'shot' }] }],
    [CANVAS_NODE_TYPES.storyboardGen, { frames: [{ description: 'Missing identity' }] }],
    [CANVAS_NODE_TYPES.storyboardGen, { frames: [{ id: 'shot', description: 1 }] }],
    [CANVAS_NODE_TYPES.storyboardGen, { gridRows: 0 }],
    [CANVAS_NODE_TYPES.storyboardSplit, { frames: {} }],
    [CANVAS_NODE_TYPES.storyboardSplit, { frames: [{ id: 'frame', imageUrl: { url: '/image.png' } }] }],
    [CANVAS_NODE_TYPES.storyboardSplit, { frames: [{ id: 'frame', imageUrl: null, note: [], order: 1 }] }],
    [CANVAS_NODE_TYPES.storyboardSplit, { frames: [{ id: 'frame', imageUrl: null, note: '', order: 'first' }] }],
    [CANVAS_NODE_TYPES.tagGroup, { memberNodeIds: 1 }],
    [CANVAS_NODE_TYPES.tagGroup, { memberNodeIds: [null] }],
    [CANVAS_NODE_TYPES.tagGroup, { legacyMemberTagIds: 'tag' }],
    [CANVAS_NODE_TYPES.tagGroup, { unresolvedMemberIds: {} }],
    [CANVAS_NODE_TYPES.jsonCard, { displayFields: [{ path: 'value', label: 'Value', value: {} }] }],
    [CANVAS_NODE_TYPES.blueprint, { items: [null] }],
    [CANVAS_NODE_TYPES.blueprint, { items: [{ id: 'actor', label: 'Actor', x: 'left', y: 0, color: '#fff' }] }],
    [CANVAS_NODE_TYPES.blueprint, { referenceImages: [{ id: 'ref', url: 1, label: 'Ref' }] }],
    [CANVAS_NODE_TYPES.blueprint, { snapshotHistory: [false] }],
    [CANVAS_NODE_TYPES.blueprint, { directorStudioProjects: [{ id: 'project', name: 'Saved', createdAt: 1, updatedAt: 1, snapshot: { items: 1 } }] }],
    [CANVAS_NODE_TYPES.blueprint, { motionProject: { objectTracks: { actor: 1 } } }],
    [CANVAS_NODE_TYPES.blueprint, { motionProject: { cameraTrack: [null] } }],
    [CANVAS_NODE_TYPES.imageEdit, { prompt: null }],
    [CANVAS_NODE_TYPES.aiText, { prompt: {} }],
    [CANVAS_NODE_TYPES.upload, { imageUrl: 1 }],
    [CANVAS_NODE_TYPES.video, { videoUrl: ['/video.mp4'] }],
    [CANVAS_NODE_TYPES.audio, { audioUrl: false }],
    [CANVAS_NODE_TYPES.imageEdit, { referenceSlots: { images: [17] } }],
    [CANVAS_NODE_TYPES.imageEdit, { modelConfig: { entryId: [] } }],
  ] satisfies Array<[CanvasNodeType, Record<string, unknown>]>)('rejects damaged %s field shapes before they can enter the graph: %j', (type, patch) => {
    expect(() => decodeCanvasClipboard(storedNode(type, patch))).toThrow(/节点内容类型/);
  });

  it('validates all supplied nodes before returning any graph and leaves the source payload untouched', () => {
    const payload = { version: 1, nodes: [snapshot.nodes[0], { id: 'broken', type: CANVAS_NODE_TYPES.storyboardGen, position: { x: 0, y: 0 }, data: { frames: 1 } }], edges: [] };
    const original = structuredClone(payload);
    expect(() => decodeCanvasClipboard(CANVAS_CLIPBOARD_PREFIX + JSON.stringify(payload))).toThrow();
    expect(payload).toEqual(original);
  });

  it('keeps valid populated storyboard and director collections including extension fields', () => {
    const storyboard = { frames: [{ id: 'frame', imageUrl: '/frame.png', previewImageUrl: null, note: 'Shot', order: 0, sourceMetadata: { requestModel: 'custom/model', unknownDetail: true } }] };
    expect(decodeCanvasClipboard(storedNode(CANVAS_NODE_TYPES.storyboardSplit, storyboard))?.nodes[0].data.frames).toEqual(storyboard.frames);
    const item = { id: 'actor', label: 'Actor', x: 0.5, y: 1, color: '#fff', pos3d: { x: 0, y: 0, z: -1 }, importedModelId: 'model', customFlags: [true] };
    const reference = { id: 'ref', url: '/ref.png', label: 'Hero', sourceMetadata: { assetId: 'asset' } };
    const stage = { items: [item], referenceImages: [reference], snapshotHistory: ['/capture.png'],
      directorStudioProjects: [{ id: 'project', name: 'Saved', createdAt: 1, updatedAt: 2, snapshot: { mode: 'flat', items: [item], referenceImages: [reference], aspectRatio: '16:9' } }],
      motionProject: { schemaVersion: 1, durationSeconds: 4, loop: false, cameraTrack: [{ id: 'key', time: 0, position: { x: 0, y: 1, z: 2 }, target: { x: 0, y: 0, z: 0 }, fov: 40, easing: 'linear' }],
        objectTracks: {}, actionTracks: {}, customClips: [], cameraRigs: [] },
    };
    expect(decodeCanvasClipboard(storedNode(CANVAS_NODE_TYPES.blueprint, stage))?.nodes[0].data).toMatchObject(stage);
    expect(decodeCanvasClipboard(storedNode(CANVAS_NODE_TYPES.tagGroup, { memberNodeIds: ['actor'], legacyMemberTagIds: ['tag'], unresolvedMemberIds: ['missing'] }))?.nodes[0].data)
      .toMatchObject({ memberNodeIds: ['actor'], legacyMemberTagIds: ['tag'], unresolvedMemberIds: ['missing'] });
  });

  it('restores missing older fields from registry defaults and normalizes optional split-frame note/order', () => {
    expect(decodeCanvasClipboard(storedNode(CANVAS_NODE_TYPES.imageEdit, {}))?.nodes[0].data.prompt).toBe('');
    expect(decodeCanvasClipboard(storedNode(CANVAS_NODE_TYPES.tagGroup, {}))?.nodes[0].data.memberNodeIds).toEqual([]);
    expect(decodeCanvasClipboard(storedNode(CANVAS_NODE_TYPES.storyboardSplit, { frames: [{ id: 'frame', imageUrl: null }] }))?.nodes[0].data.frames)
      .toEqual([{ id: 'frame', imageUrl: null, note: '', order: 0 }]);
  });
});
