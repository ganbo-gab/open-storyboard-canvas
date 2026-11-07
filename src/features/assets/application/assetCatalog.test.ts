import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createAssetCatalogDocument, deleteAssetReference, deleteAssetReferences, downloadSourcesFor, favoriteAsset, filterAssets, groupAssetsByDate, listAssets, renameAsset, saveAsset, tagAssets, type AssetRecord } from './assetCatalog';
import { getProjectRecord, listProjectSummaries } from '@/commands/projectState';
import { readWorkspaceRecord } from './assetMediaStorage';
import { createWorkbenchStore } from '@/features/workbench/store/workbenchStore';
import { createLocalDocument } from '@/features/workbench/application/workbenchPersistence';
import { emptyWorkbenchData, type WorkbenchData } from '@/features/workbench/domain/types';

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
  it('adds deduplicated tags to the persisted index overlay and downloads originals, not previews', async () => {
    const saved = await saveAsset({ id: 'tagged', name: 'Tagged original', kind: 'image', source: '/media/original-full.png',
      previewUrl: '/media/preview-small.png', origin: 'uploaded', metadata: {} });
    await tagAssets([saved.id], ['  hero ', 'hero', 'exterior']);
    await tagAssets([saved.id], ['scene']);
    expect((await listAssets({ text: 'scene' })).find((asset) => asset.id === saved.id)?.tags).toEqual(['hero', 'exterior', 'scene']);
    const persisted = await readWorkspaceRecord<{ data: { overrides: Record<string, { tags?: string[] }> } }>('documents', 'storyboard-copilot:asset-catalog:v1');
    expect(persisted?.data.overrides[saved.id].tags).toEqual(['hero', 'exterior', 'scene']);
    expect(await downloadSourcesFor([saved.id, saved.id])).toEqual([{ id: saved.id, kind: 'image', name: saved.name, source: '/media/original-full.png' }]);
    expect(saved.metadata).toEqual({});
  });
  it('deletes a batch of references without modifying source project records or files', async () => {
    const one = await saveAsset({ id: 'batch-one', name: 'One', kind: 'video', source: '/media/one.mp4', origin: 'uploaded', metadata: {} });
    const two = await saveAsset({ id: 'batch-two', name: 'Two', kind: 'text', source: 'Original text', origin: 'canvas', metadata: {} });
    const before = await getProjectRecord('p');
    await deleteAssetReferences([one.id, two.id]);
    expect((await listAssets()).filter((asset) => asset.id === one.id || asset.id === two.id)).toEqual([]);
    expect(await getProjectRecord('p')).toEqual(before);
  });
  it('keeps generated assets in the catalogue after their workbench task and messages are deleted', async () => {
    const values: Record<string, string> = {};
    const document = createLocalDocument<WorkbenchData>('delete-task-assets', emptyWorkbenchData, (value) => value as WorkbenchData, {
      getItem: (key) => values[key] ?? null, setItem: (key, value) => { values[key] = value; },
    });
    const store = createWorkbenchStore({ document, transport: {
      submit: vi.fn(async () => ({ results: [{ kind: 'image' as const, source: '/media/retained.png' }] })),
      poll: vi.fn(), recover: vi.fn(),
    } });
    const id = await store.getState().submit({ kind: 'image', model: 'fixture-model', prompt: 'Keep this generated asset' });
    const assetId = store.getState().tasks[id].results[0].assetId;
    store.getState().deleteTask(id);
    expect(store.getState().tasks[id]).toBeUndefined();
    expect(Object.values(store.getState().messages).some((message) => message.taskId === id)).toBe(false);
    expect((await listAssets()).find((asset) => asset.id === assetId)).toMatchObject({ taskId: id, source: '/media/retained.png' });
  });
});

describe('asset metadata persistence', () => {
  it('reopens declared dimensions, resolution, model and full generation provenance from the durable index', async () => {
    const asset = await saveAsset({ id: 'metadata-roundtrip', name: 'Detailed output', kind: 'video', source: '/media/detailed.mp4',
      origin: 'generated', projectId: 'linked-project', taskId: 'generation-task',
      metadata: { width: 1920, height: 1080, model: 'custom:provider:model', config: { size: '1080p', aspectRatio: '16:9', seconds: 8 },
        prompt: 'Original complete prompt', references: [{ kind: 'image', source: '/reference.png' }], jobId: 'original-job', channelModeId: 'frames' } });
    await renameAsset(asset.id, 'Renamed output');
    await favoriteAsset(asset.id, true);
    const reopened = createAssetCatalogDocument();
    await reopened.initialize?.();
    const restored = reopened.load().saved[asset.id];
    expect(restored).toMatchObject({ source: '/media/detailed.mp4', projectId: 'linked-project', taskId: 'generation-task',
      metadata: { width: 1920, height: 1080, resolution: '1080p', aspectRatio: '16:9', model: 'custom:provider:model',
        jobId: 'original-job', channelModeId: 'frames', prompt: 'Original complete prompt',
        references: [{ kind: 'image', source: '/reference.png' }], config: { size: '1080p', aspectRatio: '16:9', seconds: 8 } } });
    expect(reopened.load().overrides[asset.id]).toMatchObject({ name: 'Renamed output', favorite: true });
    expect(filterAssets([restored], { resolution: '1080p', width: 1920, height: 1080, model: 'custom:provider:model' })).toEqual([restored]);
    expect(filterAssets([restored], { resolution: '1920x1080' })).toEqual([restored]);
    expect(filterAssets([restored], { width: 1280 })).toEqual([]);
  });

  it('normalizes legacy configured resolution without fabricating unknown pixel dimensions', async () => {
    const key = `legacy-assets:${crypto.randomUUID()}`;
    const legacy = { saved: { old: { id: 'old', kind: 'image', source: '/old.png', name: 'Old', origin: 'generated',
      createdAt: 1, favorite: false, metadata: { sourceModelId: 'old-model', config: { extraParams: { resolutionType: '2K' } }, width: -1 } } }, overrides: {} };
    values[key] = JSON.stringify({ version: 1, data: legacy });
    const document = createAssetCatalogDocument(key);
    await document.initialize?.();
    expect(document.status().mode).toBe('persistent');
    expect(document.load().saved.old.metadata).toMatchObject({ model: 'old-model', resolution: '2K', sourceModelId: 'old-model' });
    expect(document.load().saved.old.metadata.width).toBeUndefined();
    expect(document.load().saved.old.metadata.height).toBeUndefined();
    const reopened = createAssetCatalogDocument(key);
    await reopened.initialize?.();
    expect(reopened.load()).toEqual(document.load());
    expect(JSON.parse(values[key])).toEqual({ version: 1, data: legacy });
  });
});

describe('pure asset filtering and calendar groups', () => {
  const now = new Date(2026, 9, 31, 12).getTime();
  const assets: AssetRecord[] = [
    { id: 'old', name: 'Old', kind: 'text', source: 'Storm scene notes', origin: 'canvas', createdAt: new Date(2026, 9, 28, 20).getTime(), favorite: false, metadata: {} },
    { id: 'upload', name: 'Actor', kind: 'image', source: '/actor.png', origin: 'uploaded', createdAt: new Date(2026, 9, 30, 23).getTime(), favorite: true, tags: ['hero'], metadata: { aspectRatio: '3:2', sourceModelId: 'capture' } },
    { id: 'generated', name: 'Shot', kind: 'video', source: '/shot.mp4', origin: 'generated', createdAt: new Date(2026, 9, 31, 1).getTime(), favorite: false, metadata: { config: { aspectRatio: '16:9' }, model: 'video-model', prompt: 'A sunrise' } },
    { id: 'latest', name: 'Latest', kind: 'image', source: '/latest.png', origin: 'generated', createdAt: new Date(2026, 9, 31, 10).getTime(), favorite: true, metadata: { aspectRatio: '1:1' } },
  ];
  it('combines every filter and includes both date endpoints without mutating input', () => {
    const original = structuredClone(assets);
    expect(filterAssets(assets, { kind: 'image', origin: 'upload', ratio: '3:2', model: 'capture', text: 'hero', favorite: true,
      from: assets[1].createdAt, to: assets[1].createdAt }).map((asset) => asset.id)).toEqual(['upload']);
    expect(filterAssets(assets, { ratio: '16:9', model: 'video-model', text: 'SUNRISE' }).map((asset) => asset.id)).toEqual(['generated']);
    expect(filterAssets(assets, { origin: 'canvas', text: 'storm' }).map((asset) => asset.id)).toEqual(['old']);
    expect(filterAssets(assets, { favorite: false }).map((asset) => asset.id)).toEqual(['old', 'generated']);
    expect(assets).toEqual(original);
  });
  it('groups local calendar dates newest first while preserving original array order', () => {
    const groups = groupAssetsByDate(assets, now);
    expect(groups.map(({ key, period, assets: items }) => ({ key, period, ids: items.map((item) => item.id) }))).toEqual([
      { key: '2026-10-31', period: 'today', ids: ['latest', 'generated'] },
      { key: '2026-10-30', period: 'yesterday', ids: ['upload'] },
      { key: '2026-10-28', period: 'earlier', ids: ['old'] },
    ]);
    expect(assets.map((asset) => asset.id)).toEqual(['old', 'upload', 'generated', 'latest']);
    expect(groupAssetsByDate([], now)).toEqual([]);
  });
});
