import { asRecord, nonemptyString } from './workflow';

export interface ComfyUIProgress {
  type: 'status' | 'executing' | 'progress' | 'executed' | 'execution_error';
  promptId?: string;
  currentNode?: string | null;
  progress?: number;
  step?: number;
  totalSteps?: number;
  queueRemaining?: number;
  completed?: boolean;
  error?: string;
}

/** Binary preview frames and unknown/faulty messages are deliberately ignored. */
export function parseComfyUIProgress(message: unknown): ComfyUIProgress | null {
  let payload: unknown = message;
  if (typeof message === 'string') {
    try { payload = JSON.parse(message); } catch { return null; }
  }
  const root = asRecord(payload);
  const data = asRecord(root?.data);
  if (!data || !['status', 'executing', 'progress', 'executed', 'execution_error'].includes(String(root?.type))) return null;
  const type = root!.type as ComfyUIProgress['type'];
  const result: ComfyUIProgress = { type };
  const promptId = nonemptyString(data.prompt_id);
  if (promptId) result.promptId = promptId;
  if (typeof data.node === 'string' || typeof data.node === 'number') result.currentNode = String(data.node);
  if (type === 'executing' && data.node === null) {
    result.currentNode = null;
    result.completed = true;
  }
  if (type === 'status') {
    const remaining = asRecord(asRecord(data.status)?.exec_info)?.queue_remaining;
    if (typeof remaining === 'number' && Number.isFinite(remaining)) result.queueRemaining = remaining;
  }
  if (type === 'progress' && typeof data.value === 'number' && typeof data.max === 'number' && Number.isFinite(data.value) && Number.isFinite(data.max) && data.max > 0) {
    result.step = data.value;
    result.totalSteps = data.max;
    result.progress = Math.max(0, Math.min(1, data.value / data.max));
  }
  if (type === 'execution_error') {
    result.error = nonemptyString(data.exception_message) || nonemptyString(data.exception_type) || 'ComfyUI 工作流执行失败。';
  }
  return result;
}
