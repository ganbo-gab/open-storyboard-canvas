import {
  RunState,
  Runner,
  Usage,
  setSensitiveDataLoggingEnabled,
  setTracingDisabled,
  type Agent,
  type AgentOutputType,
  type AgentInputItem,
  type Model,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ModelRetryAdvice,
  type ModelRetryAdviceRequest,
  type RunContext,
  type StreamEvent,
  type protocol,
} from '@openai/agents';

import { AgentModelGatewayError, createAgentModelTransport } from './agentModelGateway';
import type {
  AgentModelContentPart,
  AgentModelInputItem,
  AgentModelReference,
  AgentModelToolDefinition,
  AgentModelTransport,
  AgentModelTurnRequest,
  AgentModelTurnResponse,
} from '../domain/agentModel';

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

function imageSource(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'id' in value && typeof value.id === 'string') {
    return `asset:${value.id}`;
  }
  return undefined;
}

function messageContent(item: AgentInputItem): AgentModelContentPart[] {
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
      const source = imageSource(part.image);
      if (source) result.push({ type: 'image', imageUrl: source, detail: part.detail });
    } else if (part.type === 'image') {
      result.push({ type: 'image', imageUrl: part.image });
    } else if (part.type === 'input_file' || part.type === 'audio') {
      throw new AgentModelGatewayError('当前画布 Agent 模型适配器暂不支持文件或音频输入。');
    }
  }
  return result;
}

function toAgentModelInput(input: ModelRequest['input']): AgentModelInputItem[] {
  if (typeof input === 'string') {
    return [{ type: 'message', role: 'user', content: [{ type: 'text', text: input }] }];
  }
  const result: AgentModelInputItem[] = [];
  for (const item of input) {
    if (item.type === 'message' || item.type === undefined) {
      if (item.role !== 'system' && item.role !== 'user' && item.role !== 'assistant') continue;
      result.push({ type: 'message', role: item.role, content: messageContent(item) });
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
      result.push({
        type: 'function_call_result',
        callId: item.callId,
        name: item.name,
        namespace: item.namespace,
        output: outputText(item.output),
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
      description: tool.description,
      parameters: tool.parameters,
      strict: tool.strict,
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
  return {
    model,
    systemInstructions: request.systemInstructions,
    input: toAgentModelInput(request.input),
    tools: toAgentModelTools(request),
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
  TOutput extends AgentOutputType,
  TAgent extends Agent<TContext, TOutput>,
>(
  agent: TAgent,
  serializedState: string,
  context: RunContext<TContext>,
): Promise<RunState<TContext, TAgent>> {
  return RunState.fromStringWithContext(agent, serializedState, context, { contextStrategy: 'replace' });
}

export function serializeStoryboardRunState<
  TContext,
  TOutput extends AgentOutputType,
  TAgent extends Agent<TContext, TOutput>,
>(state: RunState<TContext, TAgent>): string {
  return state.toString({ includeTracingApiKey: false });
}
