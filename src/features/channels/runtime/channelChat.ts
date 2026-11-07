import { getPath } from '../domain/response';
import { channelChatInput, previewChannel, resolveNativeChannelModel, streamChannelChat, submitChannelChat } from '../application/channelService';
import { ChannelChatTransportError } from './transport';
import type { CustomProviderRequestDebugPreview } from './providerTypes';
import { ChannelRequestFailure, normalizeChannelError, redactChannelErrorText } from '../domain/errors';
import { getChannelCredential } from '../store/channelStore';
import { adaptChannelChatPayload } from './channelChatPayload';

export interface CustomChatCompletionResult {
  text: string; status?: number; raw: unknown; finishReason?: string | null;
  requestDebug?: CustomProviderRequestDebugPreview | null; usage?: unknown;
}
export interface CustomChatCompletionStreamResult {
  text: string; status?: number; finishReason?: string | null; requestDebug?: CustomProviderRequestDebugPreview | null;
  rawStreamTail?: string | null; streamDiagnostics?: CustomChatCompletionStreamDiagnostics; usage?: unknown;
}
export interface CustomChatCompletionStreamOptions {
  onTextDelta?: (delta: string, fullText: string) => void;
  onRawChunk?: (chunk: string) => void;
}
export interface CustomChatCompletionStreamDiagnostics {
  chunkCount: number; dataLineCount: number; parsedDataLineCount: number; parseFailureCount: number; deltaCount: number;
  doneMarkerSeen: boolean; completionEventSeen: boolean; bridgeDoneSeen: boolean;
  bridgeErrorMessage: string | null; bridgeErrorStatus: number | null; lastEventType: string | null;
  lastDataLinePreview: string | null; remainingBufferCharacters: number; elapsedMs: number;
  eventRawCharacters?: number; eventTextCharacters?: number; bridgeReturnedCharacters?: number;
  bridgeReturnedByteLength?: number; bridgeReturnedChunkCount?: number; replayTextCharacters?: number;
  replayDataLineCount?: number; replayParsedDataLineCount?: number; replayDeltaCount?: number;
  replayParseFailureCount?: number; replayDoneMarkerSeen?: boolean; bridgeReplayUsed?: boolean;
  finalTextSource?: 'event-stream' | 'bridge-response'; usage?: unknown;
}
export class CustomChatCompletionStreamError extends Error {
  status?: number; requestDebug?: CustomProviderRequestDebugPreview | null; rawStreamTail?: string | null;
  streamDiagnostics?: CustomChatCompletionStreamDiagnostics;
  upstreamMessage?: string;
  constructor(message: string, details: {
    status?: number; requestDebug?: CustomProviderRequestDebugPreview | null; rawStreamTail?: string | null;
    streamDiagnostics?: CustomChatCompletionStreamDiagnostics;
    upstreamMessage?: string;
  }) { super(message); this.name = 'CustomChatCompletionStreamError'; Object.assign(this, details); }
}
function resolveChat(catalogModelId: string) {
  const channel = resolveNativeChannelModel(catalogModelId);
  if (!channel || !(channel.model.modes ? channel.model.modes.some((mode) => mode.operation === 'chat') : channel.model.operations.includes('chat'))) throw new Error('未找到可用的 v2 文本渠道配置；请在渠道设置中完成迁移');
  return channel;
}
export function buildCustomChatCompletionRequestDebugPreview(catalogModelId: string, openAiPayload: unknown, stream = false): CustomProviderRequestDebugPreview {
  const { profile, model } = resolveChat(catalogModelId);
  const payload = { ...adaptChannelChatPayload(profile, openAiPayload, model.id), stream };
  const preview = previewChannel(profile, channelChatInput(profile, model.id, payload));
  return { providerLabel: profile.name, providerId: profile.id, modelId: catalogModelId, modelName: model.id,
    method: preview.method, bodyMode: preview.body.mode, url: preview.url, headers: preview.headers,
    body: preview.body.mode === 'json' ? preview.body.json : undefined };
}
function finishReason(raw: unknown): string | null {
  for (const path of ['choices[0].finish_reason', 'stop_reason', 'delta.stop_reason', 'candidates[0].finishReason', 'response.incomplete_details.reason']) {
    const value = getPath(raw, path); if (typeof value === 'string') return value;
  }
  return null;
}
export async function submitCustomChatCompletion(catalogModelId: string, openAiPayload: unknown): Promise<CustomChatCompletionResult> {
  const { profile, model } = resolveChat(catalogModelId);
  const payload = adaptChannelChatPayload(profile, openAiPayload, model.id);
  const requestDebug = buildCustomChatCompletionRequestDebugPreview(catalogModelId, openAiPayload);
  const response = await submitChannelChat(profile, model.id, payload);
  return { ...response, requestDebug, finishReason: finishReason(response.raw),
    usage: getPath(response.raw, 'usage') ?? getPath(response.raw, 'response.usage') ?? getPath(response.raw, 'usageMetadata') };
}
function streamText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(streamText).join('');
  if (value && typeof value === 'object') {
    if ('text' in value && value.text !== null && value.text !== undefined) return streamText(value.text);
    if ('content' in value) return streamText(value.content);
  }
  return '';
}
export async function streamCustomChatCompletion(catalogModelId: string, openAiPayload: unknown, options: CustomChatCompletionStreamOptions = {}): Promise<CustomChatCompletionStreamResult> {
  const { profile, model } = resolveChat(catalogModelId);
  const payload = adaptChannelChatPayload(profile, openAiPayload, model.id);
  const requestDebug = buildCustomChatCompletionRequestDebugPreview(catalogModelId, openAiPayload, true);
  const started = Date.now(); let text = ''; let tail = ''; let buffer = ''; let reason: string | null = null; let responseUsage: unknown;
  let streamStatus: number | undefined;
  const key = getChannelCredential(profile.id);
  const diagnostics: CustomChatCompletionStreamDiagnostics = { chunkCount: 0, dataLineCount: 0, parsedDataLineCount: 0, parseFailureCount: 0,
    deltaCount: 0, doneMarkerSeen: false, completionEventSeen: false, bridgeDoneSeen: false, bridgeErrorMessage: null,
    bridgeErrorStatus: null, lastEventType: null, lastDataLinePreview: null, remainingBufferCharacters: 0, elapsedMs: 0 };
  const consume = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(':') || trimmed.startsWith('id:')) return;
    if (trimmed.startsWith('event:')) { diagnostics.lastEventType = trimmed.slice(6).trim(); return; }
    const data = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
    diagnostics.dataLineCount += 1; diagnostics.lastDataLinePreview = redactChannelErrorText(data.slice(-500), key);
    if (data === '[DONE]') { diagnostics.doneMarkerSeen = true; return; }
    let raw: unknown;
    try { raw = JSON.parse(data); } catch { diagnostics.parseFailureCount += 1; throw new Error('渠道返回了无效的流式 JSON；不会自动重新提交'); }
    diagnostics.parsedDataLineCount += 1;
    const event = getPath(raw, 'type');
    if (typeof event === 'string') diagnostics.lastEventType = event;
    if (['response.completed', 'message_stop', 'done', 'completed'].includes(String(event))) diagnostics.completionEventSeen = true;
    if (event === 'error' || event === 'response.failed' || getPath(raw, 'error')) throw new ChannelRequestFailure(normalizeChannelError(streamStatus, data), key);
    reason = finishReason(raw) ?? reason;
    responseUsage = getPath(raw, 'usage') ?? getPath(raw, 'response.usage') ?? getPath(raw, 'usageMetadata') ?? responseUsage;
    const delta = streamText(getPath(raw, 'choices[0].delta.content') ?? getPath(raw, 'delta.text')
      ?? (event === 'response.output_text.delta' ? getPath(raw, 'delta') : undefined)
      ?? getPath(raw, 'candidates[0].content.parts') ?? getPath(raw, 'choices[0].message.content'));
    if (delta) { text += delta; diagnostics.deltaCount += 1; options.onTextDelta?.(delta, text); }
  };
  try {
    for await (const chunk of streamChannelChat(profile, model.id, payload, undefined, (status) => { streamStatus = status; })) {
      options.onRawChunk?.(chunk); diagnostics.chunkCount += 1; tail = `${tail}${chunk}`.slice(-8000);
      buffer += chunk;
      const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? '';
      for (const line of lines) consume(line);
    }
    if (buffer.trim()) consume(buffer);
    buffer = ''; diagnostics.bridgeDoneSeen = true;
    if (!text.trim()) throw new Error('流式响应中未找到文本内容；不会自动重新提交');
    diagnostics.elapsedMs = Date.now() - started; diagnostics.usage = responseUsage;
    return { text, finishReason: reason, requestDebug, rawStreamTail: tail || null, streamDiagnostics: diagnostics, usage: responseUsage };
  } catch (error) {
    diagnostics.elapsedMs = Date.now() - started; diagnostics.remainingBufferCharacters = buffer.length;
    diagnostics.bridgeErrorMessage = redactChannelErrorText(error instanceof Error ? error.message : String(error), key);
    diagnostics.bridgeErrorStatus = error instanceof ChannelChatTransportError || error instanceof ChannelRequestFailure ? error.status ?? null : streamStatus ?? null;
    throw new CustomChatCompletionStreamError(diagnostics.bridgeErrorMessage, { status: diagnostics.bridgeErrorStatus ?? undefined,
      upstreamMessage: error instanceof ChannelChatTransportError || error instanceof ChannelRequestFailure ? error.upstreamMessage : undefined,
      requestDebug, rawStreamTail: tail ? redactChannelErrorText(tail, key) : null, streamDiagnostics: diagnostics });
  }
}
