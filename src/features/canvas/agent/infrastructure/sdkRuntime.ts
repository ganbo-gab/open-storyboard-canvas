import {
  RunState,
  RunContext,
  Runner,
  Usage,
  Agent,
  tool,
  toolNamespace,
  setSensitiveDataLoggingEnabled,
  setTracingDisabled,
  type AgentInputItem,
  type Model,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ModelRetryAdvice,
  type ModelRetryAdviceRequest,
  type StreamEvent,
  type protocol,
} from '@openai/agents';
import { z } from 'zod';

import { AgentModelGatewayError, createAgentModelTransport } from './agentModelGateway';
import type {
  AgentModelContentPart,
  AgentModelInputItem,
  AgentModelProtocol,
  AgentModelReference,
  AgentModelToolDefinition,
  AgentModelTransport,
  AgentModelTurnRequest,
  AgentModelTurnResponse,
} from '../domain/agentModel';
import {
  CANVAS_COMMAND_TYPES,
  CANVAS_COMMAND_VERSION,
  type CanvasCommand,
  type CanvasCommandExecutionResult,
} from '@/features/canvas/domain/canvasCommands';
import { canvasCommandRegistry } from '@/features/canvas/application/canvasCommandService';
import {
  buildSkillContext,
  resolveAgentToolPolicy,
  type SkillRoutingContext,
} from '../application/agentSkills';
import {
  buildDiagnosticBundlePreview,
  classifyAgentError,
  inspectDiagnosticConfigSnapshot,
  inspectCanvasHealth,
  inspectPersistedGenerationJobs,
  preflightGeneration,
  type DiagnosticEvidenceInput,
} from '../application/agentDiagnostics';
import { redactSensitiveValue } from '../application/agentRedaction';
import { useCanvasStore } from '@/stores/canvasStore';
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
import {
  createAgentMediaReference,
  resolveAgentMediaReference,
  resolveOpaqueAgentMediaReference,
  restoreAgentMediaReferenceFromCanvas,
  toOpaqueAgentMediaReference,
} from '../application/agentMediaResolver';
import { buildCanvasAssetCatalog } from '@/features/canvas/application/canvasAssetCatalog';
import { canvasAgentRollbackStore } from '../application/agentCanvasRollback';
import {
  canvasAgentApprovalExecution,
  canvasAgentApprovalStore,
  createAgentRequestFingerprint,
  createApprovalId,
  findRecoverableGenerationSubmit,
  findScopedReadGrant,
  listRecoverableGenerationSubmits,
  recoverUnknownGenerationSubmit,
  type AgentScopeRequest,
} from '../application/agentApproval';

const GENERATION_POLL_PURPOSE = 'poll-approved-generation-status';
const GENERATION_POLL_GRANT_TTL_MS = 5 * 60_000;
const STORYBOARD_DEFERRED_TOOL = 'storyboardDeferredTool';
const STORYBOARD_TOOL_NAMESPACE = 'storyboard_canvas';
const STORYBOARD_TOOL_NAMESPACE_DESCRIPTION = '画布编排、诊断、供应商配置和获批图片读取工具。';

export interface StoryboardModelProviderOptions {
  resolveModel(modelName?: string): AgentModelReference;
  transport?: AgentModelTransport;
}

function outputText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function objectOutput(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { result: value };
}

interface ImageSourceResolution {
  source?: string;
  missingReferenceId?: string;
}

function imageSource(value: unknown): ImageSourceResolution {
  if (typeof value === 'string') {
    if (value.startsWith('agent-media-ref:')) {
      const encodedId = value.slice('agent-media-ref:'.length);
      let referenceId = '';
      try {
        referenceId = decodeURIComponent(encodedId);
      } catch {
        referenceId = '';
      }
      const source = resolveOpaqueAgentMediaReference(value)
        ?? (referenceId
          ? restoreAgentMediaReferenceFromCanvas(referenceId, useCanvasStore.getState().nodes)
          : null);
      return source ? { source } : { missingReferenceId: referenceId || value };
    }
    return { source: value };
  }
  if (value && typeof value === 'object' && 'url' in value && typeof value.url === 'string') {
    return imageSource(value.url);
  }
  if (value && typeof value === 'object' && 'id' in value && typeof value.id === 'string') {
    const source = resolveAgentMediaReference(value.id)
      ?? restoreAgentMediaReferenceFromCanvas(value.id, useCanvasStore.getState().nodes);
    return source ? { source } : { missingReferenceId: value.id };
  }
  return {};
}

function unavailableImageText(referenceId: string | undefined, supportsVision: boolean): string {
  const stableReference = referenceId ? `（稳定引用 ${referenceId}）` : '';
  return supportsVision
    ? `[图片引用已缺失${stableReference}。不得声称已看到图片；请让用户重新附加或查找资产。]`
    : `[当前文本模型未接收图片${stableReference}。不得推断或描述图片内容。]`;
}

function toolResultContent(value: unknown, supportsVision: boolean): AgentModelContentPart[] {
  const values = Array.isArray(value) ? value : [value];
  const result: AgentModelContentPart[] = [];
  for (const item of values) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if ((record.type === 'text' || record.type === 'input_text') && typeof record.text === 'string') {
      result.push({ type: 'text', text: record.text });
      continue;
    }
    if (record.type !== 'image' && record.type !== 'input_image') continue;
    const resolved = supportsVision
      ? imageSource(record.image ?? record.imageUrl ?? record.image_url)
      : { missingReferenceId: mediaReferenceId(record.image ?? record.imageUrl ?? record.image_url) };
    if (resolved.source) {
      result.push({
        type: 'image',
        imageUrl: resolved.source,
        detail: typeof record.detail === 'string' ? record.detail : undefined,
      });
    } else {
      result.push({ type: 'text', text: unavailableImageText(resolved.missingReferenceId, supportsVision) });
    }
  }
  return result;
}

function mediaReferenceId(value: unknown): string | undefined {
  if (typeof value === 'string' && value.startsWith('agent-media-ref:')) {
    try {
      return decodeURIComponent(value.slice('agent-media-ref:'.length));
    } catch {
      return value;
    }
  }
  if (value && typeof value === 'object' && 'id' in value && typeof value.id === 'string') {
    return value.id;
  }
  return undefined;
}

function messageContent(item: AgentInputItem, supportsVision: boolean): AgentModelContentPart[] {
  if (!('role' in item)) return [];
  if (typeof item.content === 'string') return [{ type: 'text', text: item.content }];
  if (!Array.isArray(item.content)) return [];
  const result: AgentModelContentPart[] = [];
  for (const part of item.content) {
    if (part.type === 'input_text' || part.type === 'output_text') {
      result.push({ type: 'text', text: part.text });
    } else if (part.type === 'refusal') {
      result.push({ type: 'text', text: part.refusal });
    } else if (part.type === 'input_image') {
      const resolved = supportsVision
        ? imageSource(part.image)
        : { missingReferenceId: mediaReferenceId(part.image) };
      if (resolved.source) result.push({ type: 'image', imageUrl: resolved.source, detail: part.detail });
      else result.push({ type: 'text', text: unavailableImageText(resolved.missingReferenceId, supportsVision) });
    } else if (part.type === 'image') {
      if (supportsVision) result.push({ type: 'image', imageUrl: part.image });
      else result.push({ type: 'text', text: unavailableImageText(undefined, false) });
    } else if (part.type === 'input_file' || part.type === 'audio') {
      throw new AgentModelGatewayError('当前画布 Agent 模型适配器暂不支持文件或音频输入。');
    }
  }
  return result;
}

function toAgentModelInput(
  input: ModelRequest['input'],
  supportsVision: boolean,
): AgentModelInputItem[] {
  if (typeof input === 'string') {
    return [{ type: 'message', role: 'user', content: [{ type: 'text', text: input }] }];
  }
  const result: AgentModelInputItem[] = [];
  for (const item of input) {
    if (item.type === 'message' || item.type === undefined) {
      if (item.role !== 'system' && item.role !== 'user' && item.role !== 'assistant') continue;
      result.push({ type: 'message', role: item.role, content: messageContent(item, supportsVision) });
      continue;
    }
    if (item.type === 'function_call') {
      result.push({
        type: 'function_call',
        callId: item.callId,
        name: item.name,
        namespace: item.namespace,
        arguments: item.arguments,
      });
      continue;
    }
    if (item.type === 'function_call_result') {
      const content = toolResultContent(item.output, supportsVision);
      const textOutput = content
        .filter((part): part is Extract<AgentModelContentPart, { type: 'text' }> => part.type === 'text')
        .map((part) => part.text)
        .join('\n');
      result.push({
        type: 'function_call_result',
        callId: item.callId,
        name: item.name,
        namespace: item.namespace,
        output: textOutput || outputText(item.output),
        content: content.length ? content : undefined,
      });
    }
  }
  return result;
}

function toAgentModelTools(request: ModelRequest): AgentModelToolDefinition[] {
  const tools: AgentModelToolDefinition[] = [];
  for (const tool of request.tools) {
    if (tool.type !== 'function') {
      throw new AgentModelGatewayError(`当前画布 Agent 不支持 ${tool.type} 类型的 SDK 工具。`);
    }
    tools.push({
      name: tool.name,
      namespace: tool.namespace,
      namespaceDescription: tool.namespaceDescription,
      description: tool.description,
      parameters: tool.parameters,
      strict: tool.strict,
      deferLoading: tool.providerData?.[STORYBOARD_DEFERRED_TOOL] === true,
    });
  }
  for (const handoff of request.handoffs) {
    tools.push({
      name: handoff.toolName,
      description: handoff.toolDescription,
      parameters: handoff.inputJsonSchema,
      strict: handoff.strictJsonSchema,
    });
  }
  return tools;
}

function toAgentModelRequest(
  model: AgentModelReference,
  request: ModelRequest,
): AgentModelTurnRequest {
  if (request.prompt) {
    throw new AgentModelGatewayError('当前多供应商画布 Agent 不支持 OpenAI 托管 Prompt 模板。');
  }
  const tools = toAgentModelTools(request);
  const supportsResponsesToolSearch = model.capabilities.protocol === 'openai-responses'
    && model.capabilities.toolSearch;
  const deferredTools = supportsResponsesToolSearch
    ? tools.filter((candidate) => candidate.deferLoading)
    : [];
  return {
    model,
    systemInstructions: request.systemInstructions,
    input: toAgentModelInput(request.input, model.capabilities.vision),
    tools,
    toolPolicy: {
      mode: deferredTools.length ? 'responses-tool-search' : 'local-pruned',
      deferredToolNames: deferredTools.map((candidate) => (
        candidate.namespace ? `${candidate.namespace}.${candidate.name}` : candidate.name
      )),
      deferredNamespaces: Array.from(new Set(deferredTools.flatMap((candidate) => (
        candidate.namespace ? [candidate.namespace] : []
      )))),
    },
    toolChoice: request.modelSettings.toolChoice,
    parallelToolCalls: request.modelSettings.parallelToolCalls,
    temperature: request.modelSettings.temperature,
    topP: request.modelSettings.topP,
    maxOutputTokens: request.modelSettings.maxTokens,
  };
}

function toUsage(response: AgentModelTurnResponse): Usage {
  return new Usage({
    requests: 1,
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    totalTokens: response.usage.totalTokens,
    inputTokensDetails: {
      cached_tokens: response.usage.cachedInputTokens ?? 0,
    },
    outputTokensDetails: {
      reasoning_tokens: response.usage.reasoningTokens ?? 0,
    },
  });
}

function toModelOutput(response: AgentModelTurnResponse): protocol.OutputModelItem[] {
  const output: protocol.OutputModelItem[] = [];
  if (response.reasoningSummary) {
    output.push({
      type: 'reasoning',
      content: [{ type: 'input_text', text: response.reasoningSummary }],
    });
  }
  if (response.text) {
    output.push({
      id: response.responseId,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: response.text }],
    });
  }
  for (const call of response.toolCalls) {
    output.push({
      id: response.responseId,
      type: 'function_call',
      callId: call.callId,
      name: call.name,
      namespace: call.namespace,
      arguments: call.arguments,
      status: 'completed',
    });
  }
  return output;
}

function toModelResponse(response: AgentModelTurnResponse): ModelResponse {
  return {
    usage: toUsage(response),
    output: toModelOutput(response),
    responseId: response.responseId,
    requestId: response.requestId,
    providerData: response.providerSummary,
  };
}

export class StoryboardAgentModel implements Model {
  constructor(
    readonly reference: AgentModelReference,
    private readonly transport: AgentModelTransport,
  ) {}

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const response = await this.transport.getResponse(
      toAgentModelRequest(this.reference, request),
      request.signal,
    );
    return toModelResponse(response);
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    yield {
      type: 'response_started',
      providerData: { protocol: this.reference.capabilities.protocol },
    };
    for await (const event of this.transport.getStreamedResponse(
      toAgentModelRequest(this.reference, request),
      request.signal,
    )) {
      if (event.type === 'text_delta') {
        yield { type: 'output_text_delta', delta: event.delta };
      } else if (event.type === 'reasoning_summary_delta') {
        yield {
          type: 'model',
          event: { type: 'reasoning_summary_delta', delta: event.delta },
          providerData: { protocol: this.reference.capabilities.protocol },
        };
      } else {
        const response = toModelResponse(event.response);
        yield {
          type: 'response_done',
          response: {
            id: response.responseId ?? event.response.responseId,
            requestId: response.requestId,
            usage: response.usage,
            output: toModelOutput(event.response),
            providerData: response.providerData,
          },
        };
      }
    }
  }

  getRetryAdvice(args: ModelRetryAdviceRequest): ModelRetryAdvice {
    if (args.error instanceof DOMException && args.error.name === 'AbortError') {
      return { suggested: false, replaySafety: 'unsafe', reason: 'aborted by user' };
    }
    if (args.error instanceof AgentModelGatewayError) {
      if (args.error.retryable && !args.error.responseStarted) {
        return {
          suggested: true,
          replaySafety: 'safe',
          reason: 'transient model transport failure before streamed output',
          normalized: {
            statusCode: args.error.status,
            isNetworkError: args.error.status === undefined,
            isAbort: false,
          },
        };
      }
      return {
        suggested: false,
        replaySafety: 'unsafe',
        reason: args.error.responseStarted
          ? 'stream output already started'
          : 'provider did not establish replay safety',
      };
    }
    return { suggested: false, replaySafety: 'unsafe', reason: 'unknown model failure' };
  }
}

export class StoryboardModelProvider implements ModelProvider {
  private readonly transport: AgentModelTransport;
  private readonly models = new Map<string, StoryboardAgentModel>();

  constructor(private readonly options: StoryboardModelProviderOptions) {
    this.transport = options.transport ?? createAgentModelTransport();
  }

  getModel(modelName?: string): Model {
    const reference = this.options.resolveModel(modelName);
    if (!reference.usable || !reference.capabilities.tools) {
      throw new AgentModelGatewayError(
        reference.notReadyReason || '所选模型不满足画布 Agent 的工具调用要求。',
      );
    }
    const cached = this.models.get(reference.catalogId);
    if (cached) return cached;
    const model = new StoryboardAgentModel(reference, this.transport);
    this.models.set(reference.catalogId, model);
    return model;
  }
}

export function conservativeModelRetryPolicy(context: {
  attempt: number;
  maxRetries: number;
  normalized: { isAbort: boolean };
  providerAdvice?: ModelRetryAdvice;
}): boolean {
  return context.attempt <= context.maxRetries
    && !context.normalized.isAbort
    && context.providerAdvice?.suggested === true
    && context.providerAdvice.replaySafety === 'safe';
}

export interface StoryboardAgentRuntime {
  modelProvider: StoryboardModelProvider;
  runner: Runner;
}

export interface CanvasAgentToolEvent {
  toolName: string;
  callId?: string;
  status: 'awaiting-approval' | 'executing' | 'succeeded' | 'failed' | 'unknown';
  input?: unknown;
  output?: unknown;
  error?: string;
}

export interface CanvasAgentContext {
  projectId: string;
  runId: string;
  onToolEvent?: (event: CanvasAgentToolEvent) => void;
  executeCanvasCommand?: (command: CanvasCommand, expectedRevision: number) => Promise<CanvasCommandExecutionResult>;
  getCanvasRevision?: () => number;
  getActiveProjectId?: () => string | null;
  persistCanvasCheckpoint?: () => Promise<void>;
  /** Optional safe evidence providers. Values are recursively redacted before they reach the model. */
  getDiagnosticEvidence?: () => DiagnosticEvidenceInput;
  getDiagnosticRuntimeSnapshot?: () => unknown;
}

const canvasCommandInputParser = z.object({
  type: z.string().min(1),
  input: z.record(z.string(), z.unknown()).default({}),
}).strict();

const canvasCommandParameters = {
  type: 'object' as const,
  properties: {
    type: {
      type: 'string' as const,
      enum: [...CANVAS_COMMAND_TYPES],
      description: 'Registered CanvasCommand type, including safe tag and tag-group operations.',
    },
    input: { type: 'object' as const, description: 'Command-specific input validated by CanvasCommandRegistry.', additionalProperties: true },
  },
  required: ['type', 'input'],
  additionalProperties: true as const,
};

const diagnosticsParameters = z.object({
  operation: z.enum(['health', 'provider-config', 'generation-jobs', 'preflight', 'classify-error', 'bundle-preview']),
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

function requiredToolCallId(details: { toolCall?: { callId?: string } } | undefined): string {
  const callId = details?.toolCall?.callId;
  if (!callId) throw new Error('Agent 工具调用缺少稳定 callId，已拒绝执行。');
  return callId;
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

function approvedGenerationPollGrant(
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

export function createCanvasAgent(options: {
  runtime: StoryboardAgentRuntime;
  modelName?: string;
  skillContext: SkillRoutingContext;
  projectContext?: { brief: string; pinnedNodeIds: string[] };
  supportsVision?: boolean;
  supportsToolSearch?: boolean;
  protocol?: AgentModelProtocol;
  context: CanvasAgentContext;
}): Agent<CanvasAgentContext> {
  const { runtime, context } = options;
  const skillContext = buildSkillContext(options.skillContext);
  const toolPolicy = resolveAgentToolPolicy({
    skillContext,
    supportsVision: options.supportsVision === true,
    supportsToolSearch: options.supportsToolSearch === true,
    protocol: options.protocol,
  });
  const projectBrief = options.projectContext?.brief.trim().slice(0, 8_000) ?? '';
  const pinnedNodeIds = Array.from(new Set(options.projectContext?.pinnedNodeIds ?? [])).slice(0, 12);
  const execute = context.executeCanvasCommand ?? (async (command: CanvasCommand, expectedRevision: number) => canvasCommandRegistry.executeApproved(command, expectedRevision, 'agent'));
  const canvasTool = tool({
    name: 'canvas_command',
    description: 'Read or change the canvas through the versioned command contract. Every call is visible and requires confirmation.',
    parameters: canvasCommandParameters,
    strict: false,
    providerData: toolPolicy.deferredToolKinds.includes('canvas')
      ? { [STORYBOARD_DEFERRED_TOOL]: true }
      : undefined,
    needsApproval: async (_runContext, rawInput) => {
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
                executeStatus: (statusCommand) => execute(statusCommand, pollGrant.baseRevision),
              })
            : undefined;
          const result = recovered?.result ?? await execute(command, pollGrant.baseRevision);
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
              && canvasCommandRegistry.getDefinition(command.type).effect === 'graph';
            const rollbackToken = graphWrite
              ? canvasAgentRollbackStore.begin(
                  context.projectId,
                  context.runId,
                  useCanvasStore.getState().revision,
                  useCanvasStore.getState().history.past.length,
                )
              : undefined;
            try {
              const result = await execute(command, approval.baseRevision);
              if (!result.ok) {
                if (rollbackToken) canvasAgentRollbackStore.discard(rollbackToken);
                return result;
              }
              if (rollbackToken) canvasAgentRollbackStore.complete(rollbackToken, result.revisionAfter);
              if (result.ok && approval.impact.effect === 'canvas-write') {
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
        const toolOutput = redactSensitiveValue({
          ...result,
          execution: {
            receiptId: execution.receipt.id,
            receiptStatus: execution.receipt.status,
            safeRecovery: execution.receipt.safeRecovery,
            replayed: execution.replayed,
          },
        });
        toolEvent(context, {
          toolName: 'canvas_command',
          callId,
          status: execution.receipt.status === 'unknown' ? 'unknown' : result.ok ? 'succeeded' : 'failed',
          output: toolOutput,
        });
        return toolOutput;
      } catch (error) {
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
        toolEvent(context, { toolName: 'canvas_command', callId, status: recovery ? 'unknown' : 'failed', output, error: message });
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
        toolEvent(context, { toolName: 'config_patch', callId, status: result.ok ? 'succeeded' : 'failed', output: toolOutput });
        return toolOutput;
      } catch (error) {
        const message = redactSensitiveValue(error instanceof Error ? error.message : String(error));
        toolEvent(context, { toolName: 'config_patch', callId, status: 'failed', error: message });
        return { ok: false, error: message };
      }
    },
  });
  const assetReadTool = toolPolicy.toolKinds.includes('asset-read') ? tool({
    name: 'asset_read',
    description: 'Read one image previously discovered through asset.list. The exact image is sent to the current vision model only after user approval.',
    parameters: assetReadParameters,
    providerData: toolPolicy.deferredToolKinds.includes('asset-read')
      ? { [STORYBOARD_DEFERRED_TOOL]: true }
      : undefined,
    needsApproval: true,
    execute: async (input, _runContext, details) => {
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
            const asset = buildCanvasAssetCatalog(useCanvasStore.getState().nodes)
              .find((candidate) => candidate.id === input.assetId);
            if (!asset) throw new Error(`画布图片 ${input.assetId} 不存在或已移动。`);
            if (asset.kind !== 'image') throw new Error(`资产 ${input.assetId} 不是可供视觉模型读取的图片。`);
            const source = asset.previewUrl || asset.url;
            const reference = createAgentMediaReference(
              context.runId,
              asset.nodeId,
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
  const selectedTools = [
    ...(toolPolicy.toolKinds.includes('canvas') ? [canvasTool] : []),
    ...(toolPolicy.toolKinds.includes('diagnostics') ? [diagnosticsTool] : []),
    ...(toolPolicy.toolKinds.includes('config') ? [configPatchTool] : []),
    ...(assetReadTool ? [assetReadTool] : []),
  ];
  const routedTools = toolPolicy.mode === 'tool-search'
    ? toolNamespace({
        name: STORYBOARD_TOOL_NAMESPACE,
        description: STORYBOARD_TOOL_NAMESPACE_DESCRIPTION,
        tools: selectedTools,
      })
    : selectedTools;
  return new Agent<CanvasAgentContext>({
    name: 'Storyboard Canvas Agent',
    model: runtime.modelProvider.getModel(options.modelName),
    instructions: [
      '你是 Storyboard Copilot 的全能画布助手。你可以理解文本和获批的图片引用，使用类型化工具完成画布工作。',
      '所有读取、增删改、配置修改和外部生成都必须经过 SDK approval interruption；不要把“我会做”当成已执行。',
      '结果必须引用真实 nodeId/assetId/jobId；成功后告诉用户如何定位。错误要分类并保留未知状态。',
      options.supportsVision
        ? '需要查看画布图片时，先用 asset.list 缩小到稳定 assetId，再单独调用 asset_read 请求用户确认；不要猜测图片内容。'
        : '当前模型不支持视觉输入，不得声称已经查看图片；可以用 asset.list 返回的安全元数据帮助用户定位。',
      '不展示隐藏思维链，只展示简短 reasoning summary 和工具事件。禁止读取 API key、Cookie、Authorization、完整 base64、blob 或绝对路径。',
      `当前可按需加载的技能索引：\n${skillContext.index}`,
      skillContext.instructions,
      `本轮工具策略：${toolPolicy.reason}`,
      projectBrief || pinnedNodeIds.length
        ? [
            '用户可见、当前项目专属的项目上下文：',
            projectBrief ? `项目简报：${projectBrief}` : '项目简报：未填写。',
            pinnedNodeIds.length ? `固定参考节点：${pinnedNodeIds.join(', ')}` : '固定参考节点：无。',
            '该上下文仅属于当前项目，不得推断或写入其他项目。',
          ].join('\n')
        : '当前项目没有用户填写的项目简报或固定参考。',
    ].join('\n\n'),
    tools: routedTools,
  });
}

export function createStoryboardAgentRuntime(
  options: StoryboardModelProviderOptions,
): StoryboardAgentRuntime {
  setTracingDisabled(true);
  setSensitiveDataLoggingEnabled(false);
  const modelProvider = new StoryboardModelProvider(options);
  const runner = new Runner({
    modelProvider,
    tracingDisabled: true,
    traceIncludeSensitiveData: false,
    modelSettings: {
      retry: {
        maxRetries: 1,
        backoff: { initialDelayMs: 500, maxDelayMs: 2_000, multiplier: 2, jitter: true },
        policy: conservativeModelRetryPolicy,
      },
    },
  });
  return { modelProvider, runner };
}

export async function restoreStoryboardRunState<
  TContext,
  TAgent extends Agent<TContext, 'text'>,
>(
  agent: TAgent,
  serializedState: string,
  context: RunContext<TContext> | TContext,
): Promise<RunState<TContext, TAgent>> {
  const runContext = context instanceof RunContext ? context : new RunContext(context);
  return RunState.fromStringWithContext(agent, serializedState, runContext, { contextStrategy: 'replace' });
}

export function serializeStoryboardRunState<
  TContext,
  TAgent extends Agent<TContext, 'text'>,
>(state: RunState<TContext, TAgent>): string {
  return state.toString({ includeTracingApiKey: false });
}
