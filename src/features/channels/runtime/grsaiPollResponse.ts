import { z } from 'zod';
import type { AsyncResponse, ChannelProfileV2, OperationKind } from '../domain/profile';
import { extractOutputs } from '../domain/response';
import type { ChannelError, PollResult } from './types';

const envelopeSchema = z.object({ code: z.number().int(), msg: z.string().optional(), data: z.unknown().optional() });
const taskSchema = z.object({ id: z.union([z.string(), z.number()]).optional(), status: z.string().nullable().optional(), results: z.array(z.unknown()).nullable().optional(),
  error: z.string().nullable().optional(), failure_reason: z.string().nullable().optional(), progress: z.number().finite().nullable().optional() })
  .refine((task) => task.id !== undefined || task.status !== undefined || task.results !== undefined || task.progress !== undefined);
const resultPath = /^(?:data\.)?results(?:\[(?:\d+|\*)\]|\.(?:\d+|\*))\.url$/;

/** Match the existing GRSAI wire contract, including saved pre-refactor snapshots.
 * Other providers and custom output contracts continue using their declared status rules.
 */
export function grsaiPollResult(profile: ChannelProfileV2, response: AsyncResponse, operation: OperationKind, payload: unknown): PollResult | null {
  const poll = response.poll;
  if (!operation.startsWith('image.') || new URL(profile.baseUrl).hostname !== 'grsai.dakka.com.cn'
    || poll.method !== 'POST' || poll.path.replace(/\/$/, '') !== '/v1/draw/result' || poll.resultRequest
    || !['status', 'data.status', undefined].includes(poll.statusPath)
    || !poll.outputs.length || !poll.outputs.every((output) => 'path' in output && output.as === 'url' && resultPath.test(output.path))) return null;
  const queryFailure = (message: string, upstreamMessage?: string): PollResult => ({ state: 'failed', error: {
    category: 'upstream', message, ...(upstreamMessage ? { upstreamMessage } : {}), retryable: true,
  } });
  const envelope = envelopeSchema.safeParse(payload);
  if (envelope.success && envelope.data.code !== 0) return queryFailure(
    `GRSAI 查询返回业务错误（code ${envelope.data.code}）；已暂停查询并保留原任务，可核对渠道任务记录后重查。`, envelope.data.msg,
  );
  const data = envelope.success ? envelope.data.data : payload;
  const parsed = taskSchema.safeParse(data);
  if (!parsed.success) return queryFailure('GRSAI 查询响应不符合任务格式；已保留原任务，请检查渠道返回数据。');
  const task = parsed.data;
  const status = task.status?.trim().toLowerCase();
  // Explicit failures win over leftover outputs. An API query error above does
  // not prove task failure; a returned task's failed status does.
  if (status === 'failed' || poll.failure.some((value) => value.trim().toLowerCase() === status)) {
    const error: ChannelError = { category: 'upstream', message: 'GRSAI 上游任务失败',
      upstreamMessage: task.error || task.failure_reason || envelope.data?.msg || '上游返回 failed 状态', retryable: false };
    return { state: 'failed', error };
  }
  const outputs = extractOutputs(data, poll.outputs.map((output) => 'path' in output
    ? { ...output, path: output.path.replace(/^data\./, '') } : output), operation);
  if (outputs.length) return { state: 'done', outputs };
  if (status && !['running', 'pending', 'queued', 'processing'].includes(status)) return queryFailure(
    'GRSAI 返回非等待状态但没有可用结果；已保留原任务，可稍后取回或核对结果字段。',
  );
  return { state: 'pending', ...(typeof task.progress === 'number' ? { progress: task.progress } : {}) };
}
