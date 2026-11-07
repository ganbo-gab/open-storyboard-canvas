import {
  CANVAS_COMMAND_VERSION,
  type CanvasCommand,
  type CanvasCommandExecutionResult,
} from '@/features/canvas/domain/canvasCommands';
import { canvasCommandRegistry } from '@/features/canvas/application/canvasCommandService';
import type { CanvasAgentContext } from './sdkRuntime';
import { redactSensitiveValue } from '../application/agentRedaction';
import {
  canvasAgentApprovalStore,
  findRecoverableGenerationSubmit,
  findScopedReadGrant,
  type AgentScopeRequest,
} from '../application/agentApproval';

export const GENERATION_POLL_PURPOSE = 'poll-approved-generation-status';
export const GENERATION_POLL_GRANT_TTL_MS = 5 * 60_000;
const GENERATION_FOLLOW_THROUGH_MAX_ATTEMPTS = 72;
const GENERATION_FOLLOW_THROUGH_INITIAL_DELAY_MS = 1_500;
const GENERATION_FOLLOW_THROUGH_MAX_DELAY_MS = 3_000;

type GenerationFollowThroughOutcome = 'succeeded' | 'failed' | 'recoverable';

export interface GenerationFollowThroughResult {
  outcome: GenerationFollowThroughOutcome;
  attempts: number;
  inputNodeIds: string[];
  resultNodeIds: string[];
  status: CanvasCommandExecutionResult;
  message: string;
}

function generationStatusValue(result: CanvasCommandExecutionResult): Record<string, unknown> | null {
  if (!result.ok || !result.output.value || typeof result.output.value !== 'object' || Array.isArray(result.output.value)) {
    return null;
  }
  return result.output.value as Record<string, unknown>;
}

function generationResultNodeIds(result: CanvasCommandExecutionResult, inputNodeIds: string[]): string[] {
  if (!result.ok) return [];
  const value = generationStatusValue(result);
  const candidates = [
    ...(Array.isArray(value?.resultNodeIds) ? value.resultNodeIds : []),
    ...(typeof value?.resultNodeId === 'string' ? [value.resultNodeId] : []),
    ...(Array.isArray(result.output.references.nodeIds) ? result.output.references.nodeIds : []),
    ...(typeof result.output.references.nodeId === 'string' ? [result.output.references.nodeId] : []),
  ];
  const inputs = new Set(inputNodeIds);
  return Array.from(new Set(candidates.filter(
    (nodeId): nodeId is string => typeof nodeId === 'string' && nodeId.length > 0 && !inputs.has(nodeId),
  )));
}

export async function followAcceptedGeneration(input: {
  context: CanvasAgentContext;
  inputNodeIds: string[];
  execute: (command: CanvasCommand, expectedRevision: number) => Promise<CanvasCommandExecutionResult>;
  callId: string;
}): Promise<GenerationFollowThroughResult> {
  const maxAttempts = Math.max(1, Math.min(
    100,
    input.context.generationFollowThrough?.maxAttempts ?? GENERATION_FOLLOW_THROUGH_MAX_ATTEMPTS,
  ));
  const initialDelayMs = Math.max(
    0,
    input.context.generationFollowThrough?.initialDelayMs ?? GENERATION_FOLLOW_THROUGH_INITIAL_DELAY_MS,
  );
  const maxDelayMs = Math.max(
    initialDelayMs,
    input.context.generationFollowThrough?.maxDelayMs ?? GENERATION_FOLLOW_THROUGH_MAX_DELAY_MS,
  );
  const wait = input.context.generationFollowThrough?.wait
    ?? ((delayMs: number) => new Promise<void>((resolve) => globalThis.setTimeout(resolve, delayMs)));
  let lastStatus: CanvasCommandExecutionResult | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (input.context.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    if (attempt > 1 || initialDelayMs > 0) {
      const delayMs = Math.min(maxDelayMs, initialDelayMs * Math.max(1, attempt - 1));
      if (delayMs > 0) await wait(delayMs);
    }
    if (input.context.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const statuses = await Promise.all(input.inputNodeIds.map((nodeId) => input.execute({
      type: 'generation.status',
      version: CANVAS_COMMAND_VERSION,
      input: { nodeId },
    }, input.context.getCanvasRevision?.() ?? canvasCommandRegistry.getRevision())));
    const failedRead = statuses.find((status) => !status.ok);
    if (failedRead) {
      return {
        outcome: 'recoverable',
        attempts: attempt,
        inputNodeIds: input.inputNodeIds,
        resultNodeIds: [],
        status: failedRead,
        message: '生成已提交，但状态查询暂时失败。已保留原生成节点，可安全重新查询；没有重复提交生成请求。',
      };
    }
    const explicitFailure = statuses.find((status) => generationStatusValue(status)?.status === 'failed'
      || generationStatusValue(status)?.status === 'canceled');
    if (explicitFailure) {
      return {
        outcome: 'failed',
        attempts: attempt,
        inputNodeIds: input.inputNodeIds,
        resultNodeIds: generationResultNodeIds(explicitFailure, input.inputNodeIds),
        status: explicitFailure,
        message: String(generationStatusValue(explicitFailure)?.error || '上游生成明确失败。'),
      };
    }
    const recoverable = statuses.find((status) => {
      const state = generationStatusValue(status)?.status;
      return state === 'recoverable_wait' || state === 'unknown';
    });
    if (recoverable) {
      return {
        outcome: 'recoverable',
        attempts: attempt,
        inputNodeIds: input.inputNodeIds,
        resultNodeIds: generationResultNodeIds(recoverable, input.inputNodeIds),
        status: recoverable,
        message: '生成结果当前处于可恢复的未知状态。可以继续查询或重新获取已有任务结果；没有重复提交生成请求。',
      };
    }
    const pending = statuses.filter((status) => {
      const state = generationStatusValue(status)?.status;
      return state === 'idle' || state === 'queued' || state === 'submitting'
        || state === 'running' || state === 'materializing';
    });
    lastStatus = statuses[statuses.length - 1] ?? lastStatus;
    input.context.onToolEvent?.({
      toolName: 'canvas_command',
      callId: input.callId,
      status: 'executing',
      output: redactSensitiveValue({
        followThrough: {
          phase: 'generation-follow-through',
          attempt,
          maxAttempts,
          inputNodeIds: input.inputNodeIds,
          resultNodeIds: statuses.flatMap((status) => generationResultNodeIds(status, input.inputNodeIds)),
          statuses: statuses.map((status) => generationStatusValue(status)?.status ?? 'unknown'),
        },
      }),
    });
    if (pending.length === 0) {
      const resultNodeIds = statuses.flatMap((status) => generationResultNodeIds(status, input.inputNodeIds));
      return {
        outcome: 'succeeded',
        attempts: attempt,
        inputNodeIds: input.inputNodeIds,
        resultNodeIds: Array.from(new Set(resultNodeIds)),
        status: statuses[statuses.length - 1],
        message: '生成已完成。',
      };
    }
  }

  return {
    outcome: 'recoverable',
    attempts: maxAttempts,
    inputNodeIds: input.inputNodeIds,
    resultNodeIds: lastStatus ? generationResultNodeIds(lastStatus, input.inputNodeIds) : [],
    status: lastStatus ?? {
      ok: false,
      commandType: 'generation.status',
      revisionBefore: input.context.getCanvasRevision?.() ?? canvasCommandRegistry.getRevision(),
      revisionAfter: input.context.getCanvasRevision?.() ?? canvasCommandRegistry.getRevision(),
      error: { code: 'execution_failed', message: '生成状态查询已达到本轮上限。' },
    },
    message: `已完成 ${maxAttempts} 次有上限的状态查询，任务仍在处理中。已保留原任务，可稍后安全继续查询；没有重复提交生成请求。`,
  };
}

function generationPollScopeRequest(
  context: CanvasAgentContext,
  command: CanvasCommand,
): AgentScopeRequest | null {
  if (command.type !== 'generation.status' || !command.input.nodeId) return null;
  return {
    projectId: context.projectId,
    runId: context.runId,
    purpose: GENERATION_POLL_PURPOSE,
    resourceKinds: ['generation-status'],
    nodeIds: [command.input.nodeId],
    maxItems: 1,
  };
}

export function approvedGenerationPollGrant(
  context: CanvasAgentContext,
  command: CanvasCommand,
): { kind: 'grant'; approvalId: string; baseRevision: number }
  | { kind: 'recovery'; approvalId: string; receiptId: string; baseRevision: number }
  | undefined {
  const request = generationPollScopeRequest(context, command);
  const grant = request ? findScopedReadGrant(canvasAgentApprovalStore, request) : undefined;
  if (grant) return { kind: 'grant', approvalId: grant.id, baseRevision: grant.baseRevision };
  if (command.type !== 'generation.status') return undefined;
  const recovery = findRecoverableGenerationSubmit(canvasAgentApprovalStore, {
    projectId: context.projectId,
    runId: context.runId,
    nodeId: command.input.nodeId,
    jobId: command.input.jobId,
  });
  if (!recovery) return undefined;
  const approval = canvasAgentApprovalStore.get(recovery.approvalId);
  return {
    kind: 'recovery',
    approvalId: recovery.approvalId,
    receiptId: recovery.receiptId,
    baseRevision: approval?.baseRevision ?? context.getCanvasRevision?.() ?? canvasCommandRegistry.getRevision(),
  };
}
