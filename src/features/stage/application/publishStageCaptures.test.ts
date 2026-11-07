import { beforeEach, expect, it, vi } from 'vitest';
import { publishStageCaptures } from './publishStageCaptures';
import { useCanvasStore } from '@/stores/canvasStore';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { resolveAsset } from '@/features/assets/application/assetCatalog';

vi.mock('@/features/assets/application/assetCatalog', () => ({ resolveAsset: vi.fn() }));
beforeEach(() => {
  useCanvasStore.setState({ nodes: [{ id: 'stage', type: CANVAS_NODE_TYPES.blueprint, position: { x: 0, y: 0 }, data: { mode: 'flat', aspectRatio: '16:9', referenceImages: [], items: [] } }], edges: [], revision: 0, selectedNodeId: 'stage', history: { past: [], future: [] } });
  vi.mocked(resolveAsset).mockImplementation(async (id) => ({ id, kind: 'image', source: `asset-media:${id}`, name: id, origin: 'generated', favorite: false, createdAt: 1, metadata: {} }));
});
it('adds a four-view group and four provenance edges with exactly one undo', async () => {
  const ids = await publishStageCaptures('stage', ['front', 'right', 'back', 'left']);
  expect(ids).toHaveLength(4);
  expect(useCanvasStore.getState().edges).toHaveLength(4);
  expect(useCanvasStore.getState().history.past).toHaveLength(1);
  useCanvasStore.getState().undo();
  expect(useCanvasStore.getState().nodes.map((node) => node.id)).toEqual(['stage']);
  expect(useCanvasStore.getState().edges).toHaveLength(0);
});
it('does not publish a partial capture group if one asset is missing', async () => {
  vi.mocked(resolveAsset).mockResolvedValueOnce(null);
  await expect(publishStageCaptures('stage', ['missing', 'right'])).rejects.toThrow();
  expect(useCanvasStore.getState().nodes).toHaveLength(1);
  expect(useCanvasStore.getState().history.past).toHaveLength(0);
});
