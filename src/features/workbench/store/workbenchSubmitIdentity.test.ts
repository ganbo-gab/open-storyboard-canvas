import { expect, it, vi } from 'vitest';
import { createWorkbenchStore } from './workbenchStore';
import { createLocalDocument } from '../application/workbenchPersistence';
import { emptyWorkbenchData, type WorkbenchData } from '../domain/types';
const barrier = vi.hoisted(() => ({ promise: Promise.resolve(), started: false }));
vi.mock('@/features/assets/application/assetMediaStorage', async () => {
  const original = await vi.importActual<typeof import('@/features/assets/application/assetMediaStorage')>('@/features/assets/application/assetMediaStorage');
  return { ...original, externalizeAssetMedia: async <T,>(value: T) => { barrier.started = true; await barrier.promise; return value; } };
});
it('keeps a submission in the original conversation while its media is being prepared', async () => {
  const gate = Promise.withResolvers<void>(); barrier.promise = gate.promise; barrier.started = false;
  const storage = { getItem: () => null, setItem: () => {} };
  const document = createLocalDocument<WorkbenchData>('identity', emptyWorkbenchData, () => emptyWorkbenchData(), storage);
  const store = createWorkbenchStore({ document, transport: { submit: vi.fn(async () => ({ jobId: 'original-job' })),
    poll: vi.fn(async () => ({ job_id: 'original-job', status: 'recoverable_wait' as const })), recover: vi.fn() } });
  await store.getState().initialize();
  const original = store.getState().createConversation('Original');
  const pending = store.getState().submit({ kind: 'image', model: 'custom:test:image', prompt: 'Original scene' });
  await vi.waitFor(() => expect(barrier.started).toBe(true));
  const second = store.getState().createConversation('Other');
  gate.resolve(); const id = await pending;
  expect(store.getState().tasks[id].conversationId).toBe(original);
  expect(store.getState().selectedConversationId).toBe(second);
  store.getState().cancelWaiting(id);
});
