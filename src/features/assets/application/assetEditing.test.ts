import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/commands/projectState', () => ({ listProjectSummaries: vi.fn(async () => []), getProjectRecord: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false, invoke: vi.fn() }));
import { createDerivedAssetSaver, saveDerivedAsset } from './assetEditing';
import { createAssetCatalogDocument, listAssets, saveAsset, type AssetRecord } from './assetCatalog';
const original: AssetRecord = { id: 'original-fixture', name: 'Original', kind: 'image', source: '/fixture/original.png', previewUrl: '/fixture/thumb.png', origin: 'generated',
  createdAt: 1, favorite: true, projectId: 'p', nodeId: 'n', taskId: 'paid-original', metadata: { prompt: 'Original prompt', width: 1024, height: 1024, model: 'model', config: { size: '1K' } } };
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
});
describe('derived asset saves', () => {
  it('keeps the original record and bytes while saving new content and provenance', async () => {
    const before = structuredClone(original);
    const saved = await saveAsset(original);
    const derived = await saveDerivedAsset(saved, { kind: 'image', source: '/fixture/cropped.png', width: 480, height: 270 },
      { name: 'Edited', prompt: 'Updated explanation', operations: ['crop'] });
    expect(derived.id).not.toBe(original.id); expect(derived.source).toBe('/fixture/cropped.png'); expect(derived.previewUrl).toBeNull();
    expect(derived).not.toHaveProperty('nodeId'); expect(derived).not.toHaveProperty('taskId');
    expect(derived.metadata).toMatchObject({ width: 480, height: 270, aspectRatio: '480:270', resolution: '480×270', prompt: 'Updated explanation',
      editProvenance: { parentAssetId: original.id, parentNodeId: 'n', parentTaskId: 'paid-original', operations: ['crop'], parentMetadata: original.metadata } });
    expect((await listAssets()).find((asset) => asset.id === original.id)).toEqual(saved);
    expect(original).toEqual(before);
    const reopened = createAssetCatalogDocument(); await reopened.initialize?.();
    expect(reopened.load().saved[derived.id]).toEqual(derived);
  });
  it('rejects changed or deleted sources, aborted saves and attempts to overwrite the parent', async () => {
    const save = vi.fn<typeof saveAsset>();
    const resolve = vi.fn(async () => ({ ...original, source: '/changed.png' }));
    const derived = createDerivedAssetSaver({ resolve, save });
    const output = { kind: 'image' as const, source: '/edited.png' }; const details = { name: 'Edited', operations: ['rotate'] };
    await expect(derived(original, output, details)).rejects.toThrow(/变更/);
    await expect(derived(original, output, details, { id: original.id })).rejects.toThrow(/不能覆盖/);
    const controller = new AbortController(); controller.abort();
    await expect(derived(original, output, details, { signal: controller.signal })).rejects.toThrow('aborted');
    expect(save).not.toHaveBeenCalled();
  });
  it('propagates persistence failure without reporting a saved result', async () => {
    const save = vi.fn<typeof saveAsset>().mockRejectedValue(new Error('storage unavailable'));
    const derived = createDerivedAssetSaver({ resolve: async () => original, save });
    await expect(derived(original, { kind: 'text', source: 'Edited text' }, { name: 'Text copy', operations: ['text.edit'] })).rejects.toThrow('storage unavailable');
    expect(save).toHaveBeenCalledOnce();
  });
});
