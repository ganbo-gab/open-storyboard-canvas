import type { ChannelProfileV2, OperationSpec } from '../domain/profile';
import { normalizeChannelError, classifyTransportError } from '../domain/errors';
import { classifyAsyncStatus, extractChatText, extractError, extractOutputs, getPathValues } from '../domain/response';
import { renderPreview, renderRequest, resolveJobOperation, TemplateValidationError, type HttpRequest, type ResolveRef } from '../domain/template';
import type { ChannelAdapter, ChannelError, JobInput, PollResult, RequestPreview, SubmitResult } from './types';
import { captureSubmitSnapshot } from './submitSnapshot';
import { grsaiPollResult } from './grsaiPollResponse';

export interface HttpResponse { status: number; headers: Record<string, string>; bodyText?: string; bodyBytes?: Uint8Array | number[] }
export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>;
export interface TemplateAdapterOptions {
  profile: ChannelProfileV2; apiKey: string | (() => string); http: HttpTransport; resolveRef: ResolveRef;
  /** Restore a submitted response for dynamic polling after an application restart. Never persist secrets or reference bytes. */
  getSubmitResponse?: (job: JobInput, taskId: string) => unknown;
  /** Called before polling starts. Persistence errors must not trigger a second submit. */
  onSubmitted?: (job: JobInput, taskId: string, snapshot: Record<string, unknown>) => Promise<void>;
  /** Ephemeral actual chat response for the existing Agent codec; never persisted as recovery data. */
  onChatResponse?: (payload: unknown, response: HttpResponse) => void;
}
function parseResponse(response: HttpResponse): { payload: unknown; text: string } {
  const text = response.bodyText ?? (response.bodyBytes ? new TextDecoder().decode(new Uint8Array(response.bodyBytes)) : '');
  try { return { payload: JSON.parse(text), text }; } catch { return { payload: undefined, text }; }
}
function validationError(error: unknown): ChannelError {
  const classified = classifyTransportError(error);
  if (classified.error.category === 'credential') return classified.error;
  return { category: 'validation', message: error instanceof Error ? error.message : '请求配置无效', retryable: false };
}

/** Stateless HTTP attempts: scheduling, retries and poll deadlines belong to the executor. */
export class TemplateAdapter implements ChannelAdapter {
  private readonly submitted = new Map<string, unknown>();
  constructor(private readonly options: TemplateAdapterOptions) {}
  preview(job: JobInput): RequestPreview {
    return renderPreview(this.options.profile, job);
  }
  async submit(job: JobInput, signal?: AbortSignal): Promise<SubmitResult> {
    let request: HttpRequest;
    try { request = (await renderRequest(this.options.profile, job, typeof this.options.apiKey === 'function' ? this.options.apiKey() : this.options.apiKey, this.options.resolveRef)).request; }
    catch (error) { return { state: 'failed', error: validationError(error) }; }
    request.signal = signal;
    let response: HttpResponse;
    try { response = await this.options.http(request); }
    catch (error) {
      const classified = classifyTransportError(error);
      return { state: classified.beforeSend ? 'failed' : 'unknown', error: classified.error };
    }
    const op = resolveJobOperation(this.options.profile, job);
    const { payload, text } = parseResponse(response);
    if (response.status < 200 || response.status >= 300) return { state: 'failed', error: normalizeChannelError(response.status, text || extractError(payload, op.errorPath), request.url) };
    if (op.response.mode === 'async') {
      const id = getPathValues(payload, op.response.taskIdPath)[0];
      if ((typeof id !== 'string' && typeof id !== 'number') || String(id).trim() === '') return { state: 'unknown', error: { category: 'upstream', message: '上游已响应但未返回任务 ID，请先核对渠道任务记录', upstreamMessage: extractError(payload, op.errorPath) ?? text, retryable: false } };
      // Record the handle even when a dynamic field cannot safely be retained.
      // The executor then exposes an actionable recovery error, never a replay.
      let snapshot: Record<string, unknown>;
      try { snapshot = captureSubmitSnapshot(this.options.profile, job.operation, payload, typeof this.options.apiKey === 'function' ? this.options.apiKey() : this.options.apiKey, op); }
      catch (error) {
        await this.options.onSubmitted?.(job, String(id), {});
        return { state: 'unknown', error: validationError(error) };
      }
      this.submitted.set(`${job.jobId}:${String(id)}`, snapshot);
      await this.options.onSubmitted?.(job, String(id), snapshot);
      return { state: 'submitted', taskId: String(id) };
    }
    try {
      if (job.operation === 'chat') this.options.onChatResponse?.(payload, response);
      const chatText = job.operation === 'chat' ? extractChatText(payload) : undefined;
      const outputs = chatText ? [{ kind: 'text' as const, text: chatText }] : extractOutputs(payload, op.response.outputs, job.operation, { profile: this.options.profile, apiKey: typeof this.options.apiKey === 'function' ? this.options.apiKey() : this.options.apiKey, submit: payload });
      const hasToolCalls = job.operation === 'chat' && (getPathValues(payload, 'choices[*].message.tool_calls[*]').length > 0
        || getPathValues(payload, 'content[*]').some((item) => item && typeof item === 'object' && 'type' in item && item.type === 'tool_use')
        || getPathValues(payload, 'output[*]').some((item) => item && typeof item === 'object' && 'type' in item && item.type === 'function_call')
        || getPathValues(payload, 'candidates[*].content.parts[*].functionCall').length > 0);
      if (!outputs.length && !hasToolCalls) return { state: 'failed', error: normalizeChannelError(undefined, extractError(payload, op.errorPath) ?? '上游未返回可识别的结果') };
      return { state: 'done', outputs };
    } catch (error) { return { state: 'failed', error: validationError(error) }; }
  }
  async poll(job: JobInput, taskId: string, signal?: AbortSignal): Promise<PollResult> {
    let op: OperationSpec;
    try { op = resolveJobOperation(this.options.profile, job); }
    catch (error) { return { state: 'failed', error: validationError(error) }; }
    if (!op || op.response.mode !== 'async') return { state: 'failed', error: validationError(new Error('此操作不支持轮询')) };
    const submit = this.submitted.get(`${job.jobId}:${taskId}`) ?? this.options.getSubmitResponse?.(job, taskId);
    const apiKey = typeof this.options.apiKey === 'function' ? this.options.apiKey() : this.options.apiKey;
    let request: HttpRequest;
    try { request = (await renderRequest(this.options.profile, job, apiKey, this.options.resolveRef, taskId, submit)).request; }
    catch (error) { return { state: 'failed', error: validationError(error) }; }
    request.signal = signal;
    try {
      const response = await this.options.http(request);
      let { payload, text } = parseResponse(response);
      if (response.status < 200 || response.status >= 300) {
        const error = normalizeChannelError(response.status, text || extractError(payload, op.errorPath), request.url);
        return error.retryable ? { state: 'pending', message: error.message, diagnostic: error } : { state: 'failed', error };
      }
      const grsai = grsaiPollResult(this.options.profile, op.response, job.operation, payload);
      if (grsai) {
        if (grsai.state === 'done') this.submitted.delete(`${job.jobId}:${taskId}`);
        return grsai;
      }
      const classified = classifyAsyncStatus(payload, op.response, job.operation, op.errorPath);
      if (classified.state === 'failed') return { state: 'failed', error: normalizeChannelError(response.status, text || classified.message || '上游任务失败') };
      if (classified.state === 'pending') {
        const missingStatus = op.response.poll.statusPath && getPathValues(payload, op.response.poll.statusPath).length === 0;
        return { state: 'pending', ...(classified.progress === undefined ? {} : { progress: classified.progress }),
          ...(missingStatus ? { diagnostic: { category: 'validation' as const, message: `查询响应缺少配置的状态字段 ${op.response.poll.statusPath}；请核对响应格式，原任务编号已保留。`, retryable: true } } : {}) };
      }
      if (op.response.poll.resultRequest) {
        const resultRequest = (await renderRequest(this.options.profile, job, apiKey, this.options.resolveRef, taskId, submit, true, payload)).request;
        resultRequest.signal = signal;
        const resultResponse = await this.options.http(resultRequest);
        ({ payload, text } = parseResponse(resultResponse));
        if (resultResponse.status < 200 || resultResponse.status >= 300) {
          const error = normalizeChannelError(resultResponse.status, text || extractError(payload, op.errorPath), resultRequest.url);
          return error.retryable ? { state: 'pending', message: error.message, diagnostic: error } : { state: 'failed', error };
        }
      }
      const outputs = extractOutputs(payload, op.response.poll.outputs, job.operation, { profile: this.options.profile, apiKey, taskId, submit });
      if (!outputs.length) return { state: 'failed', error: { ...normalizeChannelError(undefined, extractError(payload, op.errorPath) ?? '任务已完成但未返回可识别的结果；保留原任务，可稍后取回'), retryable: true } };
      this.submitted.delete(`${job.jobId}:${taskId}`);
      return { state: 'done', outputs };
    } catch (error) {
      if (error instanceof TemplateValidationError) return { state: 'failed', error: { ...validationError(error), retryable: true } };
      const classified = classifyTransportError(error);
      if (classified.error.category === 'credential') return { state: 'failed', error: classified.error };
      return { state: 'pending', message: '查询暂时失败，可稍后重新查询；未重新提交任务',
        diagnostic: { ...classified.error, message: '查询连接暂时失败；原任务编号已保留，不会重新提交。', retryable: true } };
    }
  }
  async listModels(signal?: AbortSignal): Promise<{ ok: true; models: string[] } | { ok: false; error: ChannelError }> {
    const profile = this.options.profile;
    const job: JobInput = { jobId: 'models.list', channelId: profile.id, modelId: '', operation: 'models.list', prompt: '', params: {}, refs: [], count: 1 };
    let request: HttpRequest;
    try { request = (await renderRequest(profile, job, typeof this.options.apiKey === 'function' ? this.options.apiKey() : this.options.apiKey, this.options.resolveRef)).request; }
    catch (error) { return { ok: false, error: validationError(error) }; }
    request.signal = signal;
    try {
      const response = await this.options.http(request);
      const { payload, text } = parseResponse(response);
      if (response.status < 200 || response.status >= 300) return { ok: false, error: normalizeChannelError(response.status, text || extractError(payload, profile.operations['models.list']?.errorPath), request.url) };
      const entries = getPathValues(payload, 'data[*].id').concat(getPathValues(payload, 'models[*].name'));
      const models = [...new Set(entries.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0))];
      if (!models.length) return { ok: false, error: normalizeChannelError(undefined, '上游未返回可识别的模型列表') };
      return { ok: true, models };
    } catch (error) { return { ok: false, error: classifyTransportError(error).error }; }
  }
}
export function createTemplateAdapter(options: TemplateAdapterOptions): TemplateAdapter {
  return new TemplateAdapter(options);
}
