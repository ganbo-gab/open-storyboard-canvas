import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanvasStore } from '@/stores/canvasStore';
import { CANVAS_NODE_TYPES, type CanvasNode, type CanvasNodeType } from '../domain/canvasNodes';
import { collectDownloadableMedia, saveNodesToAssets } from './selectionAssets';
import { buildCanvasNodeTree } from './canvasNodeTree';
import type { AssetRecord } from '@/features/assets/application/assetCatalog';

const storage = vi.hoisted(() => ({ save: vi.fn(), persist: vi.fn() }));
vi.mock('@/features/assets/application/assetCatalog', () => ({ saveAsset: storage.save }));
vi.mock('@/features/assets/application/assetMediaStorage', () => ({ persistAssetMedia: storage.persist }));

function node(id: string, type: CanvasNodeType, data: CanvasNode['data']): CanvasNode {
  return { id, type, data, position: { x: 0, y: 0 } };
}
beforeEach(() => {
  vi.clearAllMocks();
  storage.persist.mockImplementation(async (source: string) => source.startsWith('https:') ? '/durable/imported.mp4' : source);
  storage.save.mockImplementation(async (input: Omit<AssetRecord, 'id' | 'createdAt' | 'favorite'>) => ({ ...input, id: `asset-${input.nodeId}`, createdAt: 1, favorite: false }));
  useCanvasStore.setState({ nodes: [], edges: [], selectedNodeId: null });
});

describe('selection assets', () => {
  it('saves durable image/video/audio and authored text while skipping missing, empty and session-only sources', async () => {
    useCanvasStore.setState({ nodes: [
      node('image', CANVAS_NODE_TYPES.upload, { imageUrl: '/durable/image.png', aspectRatio: '1:1' }),
      node('video', CANVAS_NODE_TYPES.video, { videoUrl: 'https://media.example/video.mp4', aspectRatio: '16:9' }),
      node('audio', CANVAS_NODE_TYPES.audio, { audioUrl: `asset-media:audio%2Fwav:${'a'.repeat(64)}` }),
      node('text', CANVAS_NODE_TYPES.textAnnotation, { content: 'An authored shot description' }),
      node('blob', CANVAS_NODE_TYPES.upload, { imageUrl: 'blob:expired', aspectRatio: '1:1' }),
      node('data', CANVAS_NODE_TYPES.upload, { imageUrl: 'data:image/png;base64,AA==', aspectRatio: '1:1' }),
      node('unsafe', CANVAS_NODE_TYPES.video, { videoUrl: 'javascript:alert(1)', aspectRatio: '16:9' }),
      node('empty', CANVAS_NODE_TYPES.upload, { imageUrl: null, aspectRatio: '1:1' }),
    ] });
    const ids = ['image', 'video', 'audio', 'text', 'blob', 'data', 'unsafe', 'empty', 'missing'];
    expect(await saveNodesToAssets(ids, { name: 'Saved shot', tags: ['hero', 'hero'] })).toEqual({
      assetIds: ['asset-image', 'asset-video', 'asset-audio', 'asset-text'], skipped: ['blob', 'data', 'unsafe', 'empty', 'missing'],
    });
    expect(storage.persist).toHaveBeenCalledTimes(3);
    expect(storage.save).toHaveBeenCalledWith(expect.objectContaining({ nodeId: 'video', source: '/durable/imported.mp4', name: 'Saved shot', metadata: expect.objectContaining({ tags: ['hero'] }) }));
    expect(storage.save).toHaveBeenCalledWith(expect.objectContaining({ nodeId: 'text', kind: 'text', source: 'An authored shot description' }));
  });

  it('collects durable visible media and authored text with safe extension-free download stems', () => {
    useCanvasStore.setState({ nodes: [
      node('image', CANVAS_NODE_TYPES.upload, { imageUrl: '/durable/image.png', aspectRatio: '1:1', displayName: 'shot/one', generatedFileName: 'take:1.png' }),
      node('audio', CANVAS_NODE_TYPES.audio, { audioUrl: '/durable/audio.wav', displayName: 'Voice' }),
      node('text', CANVAS_NODE_TYPES.textAnnotation, { content: 'asset-media:literal text', displayName: 'Script' }),
      node('blob', CANVAS_NODE_TYPES.upload, { imageUrl: 'blob:temporary', aspectRatio: '1:1' }),
    ] });
    expect(collectDownloadableMedia(['image', 'audio', 'text', 'blob'])).toEqual([
      { nodeId: 'image', kind: 'image', source: '/durable/image.png', fileStem: 'take_1' },
      { nodeId: 'audio', kind: 'audio', source: '/durable/audio.wav', fileStem: 'Voice' },
      { nodeId: 'text', kind: 'text', source: 'asset-media:literal text', fileStem: 'Script' },
    ]);
  });
});

describe('canvas node tree', () => {
  it('groups by node type with authored titles and parent links, without mutating inputs', () => {
    const nodes = [node('video', CANVAS_NODE_TYPES.video, { displayName: 'Closing shot', videoUrl: '/durable/video.mp4', aspectRatio: '16:9' }),
      { ...node('image', CANVAS_NODE_TYPES.upload, { displayName: 'Reference', imageUrl: '/reference.png', aspectRatio: '1:1' }), parentId: 'group' },
      node('image-two', CANVAS_NODE_TYPES.upload, { displayName: 'Lighting', imageUrl: '/lighting.png', aspectRatio: '1:1' })];
    const before = JSON.stringify(nodes);
    expect(buildCanvasNodeTree(nodes)).toEqual([
      { kind: CANVAS_NODE_TYPES.upload, count: 2, items: [{ nodeId: 'image', title: 'Reference', parentId: 'group' }, { nodeId: 'image-two', title: 'Lighting' }] },
      { kind: CANVAS_NODE_TYPES.video, count: 1, items: [{ nodeId: 'video', title: 'Closing shot' }] },
    ]);
    expect(JSON.stringify(nodes)).toBe(before);
  });
});
