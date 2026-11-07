import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkbenchStore } from './workbenchStore';
import { createLocalDocument } from '../application/workbenchPersistence';
import { WORKBENCH_STALL_WINDOW_MS, workbenchTaskStatusLabel } from '../application/taskHealth';
import { canDeleteWorkbenchTask, selectAttentionTaskCount, selectRunningTaskCount } from '../application/taskSelectors';
import { emptyWorkbenchData, type WorkbenchData, type WorkbenchTask } from '../domain/types';
import type { WorkbenchTransport } from '../application/workbenchTransport';
import type { AssetRecord } from '@/features/assets/application/assetCatalog';
import type { GenerationJobPollStatus } from '@/features/canvas/application/ports';

const now = 1_800_000_000_000;
function runningTask(patch: Partial<WorkbenchTask> = {}): WorkbenchTask {
  return { id: 'original-task', conversationId: 'original-conversation', input: { kind: 'image', prompt: 'Saved request', model: 'fixture' },
    status: 'running', jobId: 'original-job', job: { job_id: 'original-job', status: 'running', phase: 'poll',
      external_task_id: 'original-upstream-job', resumable: true, updated_at: now - 1000 },
    results: [], waitingCanceled: false, createdAt: now - 60_000, updatedAt: now - 1000, ...patch };
}
function fixture(task: WorkbenchTask, source?: Pick<Storage, 'getItem' | 'setItem'>) {
  const data: WorkbenchData = { ...emptyWorkbenchData(), tasks: { [task.id]: task },
    conversations: { [task.conversationId]: { id: task.conversationId, title: 'Saved conversation', createdAt: task.createdAt,
      updatedAt: task.updatedAt, pinnedAt: null, projectId: null } }, selectedConversationId: task.conversationId };
  const values = new Map([['task-health-fixture', JSON.stringify({ version: 1, data })]]);
  const storage = source ?? { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const document = createLocalDocument<WorkbenchData>('task-health-fixture', emptyWorkbenchData, value => value as WorkbenchData, storage);
  const transport: WorkbenchTransport = {
    submit: vi.fn(), recover: vi.fn(),
    poll: vi.fn(async () => ({ ...task.job!, job_id: task.jobId!, status: task.status, updated_at: Date.now() })),
  };
  const saveResult = vi.fn(async (value: Omit<AssetRecord, 'id' | 'createdAt' | 'favorite'>) => ({ ...value, id: 'saved-result', createdAt: 1, favorite: false }));
  const store = createWorkbenchStore({ document, transport, saveResult });
  return { store, transport, storage, saveResult };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('workbench local observation windows', () => {
  it('pauses old legacy running work on startup even when polling updatedAt is recent, without querying or resubmitting', async () => {
    const original = runningTask({ createdAt: now - WORKBENCH_STALL_WINDOW_MS - 1, updatedAt: now - 1 });
    const { store, transport } = fixture(original);
    await store.getState().initialize();
    const task = store.getState().tasks[original.id];
    expect(task).toMatchObject({ status: 'running', waitingCanceled: true, jobId: original.jobId, job: original.job,
      failure: { kind: 'interrupted', code: 'task.stalled' } });
    expect(task.status).not.toBe('failed');
    expect(canDeleteWorkbenchTask(task)).toBe(false);
    expect(selectRunningTaskCount(store.getState())).toBe(0);
    expect(selectAttentionTaskCount(store.getState())).toBe(1);
    expect(workbenchTaskStatusLabel(task)).toBe('stalled');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(transport.poll).not.toHaveBeenCalled();
    expect(transport.recover).not.toHaveBeenCalled();
    expect(transport.submit).not.toHaveBeenCalled();
  });

  it('continues normal polling of a recent task and keeps the original job identity', async () => {
    const original = runningTask();
    const { store, transport } = fixture(original);
    await store.getState().initialize();
    expect(transport.poll).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(transport.poll).toHaveBeenCalledOnce();
    expect(transport.poll).toHaveBeenCalledWith(expect.objectContaining({ id: original.id, jobId: original.jobId,
      job: expect.objectContaining({ external_task_id: 'original-upstream-job' }) }));
    expect(store.getState().tasks[original.id]).toMatchObject({ status: 'running', waitingCanceled: false });
    expect(selectRunningTaskCount(store.getState())).toBe(1);
    expect(transport.submit).not.toHaveBeenCalled();
    expect(transport.recover).not.toHaveBeenCalled();
  });

  it('pauses a scheduled query before transport access when the computer sleeps across the observation window', async () => {
    const original = runningTask();
    const { store, transport } = fixture(original);
    await store.getState().initialize();
    vi.setSystemTime(now + WORKBENCH_STALL_WINDOW_MS + 1);
    await vi.advanceTimersByTimeAsync(2000);
    const task = store.getState().tasks[original.id];
    expect(task).toMatchObject({ status: 'running', waitingCanceled: true, jobId: original.jobId, job: original.job,
      failure: { kind: 'interrupted', code: 'task.stalled' } });
    expect(workbenchTaskStatusLabel(task)).toBe('stalled');
    expect(selectRunningTaskCount(store.getState())).toBe(0);
    expect(selectAttentionTaskCount(store.getState())).toBe(1);
    expect(canDeleteWorkbenchTask(task)).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(transport.poll).not.toHaveBeenCalled();
    expect(transport.submit).not.toHaveBeenCalled();
    expect(transport.recover).not.toHaveBeenCalled();
  });

  it.each(['user', 'stale'] as const)('preserves a %s pause when an in-flight query later reports active progress', async reason => {
    const original = runningTask();
    const { store, transport } = fixture(original);
    let resolvePoll!: (job: GenerationJobPollStatus) => void;
    vi.mocked(transport.poll).mockImplementation(() => new Promise(resolve => { resolvePoll = resolve; }));
    await store.getState().initialize();
    const pending = store.getState().poll(original.id);
    expect(transport.poll).toHaveBeenCalledOnce();
    if (reason === 'user') store.getState().cancelWaiting(original.id);
    else {
      vi.setSystemTime(now + WORKBENCH_STALL_WINDOW_MS + 1);
      store.getState().reconcileTasks();
    }
    expect(store.getState().tasks[original.id].waitingCanceled).toBe(true);
    resolvePoll({ ...original.job!, status: 'running', phase: 'poll', progress: 0.5, updated_at: Date.now() });
    await pending;
    const task = store.getState().tasks[original.id];
    expect(task).toMatchObject({ status: 'running', waitingCanceled: true, jobId: original.jobId,
      job: { external_task_id: 'original-upstream-job', progress: 0.5 } });
    expect(task.failure?.code).toBe(reason === 'stale' ? 'task.stalled' : undefined);
    expect(workbenchTaskStatusLabel(task)).toBe(reason === 'stale' ? 'stalled' : 'paused');
    expect(selectRunningTaskCount(store.getState())).toBe(0);
    expect(selectAttentionTaskCount(store.getState())).toBe(1);
    expect(canDeleteWorkbenchTask(task)).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(transport.poll).toHaveBeenCalledOnce();
    expect(transport.submit).not.toHaveBeenCalled();
    expect(transport.recover).not.toHaveBeenCalled();
  });

  it.each(['failed', 'canceled'] as const)('clears a stale classification when an in-flight query ends %s', async status => {
    const original = runningTask();
    const { store, transport } = fixture(original);
    let resolvePoll!: (job: GenerationJobPollStatus) => void;
    vi.mocked(transport.poll).mockImplementation(() => new Promise(resolve => { resolvePoll = resolve; }));
    await store.getState().initialize();
    const pending = store.getState().poll(original.id);
    vi.setSystemTime(now + WORKBENCH_STALL_WINDOW_MS + 1);
    store.getState().reconcileTasks();
    expect(store.getState().tasks[original.id].failure?.code).toBe('task.stalled');
    resolvePoll({ ...original.job!, status, error: status === 'failed' ? 'Provider rejected the job.' : undefined, updated_at: Date.now() });
    await pending;
    const task = store.getState().tasks[original.id];
    expect(task).toMatchObject({ status, jobId: original.jobId, job: { external_task_id: 'original-upstream-job', status } });
    expect(task.failure?.code).not.toBe('task.stalled');
    expect(workbenchTaskStatusLabel(task)).toBe(status);
    expect(selectRunningTaskCount(store.getState())).toBe(0);
    expect(selectAttentionTaskCount(store.getState())).toBe(0);
    expect(canDeleteWorkbenchTask(task)).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(transport.poll).toHaveBeenCalledOnce();
    expect(transport.submit).not.toHaveBeenCalled();
    expect(transport.recover).not.toHaveBeenCalled();
  });

  it('does not treat changing provider timestamps or local updatedAt as progress', async () => {
    const started = now - WORKBENCH_STALL_WINDOW_MS + 10_000;
    const original = runningTask({ createdAt: started, tracking: { startedAt: started, lastProgressAt: started } });
    const { store, transport } = fixture(original);
    await store.getState().initialize();
    await vi.advanceTimersByTimeAsync(8000);
    expect(transport.poll).toHaveBeenCalledTimes(4);
    expect(store.getState().tasks[original.id].updatedAt).toBe(now + 8000);
    expect(store.getState().tasks[original.id].job?.updated_at).toBe(now + 8000);
    expect(store.getState().tasks[original.id].tracking?.lastProgressAt).toBe(started);
    vi.setSystemTime(now + 10_000);
    store.getState().reconcileTasks();
    expect(store.getState().tasks[original.id]).toMatchObject({ status: 'running', waitingCanceled: true, failure: { code: 'task.stalled' } });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(transport.poll).toHaveBeenCalledTimes(4);
    expect(transport.submit).not.toHaveBeenCalled();
  });

  it.each(['step', 'progress'] as const)('extends the observation window for an actual %s change', async field => {
    const started = now - WORKBENCH_STALL_WINDOW_MS + 2000;
    const original = runningTask({ createdAt: started, tracking: { startedAt: started, lastProgressAt: started },
      job: { job_id: 'original-job', status: 'running', phase: 'poll', step: 1, progress: 0.1, external_task_id: 'original-upstream-job' } });
    const { store, transport } = fixture(original);
    vi.mocked(transport.poll).mockResolvedValue({ ...original.job!, [field]: field === 'step' ? 2 : 0.2 });
    await store.getState().initialize();
    vi.setSystemTime(now + 1000);
    await store.getState().poll(original.id);
    expect(store.getState().tasks[original.id].tracking).toEqual({ startedAt: started, lastProgressAt: now + 1000 });
    vi.setSystemTime(now + 3000);
    store.getState().reconcileTasks();
    expect(store.getState().tasks[original.id].waitingCanceled).toBe(false);
    vi.setSystemTime(now + 1000 + WORKBENCH_STALL_WINDOW_MS);
    store.getState().reconcileTasks();
    expect(store.getState().tasks[original.id]).toMatchObject({ waitingCanceled: true, status: 'running', failure: { code: 'task.stalled' } });
    expect(transport.poll).toHaveBeenCalledOnce();
    expect(transport.submit).not.toHaveBeenCalled();
  });

  it('resumes only the original job and opens a fresh local observation window', async () => {
    const original = runningTask({ createdAt: now - WORKBENCH_STALL_WINDOW_MS - 1000 });
    const { store, transport } = fixture(original);
    await store.getState().initialize();
    expect(store.getState().tasks[original.id].waitingCanceled).toBe(true);
    vi.setSystemTime(now + 5000);
    await store.getState().resume(original.id);
    const resumed = store.getState().tasks[original.id];
    expect(resumed).toMatchObject({ id: original.id, jobId: original.jobId, status: 'running', waitingCanceled: false,
      tracking: { startedAt: now + 5000, lastProgressAt: now + 5000 }, job: { external_task_id: 'original-upstream-job' } });
    expect(resumed.failure).toBeUndefined();
    expect(transport.poll).toHaveBeenCalledOnce();
    expect(transport.recover).not.toHaveBeenCalled();
    expect(transport.submit).not.toHaveBeenCalled();
    store.getState().reconcileTasks();
    expect(resumed.waitingCanceled).toBe(false);
  });

  it.each([false, true])('does not access transport for credential-blocked tasks during scans or reopening (paused=%s)', async paused => {
    const original = runningTask({ createdAt: now - WORKBENCH_STALL_WINDOW_MS - 1000, status: 'recoverable_wait', waitingCanceled: paused,
      failure: { kind: 'authentication', message: 'Credentials need authorization.' },
      job: { job_id: 'original-job', status: 'recoverable_wait', external_task_id: 'original-upstream-job', resumable: true,
        phase: 'download', error_category: 'credential' } });
    const first = fixture(original);
    await first.store.getState().initialize();
    first.store.getState().reconcileTasks();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(first.store.getState().tasks[original.id]).toEqual(original);
    expect(first.transport.poll).not.toHaveBeenCalled();
    const reopened = fixture(original, first.storage);
    await reopened.store.getState().initialize();
    reopened.store.getState().reconcileTasks();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reopened.store.getState().tasks[original.id]).toEqual(original);
    for (const transport of [first.transport, reopened.transport]) {
      expect(transport.poll).not.toHaveBeenCalled(); expect(transport.recover).not.toHaveBeenCalled(); expect(transport.submit).not.toHaveBeenCalled();
    }
    expect(workbenchTaskStatusLabel(original)).toBe('credential');
  });

  it('leaves durable successful results and their status unchanged during startup and stale scans', async () => {
    const original = runningTask({ status: 'succeeded', createdAt: now - WORKBENCH_STALL_WINDOW_MS * 10,
      results: [{ kind: 'image', source: '/durable/result.png', assetId: 'original-asset' }],
      job: { job_id: 'original-job', status: 'succeeded', result: '/durable/result.png' } });
    const { store, transport, saveResult } = fixture(original);
    await store.getState().initialize();
    store.getState().reconcileTasks();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.getState().tasks[original.id]).toEqual(original);
    expect(selectAttentionTaskCount(store.getState())).toBe(0);
    expect(selectRunningTaskCount(store.getState())).toBe(0);
    expect(transport.poll).not.toHaveBeenCalled(); expect(transport.submit).not.toHaveBeenCalled(); expect(transport.recover).not.toHaveBeenCalled();
    expect(saveResult).not.toHaveBeenCalled();
  });
});
