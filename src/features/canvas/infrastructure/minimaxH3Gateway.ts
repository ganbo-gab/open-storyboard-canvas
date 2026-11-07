import i18n from 'i18next';
import {
  createGenerationJob,
  customHttpRequest,
  getGenerationJobRecord,
  updateGenerationJob,
  type GenerateRequest,
  type GenerationJobStatus,
  type UpdateGenerationJobRequest,
} from '@/commands/ai';
import { persistVideoSource } from '@/commands/image';
import { useCustomProvidersStore, type CustomProviderConfig } from '@/stores/customProvidersStore';
import { useSettingsStore, type GenerationNetworkSettings } from '@/stores/settingsStore';
import { composeMinimaxH3Request, MinimaxH3ValidationError } from '../application/minimaxH3';
import { isLightweightGenerationRetryResultUrl } from '../application/generationRetry';
import { shouldForwardProviderCredentials } from '../application/imageProviderContracts';
import { buildProviderUrl, normalizeProviderBaseUrl } from '../application/providerUrl';

const JOB_PREFIX = 'custom-local-h3-';
const POLL_PATH = '/v2/query/video_generation/{taskId}';
const POLL_DESCRIPTOR = { method: 'GET', pathTemplate: POLL_PATH };
const jobs = new Map<string, GenerationJobStatus>();
const activeJobs = new Map<string, Promise<GenerationJobStatus>>();

class H3RuntimeError extends Error {
  constructor(message: string, readonly category: string, readonly terminal = false) {
    super(message);
  }
}

// Keep the fingerprint compatible with persisted H3 jobs from the old gateway.
function fingerprint(config: CustomProviderConfig, model: string): string {
  const basis = [config.id, model, config.baseUrl, config.endpointPath ?? '', config.apiStyle].join('|');
  let hash = 2166136261;
  for (let index = 0; index < basis.length; index += 1) {
    hash ^= basis.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function patchJob(id: string, patch: Partial<GenerationJobStatus>): GenerationJobStatus {
  const job: GenerationJobStatus = {
    job_id: id, status: 'queued', result: null, error: null, created_at: Date.now(),
    ...jobs.get(id), ...patch, updated_at: Date.now(),
  };
  jobs.set(id, job);
  return job;
}

function errorMessage(error: unknown, config?: CustomProviderConfig): string {
  let message = error instanceof Error ? error.message : String(error);
  if (config?.apiKey.trim()) message = message.split(config.apiKey.trim()).join('[redacted]');
  return message.replace(/(Bearer\s+)[^\s,]+/gi, '$1[redacted]');
}

/** Updates are awaited in lifecycle order; handles remain cached even if storage fails. */
async function saveJob(id: string, patch: Partial<GenerationJobStatus>): Promise<void> {
  const job = patchJob(id, patch);
  const update: UpdateGenerationJobRequest = {
    jobId: id, status: job.status, phase: job.phase, externalTaskId: job.external_task_id ?? undefined,
    pollDescriptor: job.poll_descriptor ?? undefined, result: job.result ?? undefined,
    resultUrl: job.result_url ?? undefined, error: job.error ?? '', errorCategory: job.error_category ?? '',
    networkRoute: job.network_route, resumable: job.resumable, lastPollAt: job.last_poll_at ?? undefined,
  };
  try {
    await updateGenerationJob(update);
  } catch {
    throw new H3RuntimeError('本机任务状态保存失败，尚未确认任务完成。', 'storage');
  }
}

function headers(config: CustomProviderConfig, method: 'GET' | 'POST'): Record<string, string> {
  return {
    Authorization: `Bearer ${config.apiKey.trim()}`,
    ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
    ...config.extraHeaders,
  };
}

/** H3 has exactly one paid POST and a separate, query-only V2 task endpoint. */
async function h3Request(
  config: CustomProviderConfig,
  network: Readonly<GenerationNetworkSettings>,
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const url = buildProviderUrl(config.baseUrl, path, config.queryParams);
  if (!shouldForwardProviderCredentials(config.baseUrl, url)) {
    throw new H3RuntimeError('MiniMax H3 接口必须与服务商地址同源。', 'configuration');
  }
  let response;
  try {
    response = await customHttpRequest({
      url, method, headers: headers(config, method), bodyMode: 'json', body,
      timeoutMs: method === 'POST' ? 5 * 60 * 1000 : 30000,
      networkRoute: network.route,
      ...(network.route === 'custom-proxy' ? { customProxyUrl: network.customProxyUrl } : {}),
    });
  } catch (error) {
    throw new H3RuntimeError(errorMessage(error, config), method === 'POST' ? 'submission-unknown' : 'network');
  }
  if (response.status < 200 || response.status >= 300) {
    const ambiguous = method === 'POST' && (response.status >= 500 || response.status === 408);
    throw new H3RuntimeError(`MiniMax H3 HTTP ${response.status}`, ambiguous ? 'submission-unknown' : 'provider');
  }
  try {
    const payload: unknown = JSON.parse(response.text);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid payload');
    return payload as Record<string, unknown>;
  } catch {
    throw new H3RuntimeError('MiniMax H3 返回了无法解析的响应。', method === 'POST' ? 'submission-unknown' : 'response-parse');
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function pollJob(id: string, config: CustomProviderConfig, network: Readonly<GenerationNetworkSettings>): Promise<string> {
  const taskId = getMinimaxH3Job(id).external_task_id!;
  const configuredInterval = Number(config.extraParams?.videoPollIntervalMs);
  const configuredTimeout = Number(config.extraParams?.videoPollTimeoutMs);
  const interval = Number.isFinite(configuredInterval) ? Math.max(500, configuredInterval) : 10000;
  const timeout = Number.isFinite(configuredTimeout) ? Math.max(5000, configuredTimeout) : 20 * 60 * 1000;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const payload = await h3Request(config, network, 'GET', POLL_PATH.replace('{taskId}', encodeURIComponent(taskId)));
    patchJob(id, { last_poll_at: Date.now() });
    const task = record(payload.task);
    if (task.status === 'failed' || task.status === 'cancelled' || task.status === 'canceled') {
      const detail = typeof task.error === 'string' ? task.error : JSON.stringify(task.error ?? task.status);
      throw new H3RuntimeError(errorMessage(detail, config), 'provider', true);
    }
    // Input URLs may be echoed while queued/running. Only succeeded content is output.
    if (task.status === 'succeeded') {
      const source = record(task.content).url;
      if (typeof source === 'string' && isLightweightGenerationRetryResultUrl(source)) return source;
      throw new H3RuntimeError('MiniMax H3 已完成，但响应中没有有效的视频结果地址。', 'response-parse');
    }
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(interval, Math.max(0, deadline - Date.now()))));
  }
  throw new H3RuntimeError('MiniMax H3 视频任务轮询超时，未获取到结果。', 'poll-timeout');
}

async function materializeJob(id: string, config: CustomProviderConfig, network: Readonly<GenerationNetworkSettings>, source: string): Promise<void> {
  await saveJob(id, { status: 'materializing', phase: 'materialize', result_url: source, resumable: true, error: null });
  let result: string;
  try {
    result = await persistVideoSource(
      source,
      shouldForwardProviderCredentials(config.baseUrl, source) ? headers(config, 'GET') : undefined,
      {
        route: network.route,
        ...(network.route === 'custom-proxy' ? { customProxyUrl: network.customProxyUrl } : {}),
        configuredProviderOrigin: new URL(normalizeProviderBaseUrl(config.baseUrl)).origin,
      },
    );
  } catch (error) {
    throw new H3RuntimeError(errorMessage(error, config), 'download');
  }
  await saveJob(id, { status: 'succeeded', phase: 'materialize', result, error: null, error_category: null, resumable: false });
}

async function failJob(id: string, error: unknown, config?: CustomProviderConfig): Promise<void> {
  const current = getMinimaxH3Job(id);
  const category = error instanceof H3RuntimeError ? error.category : 'configuration';
  const terminal = error instanceof H3RuntimeError && error.terminal;
  const safeHandle = Boolean(current.external_task_id || current.result_url);
  const status = terminal ? 'failed' : safeHandle ? 'recoverable_wait' : category === 'submission-unknown' ? 'unknown' : 'failed';
  const patch: Partial<GenerationJobStatus> = {
    status, resumable: safeHandle && !terminal, error: errorMessage(error, config), error_category: category,
  };
  try {
    await saveJob(id, patch);
  } catch {
    // Preserve the primary failure, including terminal and ambiguous-submit semantics.
    patchJob(id, patch);
  }
}

async function runSubmission(id: string, config: CustomProviderConfig, model: string, request: GenerateRequest, network: Readonly<GenerationNetworkSettings>): Promise<GenerationJobStatus> {
  try {
    if (!config.apiKey.trim()) throw new H3RuntimeError(`${config.label} 未填写 API Key`, 'configuration');
    let body: Record<string, unknown>;
    try {
      body = composeMinimaxH3Request(model, request, record(config.extraParams?.defaultRequestParams));
    } catch (error) {
      if (error instanceof MinimaxH3ValidationError) {
        throw new H3RuntimeError(i18n.isInitialized ? i18n.t(error.message) : error.message, 'configuration');
      }
      throw error;
    }
    try {
      await createGenerationJob({
        jobId: id, mediaType: 'video', providerId: config.id, modelId: model,
        configFingerprint: fingerprint(config, model), status: 'queued', phase: 'submit',
        networkRoute: network.route, resumable: false,
      });
    } catch {
      throw new H3RuntimeError('无法创建本机任务记录，生成请求未发送。', 'storage');
    }
    await saveJob(id, { status: 'submitting', phase: 'submit' });
    const payload = await h3Request(config, network, 'POST', config.endpointPath || '/v2/video_generation', body);
    const taskId = typeof payload.task_id === 'string' ? payload.task_id.trim() : '';
    if (!taskId) throw new H3RuntimeError('提交结果未知，响应缺少 task_id；为避免重复计费不会重发。', 'submission-unknown');
    await saveJob(id, {
      status: 'running', phase: 'polling', external_task_id: taskId,
      poll_descriptor: POLL_DESCRIPTOR, resumable: true,
    });
    await materializeJob(id, config, network, await pollJob(id, config, network));
  } catch (error) {
    await failJob(id, error, config);
  }
  return getMinimaxH3Job(id);
}

function trackJob(id: string, pending: Promise<GenerationJobStatus>): Promise<GenerationJobStatus> {
  activeJobs.set(id, pending);
  void pending.then(() => { if (activeJobs.get(id) === pending) activeJobs.delete(id); }, () => {
    if (activeJobs.get(id) === pending) activeJobs.delete(id);
  });
  return pending;
}

export async function submitMinimaxH3Job(config: CustomProviderConfig, model: string, request: GenerateRequest): Promise<string> {
  const id = `${JOB_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const network = { ...useSettingsStore.getState().generationNetworkSettings };
  patchJob(id, {
    status: 'queued', media_type: 'video', provider_id: config.id, model_id: model,
    config_fingerprint: fingerprint(config, model), network_route: network.route, resumable: false,
  });
  void trackJob(id, runSubmission(id, config, model, request, network));
  return id;
}

export function isMinimaxH3JobId(id: string): boolean {
  return id.startsWith(JOB_PREFIX);
}

export function getMinimaxH3Job(id: string): GenerationJobStatus {
  return { ...(jobs.get(id) ?? { job_id: id, status: 'not_found', result: null, error: 'MiniMax H3 任务不存在' }) };
}

async function recoverJob(id: string): Promise<GenerationJobStatus> {
  const persisted = await getGenerationJobRecord(id);
  jobs.set(id, { ...persisted });
  if (persisted.status === 'succeeded' || persisted.status === 'failed' || persisted.status === 'canceled') return getMinimaxH3Job(id);
  if (!persisted.external_task_id && !persisted.result_url) {
    await failJob(id, new H3RuntimeError('任务没有可安全恢复的 task id 或结果地址；不会重新提交生成请求。', 'submission-unknown'));
    return getMinimaxH3Job(id);
  }
  if (persisted.resumable === false) throw new Error('任务不允许安全取回；不会重新提交生成请求。');
  let config: CustomProviderConfig | undefined;
  try {
    config = useCustomProvidersStore.getState().providers.find((provider) => provider.id === persisted.provider_id);
    if (!config || config.extraParams?.providerKind !== 'minimax-h3' || persisted.model_id !== 'MiniMax-H3') {
      throw new H3RuntimeError('恢复任务需要原 MiniMax H3 服务商配置和模型。', 'configuration');
    }
    if (!config.apiKey.trim()) throw new H3RuntimeError(`${config.label} 未填写 API Key`, 'configuration');
    if (persisted.config_fingerprint && persisted.config_fingerprint !== fingerprint(config, persisted.model_id)) {
      throw new H3RuntimeError('服务商配置已变化，请恢复原配置后安全取回任务。', 'configuration');
    }
    const network = { ...useSettingsStore.getState().generationNetworkSettings };
    if (persisted.network_route && persisted.network_route !== network.route) {
      throw new H3RuntimeError('网络路线已变化，请切回任务创建时的路线后恢复。', 'configuration');
    }
    let source = persisted.result_url?.trim();
    if (source && !isLightweightGenerationRetryResultUrl(source)) throw new H3RuntimeError('任务保存的结果地址不是安全的轻量来源。', 'configuration');
    if (!source) {
      await saveJob(id, { status: 'running', phase: 'polling', error: null });
      source = await pollJob(id, config, network);
    }
    await materializeJob(id, config, network, source);
  } catch (error) {
    await failJob(id, error, config);
  }
  return getMinimaxH3Job(id);
}

/** Old durable IDs are accepted here only after resolving their saved H3 provider. */
export async function recoverMinimaxH3Job(id: string): Promise<GenerationJobStatus> {
  const normalized = id.trim();
  if (!normalized) throw new Error('恢复任务需要有效的 jobId。');
  const active = activeJobs.get(normalized);
  return await (active ?? trackJob(normalized, recoverJob(normalized)));
}

export async function getMinimaxH3JobAsync(id: string): Promise<GenerationJobStatus> {
  if (jobs.has(id)) return getMinimaxH3Job(id);
  try {
    const persisted = await getGenerationJobRecord(id);
    jobs.set(id, { ...persisted });
    if (['queued', 'submitting', 'running', 'materializing'].includes(persisted.status)) {
      if (persisted.external_task_id || persisted.result_url) {
        if (persisted.resumable !== false) void recoverMinimaxH3Job(id).catch(() => undefined);
      } else {
        await failJob(id, new H3RuntimeError('提交结果未知；没有安全恢复句柄，不会重新提交生成请求。', 'submission-unknown'));
      }
    }
  } catch {
    // Status reads remain usable when the durable store is unavailable.
  }
  return getMinimaxH3Job(id);
}
