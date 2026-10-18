import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkbenchStore } from './workbenchStore';
import { createLocalDocument } from '../application/workbenchPersistence';
import { classifyWorkbenchFailure, emptyWorkbenchData, type WorkbenchData, type WorkbenchSubmitInput } from '../domain/types';
import type { WorkbenchTransport } from '../application/workbenchTransport';
import { useCanvasStore } from '@/stores/canvasStore';
import type { AssetRecord } from '@/features/assets/application/assetCatalog';

const input: WorkbenchSubmitInput = { kind: 'image', prompt: 'A cat at sunset', model: 'custom:test:model', config: { size: '1K', aspectRatio: '1:1' } };
function fixture(options: { storage?: Pick<Storage, 'getItem' | 'setItem'>; transport?: WorkbenchTransport } = {}) {
  const values: Record<string, string> = {};
  const storage = options.storage ?? { getItem: (key: string) => values[key] ?? null, setItem: (key: string, value: string) => { values[key] = value; } };
  const transport = options.transport ?? { submit: vi.fn(async () => ({ jobId: 'job-1' })), poll: vi.fn(async () => ({ job_id: 'job-1', status: 'succeeded' as const, result: '/media/cat.png' })), recover: vi.fn(async () => undefined) };
  const document = createLocalDocument<WorkbenchData>('test', emptyWorkbenchData, (value) => value as WorkbenchData, storage);
  const saveResult = vi.fn(async (value: Omit<AssetRecord, 'id' | 'createdAt' | 'favorite'>) => ({ ...value, id: 'asset-1', createdAt: 1, favorite: false }));
  const store = createWorkbenchStore({ document, transport, saveResult });
  return { store, document, storage, transport, saveResult };
}
afterEach(() => vi.useRealTimers());

describe('non-canvas workbench', () => {
  it('submits real gateway work and preserves the entire canvas snapshot', async () => {
    const { store, transport } = fixture();
    const before = useCanvasStore.getState();
    const id = await store.getState().submit(input);
    expect(transport.submit).toHaveBeenCalledOnce();
    expect(transport.submit).toHaveBeenCalledWith(input, []);
    expect(store.getState().tasks[id].results).toEqual([{ kind: 'image', source: '/media/cat.png', assetId: 'asset-1' }]);
    expect(useCanvasStore.getState()).toBe(before);
  });
  it('restores conversations, prompt, model, references and results after reopening', async () => {
    const first = fixture();
    const id = await first.store.getState().submit({ ...input, references: [{ id: 'ref', kind: 'image', source: '/media/ref.png', name: 'Ref' }] });
    const conversationId = first.store.getState().tasks[id].conversationId;
    first.store.getState().renameConversation(conversationId, 'Saved conversation');
    const second = fixture({ storage: first.storage });
    await second.store.getState().initialize();
    expect(second.store.getState().conversations[conversationId].title).toBe('Saved conversation');
    expect(second.store.getState().tasks[id]).toEqual(first.store.getState().tasks[id]);
    expect(second.transport.submit).not.toHaveBeenCalled();
  });
  it('keeps ambiguous POST outcomes unknown and never resubmits on resume', async () => {
    const transport: WorkbenchTransport = { submit: vi.fn(async () => { throw new Error('Network timeout after send'); }), poll: vi.fn(), recover: vi.fn() };
    const { store } = fixture({ transport });
    const id = await store.getState().submit(input);
    expect(store.getState().tasks[id].status).toBe('unknown');
    expect(store.getState().tasks[id].failure?.kind).toBe('unknown-submit');
    await expect(store.getState().resume(id)).rejects.toThrow('不会重新提交');
    expect(transport.submit).toHaveBeenCalledOnce();
  });
  it('retains existing handle when lookup is missing and fetches without submit', async () => {
    const transport: WorkbenchTransport = { submit: vi.fn(async () => ({ jobId: 'existing' })), poll: vi.fn(async () => ({ job_id: 'existing', status: 'not_found' as const })), recover: vi.fn(async () => undefined) };
    const { store } = fixture({ transport });
    const id = await store.getState().submit(input);
    expect(store.getState().tasks[id].status).toBe('recoverable_wait');
    await store.getState().recoverResult(id);
    expect(store.getState().tasks[id].jobId).toBe('existing');
    expect(transport.submit).toHaveBeenCalledOnce();
    expect(transport.recover).toHaveBeenCalledOnce();
  });
  it('does not send paid requests when writing the local record fails', async () => {
    const { store, transport } = fixture({ storage: { getItem: () => null, setItem: () => { throw new DOMException('Full', 'QuotaExceededError'); } } });
    const id = await store.getState().submit(input);
    expect(transport.submit).not.toHaveBeenCalled();
    expect(store.getState().tasks[id].failure?.kind).toBe('storage');
    expect(store.getState().storageStatus.mode).toBe('memory');
  });
  it('cancels only local polling, preserving the task for explicit resume', async () => {
    vi.useFakeTimers();
    const transport: WorkbenchTransport = { submit: vi.fn(async () => ({ jobId: 'existing' })), poll: vi.fn(async () => ({ job_id: 'existing', status: 'running' as const })), recover: vi.fn() };
    const { store } = fixture({ transport });
    const id = await store.getState().submit(input);
    store.getState().cancelWaiting(id);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(transport.poll).toHaveBeenCalledOnce();
    expect(store.getState().tasks[id].status).toBe('running');
    await store.getState().resume(id);
    store.getState().cancelWaiting(id);
    expect(transport.poll).toHaveBeenCalledTimes(2);
  });
  it('does not copy task conversation identity into a draft reused in another conversation', async () => {
    const { store } = fixture();
    const originalId = await store.getState().submit(input);
    const original = store.getState().tasks[originalId];
    const other = store.getState().createConversation('Other conversation');
    store.getState().setDraft(original.input);
    expect(store.getState().draft).not.toHaveProperty('conversationId');
    const nextId = await store.getState().submit(store.getState().draft);
    expect(store.getState().tasks[nextId].conversationId).toBe(other);
    expect(store.getState().tasks[originalId].conversationId).toBe(original.conversationId);
  });
  it('merges only touched mount-time draft fields over the restored draft', async () => {
    const first = fixture();
    await first.store.getState().initialize();
    first.store.getState().setDraft({ prompt: 'Persisted prompt must survive', model: 'old-model', references: [{ id: 'saved', kind: 'image', source: '/media/saved.png' }], config: { size: '2K' } });
    const next = fixture({ storage: first.storage });
    next.store.getState().setDraft({ model: 'normalized-default-model' });
    await next.store.getState().initialize();
    expect(next.store.getState().draft).toMatchObject({ prompt: 'Persisted prompt must survive', model: 'normalized-default-model', references: [{ id: 'saved', source: '/media/saved.png' }], config: { size: '2K' } });
    expect(next.store.getState().storageStatus.mode).toBe('persistent');
    const restored = fixture({ storage: first.storage });
    await restored.store.getState().initialize();
    expect(restored.store.getState().draft.prompt).toBe('Persisted prompt must survive');
  });
});

describe('local document recovery and failures', () => {
  it('does not overwrite malformed or future-version stored values', () => {
    for (const raw of ['{bad', JSON.stringify({ version: 99, data: {} })]) {
      const setItem = vi.fn();
      const document = createLocalDocument('key', emptyWorkbenchData, (value) => value as WorkbenchData, { getItem: () => raw, setItem });
      expect(document.load()).toEqual(emptyWorkbenchData());
      document.save(emptyWorkbenchData());
      expect(setItem).not.toHaveBeenCalled();
      expect(document.status().mode).toBe('memory');
    }
  });
  it('distinguishes local storage, account quota, authentication and ambiguous submission', () => {
    expect(classifyWorkbenchFailure(new DOMException('Quota exceeded', 'QuotaExceededError')).kind).toBe('storage');
    expect(classifyWorkbenchFailure(new Error('insufficient_quota')).kind).toBe('quota');
    expect(classifyWorkbenchFailure(new Error('401 unauthorized')).kind).toBe('authentication');
    expect(classifyWorkbenchFailure(new Error('429 rate limit')).kind).toBe('rate-limit');
    expect(classifyWorkbenchFailure(new Error('Network timeout'), true).kind).toBe('unknown-submit');
    expect(classifyWorkbenchFailure(new Error('Network timeout')).kind).toBe('network');
  });
});
