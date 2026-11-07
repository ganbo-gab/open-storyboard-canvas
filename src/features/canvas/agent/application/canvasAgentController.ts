import { completeInterruptedAgentHistory, recoverInterruptedAgentHistory, recoverInterruptedAgentRequestHistory } from './agentInterruptedHistory';
import { requestUserInputSchema, readAgentUserInputAnswer } from './agentUserInput';
import type { RunState, Agent, RunToolApprovalItem, AgentInputItem } from '@openai/agents';
import type { CanvasAgentSdkRuntimeModule } from './agentRuntimeLoader';
import type { ChatCatalogEntry } from '@/features/canvas/application/chatModelCatalog';
import { buildChatModelCatalog } from '@/features/canvas/application/chatModelCatalog';
import { getChannelCatalogProviders } from '@/features/channels/application/channelCatalog';
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
import type { AgentScope } from '../domain/agentModel';
import { getScopedAgentTools, inspectScopedAgentTool } from '@/features/agents/application/scopedAgentTools';
import { integrationDraftApprovalSummary } from '@/features/agents/application/scopedIntegrationTools';
import { redactSensitiveValue } from './agentRedaction';
import { redactAgentRunError } from './agentFailurePolicy';
import type { AgentModelRetryNotice, CanvasAgentToolEvent } from '../infrastructure/sdkRuntime';
import {
  createAgentMediaReference,
  inspectAgentMediaReference,
  resolveAgentMediaReference,
} from './agentMediaResolver';
import { buildAgentAttachmentContext, prepareRegisteredAgentMedia, restoreAgentSessionMedia } from './agentSessionMedia';
import { buildSkillContext, resolveAgentToolPolicy, type SkillRoutingContext } from './agentSkills';
import { getAgentGenerationNetworkRevision, getAgentProviderRevision } from './agentConfigPatch';
import { canvasAgentBudgetLedger } from './agentBudget';
import { canvasCommandRegistry } from '@/features/canvas/application/canvasCommandService';
import { buildCanvasAssetCatalog } from '@/features/canvas/application/canvasAssetCatalog';
import { CANVAS_COMMAND_TYPES, CANVAS_COMMAND_VERSION, type CanvasCommand } from '@/features/canvas/domain/canvasCommands';
import { useProjectStore } from '@/stores/projectStore';
import { useCanvasStore } from '@/stores/canvasStore';
import { resolveAgentDefaults } from '@/stores/settingsStore';
import {
  cancelPendingApprovals,
  canvasAgentApprovalExecution,
  canvasAgentApprovalStore,
  createAgentRequestFingerprint,
  createApprovalId,
  createIdempotencyKey,
  createApprovalRecord,
  type AgentEffect,
  type AgentImpactSummary,
  type AgentApprovalRecord,
} from './agentApproval';
import { consumeAgentRunStream } from './agentRunStreamReader';
import { shouldAutomaticallyResolveAgentApproval, type CanvasAgentExecutionMode } from './agentAutoApprovalPolicy';
import { AGENT_TURN_TOOL_CALL_LIMIT, AgentTurnSafety, AgentTurnLimitError, normalizeAgentTurnSafetySnapshot, type AgentTurnSafetySnapshot } from './agentTurnSafety';
import { createKnowledgeModelPort } from '@/features/knowledge/infrastructure/chatKnowledgeModel';
import { independentSiblingApprovalIds, type AgentGraphApprovalTargets } from './agentSiblingApprovalRebase';
import { agentGenerationPreferencesSchema, type AgentGenerationPreferences } from './agentGenerationPreferences';

const repository = new AgentSessionRepository();
const activeRuns = new Map<string, ActiveRun>();
const sessionTurnLocks = new Set<string>();
const runResolutionLocks = new Set<string>();
const approvalResolutionLocks = new Map<string, { approve: boolean; pending: Promise<CanvasAgentTurnResult> }>();

interface ActiveRun {
  runId: string;
  sessionId: string;
  scope: AgentScope;
  executionMode: CanvasAgentExecutionMode;
  projectId: string;
  modelRef: string;
  generationPreferences?: AgentGenerationPreferences;
  supportsStreaming: boolean;
  runtime: CanvasAgentSdkRuntimeModule;
  orchestrator: ReturnType<CanvasAgentSdkRuntimeModule['createStoryboardAgentRuntime']>;
  agent: Agent<any, any>;
  invalidRepairKeys: Set<string>;
  turnSafety: AgentTurnSafety;
  skillRoutingContext: SkillRoutingContext;
  allowedToolNames?: readonly string[];
  requestHistory: { items?: AgentInputItem[] };
  feedback: {
    signal: AbortSignal;
    onRetry?: (notice: AgentModelRetryNotice) => void;
    onToolEvent?: (event: CanvasAgentToolEvent) => void;
    onTurnStopped?: (error: AgentTurnLimitError) => void;
  };
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
  if (command.type === 'node.tool.run' || command.type === 'generation.recover') return 'canvas-write';
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

function generationApprovalDetails(nodeIds: unknown): { model?: string; summary: string } {
  const safeNodeIds = Array.isArray(nodeIds)
    ? nodeIds.filter((nodeId): nodeId is string => typeof nodeId === 'string' && nodeId.trim().length > 0)
    : [];
  const requested = new Set(safeNodeIds);
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
    summary: `Submit generation for ${safeNodeIds.length} node(s).${modelSummary}${parameterSummary}`,
  };
}

function invalidCanvasCommandReason(toolName: string, args: unknown, scope: AgentScope = 'canvas'): string | null {
  if (toolName === 'request_user_input') return requestUserInputSchema.safeParse(args).success ? null : '询问参数无效，请提供有效问题与选项。';
  if (scope !== 'canvas' || getScopedAgentTools(scope).some((tool) => tool.name === toolName)) {
    try { inspectScopedAgentTool(scope, toolName, args); return null; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  }
  if (!['canvas_command', 'diagnostics', 'config_patch', 'asset_read'].includes(toolName)) return `Tool ${toolName} is not available in canvas scope.`;
  if (toolName !== 'canvas_command') return null;
  const command = canvasCommandFromArguments(args);
  if (!command) {
    return '画布工具调用缺少有效的 type 或 input。请根据工具结构补齐参数后重试，不要让用户批准这个无效请求。';
  }
  const preview = canvasCommandRegistry.inspect(command, 'agent');
  if (preview.valid) return null;
  const detail = preview.errors.map((error) => error.message).filter(Boolean).join(' ');
  const repair = command.type === 'generation.submit'
    ? '正确流程：如果是从零生成，先调用 node.create 创建 imageNode/aiVideoNode，并在 configuration 中写入 prompt、modelId、aspectRatio、resolution 等配置；再把 node.create 返回的真实 nodeId 放入 generation.submit.input.nodeIds。generation.submit 不接受 prompt。'
    : command.type === 'canvas.query'
      ? '正确格式：{"type":"canvas.query","input":{"scope":"graph|nodes|edges|selection","nodeIds":["可选"],"limit":100}}。不存在 filter 字段。'
      : command.type === 'node.create'
        ? '从零生图的正确格式：{"type":"node.create","input":{"nodeType":"imageNode","position":{"x":0,"y":0},"configuration":{"prompt":"完整提示词","modelId":"当前所选模型","aspectRatio":"16:9","resolution":"2K"}}}。不要写 image、imageEditNode、ratio、size，也不要在创建成功前自造 nodeId。只有返回 ok=true 后才可使用 output.references.nodeId。'
        : CANVAS_COMMAND_TYPES.includes(command.type)
          ? `允许的 input 字段：${Object.entries(canvasCommandRegistry.getDefinition(command.type).schema.input.properties)
          .map(([name, field]) => `${name}:${field.type}`)
          .join(', ')}。`
          : `允许的命令类型：${CANVAS_COMMAND_TYPES.join(', ')}。`;
  return `画布工具参数校验失败：${detail || '命令结构无效。'} ${repair} 只纠正一次；不要重复提交相同无效参数。若信息不足，先询问用户。`;
}

function buildApprovalImpact(toolName: string, args: unknown, scope: AgentScope = 'canvas', selectedModel?: string): {
  impact: AgentImpactSummary;
  baseRevision: number;
  baseConfigRevision?: string;
} {
  if (toolName === 'request_user_input') return { baseRevision: canvasCommandRegistry.getRevision(), impact: { effect: 'read', title: 'request_user_input', summary: requestUserInputSchema.parse(args).questions.map(q => q.title).join('；'), affectedNodeCount: 0, affectedEdgeCount: 0, externalSideEffect: false } };
  const scoped = getScopedAgentTools(scope).find((tool) => tool.name === toolName);
  if (scoped) {
    const { risk, input } = inspectScopedAgentTool(scoped.scope, toolName, args);
    const values = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    return {
      baseRevision: canvasCommandRegistry.getRevision(),
      impact: {
        effect: risk === 'paid' ? 'external-submit' : risk === 'read' ? 'read' : 'canvas-write',
        title: `${scoped.scope}: ${toolName}`,
        summary: `${risk === 'paid' ? '付费操作（费用未知），需明确确认：' : risk === 'destructive' ? '破坏性操作，需确认：' : ''}${scoped.description}${toolName.startsWith('integration_') && toolName.endsWith('_apply') && typeof values.draftId === 'string' ? `\n${integrationDraftApprovalSummary(values.draftId) ?? '草稿已失效，请重新预览。'}` : ''}`,
        affectedNodeCount: toolName === 'project_create' || toolName === 'project_open' ? 0 : 1, affectedEdgeCount: 0,
        model: typeof values.model === 'string' ? values.model : typeof values.modelId === 'string' ? values.modelId : selectedModel,
        estimatedCost: risk === 'paid' ? { confidence: 'unknown' } : undefined,
        externalSideEffect: risk === 'paid',
      },
    };
  }
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
    const recoverySummary = command.type === 'generation.recover'
      ? `只查询/下载任务 ${command.input.jobId} 的现有结果并保存到本机画布；不会提交生成 POST，预计不会产生新的生成费用。`
      : undefined;
    return {
      baseRevision: preview.baseRevision,
      impact: {
        effect,
        title: command.type,
        summary: preview.valid
          ? recoverySummary ?? generationDetails?.summary
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
  const generationNetworkTarget = configArgs?.settingsTarget === 'generation-network';
  const requestedConfigRevision = typeof configArgs?.baseRevision === 'string'
    ? configArgs.baseRevision
    : undefined;
  return {
    baseRevision: canvasCommandRegistry.getRevision(),
    baseConfigRevision: generationNetworkTarget
      ? requestedConfigRevision ?? getAgentGenerationNetworkRevision()
      : providerId
        ? requestedConfigRevision ?? getAgentProviderRevision(providerId) ?? undefined
        : undefined,
    impact: {
      effect,
      title: toolName,
      summary: toolName === 'config_patch'
        ? '预览、应用或回滚已列出的非敏感供应商或网络路线配置字段。'
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

export interface PreparedCanvasAgentApproval {
  view: AgentApprovalView;
  record: AgentApprovalRecord;
}

/** Views are display-redacted; continuation must use the original persisted binding. */
export function restorePreparedCanvasAgentApprovals(runId: string, views: AgentApprovalView[]): PreparedCanvasAgentApproval[] {
  return views.map((view) => {
    const record = canvasAgentApprovalStore.get(createApprovalId(runId, view.toolName, view.id));
    if (!record || record.interruptionId !== view.id || record.runId !== runId) throw new Error('Agent 审批记录已不存在。');
    return { view, record };
  });
}

export async function prepareCanvasAgentToolApproval(input: {
  runId: string;
  projectId: string;
  callId: string;
  toolName: string;
  arguments: unknown;
  persist?: boolean;
  scope?: AgentScope;
  allowedToolNames?: readonly string[];
  selectedModel?: string;
}): Promise<PreparedCanvasAgentApproval> {
  if (input.allowedToolNames && !input.allowedToolNames.includes(input.toolName)) throw new Error('Tool is not allowed by the selected skills.');
  const invalidReason = invalidCanvasCommandReason(input.toolName, input.arguments, input.scope);
  if (invalidReason) throw new Error(invalidReason);
  const safe = redactSensitiveValue(input.arguments);
  const id = createApprovalId(input.runId, input.toolName, input.callId);
  const existing = canvasAgentApprovalStore.get(id);
  const requestFingerprint = await createAgentRequestFingerprint(input.toolName, input.arguments);
  if (existing && existing.requestFingerprint !== requestFingerprint) {
    canvasAgentApprovalStore.update(existing.id, { status: 'conflicted' });
    throw new Error('Agent callId was reused with different tool arguments; the old approval was invalidated.');
  }
  const details = buildApprovalImpact(input.toolName, input.arguments, input.scope, input.selectedModel);
  const record = existing ?? createApprovalRecord({
    id,
    runId: input.runId,
    projectId: input.projectId,
    interruptionId: input.callId,
    toolName: input.toolName,
    arguments: safe,
    requestFingerprint,
    impact: details.impact,
    baseRevision: details.baseRevision,
    baseConfigRevision: details.baseConfigRevision,
    ttlMs: 5 * 60_000,
    ...(details.impact.effect === 'read' ? {
      scope: {
        projectId: input.projectId,
        runId: input.runId,
        purpose: details.impact.summary,
        resourceKinds: [input.toolName === 'canvas_command'
          ? 'canvas'
          : input.toolName === 'asset_read'
            ? 'canvas-assets'
            : 'diagnostics'],
        nodeIds: input.toolName === 'asset_read' && safe && typeof safe === 'object' && !Array.isArray(safe)
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
  if (!existing && input.persist !== false) canvasAgentApprovalStore.put(safeRecord);
  return {
    record: safeRecord,
    view: {
      id: input.callId,
      toolName: input.toolName,
      arguments: safe,
      summary: safeRecord.impact.summary,
      impact: safeRecord.impact,
      expiresAt: safeRecord.expiresAt,
    },
  };
}

export function explainInvalidCanvasAgentCommand(toolName: string, argumentsValue: unknown): string | null {
  return invalidCanvasCommandReason(toolName, argumentsValue);
}

async function prepareApproval(
  item: RunToolApprovalItem,
  runId: string,
  projectId: string,
  scope: AgentScope,
  allowedToolNames?: readonly string[],
  selectedModel?: string,
): Promise<PreparedCanvasAgentApproval> {
  let args: unknown = item.arguments ?? {};
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { args = { raw: args }; }
  }
  const rawId = approvalId(item);
  const toolName = item.name ?? item.toolName ?? 'tool';
  return prepareCanvasAgentToolApproval({
    runId,
    projectId,
    callId: rawId,
    toolName,
    arguments: args,
    persist: false,
    scope,
    allowedToolNames,
    selectedModel,
  });
}

function graphApprovalTargets(record: AgentApprovalRecord, args: unknown): AgentGraphApprovalTargets | null {
  if (record.toolName !== 'canvas_command' || record.impact.effect !== 'canvas-write') return null;
  const command = canvasCommandFromArguments(args);
  if (!command || canvasCommandRegistry.getDefinition(command.type).effect !== 'graph') return null;
  const preview = canvasCommandRegistry.inspect(command, 'agent');
  if (!preview.valid) return null;
  return {
    approvalId: record.id,
    nodeIds: Array.from(new Set(preview.impacts.flatMap((impact) => impact.affectedNodeIds))),
    edgeIds: Array.from(new Set(preview.impacts.flatMap((impact) => impact.affectedEdgeIds))),
  };
}

function persistRunCheckpoint(
  active: Omit<ActiveRun, 'state'> | ActiveRun,
  state: RunState<any, any>,
  prepared: PreparedCanvasAgentApproval[],
): void {
  active.turnSafety.assertActive();
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
        turnSafety: active.turnSafety.snapshot(),
        skillRoutingContext: active.skillRoutingContext,
        allowedToolNames: active.allowedToolNames,
        modelRef: active.modelRef,
        generationPreferences: active.generationPreferences,
        executionMode: active.executionMode,
        createdAt: Date.now(),
      },
    );
  } else {
    canvasAgentApprovalStore.deleteRunRecovery(active.runId);
    active.turnSafety.dispose();
    activeRuns.delete(active.runId);
  }
  repository.saveRunState({
    id: active.runId,
    sessionId: active.sessionId,
    projectId: active.projectId,
    status: prepared.length ? 'awaiting_approval' : 'completed',
    serializedState,
    turnSafety: active.turnSafety.snapshot(),
    skillRoutingContext: active.skillRoutingContext,
    allowedToolNames: active.allowedToolNames,
    modelRef: active.modelRef,
    generationPreferences: active.generationPreferences,
    executionMode: active.executionMode,
  });
}

function getRunStateForResume(runId: string): {
  id: string;
  sessionId: string;
  projectId: string;
  serializedState: string;
  createdAt: number;
  turnSafety?: AgentTurnSafetySnapshot;
  skillRoutingContext?: SkillRoutingContext;
  allowedToolNames?: readonly string[];
  modelRef?: string;
  generationPreferences?: AgentGenerationPreferences;
  executionMode?: CanvasAgentExecutionMode;
} {
  const persisted = repository.getRunState(runId);
  if (persisted) {
    const record = repository.getRunStateForResume(runId);
    return { ...record, turnSafety: normalizeAgentTurnSafetySnapshot(record.turnSafety, record.createdAt, record.serializedState) };
  }
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
    createdAt: recovery.createdAt,
    turnSafety: normalizeAgentTurnSafetySnapshot(recovery.turnSafety, recovery.createdAt, recovery.serializedState),
    skillRoutingContext: recovery.skillRoutingContext,
    allowedToolNames: recovery.allowedToolNames,
    modelRef: recovery.modelRef,
    generationPreferences: recovery.generationPreferences,
    executionMode: recovery.executionMode,
  };
}

async function createActiveRun(input: {
  runId: string;
  sessionId: string;
  projectId: string;
  scope?: AgentScope;
  model: ChatCatalogEntry;
  message: string;
  media?: AgentTurnMediaInput[];
  projectContext?: { brief: string; pinnedNodeIds: string[] };
  generationPreferences?: Parameters<CanvasAgentSdkRuntimeModule['createCanvasAgent']>[0]['generationPreferences'];
  onToolEvent?: (event: CanvasAgentToolEvent) => void;
  executionMode?: CanvasAgentExecutionMode;
  explicitSkillIds?: string[];
  restoredSkillRoutingContext?: SkillRoutingContext;
  allowedToolNames?: readonly string[];
  signal?: AbortSignal;
  startedAt?: number;
  turnSafety?: AgentTurnSafetySnapshot;
  onTurnStopped?: (error: AgentTurnLimitError) => void;
  onRetry?: (notice: AgentModelRetryNotice) => void;
}): Promise<Omit<ActiveRun, 'state'>> {
  const reference = { ...resolveAgentModelReference(input.model), contextSessionId: input.sessionId };
  const generationPreferences = input.generationPreferences === undefined ? undefined : agentGenerationPreferencesSchema.parse(input.generationPreferences);
  const feedback: ActiveRun['feedback'] = { signal: input.signal ?? new AbortController().signal,
    onRetry: input.onRetry, onToolEvent: input.onToolEvent, onTurnStopped: input.onTurnStopped };
  const turnSafety = new AgentTurnSafety(input.turnSafety ?? { startedAt: input.startedAt ?? Date.now(), toolCalls: 0 }, (error) => {
    cancelPendingApprovals(canvasAgentApprovalStore, input.runId);
    canvasAgentApprovalStore.deleteRunRecovery(input.runId);
    activeRuns.delete(input.runId);
    feedback.onTurnStopped?.(error);
    void (async () => {
      repository.saveRunState({ id: input.runId, sessionId: input.sessionId, projectId: input.projectId, status: 'failed', serializedState: '{}', turnSafety: turnSafety.snapshot() });
      await repository.createSdkSession(input.sessionId).addItems([{
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: error.message }],
      }]);
    })().catch(() => undefined);
  });
  feedback.signal = turnSafety.signalFor(input.signal);
  turnSafety.assertActive();
  let runtime: CanvasAgentSdkRuntimeModule;
  let sessionMedia: AgentSessionMediaReferenceView[] = [];
  try {
    sessionMedia = await turnSafety.run(() => refreshCanvasAgentSessionMedia(input.sessionId), input.signal);
    runtime = await turnSafety.run(() => loadCanvasAgentSdkRuntime(), input.signal);
  } catch (error) {
    turnSafety.dispose();
    throw error;
  }
  const requestHistory: { items?: AgentInputItem[] } = {};
  const orchestrator = runtime.createStoryboardAgentRuntime({ resolveModel: () => reference, turnSafety, onRetry: notice => feedback.onRetry?.(notice),
    onModelInput: (items) => { requestHistory.items = typeof items === 'string' ? [{ role: 'user', content: items }] : items.slice(); },
  });
  const recentUserText = getCanvasAgentSessionMessages(input.sessionId)
    .filter((message) => message.role === 'user')
    .slice(-6)
    .map((message) => message.text)
    .join('\n');
  const skillRoutingContext: SkillRoutingContext = input.restoredSkillRoutingContext ?? {
    surface: input.scope ?? 'canvas',
    explicitSkillIds: input.explicitSkillIds,
    text: input.message,
    recentUserText,
    attachmentKinds: input.media?.length ? ['image'] : [],
  };
  const selectedTools = buildSkillContext(skillRoutingContext).allowedToolNames;
  const allowedToolNames = input.allowedToolNames
    ? input.allowedToolNames.filter((name) => !selectedTools || selectedTools.includes(name))
    : selectedTools;
  const allowedWithQuestions = allowedToolNames ? [...new Set([...allowedToolNames, 'request_user_input'])] : undefined;
  let agent: ActiveRun['agent'];
  try {
    agent = runtime.createCanvasAgent({
      runtime: orchestrator,
      scope: input.scope,
      modelName: reference.catalogId,
      skillContext: skillRoutingContext,
      projectContext: input.projectContext,
      attachmentContext: buildAgentAttachmentContext({ scope: input.scope ?? 'canvas', projectId: input.projectId, current: input.media, history: sessionMedia }),
      supportsVision: reference.capabilities.vision,
      supportsToolSearch: reference.capabilities.toolSearch,
      protocol: reference.capabilities.protocol,
      generationPreferences,
      executionMode: input.executionMode,
      context: {
        projectId: input.projectId,
        runId: input.runId,
        selectedTurnModel: input.model,
        knowledgeModel: createKnowledgeModelPort(input.model),
        allowedToolNames: allowedWithQuestions,
        get signal() { return feedback.signal; },
        onToolEvent: event => feedback.onToolEvent?.(event),
        getActiveProjectId: () => input.scope === 'home' ? input.projectId : useProjectStore.getState().currentProjectId,
        getCanvasRevision: () => canvasCommandRegistry.getRevision(),
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
  } catch (error) {
    turnSafety.dispose();
    throw error;
  }
  return {
    runId: input.runId,
    sessionId: input.sessionId,
    projectId: input.projectId,
    scope: input.scope ?? 'canvas',
    executionMode: input.executionMode ?? 'manual',
    modelRef: reference.catalogId,
    generationPreferences,
    supportsStreaming: input.model.supportsStreaming,
    runtime,
    orchestrator,
    agent,
    invalidRepairKeys: new Set<string>(),
    turnSafety,
    skillRoutingContext,
    allowedToolNames: allowedWithQuestions,
    requestHistory,
    feedback,
  };
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
  if (input.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  return input.active.turnSafety.run(async (signal) => {
    const options = {
      context: { projectId: input.active.projectId, runId: input.active.runId },
      session: repository.createSdkSession(input.sessionId),
      signal,
      maxTurns: AGENT_TURN_TOOL_CALL_LIMIT + 1,
    };
    if (!input.active.supportsStreaming) {
      return input.active.orchestrator.runner.run(input.active.agent, input.turnInput, options);
    }
    const streamed = await input.active.orchestrator.runner.run(input.active.agent, input.turnInput, { ...options, stream: true });
    try {
      await consumeAgentRunStream(streamed, (event) => {
        const delta = streamDelta(event);
        if (delta?.kind === 'text') input.onTextDelta?.(delta.delta);
        else if (delta?.kind === 'reasoning') input.onReasoningDelta?.(delta.delta);
      });
      if (streamed.error) throw streamed.error;
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { state: streamed.state });
    }
    if (streamed.cancelled || signal.aborted) {
      throw Object.assign(new DOMException('The Agent run was cancelled.', 'AbortError'), { state: streamed.state });
    }
    return streamed;
  }, input.signal);
}

async function continuePastInvalidToolRequests(input: {
  active: ActiveRun | Omit<ActiveRun, 'state'>;
  result: Awaited<ReturnType<typeof runAgentWithFeedback>>;
  sessionId: string;
  signal?: AbortSignal;
  onToolEvent?: (event: CanvasAgentToolEvent) => void;
  onTextDelta?: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
}): Promise<Awaited<ReturnType<typeof runAgentWithFeedback>>> {
  let result = input.result;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const invalid = result.interruptions.flatMap((item) => {
      let args: unknown = item.arguments ?? {};
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch { args = { raw: args }; }
      }
      const toolName = item.name ?? item.toolName ?? 'tool';
      const reason = invalidCanvasCommandReason(toolName, args, input.active.scope);
      return reason ? [{ item, toolName, args, callId: approvalId(item), reason }] : [];
    });
    if (!invalid.length) return result;

    for (const failure of invalid) {
      await rememberInvalidCanvasAgentRequest(
        input.active.invalidRepairKeys,
        failure.toolName,
        failure.args,
      );
      input.onToolEvent?.({
        toolName: failure.toolName,
        callId: failure.callId,
        status: 'failed',
        input: redactSensitiveValue(failure.args),
        error: failure.reason,
        output: { ok: false, error: { code: 'invalid_command', message: failure.reason } },
      });
      result.state.reject(failure.item, { message: failure.reason });
    }

    const active = { ...input.active, state: result.state } as ActiveRun;
    activeRuns.set(active.runId, active);
    result = await runAgentWithFeedback({
      active,
      turnInput: active.state,
      sessionId: input.sessionId,
      signal: input.signal,
      onTextDelta: input.onTextDelta,
      onReasoningDelta: input.onReasoningDelta,
    });
  }
  const remainingInvalid = result.interruptions.some((item) => {
    let args: unknown = item.arguments ?? {};
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch { args = { raw: args }; }
    }
    return invalidCanvasCommandReason(item.name ?? item.toolName ?? 'tool', args) !== null;
  });
  if (remainingInvalid) {
    throw new Error('Agent 连续生成了无效的画布命令。本轮已安全停止，请让 Agent 诊断后重新规划。');
  }
  return result;
}

export async function rememberInvalidCanvasAgentRequest(
  rejectedFingerprints: Set<string>,
  toolName: string,
  args: unknown,
): Promise<void> {
  const commandType = toolName === 'canvas_command'
    && args
    && typeof args === 'object'
    && !Array.isArray(args)
    && typeof (args as Record<string, unknown>).type === 'string'
    ? (args as Record<string, unknown>).type as string
    : 'unknown';
  const repairKey = `repair:${toolName}:${commandType}`;
  const fingerprint = await createAgentRequestFingerprint(
    toolName,
    redactSensitiveValue(args),
  );
  if (rejectedFingerprints.has(fingerprint) || rejectedFingerprints.has(repairKey)) {
    throw new Error(`Agent 已经用过一次 ${commandType} 参数纠正机会，但仍未遵守工具契约。本轮已安全停止；请重新规划，不要继续消耗模型配额。`);
  }
  rejectedFingerprints.add(fingerprint);
  rejectedFingerprints.add(repairKey);
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
  return redactAgentRunError(error);
}

function persistFailedRun(
  active: Omit<ActiveRun, 'state'> | ActiveRun,
  error: unknown,
  signal?: AbortSignal,
): void {
  const state = errorRunState(error) ?? ('state' in active ? active.state : undefined);
  active.turnSafety.dispose();
  const cancelled = isAbortError(error, signal);
  cancelPendingApprovals(canvasAgentApprovalStore, active.runId);
  canvasAgentApprovalStore.deleteRunRecovery(active.runId);
  activeRuns.delete(active.runId);
  // A terminal state needs no resumable SDK payload. Cleanup must survive unsafe/oversized history.
  repository.saveRunState({
    id: active.runId,
    sessionId: active.sessionId,
    projectId: active.projectId,
    status: cancelled ? 'cancelled' : 'failed',
    serializedState: '{}',
  });
  try {
    const saved = repository.getSession(active.sessionId)?.items;
    if (saved) {
      const receiptFor = (call: Extract<(typeof saved)[number], { type: 'function_call' }>) =>
        canvasAgentApprovalStore.getReceipt(createIdempotencyKey(active.runId, call.name, call.callId));
      let recovered: AgentInputItem[] | undefined;
      if (state) {
        try { recovered = recoverInterruptedAgentHistory(saved, state, receiptFor); }
        catch { /* Fall back to the portable model input when the SDK snapshot cannot serialize. */ }
      }
      recovered ??= active.requestHistory.items
        ? recoverInterruptedAgentRequestHistory(saved, active.requestHistory.items, receiptFor) : undefined;
      // A different turn may have appended history while this run stopped.
      // In that case preserve the current session rather than replacing it.
      if (!recovered) return;
      repository.replaceItems(active.sessionId, recovered);
    }
  } catch {
    // Keep the last valid session and receipts. Recovery failure must not revive tool authority
    // or replace the actual provider error with a storage error.
    console.warn('[Agent] Interrupted history could not be saved; previous history and receipts retained.');
  }
}

export function cancelCanvasAgentRun(runId: string): void {
  cancelPendingApprovals(canvasAgentApprovalStore, runId);
  activeRuns.get(runId)?.turnSafety.dispose();
  canvasAgentApprovalStore.deleteRunRecovery(runId);
  const record = repository.getRunState(runId);
  if (record) repository.saveRunState({ ...record, status: 'cancelled', serializedState: '{}' });
  activeRuns.delete(runId);
}

/** A session owns one advancing runner; a failed/new turn cannot rewrite a waiting approval. */
export async function runCanvasAgentTurn(input: Parameters<typeof performCanvasAgentTurn>[0]): Promise<CanvasAgentTurnResult> {
  let ownedSession: string | undefined;
  const reserve = (sessionId: string) => {
    if (sessionTurnLocks.has(sessionId) || [...activeRuns.values()].some(run => run.sessionId === sessionId)
      || listPendingCanvasAgentApprovals(input.projectId, sessionId, input.scope ?? 'canvas').length) {
      throw new Error('此会话仍有正在运行或等待确认的回合，请先停止或完成审批。');
    }
    sessionTurnLocks.add(sessionId); ownedSession = sessionId;
  };
  if (input.sessionId) reserve(input.sessionId);
  try {
    return await performCanvasAgentTurn({ ...input, onRunStarted: identity => {
      if (!ownedSession) reserve(identity.sessionId);
      input.onRunStarted?.(identity);
    } });
  } finally { if (ownedSession) sessionTurnLocks.delete(ownedSession); }
}

async function performCanvasAgentTurn(input: {
  projectId: string;
  scope?: AgentScope;
  sessionId?: string;
  onRunStarted?: (identity: { sessionId: string; runId: string }) => void;
  model?: ChatCatalogEntry;
  message: string;
  media?: AgentTurnMediaInput[];
  projectContext?: { brief: string; pinnedNodeIds: string[] };
  generationPreferences?: Parameters<CanvasAgentSdkRuntimeModule['createCanvasAgent']>[0]['generationPreferences'];
  signal?: AbortSignal;
  onToolEvent?: (event: CanvasAgentToolEvent) => void;
  onTextDelta?: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
  executionMode?: CanvasAgentExecutionMode;
  explicitSkillIds?: string[];
  onTurnStopped?: (error: AgentTurnLimitError) => void;
  onRetry?: (notice: AgentModelRetryNotice) => void;
}): Promise<CanvasAgentTurnResult> {
  if (input.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  const startedAt = Date.now();
  if (input.scope !== 'home' && useProjectStore.getState().currentProjectId !== input.projectId) {
    throw new Error('Agent 请求的项目不是当前打开的项目。');
  }
  const previousSession = input.sessionId ? repository.getSession(input.sessionId) : null;
  if (input.sessionId && (!previousSession || previousSession.projectId !== input.projectId
    || (previousSession.scope ?? 'canvas') !== (input.scope ?? 'canvas'))) {
    throw new Error('Agent 对话不属于当前项目或作用域。');
  }
  const defaults = resolveAgentDefaults({
    modelId: input.model?.id ?? previousSession?.modelRef,
    executionMode: input.executionMode ?? previousSession?.executionMode,
  });
  const model = input.model ?? buildChatModelCatalog(getChannelCatalogProviders()).find((entry) => entry.id === defaults.modelId);
  if (!model) throw new Error('请选择可用的 Agent 模型；保存的模型不会自动切换到其他渠道。');
  if (input.media?.length && !model.supportsMultimodal) {
    throw new Error('当前文本模型不支持图片理解，请移除附件或切换到支持视觉的模型。');
  }
  const preparationSafety = new AgentTurnSafety({ startedAt, toolCalls: 0 }, input.onTurnStopped);
  let preparedMedia: AgentTurnMediaInput[];
  try {
    preparedMedia = await preparationSafety.run(async () => input.media?.length
      ? prepareRegisteredAgentMedia(input.media, useCanvasStore.getState().nodes)
      : [], input.signal);
  } finally {
    preparationSafety.dispose();
  }
  if (input.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  const createdSession = !input.sessionId;
  const session = input.sessionId
    ? repository.getSession(input.sessionId)
    : repository.createSession({ projectId: input.projectId, scope: input.scope, title: input.message.slice(0, 36), modelRef: model.id });
  if (!session || session.projectId !== input.projectId || (session.scope ?? 'canvas') !== (input.scope ?? 'canvas')) throw new Error('Agent 对话不属于当前项目或作用域。');
  const runId = nextId('run');
  if (previousSession) repository.replaceItems(session.id, completeInterruptedAgentHistory(session.items));
  input.onRunStarted?.({ sessionId: session.id, runId });
  repository.updateSessionMetadata(session.id, { executionMode: defaults.executionMode, modelRef: model.id });
  let partial: Awaited<ReturnType<typeof createActiveRun>>;
  try {
    partial = await createActiveRun({ ...input, model, executionMode: defaults.executionMode, startedAt, media: preparedMedia, runId, sessionId: session.id });
  } catch (error) {
    if (createdSession && repository.getSession(session.id)?.items.length === 0) {
      repository.deleteSession(session.id);
    }
    throw redactedRunError(error, input.signal);
  }
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
    result = await continuePastInvalidToolRequests({
      active: partial,
      result,
      sessionId: session.id,
      signal: input.signal,
      onToolEvent: input.onToolEvent,
      onTextDelta: input.onTextDelta,
      onReasoningDelta: input.onReasoningDelta,
    });
  } catch (error) {
    persistFailedRun(partial, error, input.signal);
    if (createdSession && repository.getSession(session.id)?.items.length === 0) {
      repository.deleteSession(session.id);
    }
    throw redactedRunError(error, input.signal);
  }
  const state = result.state;
  let prepared = await Promise.all(result.interruptions.map((item) => prepareApproval(item, runId, input.projectId, partial.scope, partial.allowedToolNames, partial.modelRef)));
  activeRuns.set(runId, { ...partial, state });
  persistRunCheckpoint(partial, state, prepared);
  if (prepared.length) {
    let iterations = 0;
    while (prepared.length > 0 && iterations < AGENT_TURN_TOOL_CALL_LIMIT) {
      const nextAutoApproval = prepared.find((approval) => shouldAutomaticallyResolveAgentApproval(approval, defaults.executionMode));
      if (!nextAutoApproval) break;
      const resumed = await performCanvasAgentApprovalResolution({
        runId,
        approvalId: nextAutoApproval.view.id,
        approve: true,
        model,
        signal: input.signal,
        onToolEvent: input.onToolEvent,
        onTextDelta: input.onTextDelta,
        onReasoningDelta: input.onReasoningDelta,
        onRetry: input.onRetry,
        onTurnStopped: input.onTurnStopped,
      });
      if (resumed.status === 'completed') return resumed;
      prepared = restorePreparedCanvasAgentApprovals(runId, resumed.approvals);
      iterations += 1;
    }
  }
  const approvals = prepared.map((approval) => approval.view);
  const skillContext = buildSkillContext(partial.skillRoutingContext);
  const toolPolicy = resolveAgentToolPolicy({
    skillContext,
    supportsVision: model.supportsMultimodal,
    supportsToolSearch: model.supportsToolSearch,
    protocol: model.agentProtocol,
  });
  return {
    runId,
    sessionId: session.id,
    finalText: !approvals.length && typeof result.finalOutput === 'string' ? result.finalOutput : undefined,
    approvals,
    status: approvals.length ? 'awaiting-approval' : 'completed',
    skillSelection: {
      skillIds: partial.scope === 'canvas' ? skillContext.selections.map((selection) => selection.skill.id) : [],
      reason: partial.scope === 'canvas' ? skillContext.selections.map((selection) => selection.reason).join(' ') : `${partial.scope} scope`,
      estimatedTokens: partial.scope === 'canvas' ? skillContext.estimatedTokens : 0,
      toolCount: partial.scope === 'canvas' ? toolPolicy.toolKinds.length : getScopedAgentTools(partial.scope).length,
      mode: partial.scope === 'canvas' ? toolPolicy.mode : 'minimal',
      deferredToolCount: partial.scope === 'canvas' ? toolPolicy.deferredToolKinds.length : 0,
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
  onTurnStopped?: (error: AgentTurnLimitError) => void;
  onRetry?: (notice: AgentModelRetryNotice) => void;
}): Promise<CanvasAgentTurnResult> {
  if (input.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  let active = activeRuns.get(input.runId);
  if (!active) {
    const persisted = repository.getRunState(input.runId);
    if (persisted?.status === 'completed') {
      return { runId: persisted.id, sessionId: persisted.sessionId, approvals: [], status: 'completed', skillSelection: { skillIds: [], reason: '', estimatedTokens: 0, toolCount: 0, mode: 'minimal', deferredToolCount: 0 } };
    }
    const record = getRunStateForResume(input.runId);
    const session = repository.getSession(record.sessionId);
    if (!session) throw new Error('Agent 对话已不存在。');
    const selectedModel = record.modelRef
      ? buildChatModelCatalog(getChannelCatalogProviders()).find((model) => model.id === record.modelRef && model.usable)
      : input.model;
    if (!selectedModel) throw new Error('The original selected turn model is unavailable; start a new turn with an available model.');
    const partial = await createActiveRun({ runId: record.id, sessionId: record.sessionId, projectId: record.projectId, scope: session.scope ?? 'canvas', executionMode: record.executionMode ?? 'manual', generationPreferences: record.generationPreferences, model: selectedModel, message: '恢复已中断的工具审批', restoredSkillRoutingContext: record.skillRoutingContext, allowedToolNames: record.allowedToolNames, onToolEvent: input.onToolEvent, signal: input.signal, onTurnStopped: input.onTurnStopped, onRetry: input.onRetry, turnSafety: record.turnSafety });
    const context = { projectId: record.projectId, runId: record.id, onToolEvent: input.onToolEvent };
    const restored = await partial.runtime.restoreStoryboardRunState(partial.agent as any, record.serializedState, { context } as any);
    active = { ...partial, state: restored };
  }
  // Approval continues the same tool closures, but the UI owns a fresh operation
  // epoch and abort controller. Route feedback and cancellation to this operation.
  active.feedback.signal = active.turnSafety.signalFor(input.signal);
  if (input.onRetry) active.feedback.onRetry = input.onRetry;
  if (input.onToolEvent) active.feedback.onToolEvent = input.onToolEvent;
  if (input.onTurnStopped) active.feedback.onTurnStopped = input.onTurnStopped;
  active.turnSafety.assertActive();
  if (active.scope !== 'home' && useProjectStore.getState().currentProjectId !== active.projectId) {
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
  if (input.approve && active.allowedToolNames && !active.allowedToolNames.includes(toolName)) throw new Error('Tool is no longer allowed by the selected skills; reject this approval or start a new turn.');
  let interruptionArgs: unknown = interruption.arguments ?? {};
  if (typeof interruptionArgs === 'string') {
    try { interruptionArgs = JSON.parse(interruptionArgs); } catch { interruptionArgs = { raw: interruptionArgs }; }
  }
  const requestFingerprint = await createAgentRequestFingerprint(toolName, interruptionArgs);
  if (input.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  const storedApprovalId = createApprovalId(active.runId, toolName, input.approvalId);
  const storedApproval = canvasAgentApprovalStore.get(storedApprovalId);
  if (!storedApproval || storedApproval.requestFingerprint !== requestFingerprint) {
    if (storedApproval) canvasAgentApprovalStore.update(storedApproval.id, { status: 'conflicted' });
    throw new Error('工具参数与持久审批不一致，原审批已失效。');
  }
  const executedTargets = input.approve && storedApproval.baseRevision === canvasCommandRegistry.getRevision()
    ? graphApprovalTargets(storedApproval, interruptionArgs) : null;
  const siblingBindings = executedTargets ? active.state.getInterruptions().flatMap((item) => {
    const name = item.name ?? item.toolName ?? 'tool';
    const record = canvasAgentApprovalStore.get(createApprovalId(active.runId, name, approvalId(item)));
    if (!record || record.id === storedApprovalId || record.status !== 'awaiting-approval'
      || record.runId !== active.runId || record.projectId !== active.projectId
      || record.baseRevision !== storedApproval.baseRevision) return [];
    let args: unknown = item.arguments ?? {};
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch { return []; }
    }
    const targets = graphApprovalTargets(record, args);
    return targets ? [{ record, args, targets }] : [];
  }) : [];
  const graphBefore = siblingBindings.length ? {
    nodes: useCanvasStore.getState().nodes, edges: useCanvasStore.getState().edges,
  } : undefined;
  if (input.approve && toolName === 'request_user_input' && !readAgentUserInputAnswer({ projectId: active.projectId, runId: active.runId, callId: input.approvalId }, requestUserInputSchema.parse(interruptionArgs))) throw new Error('请先在询问卡中回答问题。');
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
    result = await continuePastInvalidToolRequests({
      active,
      result,
      sessionId: active.sessionId,
      signal: input.signal,
      onToolEvent: input.onToolEvent,
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
  const completedApprovalStatus = canvasAgentApprovalStore.get(storedApprovalId)?.status;
  if (executedTargets && graphBefore && completedApprovalStatus === 'succeeded') {
    const revision = canvasCommandRegistry.getRevision();
    const graphAfter = { nodes: useCanvasStore.getState().nodes, edges: useCanvasStore.getState().edges };
    for (const id of independentSiblingApprovalIds(executedTargets, siblingBindings.map((binding) => binding.targets), graphBefore, graphAfter)) {
      const binding = siblingBindings.find((candidate) => candidate.record.id === id)!;
      const current = canvasAgentApprovalStore.get(id);
      if (!current || current.status !== 'awaiting-approval' || current.expiresAt <= Date.now()
        || current.baseRevision !== storedApproval.baseRevision || current.requestFingerprint !== binding.record.requestFingerprint) continue;
      const targets = graphApprovalTargets(current, binding.args);
      if (!targets || targets.nodeIds.length !== binding.targets.nodeIds.length || targets.edgeIds.length !== binding.targets.edgeIds.length
        || !targets.nodeIds.every((nodeId) => binding.targets.nodeIds.includes(nodeId))
        || !targets.edgeIds.every((edgeId) => binding.targets.edgeIds.includes(edgeId))) continue;
      canvasAgentApprovalStore.update(id, { baseRevision: revision });
    }
  }
  const prepared = await Promise.all(result.interruptions.map((item) => prepareApproval(item, active.runId, active.projectId, active.scope, active.allowedToolNames, active.modelRef)));
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
    finalText: !approvals.length && typeof result.finalOutput === 'string' ? result.finalOutput : undefined,
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
  onTurnStopped?: (error: AgentTurnLimitError) => void;
  onRetry?: (notice: AgentModelRetryNotice) => void;
}): Promise<CanvasAgentTurnResult> {
  const lockKey = `${input.runId}:${input.approvalId}`;
  const existing = approvalResolutionLocks.get(lockKey);
  if (existing) {
    if (existing.approve !== input.approve) throw new Error('该审批正在处理相反的决定，请等待当前操作完成。');
    return existing.pending;
  }
  const ownerSession = activeRuns.get(input.runId)?.sessionId ?? repository.getRunState(input.runId)?.sessionId;
  if (runResolutionLocks.has(input.runId) || (ownerSession && sessionTurnLocks.has(ownerSession))) throw new Error('此回合正在处理另一个操作，请等待完成。');
  runResolutionLocks.add(input.runId);
  const pending = performCanvasAgentApprovalResolution(input);
  approvalResolutionLocks.set(lockKey, { approve: input.approve, pending });
  try {
    let result = await pending;
    for (let iteration = 0; iteration < AGENT_TURN_TOOL_CALL_LIMIT && result.approvals.length; iteration += 1) {
      const active = activeRuns.get(input.runId);
      if (!active) break;
      const next = result.approvals.find((view) => {
        const record = canvasAgentApprovalStore.get(createApprovalId(input.runId, view.toolName, view.id));
        return record && shouldAutomaticallyResolveAgentApproval({ record }, active.executionMode);
      });
      if (!next) break;
      result = await performCanvasAgentApprovalResolution({ ...input, approvalId: next.id, approve: true });
    }
    return result;
  } finally {
    approvalResolutionLocks.delete(lockKey);
    runResolutionLocks.delete(input.runId);
  }
}

export function listCanvasAgentSessions(projectId: string, scope: AgentScope = 'canvas') {
  return repository.listSessions(projectId, scope)
    .filter((session) => hasVisibleCanvasAgentSessionItems(session.items));
}
export function deleteCanvasAgentSession(sessionId: string): void { repository.deleteSession(sessionId); }

export function getCanvasAgentSession(sessionId: string) { return repository.getSession(sessionId); }

export function listPendingCanvasAgentApprovals(projectId: string, sessionId?: string, scope?: AgentScope): Array<AgentApprovalView & { runId: string }> {
  const now = Date.now();
  return canvasAgentApprovalStore.listByProject(projectId).flatMap((record) => {
    if (record.status !== 'awaiting-approval' || record.expiresAt <= now || !record.toolName) return [];
    const runState = repository.getRunState(record.runId);
    const recovery = canvasAgentApprovalStore.getRunRecovery(record.runId);
    const ownerSessionId = runState?.sessionId ?? recovery?.sessionId;
    const owner = ownerSessionId ? repository.getSession(ownerSessionId) : null;
    const expectedScope = scope ?? (sessionId ? repository.getSession(sessionId)?.scope ?? 'canvas' : 'canvas');
    if (!owner || (owner.scope ?? 'canvas') !== expectedScope) return [];
    if (sessionId && (runState?.sessionId ?? recovery?.sessionId) !== sessionId) return [];
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

export function hasVisibleCanvasAgentSessionItems(items: readonly unknown[]): boolean {
  return items.some((item) => projectSessionMessage(item) !== null);
}

function projectSessionMediaReference(
  reference: AgentSessionMediaReference,
  assets: ReturnType<typeof buildCanvasAssetCatalog>,
): AgentSessionMediaReferenceView {
  const available = inspectAgentMediaReference(reference.referenceId) !== null
    || (reference.origin === 'canvas-asset'
      && assets.some((asset) => asset.id === reference.assetId && asset.kind === 'image'));
  return { ...reference, availability: available ? 'available' : 'missing',
    previewSource: resolveAgentMediaReference(reference.referenceId) ?? undefined };
}

export function getCanvasAgentSessionMediaReferences(
  sessionId: string,
): AgentSessionMediaReferenceView[] {
  const assets = buildCanvasAssetCatalog(useCanvasStore.getState().nodes);
  return repository.getMediaReferences(sessionId)
    .map((reference) => projectSessionMediaReference(reference, assets));
}

export async function refreshCanvasAgentSessionMedia(sessionId: string): Promise<AgentSessionMediaReferenceView[]> {
  const session = repository.getSession(sessionId);
  if (!session) return [];
  const nodes = useProjectStore.getState().currentProjectId === session.projectId ? useCanvasStore.getState().nodes : [];
  return await restoreAgentSessionMedia(session, nodes);
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
