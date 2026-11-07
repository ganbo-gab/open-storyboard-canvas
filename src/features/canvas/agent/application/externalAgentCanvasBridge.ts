import { resolveExternalAgentToolCall, type ExternalAgentToolResolution } from '@/commands/externalAgent';
import { canvasCommandRegistry } from '@/features/canvas/application/canvasCommandService';
import { CANVAS_COMMAND_VERSION, type CanvasCommand } from '@/features/canvas/domain/canvasCommands';
import { useCanvasStore } from '@/stores/canvasStore';
import { closeCanvasHistoryGroup } from '@/stores/canvasHistory';
import { useProjectStore } from '@/stores/projectStore';
import {
  applyAgentGenerationNetworkPatch,
  applyAgentProviderPatch,
  getAgentGenerationNetworkRevision,
  getAgentProviderRevision,
  previewAgentGenerationNetworkPatch,
  previewAgentProviderPatch,
  rollbackAgentProviderPatch,
  type AgentProviderPatchV1,
} from './agentConfigPatch';
import {
  buildDiagnosticBundlePreview,
  classifyAgentError,
  inspectCanvasHealth,
  inspectDiagnosticConfigSnapshot,
  inspectPersistedGenerationJobs,
  preflightGeneration,
} from './agentDiagnostics';
import {
  canvasAgentApprovalExecution,
  canvasAgentApprovalStore,
  createAgentRequestFingerprint,
  createApprovalId,
  type AgentApprovalRecord,
} from './agentApproval';
import { canvasAgentBudgetLedger } from './agentBudget';
import { canvasAgentRollbackStore } from './agentCanvasRollback';
import { prepareCanvasAgentToolApproval, type AgentApprovalView } from './canvasAgentController';
import { redactSensitiveValue } from './agentRedaction';
import type { ExternalAgentToolRequest } from '../domain/agentModel';
import { loadDiagnosticEvents } from '@/features/canvas/application/diagnosticEvents';
import { shouldAutomaticallyResolveAgentApproval, type CanvasAgentExecutionMode } from './agentAutoApprovalPolicy';
import { normalizeExternalAgentToolRequest, type ExternalAgentToolRequestInput } from './externalAgentToolRequest';

export interface ExternalAgentToolExecutionResult {
  approvalId: string;
  receiptId?: string;
  output?: unknown;
  error?: string;
  status: 'approved' | 'denied' | 'error';
}

const preparingApprovals = new Map<string, Set<{ projectId: string; cancelled: boolean }>>();

/** Revoke pending authority without interrupting an operation that has already started. */
export function cancelExternalAgentToolRequest(input: {
  projectId: string;
  request: ExternalAgentToolRequestInput;
}): void {
  const request = normalizeExternalAgentToolRequest(input.request);
  const approvalId = createApprovalId(request.turnId, request.toolName, request.callId);
  for (const pending of preparingApprovals.get(approvalId) ?? []) {
    if (pending.projectId === input.projectId) pending.cancelled = true;
  }
  const approval = canvasAgentApprovalStore.get(approvalId);
  if (!approval || approval.projectId !== input.projectId) return;
  if (['proposed', 'awaiting-approval', 'approved'].includes(approval.status)) {
    canvasAgentApprovalStore.update(approvalId, { status: 'cancelled' });
    canvasAgentBudgetLedger.release(input.projectId, approvalId);
  }
}

class ExternalAgentResolutionDeliveryError extends Error {
  constructor(readonly original: unknown) {
    super(original instanceof Error ? original.message : String(original));
    this.name = 'ExternalAgentResolutionDeliveryError';
  }
}

async function deliverExternalToolResolution(
  request: ExternalAgentToolRequest,
  resolution: ExternalAgentToolResolution,
): Promise<void> {
  try {
    await resolveExternalAgentToolCall({
      sessionId: request.sessionId,
      callId: request.callId,
      resolution,
    });
  } catch (error) {
    throw new ExternalAgentResolutionDeliveryError(error);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function commandFromArguments(value: unknown): CanvasCommand {
  if (!isRecord(value) || typeof value.type !== 'string' || !isRecord(value.input)) {
    throw new Error('External Agent canvas_command arguments are invalid.');
  }
  return {
    type: value.type,
    version: CANVAS_COMMAND_VERSION,
    input: value.input,
  } as CanvasCommand;
}

function toolSuccess(output: unknown): boolean {
  return !isRecord(output) || output.ok !== false;
}

async function persistCanvas(projectId: string): Promise<void> {
  const project = useProjectStore.getState();
  if (project.currentProjectId !== projectId) throw new Error('The active project changed before persistence.');
  const canvas = useCanvasStore.getState();
  project.saveCurrentProject(canvas.nodes, canvas.edges, canvas.currentViewport, canvas.history);
  await project.waitForProjectPersistence(projectId);
}

async function executeCanvasCommand(
  request: ExternalAgentToolRequest,
  approval: AgentApprovalRecord,
  signal?: AbortSignal,
): Promise<unknown> {
  const command = commandFromArguments(request.arguments);
  const definition = canvasCommandRegistry.getDefinition(command.type);
  const historyGroupId = definition.effect === 'graph' ? JSON.stringify([approval.projectId, request.turnId]) : undefined;
  if (definition.effect !== 'graph' && approval.impact.effect !== 'read') {
    useCanvasStore.setState((state) => ({ history: closeCanvasHistoryGroup(state.history) }));
  }
  const graphWrite = approval.impact.effect === 'canvas-write'
    && (definition.effect === 'graph' || command.type === 'node.tool.run');
  const canvas = useCanvasStore.getState();
  const rollbackToken = graphWrite
    ? canvasAgentRollbackStore.begin(
        approval.projectId,
        approval.runId,
        canvas.revision,
        canvas.history.past.length,
      )
    : undefined;
  try {
    const result = await canvasCommandRegistry.executeApproved(command, approval.baseRevision, 'agent', historyGroupId, { signal });
    if (!result.ok) {
      if (rollbackToken) canvasAgentRollbackStore.discard(rollbackToken);
      return result;
    }
    if (rollbackToken) {
      const history = useCanvasStore.getState().history;
      const historyDepthBefore = historyGroupId && history.past.at(-1)?.groupId === historyGroupId
        ? Math.max(0, history.past.length - 1)
        : undefined;
      canvasAgentRollbackStore.complete(rollbackToken, result.revisionAfter, historyDepthBefore);
    }
    if (approval.impact.effect === 'canvas-write' || command.type === 'director.record') {
      await persistCanvas(approval.projectId);
    }
    return rollbackToken ? { ...result, rollbackToken } : result;
  } catch (error) {
    if (rollbackToken) canvasAgentRollbackStore.discard(rollbackToken);
    throw error;
  }
}

async function executeDiagnostics(argumentsValue: unknown): Promise<unknown> {
  if (!isRecord(argumentsValue) || typeof argumentsValue.operation !== 'string') {
    throw new Error('External Agent diagnostics arguments are invalid.');
  }
  const input = argumentsValue as any;
  switch (input.operation) {
    case 'health': return inspectCanvasHealth(input);
    case 'provider-config': return inspectDiagnosticConfigSnapshot();
    case 'generation-jobs': return inspectPersistedGenerationJobs({ jobId: input.jobId, limit: input.limit });
    case 'application-logs': return loadDiagnosticEvents({
      severity: input.severity,
      source: input.source,
      query: input.query,
      limit: input.limit,
    });
    case 'classify-error': return classifyAgentError(input.error);
    case 'bundle-preview': return buildDiagnosticBundlePreview({
      error: input.error,
      reproductionSteps: input.reproductionSteps,
      now: input.now,
    });
    case 'preflight': return preflightGeneration(input);
    default: throw new Error(`Unsupported external Agent diagnostic operation ${input.operation}.`);
  }
}

function executeConfigPatch(argumentsValue: unknown): unknown {
  if (!isRecord(argumentsValue) || !['preview', 'apply', 'rollback'].includes(String(argumentsValue.action))) {
    throw new Error('External Agent config_patch arguments are invalid.');
  }
  const input = argumentsValue as any;
  if (input.action === 'rollback') {
    return input.rollbackToken
      ? rollbackAgentProviderPatch(input.rollbackToken)
      : { ok: false, error: 'rollbackToken is required.' };
  }
  if (input.settingsTarget === 'generation-network') {
    if (!input.networkRoute) return { ok: false, issues: ['networkRoute is required.'] };
    const patch = {
      baseRevision: input.baseRevision
        ?? (input.action === 'preview' ? getAgentGenerationNetworkRevision() : ''),
      route: input.networkRoute,
    };
    return input.action === 'preview'
      ? previewAgentGenerationNetworkPatch(patch)
      : applyAgentGenerationNetworkPatch(patch);
  }
  if (!input.providerId) return { ok: false, issues: ['providerId is required.'] };
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
    baseRevision: input.baseRevision
      ?? (input.action === 'preview' ? getAgentProviderRevision(input.providerId) ?? '' : ''),
    changes: {
      baseUrl: input.baseUrl,
      endpointPath: input.endpointPath,
      apiStyle: input.apiStyle,
      modelId: input.modelId,
      modelMetadata: metadata,
    },
  };
  return input.action === 'preview'
    ? previewAgentProviderPatch(patch)
    : applyAgentProviderPatch(patch);
}

function currentConfigRevision(argumentsValue: unknown): string | null | undefined {
  if (!isRecord(argumentsValue)) return undefined;
  if (argumentsValue.settingsTarget === 'generation-network') {
    return getAgentGenerationNetworkRevision();
  }
  return typeof argumentsValue.providerId === 'string'
    ? getAgentProviderRevision(argumentsValue.providerId)
    : undefined;
}

async function executeApprovedTool(
  request: ExternalAgentToolRequest,
  approval: AgentApprovalRecord,
  signal?: AbortSignal,
): Promise<unknown> {
  switch (request.toolName) {
    case 'canvas_command': return executeCanvasCommand(request, approval, signal);
    case 'diagnostics': return executeDiagnostics(request.arguments);
    case 'config_patch':
      if (approval.impact.effect === 'config-write') {
        useCanvasStore.setState((state) => ({ history: closeCanvasHistoryGroup(state.history) }));
      }
      return executeConfigPatch(request.arguments);
    case 'asset_read':
      throw new Error('External image reads must use an explicitly attached, per-turn temporary resource.');
  }
}

export async function prepareExternalAgentToolRequest(input: {
  projectId: string;
  request: ExternalAgentToolRequestInput;
  allowedToolNames?: readonly string[];
}): Promise<AgentApprovalView> {
  if (useProjectStore.getState().currentProjectId !== input.projectId) {
    throw new Error('The active project changed before external Agent approval.');
  }
  const request = normalizeExternalAgentToolRequest(input.request);
  if (input.allowedToolNames !== undefined && !input.allowedToolNames.includes(request.toolName)) {
    throw new Error(`Tool ${request.toolName} is not allowed by the selected skill whitelist.`);
  }
  const approvalId = createApprovalId(request.turnId, request.toolName, request.callId);
  const preparation = { projectId: input.projectId, cancelled: false };
  const pending = preparingApprovals.get(approvalId) ?? new Set<typeof preparation>();
  pending.add(preparation);
  preparingApprovals.set(approvalId, pending);
  try {
    const prepared = await prepareCanvasAgentToolApproval({
      runId: request.turnId,
      projectId: input.projectId,
      callId: request.callId,
      toolName: request.toolName,
      arguments: request.arguments,
    });
    if (preparation.cancelled) {
      cancelExternalAgentToolRequest({ projectId: input.projectId, request });
      throw new Error('The external Agent turn stopped before approval was ready.');
    }
    if (useProjectStore.getState().currentProjectId !== input.projectId) {
      canvasAgentApprovalStore.update(approvalId, { status: 'conflicted' });
      throw new Error('The active project changed before external Agent approval.');
    }
    if (prepared.record.projectId !== input.projectId || prepared.record.status !== 'awaiting-approval') {
      throw new Error('The external Agent approval is already terminal.');
    }
    return prepared.view;
  } finally {
    pending.delete(preparation);
    if (pending.size === 0) preparingApprovals.delete(approvalId);
  }
}

/** Same risk policy as the SDK: paid/destructive operations never auto-approve. */
export async function processExternalAgentToolRequest(input: {
  projectId: string;
  request: ExternalAgentToolRequestInput;
  executionMode: CanvasAgentExecutionMode;
  allowedToolNames?: readonly string[];
  signal?: AbortSignal;
}): Promise<{ approval: AgentApprovalView; result?: ExternalAgentToolExecutionResult }> {
  const request = normalizeExternalAgentToolRequest(input.request);
  input = { ...input, request };
  const approval = await prepareExternalAgentToolRequest(input);
  const record = canvasAgentApprovalStore.get(createApprovalId(request.turnId, request.toolName, request.callId));
  const automatic = record && shouldAutomaticallyResolveAgentApproval({ record }, input.executionMode);
  return automatic
    ? { approval, result: await resolveExternalAgentToolApproval({ ...input, approve: true }) }
    : { approval };
}

export async function resolveExternalAgentToolApproval(input: {
  projectId: string;
  request: ExternalAgentToolRequestInput;
  approve: boolean;
  signal?: AbortSignal;
}): Promise<ExternalAgentToolExecutionResult> {
  const request = normalizeExternalAgentToolRequest(input.request);
  return resolveNormalizedExternalAgentToolApproval({ ...input, request });
}

async function resolveNormalizedExternalAgentToolApproval(input: {
  projectId: string;
  request: ExternalAgentToolRequest;
  approve: boolean;
  signal?: AbortSignal;
}): Promise<ExternalAgentToolExecutionResult> {
  const approvalId = createApprovalId(input.request.turnId, input.request.toolName, input.request.callId);
  let approval: AgentApprovalRecord | undefined;
  try {
    approval = canvasAgentApprovalStore.get(approvalId);
    if (!approval || approval.projectId !== input.projectId) {
      throw new Error('The external Agent approval no longer exists.');
    }
    const fingerprint = await createAgentRequestFingerprint(input.request.toolName, input.request.arguments);
    if (fingerprint !== approval.requestFingerprint) {
      canvasAgentApprovalStore.update(approval.id, { status: 'conflicted' });
      throw new Error('External Agent tool arguments changed after approval preview.');
    }
    if (useProjectStore.getState().currentProjectId !== input.projectId) {
      canvasAgentApprovalStore.update(approval.id, { status: 'conflicted' });
      throw new Error('The active project changed before external Agent tool resolution.');
    }
    const approvedRequest = approval;

    if (!input.approve) {
      canvasAgentApprovalExecution.decide(approval.id, false);
      canvasAgentBudgetLedger.release(input.projectId, approval.id);
      const resolution: ExternalAgentToolResolution = {
        outcome: 'denied',
        errorCode: 'user_denied',
        message: 'The user denied this Canvas operation.',
        revision: canvasCommandRegistry.getRevision(),
      };
      await deliverExternalToolResolution(input.request, resolution);
      return { approvalId, status: 'denied' };
    }

    if (approval.status === 'awaiting-approval' || approval.status === 'approved') {
      const budget = canvasAgentBudgetLedger.reserve(approval);
      if (!budget.allowed) {
        throw new Error(`Agent budget is insufficient; ${budget.remaining ?? 0} credits remain.`);
      }
      canvasAgentApprovalExecution.decide(approval.id, true);
    }
    const execution = await canvasAgentApprovalExecution.executeOnce({
      approvalId: approval.id,
      runId: approval.runId,
      projectId: approval.projectId,
      toolName: input.request.toolName,
      callId: input.request.callId,
      requestFingerprint: fingerprint,
      activeProjectId: useProjectStore.getState().currentProjectId,
      currentRevision: canvasCommandRegistry.getRevision(),
      currentConfigRevision: input.request.toolName === 'config_patch'
        ? currentConfigRevision(input.request.arguments)
        : undefined,
      safeRecovery: input.request.toolName === 'canvas_command'
        && commandFromArguments(input.request.arguments).type === 'generation.submit'
        ? {
            kind: 'generation-status',
            nodeIds: (commandFromArguments(input.request.arguments) as Extract<CanvasCommand, { type: 'generation.submit' }>).input.nodeIds,
            jobIds: [],
          }
        : undefined,
      execute: () => executeApprovedTool(input.request, approvedRequest, input.signal),
      isSuccess: toolSuccess,
      isConflict: (output) => isRecord(output)
        && output.ok === false
        && isRecord(output.error)
        && output.error.code === 'revision_conflict',
      isAccepted: (output) => input.request.toolName === 'canvas_command'
        && commandFromArguments(input.request.arguments).type === 'generation.submit'
        && toolSuccess(output),
      isUnknownOutcome: (output) => input.request.toolName === 'canvas_command'
        && commandFromArguments(input.request.arguments).type === 'generation.submit'
        && isRecord(output)
        && output.ok === false
        && isRecord(output.error)
        && output.error.code === 'execution_failed',
    });
    const output = redactSensitiveValue(execution.output);
    const succeeded = execution.receipt.status !== 'failed';
    const failureMessage = !succeeded && isRecord(output) && isRecord(output.error) && typeof output.error.message === 'string'
      ? output.error.message
      : 'The approved Canvas operation failed.';
    if (execution.receipt.status === 'succeeded' || execution.receipt.status === 'accepted' || execution.receipt.status === 'unknown') {
      canvasAgentBudgetLedger.commit(input.projectId, approval.id);
    } else {
      canvasAgentBudgetLedger.release(input.projectId, approval.id);
    }
    const resolution: ExternalAgentToolResolution = {
      outcome: succeeded ? 'approved' : 'error',
      result: output,
      errorCode: succeeded ? undefined : execution.receipt.errorCode ?? 'canvas_tool_failed',
      message: succeeded ? undefined : failureMessage,
      revision: canvasCommandRegistry.getRevision(),
      receiptId: execution.receipt.id,
    };
    await deliverExternalToolResolution(input.request, resolution);
    return {
      approvalId,
      receiptId: execution.receipt.id,
      output,
      error: succeeded ? undefined : failureMessage,
      status: succeeded ? 'approved' : 'error',
    };
  } catch (error) {
    if (error instanceof ExternalAgentResolutionDeliveryError) {
      if (error.original instanceof Error) throw error.original;
      throw new Error(String(error.original));
    }
    if (approval) {
      const current = canvasAgentApprovalStore.get(approval.id);
      if (current && ['succeeded', 'unknown'].includes(current.status)) {
        canvasAgentBudgetLedger.commit(input.projectId, approval.id);
      } else if (current?.status !== 'executing') {
        canvasAgentBudgetLedger.release(input.projectId, approval.id);
      }
      if (current && ['proposed', 'awaiting-approval', 'approved'].includes(current.status)) {
        canvasAgentApprovalStore.update(approval.id, { status: 'failed' });
      }
    }
    const rawMessage = error instanceof Error ? error.message : String(error);
    const redactedMessage = redactSensitiveValue(rawMessage);
    const message = typeof redactedMessage === 'string'
      ? redactedMessage
      : 'The Canvas operation failed.';
    await resolveExternalAgentToolCall({
      sessionId: input.request.sessionId,
      callId: input.request.callId,
      resolution: {
        outcome: 'error',
        errorCode: 'canvas_tool_failed',
        message,
        revision: canvasCommandRegistry.getRevision(),
      },
    });
    return { approvalId, status: 'error', error: message };
  }
}
