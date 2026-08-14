import type {
  AgentModelProtocol,
  AgentModelStreamEvent,
  AgentModelToolCall,
  AgentModelToolDefinition,
  AgentModelTurnRequest,
  AgentModelTurnResponse,
  AgentModelUsage,
} from '../domain/agentModel';
import {
  AgentModelProtocolError,
  asRecord,
  decodeToolName,
  getPath,
  jsonString,
  numberValue,
  parseToolArguments,
  safeResponseId,
  stringValue,
  wireToolName,
} from './agentProviderCodecUtils';

export { AgentModelProtocolError } from './agentProviderCodecUtils';
export { buildAgentProviderBody } from './agentProviderRequestCodec';

function usageFromPayload(protocol: AgentModelProtocol, payload: unknown): AgentModelUsage {
  if (protocol === 'openai-chat-completions') {
    const inputTokens = numberValue(getPath(payload, ['usage', 'prompt_tokens']));
    const outputTokens = numberValue(getPath(payload, ['usage', 'completion_tokens']));
    return {
      inputTokens,
      outputTokens,
      totalTokens: numberValue(getPath(payload, ['usage', 'total_tokens'])) || inputTokens + outputTokens,
      cachedInputTokens: numberValue(getPath(payload, ['usage', 'prompt_tokens_details', 'cached_tokens'])) || undefined,
      reasoningTokens: numberValue(getPath(payload, ['usage', 'completion_tokens_details', 'reasoning_tokens'])) || undefined,
    };
  }
  if (protocol === 'google-gemini') {
    const inputTokens = numberValue(getPath(payload, ['usageMetadata', 'promptTokenCount']));
    const outputTokens = numberValue(getPath(payload, ['usageMetadata', 'candidatesTokenCount']));
    return {
      inputTokens,
      outputTokens,
      totalTokens: numberValue(getPath(payload, ['usageMetadata', 'totalTokenCount'])) || inputTokens + outputTokens,
    };
  }
  const usageRoot = getPath(payload, ['usage']);
  const inputTokens = numberValue(getPath(usageRoot, ['input_tokens']));
  const outputTokens = numberValue(getPath(usageRoot, ['output_tokens']));
  return {
    inputTokens,
    outputTokens,
    totalTokens: numberValue(getPath(usageRoot, ['total_tokens'])) || inputTokens + outputTokens,
    cachedInputTokens: numberValue(getPath(usageRoot, ['input_tokens_details', 'cached_tokens'])) || undefined,
    reasoningTokens: numberValue(getPath(usageRoot, ['output_tokens_details', 'reasoning_tokens'])) || undefined,
  };
}

function validateToolCall(call: AgentModelToolCall): AgentModelToolCall {
  if (!call.callId.trim() || !call.name.trim()) {
    throw new AgentModelProtocolError('Provider returned a tool call without call id or name.');
  }
  parseToolArguments(call.arguments || '{}');
  return { ...call, arguments: call.arguments || '{}' };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assertStructuredToolCalling(
  request: AgentModelTurnRequest,
  text: string | undefined,
  toolCalls: readonly AgentModelToolCall[],
): void {
  if (!text?.trim() || toolCalls.length || !request.tools.length) return;
  const toolNames = request.tools.flatMap((tool) => [tool.name, wireToolName(tool)]);
  const names = Array.from(new Set(toolNames.filter(Boolean))).map(escapeRegExp).join('|');
  if (!names) return;
  const textualCall = new RegExp(`(?:^|[\\n\\r])\\s*(?:\\*\\*|#{1,6}\\s*)?(?:${names})(?:\\*\\*)?\\s*\\(\\s*\\{`, 'i');
  if (textualCall.test(text)) {
    throw new AgentModelProtocolError(
      '模型把工具调用作为普通文本返回，未执行任何画布操作。请确认该渠道支持结构化工具调用，并检查 API 协议配置。',
    );
  }
}

function parseResponsesOutput(
  payload: unknown,
  tools: readonly AgentModelToolDefinition[],
): { text: string; reasoningSummary?: string; toolCalls: AgentModelToolCall[] } {
  const output = getPath(payload, ['output']);
  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolCalls: AgentModelToolCall[] = [];
  if (!Array.isArray(output)) return { text: '', toolCalls };
  for (const item of output) {
    const record = asRecord(item);
    if (!record) continue;
    if (record.type === 'function_call') {
      const wireName = stringValue(record.name) ?? '';
      const namespace = stringValue(record.namespace);
      toolCalls.push(validateToolCall({
        callId: stringValue(record.call_id) ?? stringValue(record.id) ?? '',
        ...(namespace ? { name: wireName, namespace } : decodeToolName(wireName, tools)),
        arguments: stringValue(record.arguments) ?? '{}',
      }));
      continue;
    }
    const content = Array.isArray(record.content) ? record.content : [];
    for (const part of content) {
      const contentRecord = asRecord(part);
      const text = stringValue(contentRecord?.text);
      if (text) textParts.push(text);
    }
    if (record.type === 'reasoning') {
      const summary = Array.isArray(record.summary) ? record.summary : [];
      for (const part of summary) {
        const text = stringValue(asRecord(part)?.text);
        if (text) reasoningParts.push(text);
      }
    }
  }
  return {
    text: textParts.join(''),
    reasoningSummary: reasoningParts.join('') || undefined,
    toolCalls,
  };
}

function parseChatOutput(
  payload: unknown,
  tools: readonly AgentModelToolDefinition[],
): { text: string; toolCalls: AgentModelToolCall[] } {
  const text = stringValue(getPath(payload, ['choices', 0, 'message', 'content'])) ?? '';
  const rawCalls = getPath(payload, ['choices', 0, 'message', 'tool_calls']);
  const toolCalls: AgentModelToolCall[] = [];
  if (Array.isArray(rawCalls)) {
    for (const rawCall of rawCalls) {
      const wireName = stringValue(getPath(rawCall, ['function', 'name'])) ?? '';
      toolCalls.push(validateToolCall({
        callId: stringValue(getPath(rawCall, ['id'])) ?? '',
        ...decodeToolName(wireName, tools),
        arguments: stringValue(getPath(rawCall, ['function', 'arguments'])) ?? '{}',
      }));
    }
  }
  return { text, toolCalls };
}

function parseAnthropicOutput(
  payload: unknown,
  tools: readonly AgentModelToolDefinition[],
): { text: string; toolCalls: AgentModelToolCall[] } {
  const content = getPath(payload, ['content']);
  const textParts: string[] = [];
  const toolCalls: AgentModelToolCall[] = [];
  if (Array.isArray(content)) {
    for (const part of content) {
      const record = asRecord(part);
      if (!record) continue;
      if (record.type === 'text') {
        const text = stringValue(record.text);
        if (text) textParts.push(text);
      } else if (record.type === 'thinking') {
        // Anthropic thinking blocks are hidden chain-of-thought, not a product summary.
        continue;
      } else if (record.type === 'tool_use') {
        const wireName = stringValue(record.name) ?? '';
        toolCalls.push(validateToolCall({
          callId: stringValue(record.id) ?? '',
          ...decodeToolName(wireName, tools),
          arguments: jsonString(record.input),
        }));
      }
    }
  }
  return { text: textParts.join(''), toolCalls };
}

function parseGeminiOutput(
  payload: unknown,
  tools: readonly AgentModelToolDefinition[],
): { text: string; toolCalls: AgentModelToolCall[] } {
  const parts = getPath(payload, ['candidates', 0, 'content', 'parts']);
  const textParts: string[] = [];
  const toolCalls: AgentModelToolCall[] = [];
  if (Array.isArray(parts)) {
    for (const part of parts) {
      const record = asRecord(part);
      if (!record) continue;
      const text = stringValue(record.text);
      if (text) textParts.push(text);
      const functionCall = asRecord(record.functionCall);
      if (functionCall) {
        const wireName = stringValue(functionCall.name) ?? '';
        toolCalls.push(validateToolCall({
          callId: stringValue(functionCall.id) ?? safeResponseId(undefined),
          ...decodeToolName(wireName, tools),
          arguments: jsonString(functionCall.args),
        }));
      }
    }
  }
  return { text: textParts.join(''), toolCalls };
}

function finishReason(protocol: AgentModelProtocol, payload: unknown): string | undefined {
  if (protocol === 'openai-chat-completions') {
    return stringValue(getPath(payload, ['choices', 0, 'finish_reason']));
  }
  if (protocol === 'anthropic-messages') return stringValue(getPath(payload, ['stop_reason']));
  if (protocol === 'google-gemini') return stringValue(getPath(payload, ['candidates', 0, 'finishReason']));
  return stringValue(getPath(payload, ['incomplete_details', 'reason']))
    ?? stringValue(getPath(payload, ['status']));
}

export function parseAgentProviderResponse(
  request: AgentModelTurnRequest,
  payload: unknown,
): AgentModelTurnResponse {
  const protocol = request.model.capabilities.protocol;
  const output = protocol === 'openai-responses'
    ? parseResponsesOutput(payload, request.tools)
    : protocol === 'anthropic-messages'
      ? parseAnthropicOutput(payload, request.tools)
      : protocol === 'google-gemini'
        ? parseGeminiOutput(payload, request.tools)
        : parseChatOutput(payload, request.tools);
  const responseId = safeResponseId(
    getPath(payload, ['id'])
      ?? getPath(payload, ['response', 'id'])
      ?? getPath(payload, ['candidates', 0, 'content', 'role']),
  );
  const reasoningSummary = 'reasoningSummary' in output
    && typeof output.reasoningSummary === 'string'
    ? output.reasoningSummary
    : undefined;
  assertStructuredToolCalling(request, output.text, output.toolCalls);
  return {
    responseId,
    requestId: stringValue(getPath(payload, ['request_id']))
      ?? stringValue(getPath(payload, ['_request_id'])),
    text: output.text || undefined,
    reasoningSummary,
    toolCalls: output.toolCalls,
    finishReason: finishReason(protocol, payload),
    usage: usageFromPayload(protocol, payload),
    providerSummary: {
      protocol,
      finishReason: finishReason(protocol, payload) ?? null,
    },
  };
}

interface PartialToolCall {
  callId: string;
  name: string;
  namespace?: string;
  arguments: string;
}

export class AgentProviderStreamAccumulator {
  private responseId = '';
  private requestId: string | undefined;
  private text = '';
  private reasoningSummary = '';
  private finish: string | undefined;
  private usage: AgentModelUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  private readonly toolCalls = new Map<string, PartialToolCall>();
  private finalResponse: AgentModelTurnResponse | null = null;

  constructor(private readonly request: AgentModelTurnRequest) {}

  consume(payload: unknown): AgentModelStreamEvent[] {
    const protocol = this.request.model.capabilities.protocol;
    if (protocol === 'openai-responses') return this.consumeResponses(payload);
    if (protocol === 'anthropic-messages') return this.consumeAnthropic(payload);
    if (protocol === 'google-gemini') return this.consumeGemini(payload);
    return this.consumeChat(payload);
  }

  complete(): AgentModelTurnResponse {
    if (this.finalResponse) return this.finalResponse;
    const toolCalls = Array.from(this.toolCalls.values()).map((call) => {
      const decoded = call.namespace
        ? { name: call.name, namespace: call.namespace }
        : decodeToolName(call.name, this.request.tools);
      return validateToolCall({
        callId: call.callId,
        ...decoded,
        arguments: call.arguments || '{}',
      });
    });
    assertStructuredToolCalling(this.request, this.text, toolCalls);
    return {
      responseId: safeResponseId(this.responseId),
      requestId: this.requestId,
      text: this.text || undefined,
      reasoningSummary: this.reasoningSummary || undefined,
      toolCalls,
      finishReason: this.finish,
      usage: this.usage,
      providerSummary: {
        protocol: this.request.model.capabilities.protocol,
        finishReason: this.finish ?? null,
      },
    };
  }

  private consumeResponses(payload: unknown): AgentModelStreamEvent[] {
    const events: AgentModelStreamEvent[] = [];
    const type = stringValue(getPath(payload, ['type'])) ?? '';
    this.responseId = stringValue(getPath(payload, ['response', 'id']))
      ?? this.responseId;
    this.requestId = stringValue(getPath(payload, ['response', '_request_id'])) ?? this.requestId;
    if (type === 'response.output_text.delta') {
      const delta = stringValue(getPath(payload, ['delta'])) ?? '';
      if (delta) {
        this.text += delta;
        events.push({ type: 'text_delta', delta });
      }
    } else if (type.includes('reasoning_summary') && type.endsWith('.delta')) {
      const delta = stringValue(getPath(payload, ['delta'])) ?? '';
      if (delta) {
        this.reasoningSummary += delta;
        events.push({ type: 'reasoning_summary_delta', delta });
      }
    } else if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      this.mergeResponsesToolItem(getPath(payload, ['item']));
    } else if (type === 'response.function_call_arguments.delta') {
      const key = stringValue(getPath(payload, ['item_id']))
        ?? String(numberValue(getPath(payload, ['output_index'])));
      const current = this.toolCalls.get(key) ?? { callId: key, name: '', arguments: '' };
      current.arguments += stringValue(getPath(payload, ['delta'])) ?? '';
      this.toolCalls.set(key, current);
    } else if (type === 'response.completed' || type === 'response.incomplete') {
      const responsePayload = getPath(payload, ['response']);
      this.finalResponse = parseAgentProviderResponse(this.request, responsePayload);
    }
    return events;
  }

  private mergeResponsesToolItem(value: unknown): void {
    const record = asRecord(value);
    if (!record || record.type !== 'function_call') return;
    const key = stringValue(record.id) ?? stringValue(record.call_id) ?? '';
    if (!key) throw new AgentModelProtocolError('Provider streamed a tool call without an item id.');
    const current = this.toolCalls.get(key) ?? { callId: key, name: '', arguments: '' };
    current.callId = stringValue(record.call_id) ?? current.callId;
    current.name = stringValue(record.name) ?? current.name;
    current.namespace = stringValue(record.namespace) ?? current.namespace;
    const args = stringValue(record.arguments);
    if (args !== undefined) current.arguments = args;
    this.toolCalls.set(key, current);
  }

  private consumeChat(payload: unknown): AgentModelStreamEvent[] {
    const events: AgentModelStreamEvent[] = [];
    this.responseId = stringValue(getPath(payload, ['id'])) ?? this.responseId;
    const delta = stringValue(getPath(payload, ['choices', 0, 'delta', 'content'])) ?? '';
    if (delta) {
      this.text += delta;
      events.push({ type: 'text_delta', delta });
    }
    const rawCalls = getPath(payload, ['choices', 0, 'delta', 'tool_calls']);
    if (Array.isArray(rawCalls)) {
      for (const rawCall of rawCalls) {
        const key = String(numberValue(getPath(rawCall, ['index'])));
        const current = this.toolCalls.get(key) ?? { callId: key, name: '', arguments: '' };
        current.callId = stringValue(getPath(rawCall, ['id'])) ?? current.callId;
        current.name += stringValue(getPath(rawCall, ['function', 'name'])) ?? '';
        current.arguments += stringValue(getPath(rawCall, ['function', 'arguments'])) ?? '';
        this.toolCalls.set(key, current);
      }
    }
    this.finish = stringValue(getPath(payload, ['choices', 0, 'finish_reason'])) ?? this.finish;
    const usage = getPath(payload, ['usage']);
    if (usage) this.usage = usageFromPayload('openai-chat-completions', payload);
    return events;
  }

  private consumeAnthropic(payload: unknown): AgentModelStreamEvent[] {
    const events: AgentModelStreamEvent[] = [];
    const type = stringValue(getPath(payload, ['type'])) ?? '';
    this.responseId = stringValue(getPath(payload, ['message', 'id'])) ?? this.responseId;
    const index = String(numberValue(getPath(payload, ['index'])));
    if (type === 'content_block_start') {
      const block = asRecord(getPath(payload, ['content_block']));
      if (block?.type === 'tool_use') {
        this.toolCalls.set(index, {
          callId: stringValue(block.id) ?? index,
          name: stringValue(block.name) ?? '',
          arguments: block.input ? jsonString(block.input) : '',
        });
      }
    } else if (type === 'content_block_delta') {
      const deltaType = stringValue(getPath(payload, ['delta', 'type'])) ?? '';
      const delta = stringValue(getPath(payload, ['delta', 'text']))
        ?? stringValue(getPath(payload, ['delta', 'partial_json']))
        ?? '';
      if (deltaType === 'text_delta' && delta) {
        this.text += delta;
        events.push({ type: 'text_delta', delta });
      } else if (deltaType === 'input_json_delta' && delta) {
        const current = this.toolCalls.get(index) ?? { callId: index, name: '', arguments: '' };
        current.arguments += delta;
        this.toolCalls.set(index, current);
      }
    } else if (type === 'message_delta') {
      this.finish = stringValue(getPath(payload, ['delta', 'stop_reason'])) ?? this.finish;
      const outputTokens = numberValue(getPath(payload, ['usage', 'output_tokens']));
      this.usage = {
        ...this.usage,
        outputTokens,
        totalTokens: this.usage.inputTokens + outputTokens,
      };
    } else if (type === 'message_start') {
      this.usage = usageFromPayload('anthropic-messages', getPath(payload, ['message']));
    }
    return events;
  }

  private consumeGemini(payload: unknown): AgentModelStreamEvent[] {
    const parsed = parseGeminiOutput(payload, this.request.tools);
    const events: AgentModelStreamEvent[] = [];
    if (parsed.text) {
      this.text += parsed.text;
      events.push({ type: 'text_delta', delta: parsed.text });
    }
    for (const call of parsed.toolCalls) {
      this.toolCalls.set(call.callId, {
        callId: call.callId,
        name: wireToolName(call),
        arguments: call.arguments,
      });
    }
    this.finish = finishReason('google-gemini', payload) ?? this.finish;
    this.usage = usageFromPayload('google-gemini', payload);
    return events;
  }
}
