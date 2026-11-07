import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('./assetEditing', () => ({ saveDerivedAsset: vi.fn() }));
vi.mock('./assetMediaStorage', async (original) => ({ ...await original<typeof import('./assetMediaStorage')>(), getAssetPortableSource: vi.fn(async (source: string) => source) }));
import { saveDerivedAsset } from './assetEditing';
import { captureCanvasAssetEditTarget, saveCanvasAssetEdit } from './canvasAssetEditing';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import type { AssetRecord } from './assetCatalog';
const saved: AssetRecord = { id: 'derived', kind: 'image', source: '/fixture/edited.png', name: 'Edited', origin: 'canvas', favorite: false, createdAt: 2,
  metadata: { editProvenance: { parentAssetId: 'original' } } };
beforeEach(() => {
  vi.mocked(saveDerivedAsset).mockResolvedValue(saved);
  useCanvasStore.getState().setCanvasData([{ id: 'source', type: 'uploadNode', position: { x: 0, y: 0 }, data: { imageUrl: '/fixture/original.png', displayName: 'Original', aspectRatio: '1:1' }, selected: true }], []);
  useProjectStore.setState({ currentProjectId: 'fixture-project', currentProject: null });
  vi.spyOn(useProjectStore.getState(), 'saveCurrentProject').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());
it('adds one durable derivative and source edge in one undoable transaction', async () => {
  const target = captureCanvasAssetEditTarget('source'); const original = useCanvasStore.getState().nodes[0];
  const history = useCanvasStore.getState().history.past.length;
  await saveCanvasAssetEdit(target, { kind: 'image', source: saved.source, width: 640, height: 360 }, { name: 'Edited', operations: ['crop'] }, 'derived');
  const state = useCanvasStore.getState();
  expect(state.nodes).toHaveLength(2); expect(state.edges).toHaveLength(1); expect(state.edges[0].source).toBe('source');
  expect(state.nodes[0].data).toEqual(original.data);
  expect(state.nodes[1].data).toMatchObject({ assetId: 'derived', imageUrl: saved.source, assetMetadata: saved.metadata });
  expect(state.history.past).toHaveLength(history + 1);
  state.undo(); expect(useCanvasStore.getState().nodes).toHaveLength(1); expect(useCanvasStore.getState().edges).toEqual([]);
});
it('does not add edited nodes into another project if navigation happens during saving', async () => {
  const target = captureCanvasAssetEditTarget('source');
  vi.mocked(saveDerivedAsset).mockImplementation(async () => { useProjectStore.setState({ currentProjectId: 'other' }); return saved; });
  expect(await saveCanvasAssetEdit(target, { kind: 'image', source: saved.source }, { name: 'Edited', operations: [] }, 'derived')).toEqual(saved);
  expect(useCanvasStore.getState().nodes).toHaveLength(1); expect(useProjectStore.getState().saveCurrentProject).not.toHaveBeenCalled();
});
it('rejects a changed source before persisting the derivative', async () => {
  const target = captureCanvasAssetEditTarget('source');
  useCanvasStore.getState().setCanvasData([{ ...useCanvasStore.getState().nodes[0], data: { imageUrl: '/changed.png', aspectRatio: '1:1' } }], []);
  vi.mocked(saveDerivedAsset).mockClear();
  await expect(saveCanvasAssetEdit(target, { kind: 'image', source: saved.source }, { name: 'Edited', operations: [] }, 'derived')).rejects.toThrow(/变更/);
  expect(saveDerivedAsset).not.toHaveBeenCalled();
});
