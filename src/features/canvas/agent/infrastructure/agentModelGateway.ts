import { assertCompleteAgentToolTranscript } from '../application/agentToolTranscript';
import { recordAgentContextRequest, recordAgentContextResponse } from '../application/agentContextUsage';
import { resolveNativeChannelModel, streamChannelChat, submitChannelChat } from '@/features/channels/application/channelService';
import { channelChatProtocol } from '@/features/channels/runtime/channelChatPayload';
import { ChannelChatTransportError } from '@/features/channels/runtime/transport';
import { ChannelRequestFailure } from '@/features/channels/domain/errors';
import { classifyCanvasAgentFailure } from '../application/agentFailurePolicy';
import { AgentModelProtocolError, AgentProviderStreamAccumulator, parseAgentProviderResponse } from '../application/agentProviderCodec';
import { buildAgentProviderBody } from '../application/agentProviderRequestCodec';
import type { AgentModelStreamEvent, AgentModelTransport, AgentModelTurnRequest, AgentModelTurnResponse } from '../domain/agentModel';

export class AgentModelGatewayError extends Error {
  constructor(message: string, readonly status?: number, readonly retryable = false, readonly responseStarted = false, readonly retryAfterMs?: number) {
    super(message); this.name = 'AgentModelGatewayError';
  }
}
function resolveRequest(request: AgentModelTurnRequest) {
  assertCompleteAgentToolTranscript(request.input);
  if (!request.model.usable) throw new AgentModelGatewayError(request.model.notReadyReason || '所选模型不能用于画布 Agent。');
  if (request.tools.length && !request.model.capabilities.tools) throw new AgentModelGatewayError('所选模型不支持工具调用，不能执行画布 Agent 任务。');
  if (!request.model.capabilities.vision && request.input.some((item) => item.type === 'message' && item.content.some((part) => part.type === 'image'))) {
    throw new AgentModelGatewayError('所选模型不支持图片输入，请更换多模态文本模型。');
  }
  const channel = resolveNativeChannelModel(request.model.catalogId);
  if (!channel || !(channel.model.modes ? channel.model.modes.some((mode) => mode.operation === 'chat') : channel.model.operations.includes('chat'))) {
    throw new AgentModelGatewayError('未找到画布 Agent 使用的 v2 文本渠道配置。');
  }
  const mode = channel.model.modes?.find((entry) => entry.operation === 'chat');
  if (channelChatProtocol(channel.profile, channel.model.id, mode?.id) !== request.model.capabilities.protocol) {
    throw new AgentModelGatewayError('模型协议与渠道模板不一致；请重新选择渠道模型。');
  }
  return channel;
}
interface DecodedStreamChunk { payloads: unknown[]; done: boolean }
class ProviderEventDecoder {
  private buffer = '';
  push(chunk: string): DecodedStreamChunk {
    this.buffer += chunk;
    const payloads: unknown[] = []; let done = false;
    const lines = this.buffer.split(/\r?\n/); this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      const decoded = this.decodeLine(line); payloads.push(...decoded.payloads); done ||= decoded.done;
    }
    return { payloads, done };
  }
  finish(): DecodedStreamChunk {
    const line = this.buffer; this.buffer = '';
    return this.decodeLine(line);
  }
  private decodeLine(line: string): DecodedStreamChunk {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(':') || trimmed.startsWith('event:') || trimmed.startsWith('id:')) return { payloads: [], done: false };
    const data = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
    if (data === '[DONE]') return { payloads: [], done: true };
    try { return { payloads: [JSON.parse(data) as unknown], done: false }; }
    catch { throw new AgentModelProtocolError('Provider returned a malformed JSON stream event.'); }
  }
}
function gatewayError(error: unknown, responseStarted: boolean): never {
  if (error instanceof DOMException && error.name === 'AbortError') throw error;
  if (error instanceof AgentModelGatewayError || error instanceof AgentModelProtocolError) throw error;
  const known = error instanceof ChannelChatTransportError || error instanceof ChannelRequestFailure;
  const status = known ? error.status : undefined;
  const started = responseStarted || (error instanceof ChannelChatTransportError && error.responseStarted);
  // Only an explicit failed HTTP response before output permits replay of this model request.
  // Tool execution is outside the request retry, and ambiguous transport failures stay stopped.
  const retryable = !started && status !== undefined && [429, 500, 502, 503, 504].includes(status)
    && classifyCanvasAgentFailure(error).kind !== 'provider-quota';
  throw new AgentModelGatewayError(error instanceof Error ? error.message : 'Channel model request failed.',
    status, retryable, started, error instanceof ChannelChatTransportError ? error.retryAfterMs : undefined);
}
export function createAgentModelTransport(): AgentModelTransport {
  return {
    async getResponse(request: AgentModelTurnRequest, signal?: AbortSignal): Promise<AgentModelTurnResponse> {
      signal?.throwIfAborted();
      const channel = resolveRequest(request);
      try {
        const body = buildAgentProviderBody({ ...request, model: { ...request.model, modelId: channel.model.id } }, false);
        const contextRequestId = recordAgentContextRequest(request, body);
        const response = await submitChannelChat(channel.profile, channel.model.id, body, signal);
        signal?.throwIfAborted();
        const parsed = parseAgentProviderResponse(request, response.raw);
        recordAgentContextResponse(request.model.contextSessionId, contextRequestId, parsed.usage);
        return parsed;
      } catch (error) { return gatewayError(error, false); }
    },
    async *getStreamedResponse(request: AgentModelTurnRequest, signal?: AbortSignal): AsyncIterable<AgentModelStreamEvent> {
      signal?.throwIfAborted();
      const channel = resolveRequest(request);
      if (!request.model.capabilities.stream) {
        const response = await this.getResponse(request, signal);
        if (response.text) yield { type: 'text_delta', delta: response.text };
        if (response.reasoningSummary) yield { type: 'reasoning_summary_delta', delta: response.reasoningSummary };
        yield { type: 'completed', response }; return;
      }
      const accumulator = new AgentProviderStreamAccumulator(request);
      const decoder = new ProviderEventDecoder(); let responseStarted = false;
      try {
        const body = buildAgentProviderBody({ ...request, model: { ...request.model, modelId: channel.model.id } }, true);
        const contextRequestId = recordAgentContextRequest(request, body);
        for await (const chunk of streamChannelChat(channel.profile, channel.model.id, body, signal)) {
          signal?.throwIfAborted(); responseStarted = true;
          const decoded = decoder.push(chunk);
          for (const payload of decoded.payloads) for (const event of accumulator.consume(payload)) yield event;
          if (decoded.done) break;
        }
        for (const payload of decoder.finish().payloads) for (const event of accumulator.consume(payload)) yield event;
        signal?.throwIfAborted();
        const response = accumulator.complete();
        if (!response.text?.trim() && !response.reasoningSummary?.trim() && !response.toolCalls.length) throw new AgentModelProtocolError('Channel stream contained no model response; it was not resubmitted.');
        recordAgentContextResponse(request.model.contextSessionId, contextRequestId, response.usage);
        yield { type: 'completed', response };
      } catch (error) { gatewayError(error, responseStarted); }
    },
  };
}
