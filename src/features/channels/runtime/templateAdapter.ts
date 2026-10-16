import type { ChannelProfileV2 } from '../domain/profile';
import { normalizeChannelError, classifyTransportError } from '../domain/errors';
import { classifyAsyncStatus, extractChatText, extractError, extractOutputs, getPathValues } from '../domain/response';
import { renderPreview, renderRequest, TemplateValidationError, type HttpRequest, type ResolveRef } from '../domain/template';
import type { ChannelAdapter, ChannelError, JobInput, PollResult, RequestPreview, SubmitResult } from './types';

export interface HttpResponse { status: number; headers: Record<string, string>; bodyText?: string; bodyBytes?: Uint8Array | number[] }
export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>;
export interface TemplateAdapterOptions {
  profile: ChannelProfileV2; apiKey: string | (() => string); http: HttpTransport; resolveRef: ResolveRef;
  /** Restore a submitted response for dynamic polling after an application restart. Never persist secrets or reference bytes. */
  getSubmitResponse?: (job: JobInput, taskId: string) => unknown;
}
function parseResponse(response: HttpResponse): { payload: unknown; text: string } {
  const text = response.bodyText ?? (response.bodyBytes ? new TextDecoder().decode(new Uint8Array(response.bodyBytes)) : '');
  try { return { payload: JSON.parse(text), text }; } catch { return { payload: undefined, text }; }
}
function validationError(error: unknown): ChannelError {
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
    const op = this.options.profile.operations[job.operation]!;
    const { payload, text } = parseResponse(response);
    if (response.status < 200 || response.status >= 300) return { state: 'failed', error: normalizeChannelError(response.status, extractError(payload, op.errorPath) ?? text, request.url) };
    if (op.response.mode === 'async') {
      const id = getPathValues(payload, op.response.taskIdPath)[0];
      if ((typeof id !== 'string' && typeof id !== 'number') || String(id).trim() === '') return { state: 'unknown', error: { category: 'upstream', message: '上游已响应但未返回任务 ID，请先核对渠道任务记录', upstreamMessage: extractError(payload, op.errorPath) ?? text, retryable: false } };
      this.submitted.set(`${job.jobId}:${String(id)}`, payload);
      return { state: 'submitted', taskId: String(id) };
    }
    try {
      const chatText = job.operation === 'chat' ? extractChatText(payload) : undefined;
      const outputs = chatText ? [{ kind: 'text' as const, text: chatText }] : extractOutputs(payload, op.response.outputs, job.operation, { profile: this.options.profile, apiKey: typeof this.options.apiKey === 'function' ? this.options.apiKey() : this.options.apiKey, submit: payload });
      if (!outputs.length) return { state: 'failed', error: normalizeChannelError(undefined, extractError(payload, op.errorPath) ?? '上游未返回可识别的结果') };
      return { state: 'done', outputs };
    } catch (error) { return { state: 'failed', error: validationError(error) }; }
  }
  async poll(job: JobInput, taskId: string, signal?: AbortSignal): Promise<PollResult> {
    const op = this.options.profile.operations[job.operation];
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
        const error = normalizeChannelError(response.status, extractError(payload, op.errorPath) ?? text, request.url);
        return error.retryable ? { state: 'pending', message: error.message } : { state: 'failed', error };
      }
      const classified = classifyAsyncStatus(payload, op.response, job.operation, op.errorPath);
      if (classified.state === 'failed') return { state: 'failed', error: normalizeChannelError(undefined, classified.message ?? '上游任务失败') };
      if (classified.state === 'pending') return { state: 'pending', ...(classified.progress === undefined ? {} : { progress: classified.progress }) };
      if (op.response.poll.resultRequest) {
        const resultRequest = (await renderRequest(this.options.profile, job, apiKey, this.options.resolveRef, taskId, submit, true)).request;
        resultRequest.signal = signal;
        const resultResponse = await this.options.http(resultRequest);
        ({ payload, text } = parseResponse(resultResponse));
        if (resultResponse.status < 200 || resultResponse.status >= 300) {
          const error = normalizeChannelError(resultResponse.status, extractError(payload, op.errorPath) ?? text, resultRequest.url);
          return error.retryable ? { state: 'pending', message: error.message } : { state: 'failed', error };
        }
      }
      const outputs = extractOutputs(payload, op.response.poll.outputs, job.operation, { profile: this.options.profile, apiKey, taskId, submit });
      if (!outputs.length) return { state: 'failed', error: normalizeChannelError(undefined, extractError(payload, op.errorPath) ?? '任务已完成但未返回可识别的结果') };
      this.submitted.delete(`${job.jobId}:${taskId}`);
      return { state: 'done', outputs };
    } catch (error) {
      if (error instanceof TemplateValidationError) return { state: 'failed', error: validationError(error) };
      return { state: 'pending', message: '查询暂时失败，可稍后重新查询；未重新提交任务' };
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
      if (response.status < 200 || response.status >= 300) return { ok: false, error: normalizeChannelError(response.status, extractError(payload, profile.operations['models.list']?.errorPath) ?? text, request.url) };
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
