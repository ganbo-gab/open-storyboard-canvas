import { providerContinuationSchema } from './agentProviderContinuation';
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
      cachedInputTokens: numberValue(getPath(payload, ['usage', 'prompt_cache_hit_tokens'])) || numberValue(getPath(payload, ['usage', 'prompt_tokens_details', 'cached_tokens'])) || undefined,
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
  try {
    parseToolArguments(call.arguments || '{}');
  } catch {
    throw new AgentModelProtocolError(`工具 ${call.name} 返回的参数不是有效的 JSON 对象，本次调用未执行。`);
  }
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
    if (record.type === 'message') {
      const content = Array.isArray(record.content) ? record.content : [];
      for (const part of content) {
        const record = asRecord(part);
        if (record?.type === 'output_text' && typeof record.text === 'string') textParts.push(record.text);
        else if (record?.type === 'refusal' && typeof record.refusal === 'string') textParts.push(record.refusal);
      }
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
          arguments: JSON.stringify(record.input === undefined ? {} : record.input),
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
      const text = typeof record.text === 'string' ? record.text : undefined;
      if (text && record?.thought !== true) textParts.push(text);
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
  const nativeContinuation = protocol === 'anthropic-messages' ? { kind: 'anthropic-content', items: getPath(payload, ['content']) }
    : protocol === 'google-gemini' ? { kind: 'gemini-parts', items: getPath(payload, ['candidates', 0, 'content', 'parts']) }
      : protocol === 'openai-responses' ? { kind: 'responses-output', items: getPath(payload, ['output']) } : undefined;
  const continuation = providerContinuationSchema.safeParse(nativeContinuation);
  const responseId = safeResponseId(
    getPath(payload, ['id'])
      ?? getPath(payload, ['response', 'id'])
      ?? getPath(payload, ['responseId']),
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
    ...(protocol === 'openai-chat-completions' && typeof getPath(payload, ['choices', 0, 'message', 'reasoning_content']) === 'string' ? { continuation: { kind: 'chat-reasoning' as const, reasoningContent: String(getPath(payload, ['choices', 0, 'message', 'reasoning_content'])) } } : {}),
    ...(continuation.success ? { continuation: continuation.data } : {}),
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
  hasInputJsonDelta?: boolean;
}

export class AgentProviderStreamAccumulator {
  private responseId = '';
  private requestId: string | undefined;
  private text = '';
  private reasoningSummary = '';
  private chatReasoning: string | undefined;
  private nativeBlocks: Record<string, unknown>[] = [];
  private nativeArguments = new Map<number, string>();
  private finish: string | undefined;
  private terminalEventReceived = false;
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
    if (this.finalResponse) {
      this.assertToolStreamComplete(this.finalResponse.toolCalls.length > 0);
      return this.finalResponse;
    }
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
    this.assertToolStreamComplete(toolCalls.length > 0);
    if (this.request.model.capabilities.protocol === 'anthropic-messages') {
      for (const [index, args] of this.nativeArguments) this.nativeBlocks[index].input = JSON.parse(args || '{}');
    }
    const native = providerContinuationSchema.safeParse({ kind: this.request.model.capabilities.protocol === 'anthropic-messages' ? 'anthropic-content' : 'gemini-parts', items: this.nativeBlocks });
    assertStructuredToolCalling(this.request, this.text, toolCalls);
    return {
      responseId: safeResponseId(this.responseId),
      requestId: this.requestId,
      text: this.text || undefined,
      reasoningSummary: this.reasoningSummary || undefined,
      ...(['anthropic-messages', 'google-gemini'].includes(this.request.model.capabilities.protocol) && native.success ? { continuation: native.data } : {}),
      ...(this.chatReasoning === undefined ? {} : { continuation: { kind: 'chat-reasoning' as const, reasoningContent: this.chatReasoning } }),
      toolCalls,
      finishReason: this.finish,
      usage: this.usage,
      providerSummary: {
        protocol: this.request.model.capabilities.protocol,
        finishReason: this.finish ?? null,
      },
    };
  }

  private assertToolStreamComplete(hasToolCalls: boolean): void {
    if (!hasToolCalls) return;
    const protocol = this.request.model.capabilities.protocol;
    const complete = protocol === 'openai-responses' ? this.terminalEventReceived
      : protocol === 'anthropic-messages' ? this.terminalEventReceived && (this.finish === 'tool_use' || this.finish === 'end_turn')
        : protocol === 'google-gemini' ? this.finish === 'STOP'
          : this.finish === 'tool_calls' || this.finish === 'stop';
    // Valid argument JSON can arrive before the message (including its private continuation) finishes.
    // EOF or a token-limit stop must never turn that partial message into an executable tool turn.
    if (!complete) throw new AgentModelProtocolError('模型的工具回复未完整结束，工具未执行。请检查连接后重新发送；不会自动重试。');
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
      { const fragment = getPath(payload, ['delta']); if (typeof fragment === 'string') current.arguments += fragment; }
      this.toolCalls.set(key, current);
    } else if (type === 'response.completed' || type === 'response.incomplete') {
      const responsePayload = getPath(payload, ['response']);
      this.finalResponse = parseAgentProviderResponse(this.request, responsePayload);
      this.terminalEventReceived = type === 'response.completed';
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
    const rawDelta = getPath(payload, ['choices', 0, 'delta', 'content']);
    const delta = typeof rawDelta === 'string' ? rawDelta : '';
    const reasoning = getPath(payload, ['choices', 0, 'delta', 'reasoning_content']);
    if (typeof reasoning === 'string') this.chatReasoning = (this.chatReasoning ?? '') + reasoning;
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
        { const fragment = getPath(rawCall, ['function', 'arguments']); if (typeof fragment === 'string') current.arguments += fragment; }
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
      if (block) this.nativeBlocks[Number(index)] = { ...block };
      if (block?.type === 'tool_use') {
        this.toolCalls.set(index, {
          callId: stringValue(block.id) ?? index,
          name: stringValue(block.name) ?? '',
          arguments: JSON.stringify(block.input === undefined ? {} : block.input),
          hasInputJsonDelta: false,
        });
      }
    } else if (type === 'content_block_delta') {
      const deltaType = stringValue(getPath(payload, ['delta', 'type'])) ?? '';
      const block = this.nativeBlocks[Number(index)];
      const field = deltaType === 'thinking_delta' ? 'thinking' : deltaType === 'signature_delta' ? 'signature' : deltaType === 'text_delta' ? 'text' : null;
      if (block && field) { const part = getPath(payload, ['delta', field]); if (typeof part === 'string') block[field] = String(block[field] ?? '') + part; }
      if (deltaType === 'input_json_delta') this.nativeArguments.set(Number(index), (this.nativeArguments.get(Number(index)) ?? '') + String(getPath(payload, ['delta', 'partial_json']) ?? ''));
      const fragment = getPath(payload, ['delta', deltaType === 'input_json_delta' ? 'partial_json' : 'text']);
      const delta = typeof fragment === 'string' ? fragment : '';
      if (deltaType === 'text_delta' && delta) {
        this.text += delta;
        events.push({ type: 'text_delta', delta });
      } else if (deltaType === 'input_json_delta' && delta) {
        const current = this.toolCalls.get(index) ?? { callId: index, name: '', arguments: '' };
        // Anthropic's start input is an empty placeholder; deltas contain the whole JSON value.
        // A compatible provider may send a complete input in the start event without deltas.
        if (!current.hasInputJsonDelta) current.arguments = '';
        current.arguments += delta;
        current.hasInputJsonDelta = true;
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
    } else if (type === 'message_stop') {
      this.terminalEventReceived = true;
    }
    return events;
  }

  private consumeGemini(payload: unknown): AgentModelStreamEvent[] {
    const rawParts = getPath(payload, ['candidates', 0, 'content', 'parts']);
    if (Array.isArray(rawParts)) for (const part of rawParts) { const record = asRecord(part); if (record) this.nativeBlocks.push(record); }
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
