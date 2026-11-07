import { describe, expect, it } from 'vitest';
import type { WorkbenchTask } from '../domain/types';
import {
  canDeleteWorkbenchTask, isWorkbenchTaskRunning, selectActiveTasks, selectActiveTaskCount, selectActiveTaskCounts,
  selectRunningTasks, selectRunningTaskCount, selectRunningTaskCounts,
  selectAttentionTasks, selectAttentionTaskCount, selectAttentionTaskCounts,
  selectUnresolvedTasks, selectUnresolvedTaskCount, selectUnresolvedTaskCounts,
} from './taskSelectors';

function task(id: string, status: WorkbenchTask['status'], createdAt: number, waitingCanceled = false): WorkbenchTask {
  return { id, conversationId: `conversation-${id}`, input: { kind: 'image', model: 'local-fixture', prompt: 'Fixture' },
    status, jobId: `original-${id}`, job: { job_id: `original-${id}`, status, external_task_id: `upstream-${id}` },
    results: [], waitingCanceled, createdAt, updatedAt: createdAt };
}

describe('workbench task activity and recovery classifications', () => {
  it('counts only actual running states with local waiting enabled and preserves all other handles', () => {
    const tasks = {
      queued: task('queued', 'queued', 1), submitting: task('submitting', 'submitting', 2),
      running: task('running', 'running', 3), materializing: task('materializing', 'materializing', 4),
      waiting: task('waiting', 'recoverable_wait', 5), unknown: task('unknown', 'unknown', 6),
      paused: task('paused', 'running', 7, true), failed: task('failed', 'failed', 8),
      missing: task('missing', 'not_found', 9), succeeded: task('succeeded', 'succeeded', 10), canceled: task('canceled', 'canceled', 11),
    };
    const before = structuredClone(tasks);
    const state = { tasks };
    expect(selectRunningTasks(state).map(item => item.id)).toEqual(['materializing', 'running', 'submitting', 'queued']);
    expect(selectRunningTaskCount(state)).toBe(4);
    expect(selectRunningTaskCounts(state)).toEqual({ total: 4, byStatus: { queued: 1, submitting: 1, running: 1, materializing: 1 } });
    expect(selectAttentionTasks(state).map(item => item.id)).toEqual(['paused', 'unknown', 'waiting']);
    expect(selectAttentionTaskCount(state)).toBe(3);
    expect(selectAttentionTaskCounts(state)).toEqual({ total: 3, byStatus: { recoverable_wait: 1, unknown: 1, running: 1 } });
    expect(selectUnresolvedTasks(state).map(item => item.id)).toEqual(['paused', 'unknown', 'waiting', 'materializing', 'running', 'submitting', 'queued']);
    expect(selectUnresolvedTaskCount(state)).toBe(7);
    expect(selectUnresolvedTaskCounts(state)).toEqual({ total: 7, byStatus: { queued: 1, submitting: 1, running: 2, materializing: 1, recoverable_wait: 1, unknown: 1 } });
    expect(selectActiveTasks(state)).toEqual(selectRunningTasks(state));
    expect(selectActiveTaskCount(state)).toBe(selectRunningTaskCount(state));
    expect(selectActiveTaskCounts(state)).toEqual(selectRunningTaskCounts(state));
    for (const item of selectUnresolvedTasks(state)) expect(canDeleteWorkbenchTask(item)).toBe(false);
    for (const item of [tasks.failed, tasks.missing, tasks.succeeded, tasks.canceled]) expect(canDeleteWorkbenchTask(item)).toBe(true);
    expect(tasks).toEqual(before);
  });

  it('moves a paused task back to running without changing status or its original recovery IDs', () => {
    const paused = task('paused', 'running', 10, true);
    const state = { tasks: { paused } };
    expect(selectRunningTaskCount(state)).toBe(0);
    expect(isWorkbenchTaskRunning(paused)).toBe(false);
    expect(selectAttentionTasks(state)).toEqual([paused]);
    const resumed = { ...paused, waitingCanceled: false };
    expect(selectRunningTasks({ tasks: { resumed } })).toEqual([resumed]);
    expect(isWorkbenchTaskRunning(resumed)).toBe(true);
    expect(selectAttentionTaskCount({ tasks: { resumed } })).toBe(0);
    expect(selectUnresolvedTaskCount({ tasks: { resumed } })).toBe(1);
    expect(resumed.jobId).toBe(paused.jobId);
    expect(resumed.job?.external_task_id).toBe(paused.job?.external_task_id);
  });

  it('does not turn terminal history or successful result warnings into unresolved global badges', () => {
    const succeeded = { ...task('warning', 'succeeded', 20), results: [{ kind: 'image' as const, source: 'asset-media:fixture' }],
      failure: { kind: 'storage' as const, message: 'Asset catalog registration needs attention.' } };
    const failed = task('failed', 'failed', 1, true), missing = task('missing', 'not_found', 2, true), canceled = task('canceled', 'canceled', 3, true);
    const state = { tasks: { succeeded, failed, missing, canceled } };
    expect(selectAttentionTasks(state)).toEqual([]);
    expect(selectRunningTaskCount({ tasks: { succeeded } })).toBe(0);
    expect(selectUnresolvedTaskCount({ tasks: { succeeded } })).toBe(0);
    expect(canDeleteWorkbenchTask(succeeded)).toBe(true);
  });

  it('uses deterministic creation order and ID ties without rewriting stored tasks', () => {
    const a = task('a', 'running', 1), b = task('b', 'running', 1);
    expect(selectRunningTasks({ tasks: { a, b } })).toEqual([b, a]);
    expect(selectAttentionTaskCounts({ tasks: {} })).toEqual({ total: 0, byStatus: {} });
    expect(selectUnresolvedTasks({ tasks: {} })).toEqual([]);
  });
});
