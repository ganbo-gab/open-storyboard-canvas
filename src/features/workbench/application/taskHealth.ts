import type { GenerationJobPollStatus } from '@/features/canvas/application/ports';
import type { WorkbenchTask } from '../domain/types';

/** A conservative local observation limit, not a provider timeout or a failed-job verdict. */
export const WORKBENCH_STALL_WINDOW_MS = 6 * 60 * 60 * 1000;

export function isWorkbenchTaskStalled(task: WorkbenchTask, now: number): boolean {
  return now - (task.tracking?.lastProgressAt ?? task.createdAt) >= WORKBENCH_STALL_WINDOW_MS;
}

export function hasWorkbenchJobProgress(previous: GenerationJobPollStatus | undefined, next: GenerationJobPollStatus): boolean {
  return previous?.status !== next.status || previous?.phase !== next.phase
    || previous?.progress !== next.progress || previous?.step !== next.step || previous?.current_node !== next.current_node;
}

/** Human-facing state keeps local pauses separate from the provider's retained raw status. */
export function workbenchTaskStatusLabel(task: WorkbenchTask): string {
  if (task.failure?.code === 'task.stalled') return 'stalled';
  if (task.status === 'succeeded' || task.status === 'failed' || task.status === 'canceled') return task.status;
  if (task.job?.error_category === 'credential' || task.failure?.kind === 'authentication') return 'credential';
  if (task.job?.local_result_missing) return 'missingResult';
  if (task.job?.status === 'not_found' || task.status === 'not_found') return 'notFound';
  if (task.waitingCanceled) return 'paused';
  return task.status;
}
