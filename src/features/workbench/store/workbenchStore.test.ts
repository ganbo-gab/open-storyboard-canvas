import { afterEach, describe, expect, it, vi } from 'vitest';
import { canDeleteWorkbenchTask, createWorkbenchStore, selectActiveTasks, selectActiveTaskCount, selectActiveTaskCounts, selectAttentionTasks, selectUnresolvedTasks, selectUnresolvedTaskCount } from './workbenchStore';
import { createLocalDocument } from '../application/workbenchPersistence';
import { classifyWorkbenchFailure, emptyWorkbenchData, type WorkbenchData, type WorkbenchSubmitInput } from '../domain/types';
import type { WorkbenchTransport } from '../application/workbenchTransport';
import { useCanvasStore } from '@/stores/canvasStore';
import type { AssetRecord } from '@/features/assets/application/assetCatalog';
import { useChannelStore } from '@/features/channels/store/channelStore';
import { miniMaxVideoProfile } from '@/features/channels/presets/videoModels';
import { getWorkbenchValidationContext, validateWorkbenchDraft } from '../application/workbenchValidation';
import { SecretStoreError } from '@/features/secrets/secretStore';
import { CREDENTIAL_ACCESS_MESSAGE } from '@/features/secrets/credentialFailure';

const input: WorkbenchSubmitInput = { kind: 'image', prompt: 'A cat at sunset', model: 'custom:test:model', config: { size: '1K', aspectRatio: '1:1' } };
function fixture(options: { storage?: Pick<Storage, 'getItem' | 'setItem'>; transport?: WorkbenchTransport } = {}) {
  const values: Record<string, string> = {};
  const storage = options.storage ?? { getItem: (key: string) => values[key] ?? null, setItem: (key: string, value: string) => { values[key] = value; } };
  const transport: WorkbenchTransport = options.transport ?? { submit: vi.fn(async () => ({ jobId: 'job-1' })), poll: vi.fn(async () => ({ job_id: 'job-1', status: 'succeeded' as const, result: '/media/cat.png' })), recover: vi.fn(async () => undefined) };
  const document = createLocalDocument<WorkbenchData>('test', emptyWorkbenchData, (value) => value as WorkbenchData, storage);
  const saveResult = vi.fn(async (value: Omit<AssetRecord, 'id' | 'createdAt' | 'favorite'>) => ({ ...value, id: 'asset-1', createdAt: 1, favorite: false }));
  const store = createWorkbenchStore({ document, transport, saveResult });
  return { store, document, storage, transport, saveResult };
}
afterEach(() => vi.useRealTimers());

describe('non-canvas workbench', () => {
  it('keeps a rejected vault read before submission failed without inventing a recoverable upstream task', async () => {
    const transport: WorkbenchTransport = { submit: vi.fn().mockRejectedValue(new SecretStoreError('locked', 'vault-locked')), poll: vi.fn(), recover: vi.fn() };
    const { store } = fixture({ transport });
    const id = await store.getState().submit(input);
    expect(store.getState().tasks[id]).toMatchObject({ status: 'failed', failure: { kind: 'authentication' } });
    expect(store.getState().tasks[id].jobId).toBeUndefined();
    await expect(store.getState().recoverResult(id)).rejects.toThrow('不会重新提交');
    expect(transport.submit).toHaveBeenCalledOnce(); expect(transport.poll).not.toHaveBeenCalled(); expect(transport.recover).not.toHaveBeenCalled();
  });
  it.each(['poll', 'download'])('retains a credential-blocked %s task after reopening and recovers its original result without submission', async (phase) => {
    vi.useFakeTimers();
    const job = { job_id: 'custom-local-channel-job-original', status: 'recoverable_wait' as const, phase, error_category: 'credential',
      external_task_id: 'original-paid-task', resumable: true, error: CREDENTIAL_ACCESS_MESSAGE };
    const original: WorkbenchTransport = { submit: vi.fn(async () => ({ jobId: job.job_id })), poll: vi.fn(async () => job), recover: vi.fn() };
    const first = fixture({ transport: original });
    const id = await first.store.getState().submit(input);
    expect(first.store.getState().tasks[id]).toMatchObject({ status: 'recoverable_wait', job, failure: { kind: 'authentication' } });
    await vi.advanceTimersByTimeAsync(120000);
    expect(original.submit).toHaveBeenCalledOnce(); expect(original.poll).toHaveBeenCalledOnce();
    const resumed: WorkbenchTransport = { submit: vi.fn(), recover: vi.fn(async () => undefined),
      poll: vi.fn(async () => ({ job_id: job.job_id, status: 'succeeded' as const, result: '/recovered/original.png', external_task_id: job.external_task_id })) };
    const second = fixture({ storage: first.storage, transport: resumed });
    await second.store.getState().initialize();
    await vi.advanceTimersByTimeAsync(120000);
    expect(second.store.getState().tasks[id]).toMatchObject({ status: 'recoverable_wait', job, failure: { kind: 'authentication' } });
    expect(resumed.poll).not.toHaveBeenCalled(); expect(resumed.recover).not.toHaveBeenCalled();
    await second.store.getState().recoverResult(id);
    expect(resumed.recover).toHaveBeenCalledWith(expect.objectContaining({ jobId: job.job_id, job: expect.objectContaining({ external_task_id: job.external_task_id }) }));
    expect(resumed.poll).toHaveBeenCalledOnce(); expect(resumed.submit).not.toHaveBeenCalled();
    expect(second.store.getState().tasks[id]).toMatchObject({ status: 'succeeded', jobId: job.job_id, results: [{ source: '/recovered/original.png' }] });
    expect(second.store.getState().tasks[id].failure).toBeUndefined();
  });
  it('prevents deleting a conversation while its original upstream task still needs recovery', async () => {
    const transport: WorkbenchTransport = { submit: vi.fn(async () => ({ jobId: 'retain-upstream' })),
      poll: vi.fn(async () => ({ job_id: 'retain-upstream', status: 'recoverable_wait' as const })), recover: vi.fn() };
    const { store } = fixture({ transport });
    const id = await store.getState().submit(input);
    const conversationId = store.getState().tasks[id].conversationId;
    store.getState().cancelWaiting(id);
    expect(() => store.getState().deleteConversation(conversationId)).toThrow('workbench.taskActive');
    expect(store.getState().tasks[id].jobId).toBe('retain-upstream');
    expect(store.getState().conversations[conversationId]).toBeDefined();
    expect(transport.submit).toHaveBeenCalledOnce();
  });
  it('refreshes all outputs for an old succeeded task without submitting again', async () => {
    const { store, transport } = fixture();
    const id = await store.getState().submit(input);
    vi.mocked(transport.poll).mockResolvedValueOnce({ job_id: 'job-1', status: 'succeeded', result: '/one.png', results: [{ kind: 'image', source: '/one.png' }, { kind: 'image', source: '/two.png' }] });
    await store.getState().poll(id);
    expect(store.getState().tasks[id].results.map((result) => result.source)).toEqual(['/one.png', '/two.png']);
    expect(transport.submit).toHaveBeenCalledOnce();
  });
  it.each(['missing', 'not_found', 'empty', 'failed'])('keeps completed history and its durable results when Comfy backfill is %s', async (failure) => {
    const { store, transport } = fixture();
    const id = await store.getState().submit(input);
    const completed = structuredClone(store.getState().tasks[id]);
    if (failure === 'missing') vi.mocked(transport.poll).mockRejectedValueOnce(new Error('Original Comfy cache bytes are missing'));
    else vi.mocked(transport.poll).mockResolvedValueOnce({ job_id: 'job-1', status: failure === 'empty' ? 'succeeded' : failure === 'failed' ? 'failed' : 'not_found' });
    await store.getState().poll(id);
    expect(store.getState().tasks[id]).toEqual(completed);
    expect(canDeleteWorkbenchTask(store.getState().tasks[id])).toBe(true);
    expect(transport.submit).toHaveBeenCalledOnce();
  });
  it('preserves existing successful outputs when supplemental result materialization fails', async () => {
    const { store, transport } = fixture();
    const id = await store.getState().submit(input);
    const results = structuredClone(store.getState().tasks[id].results);
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Supplement download failed'));
    try {
      vi.mocked(transport.poll).mockResolvedValueOnce({ job_id: 'job-1', status: 'succeeded', results: [{ kind: 'image', source: '/media/cat.png' }, { kind: 'image', source: 'https://fixture.invalid/extra.png' }] });
      await store.getState().poll(id);
      expect(store.getState().tasks[id]).toMatchObject({ status: 'succeeded', results, failure: { kind: 'storage' } });
      expect(transport.submit).toHaveBeenCalledOnce();
    } finally { fetch.mockRestore(); }
  });
  it('explicit result recovery refreshes a completed cached result from its original job', async () => {
    const { store, transport } = fixture();
    const id = await store.getState().submit(input);
    vi.mocked(transport.poll).mockResolvedValueOnce({ job_id: 'job-1', status: 'succeeded', result: '/recovered.png' });
    await store.getState().recoverResult(id);
    expect(transport.recover).toHaveBeenCalledOnce();
    expect(store.getState().tasks[id].results[0].source).toBe('/recovered.png');
    expect(transport.submit).toHaveBeenCalledOnce();
  });
  it('submits real gateway work and preserves the entire canvas snapshot', async () => {
    const { store, transport } = fixture();
    const before = useCanvasStore.getState();
    const id = await store.getState().submit(input);
    expect(transport.submit).toHaveBeenCalledOnce();
    expect(transport.submit).toHaveBeenCalledWith(input, []);
    expect(store.getState().tasks[id].results).toEqual([{ kind: 'image', source: '/media/cat.png', assetId: 'asset-1' }]);
    expect(useCanvasStore.getState()).toBe(before);
  });
  it('registers and publishes every typed output, including a video tail-frame image and text', async () => {
    const results = [{ kind: 'video' as const, source: '/video.mp4' }, { kind: 'image' as const, source: '/tail.png' },
      { kind: 'audio' as const, source: '/sound.wav' }, { kind: 'text' as const, source: 'Transcript' }];
    const transport: WorkbenchTransport = { submit: vi.fn(async () => ({ jobId: 'multi' })),
      poll: vi.fn(async () => ({ job_id: 'multi', status: 'succeeded' as const, result: '/video.mp4', results })), recover: vi.fn() };
    const { store, saveResult } = fixture({ transport });
    const id = await store.getState().submit({ ...input, kind: 'video' });
    expect(store.getState().tasks[id].results.map(({ kind, source }) => ({ kind, source }))).toEqual(results);
    expect(saveResult).toHaveBeenCalledTimes(4);
    expect(store.getState().messages[`${id}:assistant`].text).toBe('Transcript');
  });
  it('accepts typed successful outputs without the legacy first-result field', async () => {
    const transport: WorkbenchTransport = { submit: vi.fn(async () => ({ jobId: 'multi' })),
      poll: vi.fn(async () => ({ job_id: 'multi', status: 'succeeded' as const, results: [{ kind: 'image' as const, source: '/one.png' }, { kind: 'image' as const, source: '/two.png' }] })), recover: vi.fn() };
    const { store, saveResult } = fixture({ transport });
    const id = await store.getState().submit(input);
    expect(store.getState().tasks[id].status).toBe('succeeded');
    expect(saveResult).toHaveBeenCalledTimes(2);
  });
  it('seeds selected model and mode declarations into the editable draft and submitted task', async () => {
    useChannelStore.setState({ channels: [{ origin: 'native', profile: miniMaxVideoProfile, migrationIssues: [], createdAt: 1, updatedAt: 1 }] });
    const { store, transport } = fixture();
    await store.getState().initialize();
    store.getState().setDraft({ kind: 'video', model: 'custom:minimax-video:MiniMax-H3', prompt: 'A crane', config: {} });
    expect(store.getState().draft.config?.extraParams).toMatchObject({ resolution: '768P', duration: 5, ratio: '16:9' });
    store.getState().setDraft({ channelModeId: 'first-frame', referenceSlots: { first_frame: ['/media/first.png'] }, config: { extraParams: { ratio: '16:9', duration: 8 } } });
    expect(store.getState().draft.config?.extraParams).toMatchObject({ resolution: '768P', duration: 8, ratio: 'adaptive' });
    const id = await store.getState().submit(store.getState().draft);
    expect(store.getState().tasks[id].input.config?.extraParams).toMatchObject({ resolution: '768P', duration: 8, ratio: 'adaptive' });
    expect(transport.submit).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ extraParams: expect.objectContaining({ ratio: 'adaptive' }) }) }), []);
    useChannelStore.setState({ channels: [] });
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
  it('regenerates as a new task using the original input and conversation without touching the old task', async () => {
    const { store, transport } = fixture();
    const id = await store.getState().submit({ ...input, config: { ...input.config, extraParams: { seed: 42 } },
      references: [{ id: 'reference', kind: 'image', source: '/media/reference.png' }] });
    const original = structuredClone(store.getState().tasks[id]);
    store.getState().createConversation('Other');
    const regenerated = await store.getState().regenerate(id);
    expect(regenerated).not.toBe(id);
    expect(store.getState().tasks[regenerated].input).toEqual(original.input);
    expect(store.getState().tasks[regenerated].conversationId).toBe(original.conversationId);
    expect(store.getState().tasks[id]).toEqual(original);
    expect(transport.submit).toHaveBeenCalledTimes(2);
  });
  it('deletes task messages and persisted history without deleting generated assets or other tasks', async () => {
    const { store, storage, saveResult } = fixture();
    const id = await store.getState().submit(input);
    const other = await store.getState().submit(input);
    const asset = saveResult.mock.results[0];
    const conversationId = store.getState().tasks[id].conversationId;
    expect(canDeleteWorkbenchTask(store.getState().tasks[id])).toBe(true);
    store.getState().deleteTask(id);
    expect(store.getState().tasks[id]).toBeUndefined();
    expect(Object.values(store.getState().messages).some((message) => message.taskId === id)).toBe(false);
    expect(store.getState().tasks[other]).toBeDefined();
    expect(store.getState().conversations[conversationId]).toBeDefined();
    expect(saveResult.mock.results[0]).toBe(asset);
    expect(await asset.value).toMatchObject({ id: 'asset-1', source: '/media/cat.png' });
    const restored = fixture({ storage });
    await restored.store.getState().initialize();
    expect(restored.store.getState().tasks[id]).toBeUndefined();
    expect(Object.values(restored.store.getState().messages).some((message) => message.taskId === id)).toBe(false);
  });
  it('protects paused unresolved work without counting it as running, across conversations', async () => {
    const { store } = fixture({ transport: { submit: vi.fn(async () => { throw new Error('Network timeout'); }), poll: vi.fn(), recover: vi.fn() } });
    const id = await store.getState().submit(input);
    const unresolved = store.getState().tasks[id];
    const statuses = ['queued', 'submitting', 'running', 'materializing', 'unknown', 'recoverable_wait'] as const;
    const tasks = Object.fromEntries(statuses.map((status, index) => [`active-${index}`, { ...unresolved, id: `active-${index}`, conversationId: `conversation-${index}`, createdAt: index + 1, status, waitingCanceled: true }]));
    store.setState({ tasks: { ...tasks, completed: { ...unresolved, id: 'completed', createdAt: 100, status: 'succeeded' } } });
    for (const task of Object.values(tasks)) {
      expect(canDeleteWorkbenchTask(task)).toBe(false);
      expect(() => store.getState().deleteTask(task.id)).toThrow('workbench.taskActive');
    }
    expect(selectActiveTasks(store.getState())).toEqual([]);
    expect(selectActiveTaskCount(store.getState())).toBe(0);
    expect(selectActiveTaskCounts(store.getState())).toEqual({ total: 0, byStatus: {} });
    expect(selectAttentionTasks(store.getState()).map(task => task.id)).toEqual(['active-5', 'active-4', 'active-3', 'active-2', 'active-1', 'active-0']);
    expect(selectUnresolvedTasks(store.getState()).map(task => task.id)).toEqual(['active-5', 'active-4', 'active-3', 'active-2', 'active-1', 'active-0']);
    expect(selectUnresolvedTaskCount(store.getState())).toBe(6);
  });
  it('rejects submit with the exact pre-submit validation issues before creating a task or calling a provider', async () => {
    useChannelStore.setState({ channels: [{ origin: 'native', profile: miniMaxVideoProfile, migrationIssues: [], createdAt: 1, updatedAt: 1 }] });
    try {
      const { store, transport } = fixture();
      const invalid = { kind: 'video' as const, model: 'custom:minimax-video:MiniMax-H3', prompt: 'A crane', channelModeId: 'first-frame',
        referenceSlots: { first_frame: ['/one.png', '/two.png'] }, config: { seconds: 100 } };
      const expected = validateWorkbenchDraft(invalid, getWorkbenchValidationContext(invalid));
      await expect(store.getState().submit(invalid)).rejects.toMatchObject({ issues: expected.issues, code: expected.issues[0].code });
      expect(Object.keys(store.getState().tasks)).toEqual([]);
      expect(transport.submit).not.toHaveBeenCalled();
    } finally { useChannelStore.setState({ channels: [] }); }
  });
  it('retains pin and project association when generation updates activity and registers provenance', async () => {
    const { store, saveResult } = fixture();
    await store.getState().initialize();
    const conversationId = store.getState().createConversation('Project conversation', 'project-linked');
    store.getState().setConversationPinned(conversationId, true);
    const pinnedAt = store.getState().conversations[conversationId].pinnedAt;
    const id = await store.getState().submit({ ...input, conversationId });
    expect(store.getState().conversations[conversationId]).toMatchObject({ pinnedAt, projectId: 'project-linked' });
    expect(saveResult).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-linked', taskId: id,
      metadata: expect.objectContaining({ resolution: '1K', aspectRatio: '1:1', model: input.model, prompt: input.prompt, jobId: 'job-1' }),
    }));
    store.getState().associateConversationProject(conversationId, null);
    expect(store.getState().conversations[conversationId]).toMatchObject({ pinnedAt, projectId: null });
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
