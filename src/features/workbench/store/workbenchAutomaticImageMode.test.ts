import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJSONStorage } from 'zustand/middleware';
import type { ChannelProfileV2 } from '@/features/channels/domain/profile';
import { useChannelStore } from '@/features/channels/store/channelStore';
import { resolveWorkbenchMode } from '../application/workbenchImageMode';
import { getWorkbenchValidationContext, validateWorkbenchDraft } from '../application/workbenchValidation';
import { createLocalDocument } from '../application/workbenchPersistence';
import type { WorkbenchTransport } from '../application/workbenchTransport';
import { emptyWorkbenchData, type WorkbenchData, type WorkbenchSubmitInput } from '../domain/types';
import { createWorkbenchStore } from './workbenchStore';

const profile: ChannelProfileV2 = { version: 2, id: 'auto-image-fixture', name: 'Automatic image fixture', baseUrl: 'https://fixture.invalid', auth: { type: 'none' },
  operations: {
    'image.generate': { method: 'POST', path: '/images', body: 'json', template: { prompt: '{{prompt}}' }, response: { mode: 'sync', outputs: [] } },
    'image.edit': { method: 'POST', path: '/edits', body: 'json', template: { prompt: '{{prompt}}', images: '{{slot.images}}' }, response: { mode: 'sync', outputs: [] } },
  }, models: [{ id: 'image', operations: ['image.generate', 'image.edit'], params: [{ key: 'shared', label: 'Shared', type: 'number', default: 1 }], modes: [
    { id: 'text', label: 'Text', operation: 'image.generate', params: [{ key: 'textQuality', label: 'Text quality', type: 'text', default: 'text-default' }] },
    { id: 'edit', label: 'Edit', operation: 'image.edit', slots: [{ key: 'images', label: 'Images', kind: 'image', min: 1, max: 2 }],
      params: [{ key: 'editQuality', label: 'Edit quality', type: 'text', default: 'edit-default' }] },
  ] }] };
const input: WorkbenchSubmitInput = { kind: 'image', model: 'custom:auto-image-fixture:image', prompt: 'Use @图1', config: { extraParams: { shared: 3, textQuality: 'text-choice', unknown: 'never sent' } } };
function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); },
    clear: () => values.clear(), key: index => [...values.keys()][index] ?? null, get length() { return values.size; } };
}
function fixture(storage = memoryStorage(), supplied?: WorkbenchTransport) {
  const transport: WorkbenchTransport = supplied ?? { submit: vi.fn(async () => ({ jobId: 'accepted-original-job' })),
    poll: vi.fn(async () => ({ job_id: 'accepted-original-job', status: 'recoverable_wait' as const, external_task_id: 'paid-upstream-original' })), recover: vi.fn(async () => undefined) };
  const document = createLocalDocument<WorkbenchData>('automatic-image-workbench-fixture', emptyWorkbenchData, value => value as WorkbenchData, storage);
  const store = createWorkbenchStore({ document, transport });
  return { store, transport, storage };
}
let channelStorage: Storage;
beforeEach(() => {
  vi.useFakeTimers();
  channelStorage = memoryStorage();
  useChannelStore.persist.setOptions({ storage: createJSONStorage(() => channelStorage) });
  useChannelStore.setState({ channels: [{ profile: structuredClone(profile), origin: 'native', migrationIssues: [], createdAt: 1, updatedAt: 1 }] });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); useChannelStore.setState({ channels: [] }); });

describe('workbench automatic image modes', () => {
  it('adds an image into the edit slot without locking automatic mode, then returns to text after the final image is removed', async () => {
    const { store } = fixture(); await store.getState().initialize();
    store.getState().setDraft(input);
    const model = profile.models[0];
    expect(resolveWorkbenchMode(store.getState().draft, model).mode.id).toBe('text');
    store.getState().addReferences([{ id: 'image-one', kind: 'image', source: '/one.png' }]);
    const edit = store.getState().draft;
    expect(edit.channelModeId).toBeUndefined();
    expect(resolveWorkbenchMode(edit, model).mode.id).toBe('edit');
    expect(edit.referenceSlots).toEqual({ images: ['/one.png'] });
    expect(edit.references).toEqual([]);
    expect(edit.config?.extraParams).toEqual({ shared: 3, editQuality: 'edit-default' });
    expect(edit.prompt).toBe('Use @图1');
    store.getState().setDraft({ referenceSlots: {} });
    const text = store.getState().draft;
    expect(text.channelModeId).toBeUndefined();
    expect(resolveWorkbenchMode(text, model).mode.id).toBe('text');
    expect(text.config?.extraParams).toEqual({ shared: 3, textQuality: 'text-default' });
    expect(text.referenceSlots).toEqual({});
  });

  it('preserves text references and repeated images while filtering only parameters incompatible with the new mode', async () => {
    const { store } = fixture(); await store.getState().initialize();
    store.getState().setDraft({ ...input, references: [{ id: 'context', kind: 'text', source: 'Keep this context.' }] });
    store.getState().addReferences([{ id: 'image-a', kind: 'image', source: '/same.png' }, { id: 'image-b', kind: 'image', source: '/same.png' }]);
    expect(store.getState().draft.referenceSlots).toEqual({ images: ['/same.png', '/same.png'] });
    expect(store.getState().draft.references).toEqual([{ id: 'context', kind: 'text', source: 'Keep this context.' }]);
    expect(store.getState().draft.config?.extraParams).toEqual({ shared: 3, editQuality: 'edit-default' });
  });

  it('keeps explicitly selected modes locked and retains their validation error after the last image is removed', async () => {
    const { store } = fixture(); await store.getState().initialize();
    store.getState().setDraft({ ...input, channelModeId: 'edit' });
    store.getState().addReferences([{ id: 'image', kind: 'image', source: '/one.png' }]);
    expect(store.getState().draft.channelModeId).toBe('edit');
    store.getState().setDraft({ referenceSlots: {} });
    expect(store.getState().draft.channelModeId).toBe('edit');
    expect(validateWorkbenchDraft(store.getState().draft, getWorkbenchValidationContext(store.getState().draft)).issues).toContainEqual(expect.objectContaining({ code: 'slot.minNotMet' }));
    store.getState().setDraft({ channelModeId: 'text' });
    expect(() => store.getState().addReferences([{ id: 'image', kind: 'image', source: '/keep-visible.png' }])).toThrow('workbench.referenceSlotFull');
    expect(store.getState().draft.channelModeId).toBe('text');
  });

  it('keeps unsupported automatic references visible and blocks submission instead of dropping them', async () => {
    const { store, transport } = fixture(); await store.getState().initialize();
    store.getState().setDraft(input);
    const references = [1, 2, 3].map(index => ({ id: `image-${index}`, kind: 'image' as const, source: `/image-${index}.png` }));
    store.getState().addReferences(references);
    expect(store.getState().draft.references).toEqual(references);
    expect(validateWorkbenchDraft(store.getState().draft, getWorkbenchValidationContext(store.getState().draft)).issues).toContainEqual(expect.objectContaining({ code: 'mode.autoUnavailable' }));
    await expect(store.getState().submit(store.getState().draft)).rejects.toThrow();
    expect(transport.submit).not.toHaveBeenCalled();
    expect(store.getState().draft.references).toEqual(references);
  });

  it('locks the actual mode into submitted history and recovers the original job without reinterpreting changed channel modes', async () => {
    const first = fixture(); await first.store.getState().initialize();
    first.store.getState().setDraft(input);
    first.store.getState().addReferences([{ id: 'image', kind: 'image', source: '/original.png' }]);
    const taskId = await first.store.getState().submit(first.store.getState().draft);
    expect(first.transport.submit).toHaveBeenCalledWith(expect.objectContaining({ channelModeId: 'edit', referenceSlots: { images: ['/original.png'] } }), []);
    expect(first.store.getState().tasks[taskId].input).toMatchObject({ channelModeId: 'edit', referenceSlots: { images: ['/original.png'] }, config: { extraParams: { shared: 3, editQuality: 'edit-default' } } });
    expect(first.store.getState().draft.channelModeId).toBeUndefined();
    useChannelStore.setState({ channels: [] });
    const resumedTransport: WorkbenchTransport = { submit: vi.fn(), recover: vi.fn(async () => undefined),
      poll: vi.fn(async () => ({ job_id: 'accepted-original-job', status: 'canceled' as const, external_task_id: 'paid-upstream-original' })) };
    const reopened = fixture(first.storage, resumedTransport); await reopened.store.getState().initialize();
    expect(reopened.store.getState().tasks[taskId].input.channelModeId).toBe('edit');
    await reopened.store.getState().recoverResult(taskId);
    expect(resumedTransport.recover).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'accepted-original-job', input: expect.objectContaining({ channelModeId: 'edit', referenceSlots: { images: ['/original.png'] } }) }));
    expect(resumedTransport.poll).toHaveBeenCalledOnce();
    expect(resumedTransport.submit).not.toHaveBeenCalled();
    expect(reopened.store.getState().tasks[taskId]).toMatchObject({ jobId: 'accepted-original-job', status: 'canceled', input: { channelModeId: 'edit' } });
  });
});
