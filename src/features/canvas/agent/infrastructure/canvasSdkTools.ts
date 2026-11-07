import { tool } from '@openai/agents';
import type { JsonObjectSchemaNonStrict } from '@openai/agents-core/types';
import { z } from 'zod';
import {
  CANVAS_COMMAND_TYPES,
  CANVAS_COMMAND_VERSION,
  type CanvasCommand,
} from '@/features/canvas/domain/canvasCommands';
import { canvasCommandRegistry } from '@/features/canvas/application/canvasCommandService';
import { buildCanvasAssetCatalog } from '@/features/canvas/application/canvasAssetCatalog';
import { getAssetPortableSource, resolveAsset } from '@/features/assets/application/assetCatalog';
import { loadDiagnosticEvents } from '@/features/canvas/application/diagnosticEvents';
import { useCanvasStore } from '@/stores/canvasStore';
import { closeCanvasHistoryGroup, withCanvasHistoryAgentTurn } from '@/stores/canvasHistory';
import type { CanvasAgentContext, CanvasAgentToolEvent } from './sdkRuntime';
import type { AgentToolPolicy } from '../application/agentSkills';
import type { CanvasAgentExecutionMode } from '../application/agentAutoApprovalPolicy';
import {
  buildDiagnosticBundlePreview,
  classifyAgentError,
  inspectDiagnosticConfigSnapshot,
  inspectCanvasHealth,
  inspectPersistedGenerationJobs,
  preflightGeneration,
} from '../application/agentDiagnostics';
import { redactSensitiveValue } from '../application/agentRedaction';
import {
  applyAgentGenerationNetworkPatch,
  applyAgentProviderPatch,
  getAgentGenerationNetworkRevision,
  getAgentProviderRevision,
  previewAgentGenerationNetworkPatch,
  previewAgentProviderPatch,
  rollbackAgentProviderPatch,
  type AgentProviderPatchV1,
} from '../application/agentConfigPatch';
import { createAgentMediaReference, prepareAgentMediaSource, toOpaqueAgentMediaReference } from '../application/agentMediaResolver';
import { canvasAgentRollbackStore } from '../application/agentCanvasRollback';
import {
  canvasAgentApprovalExecution,
  canvasAgentApprovalStore,
  createAgentRequestFingerprint,
  createApprovalId,
  listRecoverableGenerationSubmits,
  recoverUnknownGenerationSubmit,
} from '../application/agentApproval';
import {
  approvedGenerationPollGrant,
  followAcceptedGeneration,
  GENERATION_POLL_GRANT_TTL_MS,
  GENERATION_POLL_PURPOSE,
  type GenerationFollowThroughResult,
} from './canvasSdkGeneration';

export const STORYBOARD_DEFERRED_TOOL = 'storyboardDeferredTool';

function objectOutput(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { result: value };
}

const canvasCommandInputParser = z.object({
  type: z.string().min(1),
  input: z.record(z.string(), z.unknown()).default({}),
}).strict();

function canvasCommandContractSummary(): string {
  return canvasCommandRegistry.list().map(({ type, schema }) => {
    const required = new Set(schema.input.required);
    const fields = Object.entries(schema.input.properties).map(([name, field]) => (
      `${name}${required.has(name) ? '' : '?'}:${field.type}`
    ));
    return `${type} { ${fields.join(', ')} }`;
  }).join('; ');
}

function canvasCommandVariants(): Array<Record<string, unknown>> {
  return canvasCommandRegistry.list().map(({ type, schema }) => ({
    title: type,
    description: `Exact canvas_command contract for ${type}.`,
    type: 'object',
    properties: {
      type: { type: 'string', enum: [type] },
      input: schema.input,
    },
    required: ['type', 'input'],
    additionalProperties: false,
  }));
}

const canvasCommandParameters = {
  type: 'object' as const,
  properties: {
    type: {
      type: 'string' as const,
      enum: [...CANVAS_COMMAND_TYPES],
      description: 'Registered CanvasCommand type, including safe tag and tag-group operations.',
    },
    input: {
      type: 'object' as const,
      description: `Command-specific input. Use only the fields listed for the selected type. Exact contracts: ${canvasCommandContractSummary()}`,
    },
  },
  required: ['type', 'input'],
  additionalProperties: false as const,
  anyOf: canvasCommandVariants(),
};

// The SDK's non-strict schema type requires `additionalProperties: true`, even
// though providers accept a closed JSON Schema when `strict` is disabled. Keep
// the runtime schema closed and exact, and adapt only at this SDK typing boundary.
const canvasCommandSdkParameters = canvasCommandParameters as unknown as JsonObjectSchemaNonStrict<
  typeof canvasCommandParameters.properties
>;

const diagnosticsParameters = z.object({
  operation: z.enum(['health', 'provider-config', 'generation-jobs', 'application-logs', 'preflight', 'classify-error', 'bundle-preview']),
  error: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  aspectRatio: z.string().optional(),
  resolution: z.string().optional(),
  maxPixels: z.number().optional(),
  nodeIds: z.array(z.string()).optional(),
  now: z.number().optional(),
  stalledAfterMs: z.number().optional(),
  requiresVision: z.boolean().optional(),
  supportsVision: z.boolean().optional(),
  requiresTools: z.boolean().optional(),
  supportsTools: z.boolean().optional(),
  accessState: z.enum(['configured', 'missing']).optional(),
  endpointValid: z.boolean().optional(),
  reproductionSteps: z.array(z.string()).optional(),
  jobId: z.string().optional(),
  severity: z.enum(['debug', 'info', 'warning', 'error']).optional(),
  source: z.string().max(200).optional(),
  query: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

const configPatchParameters = z.object({
  action: z.enum(['preview', 'apply', 'rollback']),
  providerId: z.string().optional(),
  settingsTarget: z.enum(['generation-network']).optional(),
  networkRoute: z.enum(['system', 'direct', 'custom-proxy']).optional(),
  baseRevision: z.string().optional(),
  rollbackToken: z.string().optional(),
  baseUrl: z.string().optional(),
  endpointPath: z.string().optional(),
  apiStyle: z.string().optional(),
  modelId: z.string().optional(),
  supportsTools: z.boolean().optional(),
  supportsMultimodal: z.boolean().optional(),
  supportsStreaming: z.boolean().optional(),
  supportsReasoningSummary: z.boolean().optional(),
  supportsToolSearch: z.boolean().optional(),
  agentProtocol: z.enum(['openai-responses', 'openai-chat-completions', 'anthropic-messages', 'google-gemini']).optional(),
});

const assetReadParameters = z.object({
  assetId: z.string().min(1),
}).strict();

function toolEvent(context: CanvasAgentContext, event: CanvasAgentToolEvent): void {
  context.onToolEvent?.({
    ...event,
    input: event.input === undefined ? undefined : redactSensitiveValue(event.input),
    output: event.output === undefined ? undefined : redactSensitiveValue(event.output),
    error: event.error === undefined ? undefined : redactSensitiveValue(event.error),
  });
}

function isRevisionConflictMessage(value: unknown): boolean {
  const message = typeof value === 'string'
    ? value
    : value instanceof Error
      ? value.message
      : '';
  return /revision.*conflict|审批后发生变化|需要重新预览|配置.*变化|stale preview/i.test(message);
}

function requiredToolCallId(details: { toolCall?: { callId?: string } } | undefined): string {
  const callId = details?.toolCall?.callId;
  if (!callId) throw new Error('Agent 工具调用缺少稳定 callId，已拒绝执行。');
  return callId;
}

export function createCanvasSdkTools(options: {
  context: CanvasAgentContext;
  toolPolicy: AgentToolPolicy;
  allowedToolNames?: readonly string[];
  executionMode?: CanvasAgentExecutionMode;
}) {
  const { context, toolPolicy, allowedToolNames } = options;
  const rejectDisallowedTool = (name: string): string | undefined => {
    if ((allowedToolNames === undefined || allowedToolNames.includes(name))
      && (context.allowedToolNames === undefined || context.allowedToolNames.includes(name))) return undefined;
    const error = `Tool ${name} is not allowed by the selected skill whitelist.`;
    toolEvent(context, { toolName: name, status: 'failed', error });
    return JSON.stringify({ ok: false, code: 'tool-not-allowed', error });
  };
  const historyGroupId = JSON.stringify([context.projectId, context.runId]);
  const execute = async (command: CanvasCommand, expectedRevision: number, signal?: AbortSignal) => {
    const effect = canvasCommandRegistry.getDefinition(command.type).effect;
    if (effect === 'generation') {
      useCanvasStore.setState((state) => ({ history: closeCanvasHistoryGroup(state.history) }));
    }
    return withCanvasHistoryAgentTurn(historyGroupId, () => context.executeCanvasCommand
      ? context.executeCanvasCommand(command, expectedRevision, { signal })
      : canvasCommandRegistry.executeApproved(command, expectedRevision, 'agent', effect === 'graph' ? historyGroupId : undefined, { signal }));
  };
  const canvasTool = tool({
    name: 'canvas_command',
    description: options.executionMode === 'full'
      ? 'Read or change the canvas through the versioned command contract. The user selected full automatic execution for registered edits, generation and configuration; budget, revision and exactly-once boundaries still apply.'
      : options.executionMode === 'auto'
      ? 'Read or change the canvas through the versioned command contract. Calls are visible; paid, destructive and configuration operations still follow application approval policy.'
      : 'Read or change the canvas through the versioned command contract. Calls are visible and require confirmation in manual mode.',
    parameters: canvasCommandSdkParameters,
    strict: false,
    providerData: toolPolicy.deferredToolKinds.includes('canvas')
      ? { [STORYBOARD_DEFERRED_TOOL]: true }
      : undefined,
    needsApproval: async (_runContext, rawInput) => {
      if (rejectDisallowedTool('canvas_command')) return false;
      const parsed = canvasCommandInputParser.safeParse(rawInput);
      if (!parsed.success) return true;
      const command = {
        type: parsed.data.type,
        version: CANVAS_COMMAND_VERSION,
        input: parsed.data.input,
      } as CanvasCommand;
      return !approvedGenerationPollGrant(context, command);
    },
    execute: async (rawInput, _runContext, details) => {
      const denied = rejectDisallowedTool('canvas_command');
      if (denied) return denied;
      // Approval resumes have a fresh SDK invocation signal, not necessarily the
      // signal captured when this tool was created for the original turn.
      const signal = details?.signal && context.signal && details.signal !== context.signal
        ? AbortSignal.any([context.signal, details.signal])
        : details?.signal ?? context.signal;
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const input = canvasCommandInputParser.parse(rawInput);
      const command = { type: input.type, version: CANVAS_COMMAND_VERSION, input: input.input } as CanvasCommand;
      const callId = requiredToolCallId(details);
      const approvalId = createApprovalId(context.runId, 'canvas_command', callId);
      const requestFingerprint = await createAgentRequestFingerprint('canvas_command', input);
      const pollGrant = approvedGenerationPollGrant(context, command);
      if (pollGrant) {
        toolEvent(context, { toolName: 'canvas_command', callId, status: 'executing', input });
        try {
          const recovered = pollGrant.kind === 'recovery'
            ? await recoverUnknownGenerationSubmit({
                store: canvasAgentApprovalStore,
                receiptId: pollGrant.receiptId,
                projectId: context.projectId,
                runId: context.runId,
                target: command.type === 'generation.status' ? command.input : {},
                executeStatus: (statusCommand) => execute(statusCommand, pollGrant.baseRevision, signal),
              })
            : undefined;
          const result = recovered?.result ?? await execute(command, pollGrant.baseRevision, signal);
          toolEvent(context, { toolName: 'canvas_command', callId, status: result.ok ? 'succeeded' : 'failed', output: result });
          return redactSensitiveValue({
            ...result,
            execution: {
              grantApprovalId: pollGrant.approvalId,
              recoveryReceiptId: recovered?.receipt.id,
              replayed: false,
            },
          });
        } catch (error) {
          const message = redactSensitiveValue(error instanceof Error ? error.message : String(error));
          toolEvent(context, { toolName: 'canvas_command', callId, status: 'failed', error: message });
          return { ok: false, error: message };
        }
      }
      const approval = canvasAgentApprovalStore.get(approvalId);
      if (!approval) throw new Error('画布命令缺少持久审批记录。');
      toolEvent(context, { toolName: 'canvas_command', callId, status: 'executing', input });
      try {
        const execution = await canvasAgentApprovalExecution.executeOnce({
          approvalId,
          runId: context.runId,
          projectId: context.projectId,
          toolName: 'canvas_command',
          callId,
          requestFingerprint,
          activeProjectId: context.getActiveProjectId?.(),
          currentRevision: context.getCanvasRevision?.() ?? canvasCommandRegistry.getRevision(),
          safeRecovery: command.type === 'generation.submit'
            ? { kind: 'generation-status', nodeIds: command.input.nodeIds, jobIds: [] }
            : undefined,
          execute: async () => {
            const graphWrite = approval.impact.effect === 'canvas-write'
              && (
                canvasCommandRegistry.getDefinition(command.type).effect === 'graph'
                || command.type === 'node.tool.run'
              );
            const rollbackToken = graphWrite
              ? canvasAgentRollbackStore.begin(
                  context.projectId,
                  context.runId,
                  useCanvasStore.getState().revision,
                  useCanvasStore.getState().history.past.length,
                )
              : undefined;
            try {
              const result = await execute(command, approval.baseRevision, signal);
              if (!result.ok) {
                if (rollbackToken) canvasAgentRollbackStore.discard(rollbackToken);
                return result;
              }
              if (rollbackToken) {
                const past = useCanvasStore.getState().history.past;
                canvasAgentRollbackStore.complete(rollbackToken, result.revisionAfter,
                  past[past.length - 1]?.groupId === historyGroupId ? past.length - 1 : undefined);
              }
              if (result.ok && (
                approval.impact.effect === 'canvas-write'
                || command.type === 'director.record'
              )) {
                await context.persistCanvasCheckpoint?.();
              }
              return rollbackToken ? { ...result, rollbackToken } : result;
            } catch (error) {
              if (rollbackToken) canvasAgentRollbackStore.discard(rollbackToken);
              throw error;
            }
          },
          isSuccess: (result) => result.ok,
          isAccepted: (result) => command.type === 'generation.submit' && result.ok,
          isUnknownOutcome: (result) => command.type === 'generation.submit'
            && !result.ok
            && result.error.code === 'execution_failed',
          isConflict: (result) => !result.ok && result.error.code === 'revision_conflict',
        });
        const result = execution.output;
        if (command.type === 'generation.submit' && result.ok) {
          const acceptedNodeIds = result.output.references.nodeIds ?? [];
          if (acceptedNodeIds.length > 0) {
            canvasAgentApprovalStore.update(approval.id, {
              scope: {
                projectId: context.projectId,
                runId: context.runId,
                purpose: GENERATION_POLL_PURPOSE,
                resourceKinds: ['generation-status'],
                nodeIds: acceptedNodeIds,
                maxItems: acceptedNodeIds.length,
                expiresAt: Date.now() + GENERATION_POLL_GRANT_TTL_MS,
              },
            });
          }
        }
        let followThrough: GenerationFollowThroughResult | undefined;
        if (command.type === 'generation.submit' && result.ok) {
          const inputNodeIds = result.output.references.nodeIds ?? command.input.nodeIds;
          if (inputNodeIds.length > 0) {
            toolEvent(context, {
              toolName: 'canvas_command',
              callId,
              status: 'executing',
              output: {
                ...result,
                followThrough: {
                  phase: 'accepted',
                  inputNodeIds,
                  resultNodeIds: [],
                },
              },
            });
            followThrough = await followAcceptedGeneration({
              context,
              inputNodeIds,
              execute: (followCommand, expectedRevision) => execute(followCommand, expectedRevision, signal),
              callId,
            });
          }
        }
        const receiptStatus = followThrough?.outcome === 'succeeded'
          ? 'succeeded' as const
          : followThrough?.outcome === 'failed'
            ? 'failed' as const
            : execution.receipt.status;
        if (receiptStatus !== execution.receipt.status) {
          const storedReceipt = canvasAgentApprovalStore.getReceiptById(execution.receipt.id) ?? execution.receipt;
          canvasAgentApprovalStore.putReceipt({
            ...storedReceipt,
            status: receiptStatus,
            updatedAt: Date.now(),
            output: redactSensitiveValue({ ...result, followThrough }),
          });
        }
        const toolOutput = redactSensitiveValue({
          ...result,
          ...(followThrough ? { followThrough } : {}),
          execution: {
            receiptId: execution.receipt.id,
            receiptStatus,
            safeRecovery: execution.receipt.safeRecovery,
            replayed: execution.replayed,
          },
        });
        toolEvent(context, {
          toolName: 'canvas_command',
          callId,
          status: followThrough?.outcome === 'failed'
            ? 'failed'
            : followThrough?.outcome === 'recoverable' || receiptStatus === 'unknown'
              ? 'unknown'
              : result.ok ? 'succeeded' : 'failed',
          output: toolOutput,
          error: followThrough && followThrough.outcome !== 'succeeded'
            ? followThrough.message
            : undefined,
        });
        return toolOutput;
      } catch (error) {
        if (signal?.aborted) throw error;
        const message = redactSensitiveValue(error instanceof Error ? error.message : String(error));
        const recovery = listRecoverableGenerationSubmits(canvasAgentApprovalStore, {
          projectId: context.projectId,
          runId: context.runId,
        }).find((candidate) => candidate.approvalId === approvalId);
        const output = recovery ? {
          ok: false,
          error: message,
          execution: {
            receiptId: recovery.receiptId,
            receiptStatus: recovery.receiptStatus,
            safeRecovery: {
              kind: recovery.kind,
              nodeIds: recovery.nodeIds,
              jobIds: recovery.jobIds,
            },
            replayed: true,
          },
        } : { ok: false, error: message };
        toolEvent(context, {
          toolName: 'canvas_command',
          callId,
          status: recovery ? 'unknown' : isRevisionConflictMessage(message) ? 'warning' : 'failed',
          output,
          error: message,
        });
        return output;
      }
    },
  });
  const diagnosticsTool = tool({
    name: 'diagnostics',
    description: 'Run a bounded, non-paying diagnostic or preflight check. It never reads secret values.',
    parameters: diagnosticsParameters,
    providerData: toolPolicy.deferredToolKinds.includes('diagnostics')
      ? { [STORYBOARD_DEFERRED_TOOL]: true }
      : undefined,
    needsApproval: true,
    execute: async (input, _runContext, details) => {
      const denied = rejectDisallowedTool('diagnostics');
      if (denied) return denied;
      const callId = requiredToolCallId(details);
      const approvalId = createApprovalId(context.runId, 'diagnostics', callId);
      const requestFingerprint = await createAgentRequestFingerprint('diagnostics', input);
      toolEvent(context, { toolName: 'diagnostics', callId, status: 'executing', input });
      try {
        const execution = await canvasAgentApprovalExecution.executeOnce({
          approvalId,
          runId: context.runId,
          projectId: context.projectId,
          toolName: 'diagnostics',
          callId,
          requestFingerprint,
          activeProjectId: context.getActiveProjectId?.(),
          execute: async () => input.operation === 'health'
            ? inspectCanvasHealth(input)
            : input.operation === 'provider-config'
              ? inspectDiagnosticConfigSnapshot()
              : input.operation === 'generation-jobs'
                ? inspectPersistedGenerationJobs({ jobId: input.jobId, limit: input.limit })
              : input.operation === 'application-logs'
                ? loadDiagnosticEvents({
                    severity: input.severity,
                    source: input.source,
                    query: input.query,
                    limit: input.limit,
                  })
              : input.operation === 'classify-error'
                ? classifyAgentError(input.error)
                : input.operation === 'bundle-preview'
                  ? buildDiagnosticBundlePreview({
                    error: input.error,
                    evidence: context.getDiagnosticEvidence?.(),
                    runtimeSnapshot: context.getDiagnosticRuntimeSnapshot?.(),
                    reproductionSteps: input.reproductionSteps,
                    now: input.now,
                  })
                : preflightGeneration(input),
        });
        const result = execution.output;
        const toolOutput = {
          ...objectOutput(result),
          execution: { receiptId: execution.receipt.id, replayed: execution.replayed },
        };
        toolEvent(context, { toolName: 'diagnostics', callId, status: 'succeeded', output: toolOutput });
        return toolOutput;
      } catch (error) {
        const message = redactSensitiveValue(error instanceof Error ? error.message : String(error));
        toolEvent(context, { toolName: 'diagnostics', callId, status: 'failed', error: message });
        return { ok: false, error: message };
      }
    },
  });
  const configPatchTool = tool({
    name: 'config_patch',
    description: 'Preview, apply, or roll back a versioned allowlisted non-secret provider configuration patch. Preview first, then ask for a separate apply approval.',
    parameters: configPatchParameters,
    providerData: toolPolicy.deferredToolKinds.includes('config')
      ? { [STORYBOARD_DEFERRED_TOOL]: true }
      : undefined,
    needsApproval: true,
    execute: async (input, _runContext, details) => {
      const denied = rejectDisallowedTool('config_patch');
      if (denied) return denied;
      const callId = requiredToolCallId(details);
      const approvalId = createApprovalId(context.runId, 'config_patch', callId);
      const requestFingerprint = await createAgentRequestFingerprint('config_patch', input);
      toolEvent(context, { toolName: 'config_patch', callId, status: 'executing', input });
      try {
        const execution = await canvasAgentApprovalExecution.executeOnce({
          approvalId,
          runId: context.runId,
          projectId: context.projectId,
          toolName: 'config_patch',
          callId,
          requestFingerprint,
          activeProjectId: context.getActiveProjectId?.(),
          currentConfigRevision: input.settingsTarget === 'generation-network'
            ? getAgentGenerationNetworkRevision()
            : input.providerId ? getAgentProviderRevision(input.providerId) : null,
          execute: async () => {
            if (input.action !== 'preview') {
              useCanvasStore.setState((state) => ({ history: closeCanvasHistoryGroup(state.history) }));
            }
            if (input.action === 'rollback') {
              return input.rollbackToken ? rollbackAgentProviderPatch(input.rollbackToken) : { ok: false, error: '缺少 rollbackToken。' };
            }
            if (input.settingsTarget === 'generation-network') {
              if (!input.networkRoute) return { ok: false, issues: ['缺少 networkRoute。'] };
              const patch = {
                baseRevision: input.baseRevision
                  ?? (input.action === 'preview' ? getAgentGenerationNetworkRevision() : ''),
                route: input.networkRoute,
              };
              return input.action === 'preview'
                ? previewAgentGenerationNetworkPatch(patch)
                : applyAgentGenerationNetworkPatch(patch);
            }
            if (!input.providerId) return { ok: false, issues: ['缺少 providerId。'] };
            const metadata = input.modelId ? {
              supportsTools: input.supportsTools,
              supportsMultimodal: input.supportsMultimodal,
              supportsStreaming: input.supportsStreaming,
              supportsReasoningSummary: input.supportsReasoningSummary,
              supportsToolSearch: input.supportsToolSearch,
              agentProtocol: input.agentProtocol,
            } : undefined;
            const patch: AgentProviderPatchV1 = {
              version: 1,
              providerId: input.providerId,
              baseRevision: input.baseRevision ?? (input.action === 'preview' ? getAgentProviderRevision(input.providerId) ?? '' : ''),
              changes: { baseUrl: input.baseUrl, endpointPath: input.endpointPath, apiStyle: input.apiStyle, modelId: input.modelId, modelMetadata: metadata },
            };
            return input.action === 'preview' ? previewAgentProviderPatch(patch) : applyAgentProviderPatch(patch);
          },
          isConflict: (result) => {
            if (result.ok) return false;
            const issues = 'issues' in result
              ? result.issues
              : 'error' in result && result.error
                ? [result.error]
                : [];
            return issues.some((issue) => /变化|版本|revision|重新(?:生成|预览)/i.test(issue));
          },
          isSuccess: (result) => result.ok,
        });
        const result = execution.output;
        const toolOutput = { ...result, execution: { receiptId: execution.receipt.id, replayed: execution.replayed } };
        toolEvent(context, {
          toolName: 'config_patch',
          callId,
          status: result.ok ? 'succeeded' : isRevisionConflictMessage('issues' in result ? result.issues.join(' ') : result.error) ? 'warning' : 'failed',
          output: toolOutput,
        });
        return toolOutput;
      } catch (error) {
        const message = redactSensitiveValue(error instanceof Error ? error.message : String(error));
        toolEvent(context, { toolName: 'config_patch', callId, status: isRevisionConflictMessage(message) ? 'warning' : 'failed', error: message });
        return { ok: false, error: message };
      }
    },
  });
  const assetReadTool = toolPolicy.toolKinds.includes('asset-read') ? tool({
    name: 'asset_read',
    description: 'Read one registered image discovered through asset.list or explicitly attached from the asset library. Use its exact stable assetId. The image is sent to the current vision model only after user approval.',
    parameters: assetReadParameters,
    providerData: toolPolicy.deferredToolKinds.includes('asset-read')
      ? { [STORYBOARD_DEFERRED_TOOL]: true }
      : undefined,
    needsApproval: true,
    execute: async (input, _runContext, details) => {
      const denied = rejectDisallowedTool('asset_read');
      if (denied) return [{ type: 'text' as const, text: denied }];
      const callId = requiredToolCallId(details);
      const approvalId = createApprovalId(context.runId, 'asset_read', callId);
      const requestFingerprint = await createAgentRequestFingerprint('asset_read', input);
      toolEvent(context, { toolName: 'asset_read', callId, status: 'executing', input });
      try {
        const approval = canvasAgentApprovalStore.get(approvalId);
        if (!approval) throw new Error('图片读取缺少持久审批记录。');
        const execution = await canvasAgentApprovalExecution.executeOnce({
          approvalId,
          runId: context.runId,
          projectId: context.projectId,
          toolName: 'asset_read',
          callId,
          requestFingerprint,
          activeProjectId: context.getActiveProjectId?.(),
          currentRevision: context.getCanvasRevision?.() ?? canvasCommandRegistry.getRevision(),
          execute: async () => {
            const currentRevision = context.getCanvasRevision?.() ?? canvasCommandRegistry.getRevision();
            if (currentRevision !== approval.baseRevision) {
              throw new Error('画布在图片审批后发生变化，请重新查找并批准这张图片。');
            }
            const canvasAsset = buildCanvasAssetCatalog(useCanvasStore.getState().nodes)
              .find((candidate) => candidate.id === input.assetId);
            const libraryAsset = canvasAsset ? null : await resolveAsset(input.assetId);
            const asset = canvasAsset ?? (libraryAsset ? {
              id: libraryAsset.id, nodeId: libraryAsset.nodeId, title: libraryAsset.name,
              kind: libraryAsset.kind, url: libraryAsset.source, aspectRatio: undefined,
            } : null);
            if (!asset) throw new Error(`图片资产 ${input.assetId} 不存在或已移除，请使用附件或资产列表中的真实 assetId。`);
            if (asset.kind !== 'image') throw new Error(`资产 ${input.assetId} 不是可供视觉模型读取的图片。`);
            const source = await prepareAgentMediaSource(await getAssetPortableSource(asset.url));
            const reference = createAgentMediaReference(
              context.runId,
              asset.nodeId ?? asset.id,
              source,
              10 * 60_000,
              asset.id,
            );
            const metadata = {
              assetId: asset.id,
              nodeId: asset.nodeId,
              title: asset.title,
              kind: asset.kind,
              aspectRatio: asset.aspectRatio,
            };
            return {
              metadata,
              content: [
                { type: 'text' as const, text: JSON.stringify(metadata) },
                { type: 'image' as const, image: toOpaqueAgentMediaReference(reference), detail: 'auto' as const },
              ],
            };
          },
        });
        const toolOutput = execution.output.content;
        toolEvent(context, {
          toolName: 'asset_read',
          callId,
          status: 'succeeded',
          output: {
            ...execution.output.metadata,
            execution: { receiptId: execution.receipt.id, replayed: execution.replayed },
          },
        });
        return toolOutput;
      } catch (error) {
        const message = redactSensitiveValue(error instanceof Error ? error.message : String(error));
        toolEvent(context, { toolName: 'asset_read', callId, status: 'failed', error: message });
        return [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: message }) }];
      }
    },
  }) : null;
  return [
    ...(toolPolicy.toolKinds.includes('canvas') ? [canvasTool] : []),
    ...(toolPolicy.toolKinds.includes('diagnostics') ? [diagnosticsTool] : []),
    ...(toolPolicy.toolKinds.includes('config') ? [configPatchTool] : []),
    ...(assetReadTool ? [assetReadTool] : []),
  ];
}
