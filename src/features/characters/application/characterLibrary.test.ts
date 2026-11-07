import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import type { AssetRecord } from '@/features/assets/application/assetCatalog';
import type { LocalDocument } from '@/features/workbench/application/workbenchPersistence';
import { readWorkspaceRecord, writeWorkspaceRecord } from '@/features/assets/application/assetMediaStorage';
import { saveAsset, resolveAsset } from '@/features/assets/application/assetCatalog';
import { CharacterLibrary, filterCharacters, type CharacterAssetPort } from './characterLibrary';
import { characterLibrary, createCharacterDocument, CHARACTER_LIBRARY_STORAGE_KEY } from './characterLibraryService';
import type { CharacterLibraryData } from '../domain/types';
import { characterVoiceCapability } from '../domain/types';
import { createCharacterLibraryStore } from '../store/characterLibraryStore';

vi.mock('@/commands/projectState', () => ({ getProjectRecord: vi.fn(), listProjectSummaries: vi.fn(async () => []) }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false, invoke: vi.fn() }));

function fixture() {
  let data: CharacterLibraryData = { characters: [] };
  let sequence = 0;
  const assets = new Map<string, AssetRecord>(['front', 'side', 'voice'].map((id) => [id, {
    id, name: id, source: `/persisted/${id}.png`, kind: id === 'voice' ? 'audio' : 'image', origin: 'uploaded', createdAt: 1, favorite: false, metadata: {},
  }]));
  const document: LocalDocument<CharacterLibraryData> = { load: () => data, save: (next) => { data = structuredClone(next); }, status: () => ({ mode: 'persistent' }) };
  const port: CharacterAssetPort = {
    resolveAsset: async (id) => assets.get(id) ?? null,
    async saveAsset(input) {
      const asset: AssetRecord = { ...input, source: `/persisted/import-${sequence}.png`, id: `saved-${++sequence}`, favorite: false, createdAt: 1 };
      assets.set(asset.id, asset); return asset;
    },
  };
  return { document, assets, port, service: new CharacterLibrary({ document, assets: port, now: () => 100 + sequence, nextId: () => `character-${++sequence}` }) };
}

describe('global character library mutations', () => {
  it('maintains ordered/main-image invariants through CRUD and clears main when the last image is removed', async () => {
    const { service, assets } = fixture();
    const created = await service.create({ name: ' Hero ', images: [{ assetId: 'front' }, { assetId: 'side' }], tags: [' lead ', 'lead'] });
    expect(created).toMatchObject({ name: 'Hero', mainImage: { assetId: 'front' }, tags: ['lead'] });
    await service.setMainImage(created.id, 'side');
    expect((await service.reorderImages(created.id, ['side', 'front'])).mainImage).toEqual({ assetId: 'side' });
    await expect(service.reorderImages(created.id, ['front', 'front'])).rejects.toMatchObject({ code: 'invalidImageOrder' });
    await expect(service.setMainImage(created.id, 'missing')).rejects.toMatchObject({ code: 'assetNotFound' });
    await service.update(created.id, { name: 'Renamed', description: ' A description ' });
    await expect(service.update(created.id, { name: 'x'.repeat(201) })).rejects.toMatchObject({ code: 'invalidInput' });
    await service.addTag(created.id, 'hero'); await service.addTag(created.id, 'hero'); await service.removeTag(created.id, 'lead');
    expect((await service.snapshot()).characters[0]).toMatchObject({ name: 'Renamed', description: 'A description', tags: ['hero'] });
    expect((await service.removeImage(created.id, 'side')).mainImage).toEqual({ assetId: 'front' });
    expect(await service.removeImage(created.id, 'front')).toMatchObject({ mainImage: null, images: [] });
    expect(await service.addImage(created.id, 'front')).toMatchObject({ mainImage: { assetId: 'front' } });
    await service.delete(created.id);
    expect((await service.snapshot()).characters).toEqual([]);
    expect(assets.has('front')).toBe(true);
    await expect(service.update(created.id, { name: 'Gone' })).rejects.toMatchObject({ code: 'notFound' });
  });
  it('rejects nonexistent/nonimage assets and invalid inputs without adding rows', async () => {
    const { service } = fixture();
    await expect(service.create({ name: ' ' })).rejects.toMatchObject({ code: 'invalidInput' });
    await expect(service.create({ name: 'x'.repeat(201) })).rejects.toMatchObject({ code: 'invalidInput' });
    await expect(service.createFromAsset('missing')).rejects.toMatchObject({ code: 'assetNotFound' });
    await expect(service.createFromAsset('voice')).rejects.toMatchObject({ code: 'imageRequired' });
    await expect(service.createFromCanvasImageNode({ id: 'n', imageUrl: null })).rejects.toMatchObject({ code: 'imageRequired' });
    expect((await service.snapshot()).characters).toEqual([]);
  });
  it('imports project assets into independent global references and imports canvas media before storing a character', async () => {
    const { service, assets } = fixture();
    assets.set('project:p:node:image', { ...assets.get('front')!, id: 'project:p:node:image', projectId: 'p', nodeId: 'node' });
    const fromAsset = await service.createFromAsset('project:p:node:image');
    expect(fromAsset.source).toEqual({ kind: 'asset', id: 'project:p:node:image' });
    expect(fromAsset.mainImage?.assetId).toMatch(/^saved-/);
    assets.delete('project:p:node:image');
    expect(assets.has(fromAsset.mainImage!.assetId)).toBe(true);
    const fromNode = await service.createFromCanvasImageNode({ id: 'canvas-image', imageUrl: 'blob:live-image', prompt: 'Original prompt' }, { name: 'Actor' });
    expect(fromNode.source).toEqual({ kind: 'canvasNode', id: 'canvas-image' });
    expect(assets.get(fromNode.mainImage!.assetId)).toMatchObject({ source: expect.stringMatching(/^\/persisted\//), metadata: { sourcePrompt: 'Original prompt' } });
    const byAssetId = await service.createFromCanvasImageNode({ id: 'existing', assetId: 'front', imageUrl: 'blob:ignored' });
    expect(byAssetId.mainImage).toEqual({ assetId: 'front' });
    expect(JSON.stringify((await service.snapshot()).characters)).not.toContain('blob:');
  });
  it('stores validated sample/provider references without pretending cloning is available', async () => {
    const { service } = fixture();
    const character = await service.create({ name: 'Voice', voice: { kind: 'sample', sampleAssetId: 'voice' } });
    expect(character.voice).toEqual({ kind: 'sample', sampleAssetId: 'voice' });
    await expect(service.update(character.id, { voice: { kind: 'sample', sampleAssetId: 'front' } })).rejects.toMatchObject({ code: 'audioRequired' });
    expect((await service.update(character.id, { voice: { kind: 'provider', providerId: 'configured', voiceId: 'voice-ref' } })).voice).toEqual({ kind: 'provider', providerId: 'configured', voiceId: 'voice-ref' });
    expect(characterVoiceCapability).toMatchObject({ voiceCloneAvailable: false, reason: expect.any(String) });
  });
  it('serializes concurrent writers and filters by name and all requested tags', async () => {
    const { service } = fixture();
    await Promise.all([service.create({ name: 'Alice', tags: ['Lead', 'Drama'] }), service.create({ name: 'Bob', tags: ['Support'] })]);
    const rows = (await service.snapshot()).characters;
    expect(rows).toHaveLength(2);
    expect(filterCharacters(rows, { search: '@ali', tags: ['lead', 'drama'] }).map((row) => row.name)).toEqual(['Alice']);
    expect(filterCharacters(rows, { search: 'support' }).map((row) => row.name)).toEqual(['Bob']);
    expect(filterCharacters(rows, { tags: ['lead', 'support'] })).toEqual([]);
  });
  it('exposes store selection, session-only storage failures and recoverable action errors', async () => {
    const { service, document } = fixture();
    const store = createCharacterLibraryStore(service);
    await store.getState().initialize();
    const character = await store.getState().createFromAsset('front');
    expect(store.getState().selectedId).toBe(character?.id);
    expect(await store.getState().setMainImage(character!.id, 'missing')).toBeNull();
    expect(store.getState()).toMatchObject({ pendingCount: 0, error: { code: 'assetNotFound', messageKey: 'characters.errors.assetNotFound' } });
    document.status = () => ({ mode: 'memory', reason: 'Disk full' });
    expect(await store.getState().updateCharacter(character!.id, { name: 'Session only' })).toBeNull();
    expect(store.getState()).toMatchObject({ storageStatus: { mode: 'memory' }, error: { code: 'storage' } });
    document.status = () => ({ mode: 'persistent' });
    expect(await store.getState().deleteCharacter(character!.id)).toBe(true);
    expect(store.getState().selectedId).toBeNull();
  });
});

describe('character durable workspace boundary', () => {
  it('migrates independently persisted records with per-entry diagnostics and reloads across document instances', async () => {
    const key = 'character-test:migration';
    await writeWorkspaceRecord('documents', key, { version: 1, data: { characters: [{ id: 'c', name: 'Global', images: ['front'] }, { id: 'bad', name: '' }] } });
    const first = createCharacterDocument(key);
    await first.document.initialize?.();
    expect(first.normalizationIssues()).toEqual([expect.objectContaining({ characterId: 'bad', action: 'dropped' })]);
    const second = createCharacterDocument(key);
    await second.document.initialize?.();
    expect(second.document.load().characters).toEqual(first.document.load().characters);
    expect(second.document.status()).toEqual({ mode: 'persistent' });
  });
  it('imports real data-image bytes through the asset save path and persists only durable asset ids', async () => {
    const fromNode = await characterLibrary.createFromCanvasImageNode({ id: 'durable-test-image', imageUrl: 'data:image/png;base64,AQID', prompt: 'Durable reference' }, { name: 'Durable Actor' });
    const media = await resolveAsset(fromNode.mainImage!.assetId);
    expect(media?.source).toMatch(/^asset-media:image%2Fpng:[a-f0-9]{64}$/);
    const storedBytes = await readWorkspaceRecord<Blob>('media', media!.source);
    expect(Array.from(new Uint8Array(await storedBytes!.arrayBuffer()))).toEqual([1, 2, 3]);
    const direct = await saveAsset({ name: 'Existing durable image', source: 'data:image/png;base64,BAUG', kind: 'image', origin: 'uploaded', metadata: {} });
    const fromAsset = await characterLibrary.createFromAsset(direct.id);
    expect(fromAsset.mainImage).toEqual({ assetId: direct.id });
    const persisted = await readWorkspaceRecord<{ version: number; data: CharacterLibraryData }>('documents', CHARACTER_LIBRARY_STORAGE_KEY);
    expect(persisted?.data.characters).toEqual(expect.arrayContaining([fromNode, fromAsset]));
    expect(JSON.stringify(persisted)).not.toMatch(/blob:|data:image/);
    const reloaded = createCharacterDocument(); await reloaded.document.initialize?.();
    expect(reloaded.document.load().characters).toEqual(persisted?.data.characters);
  });
});
