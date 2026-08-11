import type { RunState, Agent, RunToolApprovalItem } from '@openai/agents';
import type { CanvasAgentSdkRuntimeModule } from './agentRuntimeLoader';
import type { ChatCatalogEntry } from '@/features/canvas/application/chatModelCatalog';
import { resolveAgentModelReference } from './agentModelCapabilities';
import { loadCanvasAgentSdkRuntime } from './agentRuntimeLoader';
import { AgentSessionRepository } from '../infrastructure/agentSessionRepository';
import {
  CANVAS_AGENT_DEFINITION_VERSION,
  CANVAS_AGENT_RUNTIME_VERSION,
  type AgentSessionMediaReference,
  type AgentSessionMediaReferenceView,
  type AgentTurnMediaInput,
} from '../domain/agentModel';
import { redactSensitiveValue } from './agentRedaction';
import type { CanvasAgentToolEvent } from '../infrastructure/sdkRuntime';
import {
  createAgentMediaReference,
  inspectAgentMediaReference,
  prepareAgentMediaSource,
  validateAgentTurnMediaInputs,
} from './agentMediaResolver';
import { buildSkillContext, resolveAgentToolPolicy } from './agentSkills';
import { getAgentProviderRevision } from './agentConfigPatch';
import { canvasAgentBudgetLedger } from './agentBudget';
import { canvasCommandRegistry } from '@/features/canvas/application/canvasCommandService';
import { buildCanvasAssetCatalog } from '@/features/canvas/application/canvasAssetCatalog';
import { CANVAS_COMMAND_VERSION, type CanvasCommand } from '@/features/canvas/domain/canvasCommands';
import { useProjectStore } from '@/stores/projectStore';
import { useCanvasStore } from '@/stores/canvasStore';
import {
  cancelPendingApprovals,
  canvasAgentApprovalExecution,
  canvasAgentApprovalStore,
  createAgentRequestFingerprint,
  createApprovalId,
  createApprovalRecord,
  type AgentEffect,
  type AgentImpactSummary,
  type AgentApprovalRecord,
} from './agentApproval';

const repository = new AgentSessionRepository();
const activeRuns = new Map<string, ActiveRun>();
const approvalResolutionLocks = new Map<string, { approve: boolean; pending: Promise<CanvasAgentTurnResult> }>();

interface ActiveRun {
  runId: string;
  sessionId: string;
  projectId: string;
  modelRef: string;
  supportsStreaming: boolean;
  runtime: CanvasAgentSdkRuntimeModule;
  orchestrator: ReturnType<CanvasAgentSdkRuntimeModule['createStoryboardAgentRuntime']>;
  agent: Agent<any, any>;
  state: RunState<any, any>;
}

export interface AgentApprovalView {
  id: string;
  toolName: string;
  arguments: unknown;
  summary: string;
  impact: AgentImpactSummary;
  expiresAt: number;
}

export interface CanvasAgentTurnResult {
  runId: string;
  sessionId: string;
  finalText?: string;
  approvals: AgentApprovalView[];
  status: 'completed' | 'awaiting-approval';
  skillSelection: {
    skillIds: string[];
    reason: string;
    estimatedTokens: number;
    toolCount: number;
    mode: 'minimal' | 'local-router' | 'tool-search';
    deferredToolCount: number;
  };
}

function nextId(prefix: string): string {
  return globalThis.crypto?.randomUUID?.() ?? `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function approvalId(item: RunToolApprovalItem): string {
  const raw = item.rawItem as { callId?: string; id?: string };
  return raw.callId ?? raw.id ?? `${item.name ?? 'tool'}-${Math.random().toString(36).slice(2, 8)}`;
}

function approvalEffect(toolName: string, command?: CanvasCommand): AgentEffect {
  if (toolName === 'config_patch') return 'config-write';
  if (toolName !== 'canvas_command' || !command) return 'read';
  const effect = canvasCommandRegistry.getDefinition(command.type).effect;
  if (effect === 'generation') return 'external-submit';
  return effect === 'read' ? 'read' : 'canvas-write';
}

function canvasCommandFromArguments(value: unknown): CanvasCommand | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.type !== 'string' || !record.input || typeof record.input !== 'object' || Array.isArray(record.input)) return undefined;
  return { type: record.type, version: CANVAS_COMMAND_VERSION, input: record.input } as CanvasCommand;
}

function generationApprovalDetails(nodeIds: string[]): { model?: string; summary: string } {
  const requested = new Set(nodeIds);
  const nodes = useCanvasStore.getState().nodes.filter((node) => requested.has(node.id));
  const models = new Set<string>();
  const parameters = new Set<string>();
  for (const node of nodes) {
    const data = node.data as Record<string, unknown>;
    const modelConfig = data.modelConfig && typeof data.modelConfig === 'object' && !Array.isArray(data.modelConfig)
      ? data.modelConfig as Record<string, unknown>
      : undefined;
    const model = [modelConfig?.entryId, modelConfig?.modelId, data.modelId, data.model]
      .find((value): value is string => typeof value === 'string' && Boolean(value.trim()));
    if (model) models.add(model);
    for (const [label, value] of [
      ['ratio', modelConfig?.aspectRatio ?? modelConfig?.ratio ?? data.aspectRatio ?? data.requestAspectRatio],
      ['resolution', modelConfig?.resolution ?? data.resolution],
      ['duration', modelConfig?.duration ?? data.durationSeconds],
    ] as const) {
      if ((typeof value === 'string' && value.trim()) || (typeof value === 'number' && Number.isFinite(value))) {
        parameters.add(`${label}=${String(value)}`);
      }
    }
  }
  const modelSummary = models.size > 0 ? ` Models: ${Array.from(models).join(', ')}.` : ' Models: unavailable.';
  const parameterSummary = parameters.size > 0 ? ` Key parameters: ${Array.from(parameters).join(', ')}.` : ' Key parameters: unavailable.';
  return {
    model: models.size > 0 ? Array.from(models).join(', ') : undefined,
    summary: `Submit generation for ${nodeIds.length} node(s).${modelSummary}${parameterSummary}`,
  };
}

function buildApprovalImpact(toolName: string, args: unknown): {
  impact: AgentImpactSummary;
  baseRevision: number;
  baseConfigRevision?: string;
} {
  const command = toolName === 'canvas_command' ? canvasCommandFromArguments(args) : undefined;
  if (command) {
    const preview = canvasCommandRegistry.inspect(command, 'agent');
    const effect = approvalEffect(toolName, command);
    const affectedNodeIds = new Set(preview.impacts.flatMap((impact) => impact.affectedNodeIds));
    const affectedEdgeIds = new Set(preview.impacts.flatMap((impact) => impact.affectedEdgeIds));
    const input = command.input as Record<string, unknown>;
    const quantity = Array.isArray(input.nodeIds) ? input.nodeIds.length : 0;
    const readLimit = command.type === 'canvas.query'
      ? Array.isArray(command.input.nodeIds)
        ? Math.min(command.input.nodeIds.length, command.input.limit ?? 100)
        : command.input.limit ?? 100
      : command.type === 'asset.list'
        ? command.input.limit ?? 100
        : 0;
    const generationDetails = command.type === 'generation.submit'
      ? generationApprovalDetails(command.input.nodeIds)
      : undefined;
    return {
      baseRevision: preview.baseRevision,
      impact: {
        effect,
        title: command.type,
        summary: preview.valid
          ? generationDetails?.summary
            ?? (readLimit > 0 ? `Read up to ${readLimit} item(s) with ${command.type}.` : canvasCommandRegistry.summarize(command))
          : preview.errors.map((error) => error.message).join(' '),
        affectedNodeCount: affectedNodeIds.size || quantity || readLimit,
        affectedEdgeCount: affectedEdgeIds.size,
        model: generationDetails?.model ?? (typeof input.modelId === 'string' ? input.modelId : undefined),
        estimatedCost: effect === 'external-submit' ? { confidence: 'unknown' } : undefined,
        estimatedDurationMs: effect === 'external-submit' ? { confidence: 'unknown' } : undefined,
        externalSideEffect: effect === 'external-submit',
      },
    };
  }
  const effect = approvalEffect(toolName);
  const assetReadArgs = toolName === 'asset_read' && args && typeof args === 'object' && !Array.isArray(args)
    ? args as Record<string, unknown>
    : undefined;
  const assetId = typeof assetReadArgs?.assetId === 'string' ? assetReadArgs.assetId : undefined;
  const asset = assetId
    ? buildCanvasAssetCatalog(useCanvasStore.getState().nodes).find((candidate) => candidate.id === assetId)
    : undefined;
  const configArgs = toolName === 'config_patch' && args && typeof args === 'object' && !Array.isArray(args)
    ? args as Record<string, unknown>
    : undefined;
  const providerId = typeof configArgs?.providerId === 'string' ? configArgs.providerId : undefined;
  const requestedConfigRevision = typeof configArgs?.baseRevision === 'string'
    ? configArgs.baseRevision
    : undefined;
  return {
    baseRevision: canvasCommandRegistry.getRevision(),
    baseConfigRevision: providerId
      ? requestedConfigRevision ?? getAgentProviderRevision(providerId) ?? undefined
      : undefined,
    impact: {
      effect,
      title: toolName,
      summary: toolName === 'config_patch'
        ? '预览、应用或回滚已列出的非敏感供应商配置字段。'
        : toolName === 'asset_read'
          ? asset
            ? `读取画布图片“${asset.title}”并仅发送给当前多模态模型。`
            : `读取一项稳定画布图片资产（${assetId ?? '未提供 assetId'}）。`
          : '运行已列出的只读诊断，不发送付费生成请求。',
      affectedNodeCount: asset ? 1 : 0,
      affectedEdgeCount: 0,
      externalSideEffect: false,
    },
  };
}

interface PreparedApproval {
  view: AgentApprovalView;
  record: AgentApprovalRecord;
}

async function prepareApproval(item: RunToolApprovalItem, runId: string, projectId: string): Promise<PreparedApproval> {
  let args: unknown = item.arguments ?? {};
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { args = { raw: args }; }
  }
  const safe = redactSensitiveValue(args);
  const rawId = approvalId(item);
  const toolName = item.name ?? item.toolName ?? 'tool';
  const id = createApprovalId(runId, toolName, rawId);
  const existing = canvasAgentApprovalStore.get(id);
  const requestFingerprint = await createAgentRequestFingerprint(toolName, args);
  if (existing && existing.requestFingerprint !== requestFingerprint) {
    canvasAgentApprovalStore.update(existing.id, { status: 'conflicted' });
    throw new Error('SDK callId was reused with different tool arguments; the old approval was invalidated.');
  }
  const details = buildApprovalImpact(toolName, safe);
  const record = existing ?? createApprovalRecord({
    id,
    runId,
    projectId,
    interruptionId: rawId,
    toolName,
    arguments: safe,
    requestFingerprint,
    impact: details.impact,
    baseRevision: details.baseRevision,
    baseConfigRevision: details.baseConfigRevision,
    ttlMs: 5 * 60_000,
    ...(details.impact.effect === 'read' ? {
      scope: {
        projectId,
        runId,
        purpose: details.impact.summary,
        resourceKinds: [toolName === 'canvas_command'
          ? 'canvas'
          : toolName === 'asset_read'
            ? 'canvas-assets'
            : 'diagnostics'],
        nodeIds: toolName === 'asset_read' && safe && typeof safe === 'object' && !Array.isArray(safe)
          ? (() => {
              const assetId = (safe as Record<string, unknown>).assetId;
              return typeof assetId === 'string'
                ? buildCanvasAssetCatalog(useCanvasStore.getState().nodes)
                    .filter((asset) => asset.id === assetId)
                    .map((asset) => asset.nodeId)
                : undefined;
            })()
          : details.impact.affectedNodeCount > 0 && safe && typeof safe === 'object' && Array.isArray((safe as Record<string, any>).input?.nodeIds)
            ? (safe as Record<string, any>).input.nodeIds
            : undefined,
        maxItems: Math.max(1, details.impact.affectedNodeCount),
        expiresAt: Date.now() + 5 * 60_000,
      },
    } : {}),
  });
  const safeRecord = existing ?? record;
  return {
    record: safeRecord,
    view: {
      id: rawId,
      toolName,
      arguments: safe,
      summary: safeRecord.impact.summary,
      impact: safeRecord.impact,
      expiresAt: safeRecord.expiresAt,
    },
  };
}

function persistRunCheckpoint(
  active: Omit<ActiveRun, 'state'> | ActiveRun,
  state: RunState<any, any>,
  prepared: PreparedApproval[],
): void {
  const serializedState = active.runtime.serializeStoryboardRunState(state);
  if (prepared.length > 0) {
    canvasAgentApprovalStore.putRunRecovery(
      prepared.map((approval) => approval.record),
      {
        runId: active.runId,
        projectId: active.projectId,
        sessionId: active.sessionId,
        runtimeVersion: CANVAS_AGENT_RUNTIME_VERSION,
        agentDefinitionVersion: CANVAS_AGENT_DEFINITION_VERSION,
        commandSchemaVersion: CANVAS_COMMAND_VERSION,
        serializedState,
        createdAt: Date.now(),
      },
    );
  } else {
    canvasAgentApprovalStore.deleteRunRecovery(active.runId);
  }
  repository.saveRunState({
    id: active.runId,
    sessionId: active.sessionId,
    projectId: active.projectId,
    status: prepared.length ? 'awaiting_approval' : 'completed',
    serializedState,
  });
}

function getRunStateForResume(runId: string): {
  id: string;
  sessionId: string;
  projectId: string;
  serializedState: string;
} {
  const persisted = repository.getRunState(runId);
  if (persisted) return repository.getRunStateForResume(runId);
  const recovery = canvasAgentApprovalStore.getRunRecovery(runId);
  if (!recovery) throw new Error(`Agent RunState ${runId} does not exist.`);
  const reasons = [
    recovery.runtimeVersion !== CANVAS_AGENT_RUNTIME_VERSION ? `runtime version ${recovery.runtimeVersion}` : '',
    recovery.agentDefinitionVersion !== CANVAS_AGENT_DEFINITION_VERSION ? `agent definition version ${recovery.agentDefinitionVersion}` : '',
    recovery.commandSchemaVersion !== CANVAS_COMMAND_VERSION ? `canvas command version ${recovery.commandSchemaVersion}` : '',
  ].filter(Boolean);
  if (reasons.length) throw new Error(`Agent RunState cannot be resumed: ${reasons.join('; ')}.`);
  return {
    id: recovery.runId,
    sessionId: recovery.sessionId,
    projectId: recovery.projectId,
    serializedState: recovery.serializedState,
  };
}

async function createActiveRun(input: {
  runId: string;
  sessionId: string;
  projectId: string;
  model: ChatCatalogEntry;
  message: string;
  media?: AgentTurnMediaInput[];
  projectContext?: { brief: string; pinnedNodeIds: string[] };
  onToolEvent?: (event: CanvasAgentToolEvent) => void;
}): Promise<Omit<ActiveRun, 'state'>> {
  const runtime = await loadCanvasAgentSdkRuntime();
  const reference = resolveAgentModelReference(input.model);
  const orchestrator = runtime.createStoryboardAgentRuntime({ resolveModel: () => reference });
  const agent = runtime.createCanvasAgent({
    runtime: orchestrator,
    modelName: reference.catalogId,
    skillContext: {
      text: input.message,
      attachmentKinds: input.media?.length ? ['image'] : [],
    },
    projectContext: input.projectContext,
    supportsVision: reference.capabilities.vision,
    supportsToolSearch: reference.capabilities.toolSearch,
    protocol: reference.capabilities.protocol,
    context: {
      projectId: input.projectId,
      runId: input.runId,
      onToolEvent: input.onToolEvent,
      getActiveProjectId: () => useProjectStore.getState().currentProjectId,
      persistCanvasCheckpoint: async () => {
        const projectStore = useProjectStore.getState();
        if (projectStore.currentProjectId !== input.projectId) {
          throw new Error('当前项目已切换，画布检查点没有写入其他项目。');
        }
        const canvas = useCanvasStore.getState();
        projectStore.saveCurrentProject(canvas.nodes, canvas.edges, canvas.currentViewport, canvas.history);
        await projectStore.waitForProjectPersistence(input.projectId);
      },
    },
  });
  return { runId: input.runId, sessionId: input.sessionId, projectId: input.projectId, modelRef: reference.catalogId, supportsStreaming: input.model.supportsStreaming, runtime, orchestrator, agent };
}

function streamDelta(event: unknown): { kind: 'text' | 'reasoning'; delta: string } | null {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  const outer = event as Record<string, unknown>;
  if (outer.type !== 'raw_model_stream_event' || !outer.data || typeof outer.data !== 'object' || Array.isArray(outer.data)) return null;
  const data = outer.data as Record<string, unknown>;
  if (data.type === 'output_text_delta' && typeof data.delta === 'string') return { kind: 'text', delta: data.delta };
  if (data.type === 'model' && data.event && typeof data.event === 'object' && !Array.isArray(data.event)) {
    const modelEvent = data.event as Record<string, unknown>;
    if (modelEvent.type === 'reasoning_summary_delta' && typeof modelEvent.delta === 'string') return { kind: 'reasoning', delta: modelEvent.delta };
  }
  return null;
}

async function runAgentWithFeedback(input: {
  active: Omit<ActiveRun, 'state'> | ActiveRun;
  turnInput: string | Parameters<ActiveRun['orchestrator']['runner']['run']>[1];
  sessionId: string;
  signal?: AbortSignal;
  onTextDelta?: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
}) {
  const options = {
    context: { projectId: input.active.projectId, runId: input.active.runId },
    session: repository.createSdkSession(input.sessionId),
    signal: input.signal,
  };
  if (!input.active.supportsStreaming) {
    return input.active.orchestrator.runner.run(input.active.agent, input.turnInput, options);
  }
  const streamed = await input.active.orchestrator.runner.run(input.active.agent, input.turnInput, { ...options, stream: true });
  for await (const event of streamed) {
    const delta = streamDelta(event);
    if (delta?.kind === 'text') input.onTextDelta?.(delta.delta);
    else if (delta?.kind === 'reasoning') input.onReasoningDelta?.(delta.delta);
  }
  await streamed.completed;
  if (streamed.error) throw streamed.error;
  if (streamed.cancelled || input.signal?.aborted) {
    const error = new DOMException('The Agent run was cancelled.', 'AbortError') as DOMException & { state?: RunState<any, any> };
    error.state = streamed.state;
    throw error;
  }
  return streamed;
}

function errorRunState(error: unknown): RunState<any, any> | undefined {
  if (!error || typeof error !== 'object' || !('state' in error)) return undefined;
  const state = (error as { state?: unknown }).state;
  return state && typeof state === 'object' ? state as RunState<any, any> : undefined;
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true
    || (error instanceof DOMException && error.name === 'AbortError')
    || (error instanceof Error && error.name === 'AbortError');
}

function redactedRunError(error: unknown, signal?: AbortSignal): unknown {
  if (isAbortError(error, signal)) return error;
  const message = redactSensitiveValue(error instanceof Error ? error.message : String(error));
  const safe = new Error(message);
  safe.name = error instanceof Error ? error.name : 'Error';
  return safe;
}

function persistFailedRun(
  active: Omit<ActiveRun, 'state'> | ActiveRun,
  error: unknown,
  signal?: AbortSignal,
): void {
  const state = errorRunState(error) ?? ('state' in active ? active.state : undefined);
  if (!state) return;
  const cancelled = isAbortError(error, signal);
  if (cancelled) cancelPendingApprovals(canvasAgentApprovalStore, active.runId);
  canvasAgentApprovalStore.deleteRunRecovery(active.runId);
  activeRuns.set(active.runId, { ...active, state });
  repository.saveRunState({
    id: active.runId,
    sessionId: active.sessionId,
    projectId: active.projectId,
    status: cancelled ? 'cancelled' : 'failed',
    serializedState: active.runtime.serializeStoryboardRunState(state),
  });
}

export async function runCanvasAgentTurn(input: {
  projectId: string;
  sessionId?: string;
  model: ChatCatalogEntry;
  message: string;
  media?: AgentTurnMediaInput[];
  projectContext?: { brief: string; pinnedNodeIds: string[] };
  signal?: AbortSignal;
  onToolEvent?: (event: CanvasAgentToolEvent) => void;
  onTextDelta?: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
}): Promise<CanvasAgentTurnResult> {
  if (useProjectStore.getState().currentProjectId !== input.projectId) {
    throw new Error('Agent 请求的项目不是当前打开的项目。');
  }
  if (input.media?.length && !input.model.supportsMultimodal) {
    throw new Error('当前文本模型不支持图片理解，请移除附件或切换到支持视觉的模型。');
  }
  const preparedMedia = input.media?.length
    ? validateAgentTurnMediaInputs(await Promise.all(input.media.map(async (media) => ({
        ...media,
        source: await prepareAgentMediaSource(media.source),
      }))))
    : [];
  const session = input.sessionId
    ? repository.getSession(input.sessionId)
    : repository.createSession({ projectId: input.projectId, title: input.message.slice(0, 36), modelRef: input.model.id });
  if (!session || session.projectId !== input.projectId) throw new Error('Agent 对话不属于当前项目。');
  const runId = nextId('run');
  const partial = await createActiveRun({ ...input, media: preparedMedia, runId, sessionId: session.id });
  const referencedMedia = preparedMedia.map((media) => ({
    media,
    reference: createAgentMediaReference(
      runId,
      media.nodeId ?? media.assetId,
      media.source,
      10 * 60_000,
      media.assetId,
    ),
  }));
  if (referencedMedia.length) {
    repository.recordMediaReferences(session.id, referencedMedia.map(({ media, reference }) => ({
      referenceId: reference.id,
      runId,
      assetId: media.assetId,
      nodeId: media.nodeId,
      title: media.title,
      origin: media.origin,
      mimeType: media.mimeType,
      createdAt: Date.now(),
    })));
  }
  const turnInput = referencedMedia.length ? [{ role: 'user' as const, content: [
    { type: 'input_text' as const, text: input.message },
    ...referencedMedia.map(({ reference }) => ({
      type: 'input_image' as const,
      image: reference,
      detail: 'auto',
    })),
  ] }] : input.message;
  let result;
  try {
    result = await runAgentWithFeedback({
      active: partial,
      turnInput,
      sessionId: session.id,
      signal: input.signal,
      onTextDelta: input.onTextDelta,
      onReasoningDelta: input.onReasoningDelta,
    });
  } catch (error) {
    persistFailedRun(partial, error, input.signal);
    throw redactedRunError(error, input.signal);
  }
  const state = result.state;
  const prepared = await Promise.all(result.interruptions.map((item) => prepareApproval(item, runId, input.projectId)));
  activeRuns.set(runId, { ...partial, state });
  persistRunCheckpoint(partial, state, prepared);
  const approvals = prepared.map((approval) => approval.view);
  const skillContext = buildSkillContext({ text: input.message, attachmentKinds: referencedMedia.length ? ['image'] : [] });
  const toolPolicy = resolveAgentToolPolicy({
    skillContext,
    supportsVision: input.model.supportsMultimodal,
    supportsToolSearch: input.model.supportsToolSearch,
    protocol: input.model.agentProtocol,
  });
  return {
    runId,
    sessionId: session.id,
    finalText: typeof result.finalOutput === 'string' ? result.finalOutput : undefined,
    approvals,
    status: approvals.length ? 'awaiting-approval' : 'completed',
    skillSelection: {
      skillIds: skillContext.selections.map((selection) => selection.skill.id),
      reason: skillContext.selections.map((selection) => selection.reason).join(' '),
      estimatedTokens: skillContext.estimatedTokens,
      toolCount: toolPolicy.toolKinds.length,
      mode: toolPolicy.mode,
      deferredToolCount: toolPolicy.deferredToolKinds.length,
    },
  };
}

async function performCanvasAgentApprovalResolution(input: {
  runId: string;
  approvalId: string;
  approve: boolean;
  model: ChatCatalogEntry;
  signal?: AbortSignal;
  onToolEvent?: (event: CanvasAgentToolEvent) => void;
  onTextDelta?: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
}): Promise<CanvasAgentTurnResult> {
  let active = activeRuns.get(input.runId);
  if (!active) {
    const persisted = repository.getRunState(input.runId);
    if (persisted?.status === 'completed') {
      return { runId: persisted.id, sessionId: persisted.sessionId, approvals: [], status: 'completed', skillSelection: { skillIds: [], reason: '', estimatedTokens: 0, toolCount: 0, mode: 'minimal', deferredToolCount: 0 } };
    }
    const record = getRunStateForResume(input.runId);
    const session = repository.getSession(record.sessionId);
    if (!session) throw new Error('Agent 对话已不存在。');
    const partial = await createActiveRun({ runId: record.id, sessionId: record.sessionId, projectId: record.projectId, model: input.model, message: '恢复已中断的工具审批', onToolEvent: input.onToolEvent });
    const context = { projectId: record.projectId, runId: record.id, onToolEvent: input.onToolEvent };
    const restored = await partial.runtime.restoreStoryboardRunState(partial.agent as any, record.serializedState, { context } as any);
    active = { ...partial, state: restored };
  }
  if (useProjectStore.getState().currentProjectId !== active.projectId) {
    const interruption = active.state.getInterruptions().find((item) => approvalId(item) === input.approvalId);
    if (interruption) {
      const toolName = interruption.name ?? interruption.toolName ?? 'tool';
      const approval = canvasAgentApprovalStore.get(createApprovalId(active.runId, toolName, input.approvalId));
      if (approval) canvasAgentApprovalStore.update(approval.id, { status: 'conflicted' });
    }
    throw new Error('当前项目已切换，原审批已失效；请在当前项目重新发起请求。');
  }
  const interruption = active.state.getInterruptions().find((item) => approvalId(item) === input.approvalId);
  if (!interruption) {
    const runState = repository.getRunState(input.runId);
    if (runState?.status === 'completed') {
      return { runId: runState.id, sessionId: runState.sessionId, approvals: [], status: 'completed', skillSelection: { skillIds: [], reason: '', estimatedTokens: 0, toolCount: 0, mode: 'minimal', deferredToolCount: 0 } };
    }
    throw new Error('该审批已失效或已处理。');
  }
  const toolName = interruption.name ?? interruption.toolName ?? 'tool';
  let interruptionArgs: unknown = interruption.arguments ?? {};
  if (typeof interruptionArgs === 'string') {
    try { interruptionArgs = JSON.parse(interruptionArgs); } catch { interruptionArgs = { raw: interruptionArgs }; }
  }
  const requestFingerprint = await createAgentRequestFingerprint(toolName, interruptionArgs);
  const storedApprovalId = createApprovalId(active.runId, toolName, input.approvalId);
  const storedApproval = canvasAgentApprovalStore.get(storedApprovalId);
  if (!storedApproval || storedApproval.requestFingerprint !== requestFingerprint) {
    if (storedApproval) canvasAgentApprovalStore.update(storedApproval.id, { status: 'conflicted' });
    throw new Error('工具参数与持久审批不一致，原审批已失效。');
  }
  if (input.approve) {
    const budget = canvasAgentBudgetLedger.reserve(storedApproval);
    if (!budget.allowed) {
      throw new Error(`本项目 Agent 预算不足：预计 ${budget.estimatedCost ?? 0} credits，剩余 ${budget.remaining ?? 0} credits。请调整预算或修改计划。`);
    }
  } else {
    canvasAgentBudgetLedger.release(storedApproval.projectId, storedApproval.id);
  }
  try {
    canvasAgentApprovalExecution.decide(storedApprovalId, input.approve);
  } catch (error) {
    if (input.approve) canvasAgentBudgetLedger.release(storedApproval.projectId, storedApproval.id);
    throw error;
  }
  if (input.approve) active.state.approve(interruption);
  else active.state.reject(interruption, { message: '用户拒绝了这次工具调用。' });
  let result;
  try {
    result = await runAgentWithFeedback({
      active,
      turnInput: active.state,
      sessionId: active.sessionId,
      signal: input.signal,
      onTextDelta: input.onTextDelta,
      onReasoningDelta: input.onReasoningDelta,
    });
  } catch (error) {
    persistFailedRun(active, error, input.signal);
    const status = canvasAgentApprovalStore.get(storedApprovalId)?.status;
    if (status === 'unknown' || status === 'succeeded') {
      canvasAgentBudgetLedger.commit(storedApproval.projectId, storedApproval.id);
    } else {
      canvasAgentBudgetLedger.release(storedApproval.projectId, storedApproval.id);
    }
    throw redactedRunError(error, input.signal);
  }
  active.state = result.state;
  activeRuns.set(active.runId, active);
  const prepared = await Promise.all(result.interruptions.map((item) => prepareApproval(item, active.runId, active.projectId)));
  const completedApprovalStatus = canvasAgentApprovalStore.get(storedApprovalId)?.status;
  if (completedApprovalStatus === 'succeeded' || completedApprovalStatus === 'unknown') {
    canvasAgentBudgetLedger.commit(storedApproval.projectId, storedApproval.id);
  } else {
    canvasAgentBudgetLedger.release(storedApproval.projectId, storedApproval.id);
  }
  persistRunCheckpoint(active, active.state, prepared);
  const approvals = prepared.map((approval) => approval.view);
  return {
    runId: active.runId,
    sessionId: active.sessionId,
    finalText: typeof result.finalOutput === 'string' ? result.finalOutput : undefined,
    approvals,
    status: approvals.length ? 'awaiting-approval' : 'completed',
    skillSelection: { skillIds: [], reason: '', estimatedTokens: 0, toolCount: 0, mode: 'minimal', deferredToolCount: 0 },
  };
}

export async function resolveCanvasAgentApproval(input: {
  runId: string;
  approvalId: string;
  approve: boolean;
  model: ChatCatalogEntry;
  signal?: AbortSignal;
  onToolEvent?: (event: CanvasAgentToolEvent) => void;
  onTextDelta?: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
}): Promise<CanvasAgentTurnResult> {
  const lockKey = `${input.runId}:${input.approvalId}`;
  const existing = approvalResolutionLocks.get(lockKey);
  if (existing) {
    if (existing.approve !== input.approve) throw new Error('该审批正在处理相反的决定，请等待当前操作完成。');
    return existing.pending;
  }
  const pending = performCanvasAgentApprovalResolution(input);
  approvalResolutionLocks.set(lockKey, { approve: input.approve, pending });
  try {
    return await pending;
  } finally {
    approvalResolutionLocks.delete(lockKey);
  }
}

export function listCanvasAgentSessions(projectId: string) { return repository.listSessions(projectId); }
export function deleteCanvasAgentSession(sessionId: string): void { repository.deleteSession(sessionId); }

export function listPendingCanvasAgentApprovals(projectId: string): Array<AgentApprovalView & { runId: string }> {
  const now = Date.now();
  return canvasAgentApprovalStore.listByProject(projectId).flatMap((record) => {
    if (record.status !== 'awaiting-approval' || record.expiresAt <= now || !record.toolName) return [];
    const runState = repository.getRunState(record.runId);
    const recovery = canvasAgentApprovalStore.getRunRecovery(record.runId);
    const resumable = runState
      ? runState.projectId === projectId && runState.status === 'awaiting_approval'
      : recovery?.projectId === projectId && recovery.sessionId.length > 0;
    if (!resumable) return [];
    return [{
      runId: record.runId,
      id: record.interruptionId,
      toolName: record.toolName,
      arguments: record.arguments ?? {},
      summary: record.impact.summary,
      impact: record.impact,
      expiresAt: record.expiresAt,
    }];
  });
}

export interface CanvasAgentSessionMessage {
  role: 'user' | 'assistant';
  text: string;
  mediaReferences: AgentSessionMediaReferenceView[];
  createdAt: number;
}

function mediaReferenceId(value: unknown): string | null {
  if (typeof value === 'string' && value.startsWith('agent-media-ref:')) {
    try {
      return decodeURIComponent(value.slice('agent-media-ref:'.length));
    } catch {
      return null;
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const id = (value as Record<string, unknown>).id;
    return typeof id === 'string' && id.trim() ? id : null;
  }
  return null;
}

function projectSessionMessage(item: unknown): {
  role: 'user' | 'assistant';
  text: string;
  mediaReferenceIds: string[];
} | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const record = item as Record<string, unknown>;
  if (record.role !== 'user' && record.role !== 'assistant') return null;
  const content = record.content;
  const mediaReferenceIds = Array.isArray(content)
    ? content.flatMap((part) => {
        if (!part || typeof part !== 'object' || Array.isArray(part)) return [];
        const partRecord = part as Record<string, unknown>;
        if (partRecord.type !== 'input_image' && partRecord.type !== 'image') return [];
        const id = mediaReferenceId(partRecord.image ?? partRecord.imageUrl ?? partRecord.image_url);
        return id ? [id] : [];
      })
    : [];
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.flatMap((part) => {
        if (typeof part === 'string') return [part];
        if (!part || typeof part !== 'object' || Array.isArray(part)) return [];
        const value = (part as Record<string, unknown>).text;
        return typeof value === 'string' ? [value] : [];
      }).join('\n')
      : '';
  const trimmed = text.trim();
  return trimmed || mediaReferenceIds.length
    ? { role: record.role, text: trimmed, mediaReferenceIds: Array.from(new Set(mediaReferenceIds)) }
    : null;
}

function projectSessionMediaReference(
  reference: AgentSessionMediaReference,
  assets: ReturnType<typeof buildCanvasAssetCatalog>,
): AgentSessionMediaReferenceView {
  const available = inspectAgentMediaReference(reference.referenceId) !== null
    || (reference.origin === 'canvas-asset'
      && assets.some((asset) => asset.id === reference.assetId && asset.kind === 'image'));
  return { ...reference, availability: available ? 'available' : 'missing' };
}

export function getCanvasAgentSessionMediaReferences(
  sessionId: string,
): AgentSessionMediaReferenceView[] {
  const assets = buildCanvasAssetCatalog(useCanvasStore.getState().nodes);
  return repository.getMediaReferences(sessionId)
    .map((reference) => projectSessionMediaReference(reference, assets));
}

export function getCanvasAgentSessionMessages(sessionId: string): CanvasAgentSessionMessage[] {
  const session = repository.getSession(sessionId);
  if (!session) return [];
  const mediaById = new Map(
    getCanvasAgentSessionMediaReferences(sessionId)
      .map((reference) => [reference.referenceId, reference]),
  );
  return session.items.flatMap((item, index) => {
    const message = projectSessionMessage(item);
    return message ? [{
      role: message.role,
      text: message.text,
      mediaReferences: message.mediaReferenceIds.flatMap((id) => {
        const reference = mediaById.get(id);
        return reference ? [reference] : [];
      }),
      createdAt: session.createdAt + index,
    }] : [];
  });
}
