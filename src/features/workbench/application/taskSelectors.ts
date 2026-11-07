import type { WorkbenchData, WorkbenchTask } from '../domain/types';

const unresolvedStatuses: Partial<Record<WorkbenchTask['status'], true>> = {
  queued: true, submitting: true, running: true, materializing: true, unknown: true, recoverable_wait: true,
};
const runningStatuses: Partial<Record<WorkbenchTask['status'], true>> = {
  queued: true, submitting: true, running: true, materializing: true,
};
type TaskState = Pick<WorkbenchData, 'tasks'>;
export interface WorkbenchTaskCounts {
  total: number;
  byStatus: Partial<Record<WorkbenchTask['status'], number>>;
}

export function isWorkbenchTaskRunning(task: WorkbenchTask): boolean {
  return Boolean(runningStatuses[task.status]) && !task.waitingCanceled;
}
function isUnresolved(task: WorkbenchTask): boolean { return Boolean(unresolvedStatuses[task.status]); }
function needsAttention(task: WorkbenchTask): boolean {
  return isUnresolved(task) && !isWorkbenchTaskRunning(task);
}
function selectTasks(state: TaskState, matches: (task: WorkbenchTask) => boolean): WorkbenchTask[] {
  return Object.values(state.tasks).filter(matches)
    .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
}
function countTasks(state: TaskState, matches: (task: WorkbenchTask) => boolean): number {
  return Object.values(state.tasks).filter(matches).length;
}
function taskCounts(state: TaskState, matches: (task: WorkbenchTask) => boolean): WorkbenchTaskCounts {
  const byStatus: Partial<Record<WorkbenchTask['status'], number>> = {};
  let total = 0;
  for (const task of Object.values(state.tasks)) if (matches(task)) {
    total += 1;
    byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;
  }
  return { total, byStatus };
}

/** Current execution/waiting activity; paused, ambiguous and recoverable jobs are separate. */
export function selectRunningTasks(state: TaskState): WorkbenchTask[] { return selectTasks(state, isWorkbenchTaskRunning); }
export function selectRunningTaskCount(state: TaskState): number { return countTasks(state, isWorkbenchTaskRunning); }
export function selectRunningTaskCounts(state: TaskState): WorkbenchTaskCounts { return taskCounts(state, isWorkbenchTaskRunning); }

/** Unresolved work needing a user decision or recovery; terminal history stays out of global badges. */
export function selectAttentionTasks(state: TaskState): WorkbenchTask[] { return selectTasks(state, needsAttention); }
export function selectAttentionTaskCount(state: TaskState): number { return countTasks(state, needsAttention); }
export function selectAttentionTaskCounts(state: TaskState): WorkbenchTaskCounts { return taskCounts(state, needsAttention); }

/** Preserve all unresolved handles, including jobs whose local waiting was paused. */
export function selectUnresolvedTasks(state: TaskState): WorkbenchTask[] { return selectTasks(state, isUnresolved); }
export function selectUnresolvedTaskCount(state: TaskState): number { return countTasks(state, isUnresolved); }
export function selectUnresolvedTaskCounts(state: TaskState): WorkbenchTaskCounts { return taskCounts(state, isUnresolved); }

// Existing running badges keep their API while gaining the narrower activity definition.
export const selectActiveTasks = selectRunningTasks;
export const selectActiveTaskCount = selectRunningTaskCount;
export const selectActiveTaskCounts = selectRunningTaskCounts;

/** Deleting history must not discard an unresolved upstream job or recovery handle. */
export function canDeleteWorkbenchTask(task: WorkbenchTask): boolean {
  return !isUnresolved(task);
}
