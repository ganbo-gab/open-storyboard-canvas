import { customHttpRequest, customHttpStreamRequest } from '@/commands/ai';
import {
  buildChatRequestHeaders,
  resolveChatEndpointUrl,
  resolveChatRequestTimeoutMs,
  resolveProviderAndModel,
} from '@/features/canvas/infrastructure/customProviderGateway';
import { isChatCustomProvider } from '@/stores/customProvidersStore';
import { useSettingsStore } from '@/stores/settingsStore';

import {
  AgentModelProtocolError,
  AgentProviderStreamAccumulator,
  parseAgentProviderResponse,
} from '../application/agentProviderCodec';
import { buildAgentProviderBody } from '../application/agentProviderRequestCodec';
import type {
  AgentModelReference,
  AgentModelStreamEvent,
  AgentModelTransport,
  AgentModelTurnRequest,
  AgentModelTurnResponse,
  AgentProviderHttpClient,
  AgentProviderHttpRequest,
  AgentProviderHttpResponse,
} from '../domain/agentModel';

type JsonRecord = Record<string, unknown>;

const RETRYABLE_MODEL_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

function sanitizeGatewayErrorMessage(value: string): string {
  return value
    .replace(/data:[^;\s,]+(?:;[^,\s]+)*;base64,[A-Za-z0-9+/_=-]+/gi, '[inline data omitted]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/((?:api[-_]?key|authorization|token|secret|cookie)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/([?&](?:api[_-]?key|authorization|token|secret|signature|sig)=)[^&#\s]+/gi, '$1[redacted]')
    .replace(/\b[A-Za-z0-9+/_-]{160,}={0,2}\b/g, '[long payload omitted]')
    .slice(0, 2_000);
}

function providerErrorDetail(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const visit = (value: unknown, depth = 0): string | null => {
      if (depth > 4) return null;
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const record = value as Record<string, unknown>;
      for (const key of ['message', 'code', 'type', 'error', 'detail']) {
        const found = visit(record[key], depth + 1);
        if (found) return found;
      }
      return null;
    };
    return visit(parsed);
  } catch {
    return trimmed;
  }
}

function providerHttpError(
  response: AgentProviderHttpResponse,
  responseStarted = false,
): AgentModelGatewayError {
  const detail = providerErrorDetail(response.text);
  const message = detail
    ? `${sanitizeGatewayErrorMessage(detail)} (HTTP ${response.status})`
    : `Provider model request failed with HTTP ${response.status}.`;
  return new AgentModelGatewayError(
    message,
    response.status,
    RETRYABLE_MODEL_STATUS_CODES.has(response.status),
    responseStarted,
  );
}

export class AgentModelGatewayError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
    readonly responseStarted = false,
  ) {
    super(message);
    this.name = 'AgentModelGatewayError';
  }
}

export interface AgentProviderConnection {
  providerId: string;
  modelId: string;
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
  defaultRequestParams: JsonRecord;
}

export type AgentProviderConnectionResolver = (
  model: AgentModelReference,
) => AgentProviderConnection;

export interface AgentModelGatewayOptions {
  httpClient?: AgentProviderHttpClient;
  resolveConnection?: AgentProviderConnectionResolver;
}

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function abortError(): DOMException {
  return new DOMException('The model request was aborted.', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function defaultConnectionResolver(model: AgentModelReference): AgentProviderConnection {
  const resolved = resolveProviderAndModel(model.catalogId);
  if (!resolved) throw new AgentModelGatewayError('未找到画布 Agent 使用的文本模型配置。');
  if (!isChatCustomProvider(resolved.cfg)) {
    throw new AgentModelGatewayError('画布 Agent 只能使用文本模型配置。');
  }
  const defaultRequestParams = asRecord(resolved.cfg.extraParams?.defaultRequestParams) ?? {};
  return {
    providerId: resolved.cfg.id,
    modelId: resolved.model,
    url: resolveChatEndpointUrl(resolved.cfg, resolved.model),
    headers: buildChatRequestHeaders(resolved.cfg, 'POST'),
    timeoutMs: resolveChatRequestTimeoutMs(resolved.cfg),
    defaultRequestParams,
  };
}

class AsyncChunkQueue {
  private readonly values: string[] = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<string>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private ended = false;
  private failure: unknown = null;

  push(value: string): void {
    if (this.ended || this.failure || !value) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.values.push(value);
  }

  end(): void {
    if (this.ended || this.failure) return;
    this.ended = true;
    this.flushWaiters();
  }

  fail(error: unknown): void {
    if (this.ended || this.failure) return;
    this.failure = error;
    this.flushWaiters();
  }

  next(): Promise<IteratorResult<string>> {
    if (this.values.length) {
      return Promise.resolve({ value: this.values.shift() ?? '', done: false });
    }
    if (this.failure) return Promise.reject(this.failure);
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  private flushWaiters(): void {
    while (this.waiters.length) {
      const waiter = this.waiters.shift();
      if (!waiter) continue;
      if (this.failure) waiter.reject(this.failure);
      else waiter.resolve({ value: undefined, done: true });
    }
  }
}

export class TauriAgentProviderHttpClient implements AgentProviderHttpClient {
  async request(
    request: AgentProviderHttpRequest,
    signal?: AbortSignal,
  ): Promise<AgentProviderHttpResponse> {
    throwIfAborted(signal);
    const network = useSettingsStore.getState().generationNetworkSettings;
    const pending = customHttpRequest({
      url: request.url,
      method: 'POST',
      headers: request.headers,
      bodyMode: 'json',
      body: request.body,
      timeoutMs: request.timeoutMs,
      networkRoute: network.route,
      customProxyUrl: network.route === 'custom-proxy' ? network.customProxyUrl : undefined,
    });
    if (!signal) return pending;
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(abortError());
      signal.addEventListener('abort', onAbort, { once: true });
      pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  }

  async *stream(
    request: AgentProviderHttpRequest,
    signal?: AbortSignal,
  ): AsyncIterable<string> {
    // Tauri's native command has no cancellation handle yet. Abort stops
    // delivery to the Agent and marks the model turn aborted, while the
    // already-submitted native request may continue upstream. We never claim
    // that an external generation side effect was cancelled from this path.
    throwIfAborted(signal);
    const network = useSettingsStore.getState().generationNetworkSettings;
    const queue = new AsyncChunkQueue();
    let status: number | undefined;
    let emittedChunks = 0;
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      queue.fail(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    void customHttpStreamRequest({
      url: request.url,
      method: 'POST',
      headers: { ...request.headers, Accept: 'text/event-stream' },
      bodyMode: 'json',
      body: request.body,
      timeoutMs: request.timeoutMs,
      networkRoute: network.route,
      customProxyUrl: network.route === 'custom-proxy' ? network.customProxyUrl : undefined,
    }, {
      onStatus: (nextStatus) => {
        status = nextStatus;
      },
      onChunk: (chunk, nextStatus) => {
        if (aborted) return;
        status = typeof nextStatus === 'number' ? nextStatus : status;
        if (typeof status === 'number' && (status < 200 || status >= 300)) return;
        emittedChunks += 1;
        queue.push(chunk);
      },
      onError: (message, nextStatus) => {
        if (aborted) return;
        status = typeof nextStatus === 'number' ? nextStatus : status;
        queue.fail(new AgentModelGatewayError(
          sanitizeGatewayErrorMessage(message || 'Provider model stream failed.'),
          status,
          status !== undefined && RETRYABLE_MODEL_STATUS_CODES.has(status),
          emittedChunks > 0,
        ));
      },
    }).then((response) => {
      if (aborted) return;
      status = response.status;
      if (response.status < 200 || response.status >= 300) {
        queue.fail(providerHttpError(response, emittedChunks > 0));
        return;
      }
      if (emittedChunks === 0 && response.text) queue.push(response.text);
      queue.end();
    }).catch((error: unknown) => {
      if (!aborted) {
        queue.fail(error instanceof AgentModelGatewayError
          ? error
          : new AgentModelGatewayError(
            sanitizeGatewayErrorMessage(
              error instanceof Error ? error.message : 'Provider model stream failed.',
            ),
            status,
            false,
            emittedChunks > 0,
          ));
      }
    });

    try {
      while (true) {
        const result = await queue.next();
        if (result.done) break;
        yield result.value;
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

interface DecodedStreamChunk {
  payloads: unknown[];
  done: boolean;
}

class ProviderEventDecoder {
  private buffer = '';

  push(chunk: string): DecodedStreamChunk {
    this.buffer += chunk;
    const payloads: unknown[] = [];
    let done = false;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      const result = this.decodeLine(line);
      payloads.push(...result.payloads);
      done = done || result.done;
    }
    return { payloads, done };
  }

  finish(): DecodedStreamChunk {
    const line = this.buffer.trim();
    this.buffer = '';
    return line ? this.decodeLine(line) : { payloads: [], done: false };
  }

  private decodeLine(line: string): DecodedStreamChunk {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(':') || trimmed.startsWith('event:') || trimmed.startsWith('id:')) {
      return { payloads: [], done: false };
    }
    const data = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
    if (data === '[DONE]') return { payloads: [], done: true };
    try {
      return { payloads: [JSON.parse(data) as unknown], done: false };
    } catch {
      throw new AgentModelProtocolError('Provider returned a malformed JSON stream event.');
    }
  }
}

function validateRequestCapabilities(request: AgentModelTurnRequest): void {
  if (!request.model.usable) {
    throw new AgentModelGatewayError(request.model.notReadyReason || '所选模型不能用于画布 Agent。');
  }
  if (request.tools.length > 0 && !request.model.capabilities.tools) {
    throw new AgentModelGatewayError('所选模型不支持工具调用，不能执行画布 Agent 任务。');
  }
  const hasImage = request.input.some((item) => (
    item.type === 'message' && item.content.some((part) => part.type === 'image')
  ));
  if (hasImage && !request.model.capabilities.vision) {
    throw new AgentModelGatewayError('所选模型不支持图片输入，请更换多模态文本模型。');
  }
}

function parseJsonResponse(response: AgentProviderHttpResponse): unknown {
  if (response.status < 200 || response.status >= 300) {
    throw providerHttpError(response);
  }
  try {
    return JSON.parse(response.text) as unknown;
  } catch {
    throw new AgentModelProtocolError('Provider returned a non-JSON model response.');
  }
}

function hasAgentResponsePayload(response: AgentModelTurnResponse): boolean {
  return Boolean(
    response.text?.trim()
    || response.reasoningSummary?.trim()
    || response.toolCalls.length,
  );
}

function markStreamFallback(response: AgentModelTurnResponse): AgentModelTurnResponse {
  return {
    ...response,
    providerSummary: {
      ...(response.providerSummary ?? {}),
      transportFallback: 'non-stream',
    },
  };
}

export function createAgentModelTransport(
  options: AgentModelGatewayOptions = {},
): AgentModelTransport {
  const httpClient = options.httpClient ?? new TauriAgentProviderHttpClient();
  const resolveConnection = options.resolveConnection ?? defaultConnectionResolver;

  const buildRequest = (
    request: AgentModelTurnRequest,
    stream: boolean,
  ): AgentProviderHttpRequest => {
    validateRequestCapabilities(request);
    const connection = resolveConnection(request.model);
    const body = {
      ...connection.defaultRequestParams,
      ...buildAgentProviderBody({
        ...request,
        model: { ...request.model, modelId: connection.modelId },
      }, stream),
    };
    return {
      url: connection.url,
      headers: connection.headers,
      body,
      timeoutMs: connection.timeoutMs,
    };
  };

  return {
    async getResponse(
      request: AgentModelTurnRequest,
      signal?: AbortSignal,
    ): Promise<AgentModelTurnResponse> {
      throwIfAborted(signal);
      let response: AgentProviderHttpResponse;
      try {
        response = await httpClient.request(buildRequest(request, false), signal);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        if (error instanceof AgentModelGatewayError) throw error;
        throw new AgentModelGatewayError(sanitizeGatewayErrorMessage(
          error instanceof Error ? error.message : 'Provider model request failed.',
        ));
      }
      throwIfAborted(signal);
      return parseAgentProviderResponse(request, parseJsonResponse(response));
    },

    async *getStreamedResponse(
      request: AgentModelTurnRequest,
      signal?: AbortSignal,
    ): AsyncIterable<AgentModelStreamEvent> {
      throwIfAborted(signal);
      if (!request.model.capabilities.stream) {
        const response = await this.getResponse(request, signal);
        if (response.text) yield { type: 'text_delta', delta: response.text };
        if (response.reasoningSummary) {
          yield { type: 'reasoning_summary_delta', delta: response.reasoningSummary };
        }
        yield { type: 'completed', response };
        return;
      }

      const accumulator = new AgentProviderStreamAccumulator(request);
      const decoder = new ProviderEventDecoder();
      let done = false;
      let emittedVisibleDelta = false;
      try {
        for await (const chunk of httpClient.stream(buildRequest(request, true), signal)) {
          throwIfAborted(signal);
          const decoded = decoder.push(chunk);
          for (const payload of decoded.payloads) {
            for (const event of accumulator.consume(payload)) {
              if (event.type !== 'completed') emittedVisibleDelta = true;
              yield event;
            }
          }
          done = done || decoded.done;
          if (done) break;
        }
        const remaining = decoder.finish();
        for (const payload of remaining.payloads) {
          for (const event of accumulator.consume(payload)) {
            if (event.type !== 'completed') emittedVisibleDelta = true;
            yield event;
          }
        }
        throwIfAborted(signal);
        const response = accumulator.complete();
        if (!emittedVisibleDelta && !hasAgentResponsePayload(response)) {
          const fallback = markStreamFallback(await this.getResponse(request, signal));
          if (fallback.text) yield { type: 'text_delta', delta: fallback.text };
          if (fallback.reasoningSummary) {
            yield { type: 'reasoning_summary_delta', delta: fallback.reasoningSummary };
          }
          yield { type: 'completed', response: fallback };
          return;
        }
        yield { type: 'completed', response };
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        if (
          emittedVisibleDelta
          || !(error instanceof AgentModelGatewayError)
          || error.responseStarted
        ) throw error;
        const fallback = markStreamFallback(await this.getResponse(request, signal));
        if (fallback.text) yield { type: 'text_delta', delta: fallback.text };
        if (fallback.reasoningSummary) {
          yield { type: 'reasoning_summary_delta', delta: fallback.reasoningSummary };
        }
        yield { type: 'completed', response: fallback };
      }
    },
  };
}
