import 'fake-indexeddb/auto';
import { IDBObjectStore } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkbenchDocument } from './workbenchPersistence';
import { createWorkbenchStore } from '../store/workbenchStore';
import { getAssetDisplaySource, persistAssetMedia, readWorkspaceRecord } from '@/features/assets/application/assetMediaStorage';
import type { WorkbenchTransport } from './workbenchTransport';
import type { WorkbenchData } from '../domain/types';
import type { AssetRecord } from '@/features/assets/application/assetCatalog';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false, invoke: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=';

describe('IndexedDB workspace reload persistence', () => {
  it('commits binary references/results and restores with localStorage already full', async () => {
    const setItem = vi.fn(() => { throw new DOMException('Full origin storage', 'QuotaExceededError'); });
    vi.stubGlobal('localStorage', { getItem: () => null, setItem });
    const key = `test:workspace:${crypto.randomUUID()}`;
    const document = createWorkbenchDocument(key);
    const transport: WorkbenchTransport = {
      submit: vi.fn(async () => ({ results: [{ kind: 'image' as const, source: image }] })),
      poll: vi.fn(), recover: vi.fn(),
    };
    const saveResult = vi.fn(async (asset: Omit<AssetRecord, 'id' | 'createdAt' | 'favorite'>) => ({ ...asset, id: 'persisted-result', createdAt: 1, favorite: false }));
    const first = createWorkbenchStore({ document, transport, saveResult });
    const taskId = await first.getState().submit({ kind: 'image', model: 'custom:test:image', prompt: 'Durable cat', references: [{ id: 'reference', kind: 'image', source: image }] });
    await document.flush?.();
    expect(first.getState().tasks[taskId].status).toBe('succeeded');
    expect(first.getState().storageStatus.mode).toBe('persistent');
    expect(setItem).not.toHaveBeenCalled();
    const stored = await readWorkspaceRecord<{ version: number; data: WorkbenchData }>('documents', key);
    expect(JSON.stringify(stored)).not.toContain('data:image');
    expect(stored?.data.tasks[taskId].input.references?.[0].source).toMatch(/^asset-media:/);
    expect(stored?.data.tasks[taskId].results[0].source).toMatch(/^asset-media:/);
    const restoredDocument = createWorkbenchDocument(key);
    const second = createWorkbenchStore({ document: restoredDocument, transport, saveResult });
    await second.getState().initialize();
    const restored = second.getState().tasks[taskId];
    expect(restored.input.prompt).toBe('Durable cat');
    expect(restored.results).toEqual(first.getState().tasks[taskId].results);
    expect(transport.submit).toHaveBeenCalledOnce();
    const persistedBlob = await readWorkspaceRecord<Blob>('media', restored.results[0].source);
    expect(persistedBlob?.type).toBe('image/png');
    expect(persistedBlob?.size).toBeGreaterThan(0);
    const display = await getAssetDisplaySource(restored.results[0].source);
    expect((await (await fetch(display)).blob()).size).toBe(persistedBlob?.size);
  });
  it('migrates legacy inline media without changing or overwriting legacy localStorage', async () => {
    const key = `test:migrate:${crypto.randomUUID()}`;
    const legacy = { conversations: {}, messages: {}, tasks: {}, selectedConversationId: null,
      draft: { kind: 'image', prompt: '', model: '', references: [{ id: 'legacy', kind: 'image', source: image }] } };
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { getItem: (name: string) => name === key ? JSON.stringify({ version: 1, data: legacy }) : null, setItem });
    const document = createWorkbenchDocument(key);
    await document.initialize?.();
    await document.flush?.();
    expect(document.load().draft.references?.[0].source).toMatch(/^asset-media:/);
    expect(setItem).not.toHaveBeenCalled();
    const next = createWorkbenchDocument(key);
    await next.initialize?.();
    expect(next.load()).toEqual(document.load());
  });
  it('preserves restored history when Composer edits its draft during hydration', async () => {
    const key = `test:hydrate:${crypto.randomUUID()}`;
    const document = createWorkbenchDocument(key);
    const transport: WorkbenchTransport = { submit: vi.fn(async () => ({ results: [{ kind: 'text' as const, source: 'Saved answer' }] })), poll: vi.fn(), recover: vi.fn() };
    const saveResult = vi.fn(async (asset: Omit<AssetRecord, 'id' | 'createdAt' | 'favorite'>) => ({ ...asset, id: 'text', createdAt: 1, favorite: false }));
    const first = createWorkbenchStore({ document, transport, saveResult });
    const taskId = await first.getState().submit({ kind: 'chat', model: 'custom:test:chat', prompt: 'Original question' });
    first.getState().setDraft({ prompt: 'Saved draft prompt', model: 'previous-model', config: { size: '2K' } });
    await document.flush?.();
    const nextDocument = createWorkbenchDocument(key);
    const second = createWorkbenchStore({ document: nextDocument, transport, saveResult });
    second.getState().setDraft({ model: 'Mount-time default model' });
    await second.getState().initialize();
    await nextDocument.flush?.();
    expect(second.getState().tasks[taskId].input.prompt).toBe('Original question');
    expect(second.getState().draft).toMatchObject({ prompt: 'Saved draft prompt', model: 'Mount-time default model', config: { size: '2K' } });
    expect(second.getState().storageStatus.mode).toBe('persistent');
    const third = createWorkbenchDocument(key);
    await third.initialize?.();
    expect(third.load().tasks[taskId].results[0].source).toBe('Saved answer');
    expect(third.load().draft).toMatchObject({ prompt: 'Saved draft prompt', model: 'Mount-time default model', config: { size: '2K' } });
  });
  it('downloads generated remote media and safely retries only the download after failure', async () => {
    const realFetch = globalThis.fetch;
    let blocked = true;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (source, options) => {
      if (String(source) === 'https://cdn.example/result.png?signature=expiring') {
        if (blocked) throw new TypeError('Failed to fetch');
        return await realFetch(image);
      }
      return await realFetch(source, options);
    });
    const document = createWorkbenchDocument(`test:download:${crypto.randomUUID()}`);
    const transport: WorkbenchTransport = { submit: vi.fn(async () => ({ results: [{ kind: 'image' as const, source: 'https://cdn.example/result.png?signature=expiring' }] })), poll: vi.fn(), recover: vi.fn() };
    const saveResult = vi.fn(async (asset: Omit<AssetRecord, 'id' | 'createdAt' | 'favorite'>) => ({ ...asset, id: 'download', createdAt: 1, favorite: false }));
    const store = createWorkbenchStore({ document, transport, saveResult });
    const id = await store.getState().submit({ kind: 'image', model: 'custom:test:image', prompt: 'Download result' });
    expect(store.getState().tasks[id].status).toBe('recoverable_wait');
    expect(store.getState().tasks[id].results[0].source).toContain('signature=expiring');
    blocked = false;
    await store.getState().recoverResult(id);
    expect(store.getState().tasks[id].status).toBe('succeeded');
    expect(store.getState().tasks[id].results[0].source).toMatch(/^asset-media:/);
    expect(transport.submit).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls.filter(([source]) => String(source).startsWith('https://cdn.example/'))).toHaveLength(2);
  });
  it('isolates dead legacy blobs without blocking new tasks or losing original recovery handles', async () => {
    const key = `test:stale:${crypto.randomUUID()}`;
    const dead = 'blob:http://localhost:1420/dead-before-reload';
    const legacy: WorkbenchData = { conversations: { old: { id: 'old', title: 'Keep history', createdAt: 1, updatedAt: 2 } },
      messages: {}, selectedConversationId: 'old', draft: { kind: 'image', model: '', prompt: 'blob:this-is-prompt-text' },
      tasks: { oldTask: { id: 'oldTask', conversationId: 'old', input: { kind: 'image', model: 'custom:test:image', prompt: 'Original cat' },
        status: 'succeeded', jobId: 'custom-local-original', results: [{ kind: 'image', source: dead }], waitingCanceled: false, createdAt: 1, updatedAt: 2 } } };
    const original = JSON.stringify({ version: 1, data: legacy });
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { getItem: (name: string) => name === key ? original : null, setItem });
    const document = createWorkbenchDocument(key);
    const transport: WorkbenchTransport = { submit: vi.fn(async () => ({ results: [{ kind: 'image' as const, source: image }] })),
      poll: vi.fn(async () => ({ job_id: 'custom-local-original', status: 'succeeded' as const, result: image })), recover: vi.fn(async () => undefined) };
    const saveResult = vi.fn(async (asset: Omit<AssetRecord, 'id' | 'createdAt' | 'favorite'>) => ({ ...asset, id: 'new-result', createdAt: 3, favorite: false }));
    const store = createWorkbenchStore({ document, transport, saveResult });
    await store.getState().initialize();
    expect(store.getState().storageStatus.mode).toBe('persistent');
    expect(store.getState().tasks.oldTask).toMatchObject({ status: 'recoverable_wait', jobId: 'custom-local-original', results: [{ source: dead }], failure: { kind: 'interrupted' } });
    expect(store.getState().draft.prompt).toBe('blob:this-is-prompt-text');
    const id = await store.getState().submit({ kind: 'image', model: 'custom:test:image', prompt: 'New durable cat' });
    expect(store.getState().tasks[id].status).toBe('succeeded');
    await document.flush?.();
    const restored = createWorkbenchDocument(key);
    await restored.initialize?.();
    expect(restored.load().tasks.oldTask.results[0].source).toBe(dead);
    expect(restored.load().tasks[id].results[0].source).toMatch(/^asset-media:/);
    await store.getState().recoverResult('oldTask');
    expect(transport.recover).toHaveBeenCalledOnce();
    expect(transport.submit).toHaveBeenCalledOnce();
    expect(store.getState().tasks.oldTask.status).toBe('succeeded');
    expect(setItem).not.toHaveBeenCalled();
  });
  it('stores one binary copy across repeated edits of the same 5MB reference and restores its stable identity', async () => {
    const source = 'data:image/png;base64,' + 'A'.repeat(7_000_000);
    const put = vi.spyOn(IDBObjectStore.prototype, 'put');
    const objectUrl = vi.spyOn(URL, 'createObjectURL');
    const key = `test:deduplicate:${crypto.randomUUID()}`;
    const document = createWorkbenchDocument(key);
    const transport: WorkbenchTransport = { submit: vi.fn(), poll: vi.fn(), recover: vi.fn() };
    const store = createWorkbenchStore({ document, transport });
    await store.getState().initialize();
    const references = [{ id: 'large-reference', kind: 'image' as const, source }];
    store.getState().setDraft({ references });
    const committed = await Promise.all(Array.from({ length: 12 }, () => persistAssetMedia(source)));
    for (let index = 0; index < 12; index += 1) store.getState().setDraft({ prompt: `Edit ${index}` });
    await document.flush?.();
    const reference = committed[0];
    expect(new Set(committed).size).toBe(1);
    expect(store.getState().draft.references?.[0].source).toBe(reference);
    expect(put.mock.calls.filter(([, key]) => key === reference)).toHaveLength(1);
    expect(objectUrl).not.toHaveBeenCalled();
    const displays = await Promise.all(Array.from({ length: 12 }, () => getAssetDisplaySource(reference)));
    expect(new Set(displays).size).toBe(1);
    expect(objectUrl).toHaveBeenCalledOnce();
    const blob = await readWorkspaceRecord<Blob>('media', reference);
    expect(blob?.size).toBe(5_250_000);
    const restored = createWorkbenchDocument(key);
    await restored.initialize?.();
    expect(restored.load().draft.references?.[0].source).toBe(reference);
    expect(restored.load().draft.prompt).toBe('Edit 11');
  });
});
