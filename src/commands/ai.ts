import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export interface GenerateRequest {
  prompt: string;
  model: string;
  size: string;
  aspect_ratio: string;
  reference_images?: string[];
  reference_videos?: string[];
  reference_audios?: string[];
  extra_params?: Record<string, unknown>;
}

export type GenerationJobState =
  | 'queued'
  | 'submitting'
  | 'running'
  | 'recoverable_wait'
  | 'materializing'
  | 'succeeded'
  | 'failed'
  | 'not_found'
  | 'unknown'
  | 'canceled';

export type GenerationMediaType = 'image' | 'video' | 'audio' | 'unknown';
export type GenerationNetworkRoute = 'system' | 'direct' | 'custom-proxy';

export interface GenerationJobStatus {
  job_id: string;
  status: GenerationJobState;
  result?: string | null;
  error?: string | null;
  /** Non-fatal provider diagnostic, for example an upstream aspect-ratio mismatch. */
  warning?: string | null;
  media_type?: GenerationMediaType;
  provider_id?: string;
  model_id?: string | null;
  config_fingerprint?: string | null;
  phase?: string;
  external_task_id?: string | null;
  poll_descriptor?: Record<string, unknown> | null;
  result_url?: string | null;
  error_category?: string | null;
  network_route?: GenerationNetworkRoute;
  submit_attempts?: number;
  consecutive_network_errors?: number;
  last_poll_at?: number | null;
  resumable?: boolean;
  created_at?: number;
  updated_at?: number;
}

export interface CreateGenerationJobRequest {
  jobId?: string;
  mediaType: Exclude<GenerationMediaType, 'unknown'>;
  providerId: string;
  modelId?: string;
  configFingerprint?: string;
  status?: GenerationJobState;
  phase?: string;
  externalTaskId?: string;
  pollDescriptor?: Record<string, unknown>;
  resultUrl?: string;
  error?: string;
  errorCategory?: string;
  networkRoute?: GenerationNetworkRoute;
  resumable?: boolean;
}

export interface UpdateGenerationJobRequest {
  jobId: string;
  status?: GenerationJobState;
  phase?: string;
  externalTaskId?: string;
  pollDescriptor?: Record<string, unknown>;
  result?: string;
  resultUrl?: string;
  error?: string;
  errorCategory?: string;
  networkRoute?: GenerationNetworkRoute;
  resumable?: boolean;
  lastPollAt?: number;
  consecutiveNetworkErrors?: number;
}

function truncateText(value: string, max = 200): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}...(${value.length} chars)`;
}

function redactDiagnosticText(value: string): string {
  return value
    .replace(/data:[^;\s,]+(?:;[^,\s]+)*;base64,[A-Za-z0-9+/_=-]+/gi, '[data-url omitted]')
    .replace(/\b[A-Za-z0-9+/_-]{160,}={0,2}\b/g, '[base64 omitted]')
    .replace(/(Bearer\s+)[^\s,]+/gi, '$1[redacted]')
    .replace(/((?:api[-_]?key|authorization|token|secret|cookie)\s*[:=]\s*)["']?[^\s,"'}]+/gi, '$1[redacted]')
    .replace(/([?&](?:api[_-]?key|authorization|token|secret|signature|sig)=)[^&#\s]+/gi, '$1[redacted]');
}

function summarizeResultSourceForLog(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '[empty]';
  if (/^data:/i.test(trimmed)) return '[data-url omitted]';
  if (/^blob:/i.test(trimmed)) return '[blob-url omitted]';
  if (/^[A-Za-z0-9+/=]+$/.test(trimmed) && trimmed.length > 300) return '[base64 omitted]';
  if (/^https?:\/\//i.test(trimmed)) {
    return '[remote-url omitted]';
  }
  return '[local-source omitted]';
}

function sanitizeGenerateRequestForLog(request: GenerateRequest): Record<string, unknown> {
  return {
    promptLength: request.prompt.length,
    model: request.model,
    size: request.size,
    aspect_ratio: request.aspect_ratio,
    reference_images_count: request.reference_images?.length ?? 0,
    reference_images_kinds: (request.reference_images ?? []).map(summarizeResultSourceForLog),
    reference_videos_count: request.reference_videos?.length ?? 0,
    reference_audios_count: request.reference_audios?.length ?? 0,
    extra_param_keys: Object.keys(request.extra_params ?? {}).filter((key) => key.trim()),
  };
}

interface ErrorWithDetails extends Error {
  details?: string;
}

function normalizeInvokeError(error: unknown): { message: string; details?: string } {
  if (error instanceof Error) {
    const detailsText =
      'details' in error
        ? typeof (error as { details?: unknown }).details === 'string'
          ? (error as { details?: string }).details
          : undefined
        : undefined;
    return {
      message: redactDiagnosticText(error.message || 'Generation failed'),
      details: detailsText ? redactDiagnosticText(detailsText) : undefined,
    };
  }

  if (typeof error === 'string') {
    return {
      message: redactDiagnosticText(error || 'Generation failed'),
      details: error ? redactDiagnosticText(error) : undefined,
    };
  }

  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const message =
      (typeof record.message === 'string' && record.message) ||
      (typeof record.error === 'string' && record.error) ||
      (typeof record.msg === 'string' && record.msg) ||
      'Generation failed';
    let details: string | undefined;
    try {
      details = truncateText(JSON.stringify(record, null, 2), 2000);
    } catch {
      details = truncateText(String(record), 2000);
    }
    return {
      message: redactDiagnosticText(message),
      details: details ? redactDiagnosticText(details) : undefined,
    };
  }

  return { message: 'Generation failed' };
}

function createErrorWithDetails(message: string, details?: string): ErrorWithDetails {
  const error: ErrorWithDetails = new Error(message);
  if (details) {
    error.details = details;
  }
  return error;
}

export async function setApiKey(provider: string, apiKey: string): Promise<void> {
  console.info('[AI] set_api_key', {
    provider,
    apiKeyConfigured: Boolean(apiKey),
    tauri: isTauri(),
  });
  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境，请使用 `npm run tauri dev` 启动');
  }
  return await invoke('set_api_key', { provider, apiKey });
}

export async function generateImage(request: GenerateRequest): Promise<string> {
  const startedAt = performance.now();
  console.info('[AI] generate_image request', {
    ...sanitizeGenerateRequestForLog(request),
    tauri: isTauri(),
  });

  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境，请使用 `npm run tauri dev` 启动');
  }

  try {
    const rawResult = await invoke<unknown>('generate_image', { request });
    if (typeof rawResult !== 'string') {
      throw createErrorWithDetails(
        'Generation returned non-string payload',
        truncateText(
          (() => {
            try {
              return JSON.stringify(rawResult, null, 2);
            } catch {
              return String(rawResult);
            }
          })(),
          2000
        )
      );
    }
    const result = rawResult.trim();
    if (!result) {
      throw createErrorWithDetails('Generation returned empty image source');
    }
    const elapsedMs = Math.round(performance.now() - startedAt);
    console.info('[AI] generate_image success', {
      elapsedMs,
      resultSource: summarizeResultSourceForLog(result),
    });
    return result;
  } catch (error) {
    const elapsedMs = Math.round(performance.now() - startedAt);
    const normalizedError = normalizeInvokeError(error);
    console.error('[AI] generate_image failed', {
      elapsedMs,
      request: sanitizeGenerateRequestForLog(request),
      errorMessage: normalizedError.message,
      hasDetails: Boolean(normalizedError.details),
    });
    const commandError: ErrorWithDetails = new Error(normalizedError.message);
    commandError.details = normalizedError.details
      ? redactDiagnosticText(normalizedError.details)
      : undefined;
    throw commandError;
  }
}

export async function submitGenerateImageJob(request: GenerateRequest): Promise<string> {
  console.info('[AI] submit_generate_image_job request', {
    ...sanitizeGenerateRequestForLog(request),
    tauri: isTauri(),
  });

  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境，请使用 `npm run tauri dev` 启动');
  }

  const jobId = await invoke<string>('submit_generate_image_job', { request });
  if (typeof jobId !== 'string' || !jobId.trim()) {
    throw new Error('submit_generate_image_job returned invalid job id');
  }
  return jobId.trim();
}

export async function getGenerateImageJob(jobId: string): Promise<GenerationJobStatus> {
  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境，请使用 `npm run tauri dev` 启动');
  }

  const result = await invoke<GenerationJobStatus>('get_generate_image_job', { jobId });
  if (!result || typeof result !== 'object' || typeof result.status !== 'string') {
    throw new Error('get_generate_image_job returned invalid payload');
  }
  return result;
}

export async function createGenerationJob(
  request: CreateGenerationJobRequest
): Promise<GenerationJobStatus> {
  if (!isTauri()) {
    throw new Error('持久生成任务仅在桌面端可用；Web 模式关闭页面后不可恢复');
  }
  return await invoke<GenerationJobStatus>('create_generation_job', { request });
}

export async function updateGenerationJob(
  request: UpdateGenerationJobRequest
): Promise<GenerationJobStatus> {
  if (!isTauri()) {
    throw new Error('持久生成任务仅在桌面端可用；Web 模式关闭页面后不可恢复');
  }
  return await invoke<GenerationJobStatus>('update_generation_job_record', { request });
}

export async function listGenerationJobs(limit = 100): Promise<GenerationJobStatus[]> {
  if (!isTauri()) {
    return [];
  }
  return await invoke<GenerationJobStatus[]>('list_generation_jobs', { limit });
}

export async function getGenerationJobRecord(jobId: string): Promise<GenerationJobStatus> {
  if (!isTauri()) {
    throw new Error('持久生成任务仅在桌面端可用');
  }
  return await invoke<GenerationJobStatus>('get_generation_job_record', { jobId });
}

export async function forgetGenerationJob(jobId: string): Promise<boolean> {
  if (!isTauri()) {
    return false;
  }
  return await invoke<boolean>('forget_generation_job', { jobId });
}

export async function listModels(): Promise<string[]> {
  return await invoke('list_models');
}

export interface CustomHttpRequest {
  url: string;
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  bodyMode?: 'json' | 'multipart' | 'form-urlencoded';
  body?: unknown;
  multipart?: CustomHttpMultipartBody;
  timeoutMs?: number;
  networkRoute?: GenerationNetworkRoute;
  customProxyUrl?: string;
}

export interface CustomHttpMultipartField {
  name: string;
  value: string;
}

export interface CustomHttpMultipartFile {
  name: string;
  fileName?: string;
  mimeType?: string;
  dataUrl?: string;
  base64?: string;
}

export interface CustomHttpMultipartBody {
  fields?: CustomHttpMultipartField[];
  files?: CustomHttpMultipartFile[];
}

export interface CustomHttpResponse {
  status: number;
  text: string;
}

export interface CustomHttpStreamResponse {
  status: number;
  text: string;
  byteLength: number;
  chunkCount: number;
}

export interface CustomHttpStreamEvent {
  streamId: string;
  kind: 'status' | 'chunk' | 'done' | 'error';
  status?: number | null;
  chunk?: string | null;
  error?: string | null;
}

export async function customHttpRequest(request: CustomHttpRequest): Promise<CustomHttpResponse> {
  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境，请使用 `npm run tauri dev` 启动');
  }
  return await invoke<CustomHttpResponse>('custom_http_request', { request });
}

export async function customHttpStreamRequest(
  request: CustomHttpRequest,
  handlers: {
    onStatus?: (status: number) => void;
    onChunk?: (chunk: string, status?: number | null) => void;
    onDone?: (status?: number | null) => void;
    onError?: (message: string, status?: number | null) => void;
  }
): Promise<CustomHttpStreamResponse> {
  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境，请使用 `npm run tauri dev` 启动');
  }
  const streamId = `http-stream-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const unlisten = await listen<CustomHttpStreamEvent>('custom-http-stream', (event) => {
    const payload = event.payload;
    if (!payload || payload.streamId !== streamId) {
      return;
    }
    if (payload.kind === 'status' && typeof payload.status === 'number') {
      handlers.onStatus?.(payload.status);
      return;
    }
    if (payload.kind === 'chunk') {
      handlers.onChunk?.(payload.chunk ?? '', payload.status);
      return;
    }
    if (payload.kind === 'done') {
      handlers.onDone?.(payload.status);
      return;
    }
    if (payload.kind === 'error') {
      handlers.onError?.(payload.error || 'HTTP stream failed', payload.status);
    }
  });

  try {
    const response = await invoke<CustomHttpStreamResponse>('custom_http_stream_request', { request, streamId });
    await new Promise((resolve) => setTimeout(resolve, 0));
    return response;
  } finally {
    unlisten();
  }
}
