import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { deleteAssetReference, favoriteAsset, listAssets, renameAsset, saveAsset } from './assetCatalog';
import { getProjectRecord, listProjectSummaries } from '@/commands/projectState';

vi.mock('@/commands/projectState', () => ({ getProjectRecord: vi.fn(), listProjectSummaries: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false, invoke: vi.fn() }));
const values: Record<string, string> = {};
beforeAll(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values[key] ?? null,
    setItem: (key: string, value: string) => { values[key] = value; },
    removeItem: (key: string) => { delete values[key]; },
  } });
  vi.mocked(listProjectSummaries).mockResolvedValue([{ id: 'p', name: 'Project', createdAt: 1, updatedAt: 2, nodeCount: 2 }]);
  vi.mocked(getProjectRecord).mockResolvedValue({ id: 'p', name: 'Project', createdAt: 1, updatedAt: 2, nodeCount: 2,
    nodesJson: JSON.stringify([
      { id: 'upload', type: 'uploadNode', position: { x: 0, y: 0 }, data: { imageUrl: '__img_ref__:0', displayName: 'Original upload', sourceFileName: 'original.png', aspectRatio: '3:2' } },
      { id: 'video', type: 'videoNode', position: { x: 0, y: 0 }, data: { videoUrl: '/media/generated.mp4', sourcePrompt: 'Original prompt', sourceModelId: 'original-model', durationSeconds: 8, aspectRatio: '16:9' } },
    ]), edgesJson: '[]', viewportJson: '{"x":0,"y":0,"zoom":1}', historyJson: '{"past":[],"future":[]}', imagePoolJson: '["/media/original.png"]',
  });
});
describe('asset catalogue reference ownership', () => {
  it('aggregates persisted uploads and generated project media with original metadata', async () => {
    const assets = await listAssets();
    expect(assets.find((asset) => asset.nodeId === 'upload')).toMatchObject({ source: '/media/original.png', origin: 'uploaded', metadata: { sourceFileName: 'original.png', aspectRatio: '3:2' } });
    expect(assets.find((asset) => asset.nodeId === 'video')).toMatchObject({ kind: 'video', origin: 'generated', metadata: { sourcePrompt: 'Original prompt', sourceModelId: 'original-model', durationSeconds: 8 } });
  });
  it('renames, favorites and hides library references without deleting project nodes or files', async () => {
    const asset = (await listAssets()).find((item) => item.nodeId === 'upload')!;
    await renameAsset(asset.id, 'Library title');
    await favoriteAsset(asset.id, true);
    expect(await listAssets({ favorite: true })).toEqual([expect.objectContaining({ id: asset.id, name: 'Library title' })]);
    await deleteAssetReference(asset.id);
    expect((await listAssets()).some((item) => item.id === asset.id)).toBe(false);
    const record = await getProjectRecord('p');
    expect(record?.nodesJson).toContain('Original upload');
    expect(record?.imagePoolJson).toContain('/media/original.png');
  });
  it('persists independently uploaded references and filters by kind and search', async () => {
    const saved = await saveAsset({ id: 'audio-upload', name: 'Voice sample', kind: 'audio', source: 'data:audio/wav;base64,AA==', origin: 'uploaded', metadata: { originalFileName: 'voice.wav' } });
    expect(await listAssets({ kind: 'audio', search: 'voice.wav' })).toEqual([saved]);
    await deleteAssetReference(saved.id);
    expect(await listAssets({ kind: 'audio' })).toEqual([]);
  });
});
