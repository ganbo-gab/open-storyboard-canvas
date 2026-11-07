import type { GenerateRequest, GenerationJobStatus } from '@/commands/ai';
import { getGenerationJobRecord, updateGenerationJob } from '@/commands/ai';
import { useCustomProvidersStore, isVideoCustomProvider, type CustomProviderConfig } from '@/stores/customProvidersStore';
import { parseCustomProviderModelId } from '../application/imageProviderContracts';
import { channelJobFromRequest, profileForProjection, submitChannelJob, isChannelJobId, getChannelJob, getChannelJobAsync, recoverChannelJob } from '@/features/channels/runtime/channelExecution';
import { submitComfyChannelJob, isComfyChannelJobId, getComfyChannelJob, getComfyChannelJobAsync, recoverComfyChannelJob } from '@/features/channels/runtime/comfyExecution';
import { applyComfyUIAuth, resolveComfyUIProviderAuth, resolveComfyUIUrls, type ComfyUIAuth } from '@/features/channels/adapters/comfyui/url';
import { submitMinimaxH3Job, isMinimaxH3JobId, getMinimaxH3Job, getMinimaxH3JobAsync, recoverMinimaxH3Job } from './minimaxH3Gateway';
import { renderPreview } from '@/features/channels/domain/template';
import { channelRequestOptions } from '@/features/channels/runtime/requestReferences';
import { migrateLegacyConfig } from '@/features/channels/migrate/legacyConfig';
import { getChannelCredential, projectChannelProviders, useChannelStore } from '@/features/channels/store/channelStore';
import { testChannelModels } from '@/features/channels/application/channelService';
import { checkComfyUIConnection, isComfyUIProvider, listComfyUICheckpoints, parseComfyUIConfig, validateComfyUIRequest } from './comfyuiGateway';
import { createComfyProviderTransport } from './comfyProviderTransport';
import { composeMinimaxH3Request } from '../application/minimaxH3';
import { buildProviderUrl } from '../application/providerUrl';
import type { CustomProviderRequestDebugPreview, CustomProviderTestResult, CustomProviderModelListResult } from '@/features/channels/runtime/providerTypes';
export type { CustomProviderRequestDebugPreview, CustomProviderTestResult, CustomProviderModelListResult } from '@/features/channels/runtime/providerTypes';

/** Resolve projections from the channel store, including saved canvas model IDs from before migration. */
export function resolveProviderAndModel(modelId: string): { cfg: CustomProviderConfig; model: string } | null {
  const parsed = parseCustomProviderModelId(modelId);
  const agnes = /^agnes:(image|video|chat):(.+)$/.exec(modelId);
  const providers = projectChannelProviders(useChannelStore.getState().channels);
  if (agnes) {
    const cfg = providers.find((entry) => entry.extraParams?.channelProfileId === `settings-agnes-${agnes[1]}`);
    return cfg ? { cfg, model: agnes[2] } : null;
  }
  if (!parsed) return null;
  const cfg = providers.find((entry) => entry.id === parsed.providerId || entry.extraParams?.channelProfileId === parsed.providerId)
    ?? useCustomProvidersStore.getState().providers.find((entry) => entry.id === parsed.providerId && (isComfyUIProvider(entry) || entry.extraParams?.providerKind === 'minimax-h3'));
  return cfg ? { cfg, model: parsed.upstreamModel } : null;
}

export function buildCustomProviderRequestDebugPreviewForConfig(cfg: CustomProviderConfig, model: string, request: GenerateRequest): CustomProviderRequestDebugPreview {
  if (isComfyUIProvider(cfg)) {
    const config = parseComfyUIConfig(cfg, model);
    validateComfyUIRequest(config, request);
    const resolvedAuth = resolveComfyUIProviderAuth(cfg);
    const maskedValue = resolvedAuth.value ? '***' : '';
    const auth: ComfyUIAuth = resolvedAuth.config.mode === 'none' ? { mode: 'none' }
      : resolvedAuth.config.mode === 'bearer' ? { mode: 'bearer', value: maskedValue }
      : { mode: resolvedAuth.config.mode, name: 'name' in resolvedAuth.config ? resolvedAuth.config.name : '', value: maskedValue };
    const address = applyComfyUIAuth(resolveComfyUIUrls(cfg.baseUrl).prompt, auth);
    const url = new URL(address.url);
    for (const [name, value] of Object.entries(cfg.queryParams ?? {})) url.searchParams.set(name, value ? '***' : '');
    const headers = { ...address.headers, ...Object.fromEntries(Object.entries(cfg.extraHeaders ?? {})
      .map(([name, value]) => [name, /authorization|cookie|key|token|secret/i.test(name) && value ? '***' : value])) };
    return { providerLabel: cfg.label, providerId: cfg.id, modelId: request.model, modelName: model,
      method: 'POST', bodyMode: 'json', url: url.href, headers,
      body: { workflowNodeCount: Object.keys(config.workflow).length, promptBinding: config.bindings.prompt ?? 'auto',
        referenceImageCount: request.reference_images?.length ?? 0, outputNodeIds: config.outputNodeIds } };
  }
  if (cfg.extraParams?.providerKind === 'minimax-h3') {
    const defaults = cfg.extraParams?.defaultRequestParams;
    const body = composeMinimaxH3Request(model, request, defaults && typeof defaults === 'object' && !Array.isArray(defaults) ? defaults as Record<string, unknown> : {});
    const headers = Object.fromEntries(Object.entries(cfg.extraHeaders ?? {}).map(([key, value]) => [key, /authorization|cookie|key|token|secret/i.test(key) ? '***' : value]));
    headers.Authorization = 'Bearer ***';
    return { providerLabel: cfg.label, providerId: cfg.id, modelId: request.model, modelName: model, method: 'POST', bodyMode: 'json',
      url: buildProviderUrl(cfg.baseUrl, cfg.endpointPath || '/v2/video_generation'), headers,
      body: JSON.parse(JSON.stringify(body, (_key, value: unknown) => typeof value === 'string' && /^data:[^,]+;base64,/i.test(value) ? '<reference media omitted>' : value)) };
  }
  const profile = profileForProjection(cfg) ?? migrateLegacyConfig(cfg).profile;
  const preview = renderPreview(profile, channelJobFromRequest(profile, model, request, isVideoCustomProvider(cfg) ? 'video' : 'image', channelRequestOptions(profile, model, request)));
  return { providerLabel: cfg.label, providerId: cfg.id, modelId: request.model, modelName: model,
    method: preview.method, bodyMode: preview.body.mode, url: preview.url, headers: preview.headers,
    body: preview.body.mode === 'json' ? preview.body.json : preview.body.mode === 'form-urlencoded' ? preview.body.fields : undefined,
    multipart: preview.body.mode === 'multipart' ? preview.body : undefined };
}
export function buildCustomProviderRequestDebugPreview(request: GenerateRequest): CustomProviderRequestDebugPreview {
  const resolved = resolveProviderAndModel(request.model);
  if (!resolved) throw new Error('未找到对应的渠道配置');
  return buildCustomProviderRequestDebugPreviewForConfig(resolved.cfg, resolved.model, request);
}
export function buildCustomVideoProviderRequestDebugPreview(request: GenerateRequest): CustomProviderRequestDebugPreview {
  return buildCustomProviderRequestDebugPreview(request);
}

async function submit(request: GenerateRequest, media: 'image' | 'video'): Promise<string> {
  const resolved = resolveProviderAndModel(request.model);
  if (!resolved) throw new Error('未找到对应的渠道配置');
  const { cfg, model } = resolved;
  if (isComfyUIProvider(cfg)) return submitComfyChannelJob(cfg, model, request);
  if (cfg.extraParams?.providerKind === 'minimax-h3') return submitMinimaxH3Job(cfg, model, request);
  const profile = profileForProjection(cfg);
  if (!profile) throw new Error('HTTP 服务商尚未迁移为渠道，请重新打开配置');
  return submitChannelJob(profile, channelJobFromRequest(profile, model, request, media, channelRequestOptions(profile, model, request)));
}
export function submitCustomProviderJob(request: GenerateRequest): Promise<string> { return submit(request, 'image'); }
export function submitCustomVideoJob(request: GenerateRequest): Promise<string> { return submit(request, 'video'); }
export function getCustomProviderJob(id: string): GenerationJobStatus {
  if (isChannelJobId(id)) return getChannelJob(id);
  if (isComfyChannelJobId(id)) return getComfyChannelJob(id);
  if (isMinimaxH3JobId(id)) return getMinimaxH3Job(id);
  return { job_id: id, status: 'not_found', result: null, error: '旧任务请从历史记录查询；不会重新提交' };
}
export async function getCustomProviderJobAsync(id: string): Promise<GenerationJobStatus> {
  if (isChannelJobId(id)) return getChannelJobAsync(id);
  if (isComfyChannelJobId(id)) return getComfyChannelJobAsync(id);
  if (isMinimaxH3JobId(id)) return getMinimaxH3JobAsync(id);
  const record = await getGenerationJobRecord(id);
  if (!record || ['succeeded', 'failed', 'canceled'].includes(record.status)) return record ?? getCustomProviderJob(id);
  return recoverCustomProviderJob(id);
}
export async function recoverCustomProviderJob(id: string): Promise<GenerationJobStatus> {
  if (isChannelJobId(id)) return recoverChannelJob(id);
  if (isComfyChannelJobId(id)) return recoverComfyChannelJob(id);
  if (isMinimaxH3JobId(id)) return recoverMinimaxH3Job(id);
  const record = await getGenerationJobRecord(id);
  if (!record) throw new Error('任务记录不存在');
  if (['succeeded', 'failed', 'canceled'].includes(record.status)) return record;
  const provider = useCustomProvidersStore.getState().providers.find((entry) => entry.id === record.provider_id);
  if (provider?.extraParams?.providerKind === 'minimax-h3') return recoverMinimaxH3Job(id);
  const error = `升级后无法安全恢复此旧任务；原任务 ID：${record.external_task_id || record.job_id}。请前往服务商控制台核对；应用不会重新提交或重复计费。`;
  await updateGenerationJob({ jobId: id, status: 'failed', phase: 'upgrade-recovery', error,
    errorCategory: 'upgrade-recovery-unavailable', resumable: false });
  return { ...record, status: 'failed', phase: 'upgrade-recovery', error, error_category: 'upgrade-recovery-unavailable', resumable: false };
}
export function retryCustomProviderJob(id: string): boolean {
  const job = getCustomProviderJob(id);
  if (!job.resumable) return false;
  void recoverCustomProviderJob(id).catch(() => undefined);
  return true;
}
export async function fetchCustomProviderModels(cfg: CustomProviderConfig): Promise<CustomProviderModelListResult> {
  const profile = profileForProjection(cfg) ?? migrateLegacyConfig(cfg).profile;
  const result = await testChannelModels(profile, profileForProjection(cfg) ? getChannelCredential(profile.id) : cfg.apiKey);
  return result.ok ? { ok: true, models: result.models } : { ok: false, models: [], errorMessage: result.error.message, status: result.error.status };
}
export async function listCustomComfyUICheckpoints(cfg: CustomProviderConfig): Promise<string[]> {
  if (!isComfyUIProvider(cfg)) throw new Error('当前配置不是 ComfyUI 连接');
  return listComfyUICheckpoints(createComfyProviderTransport(cfg));
}
export async function testCustomProviderConnectivity(cfg: CustomProviderConfig, _testModelId?: string): Promise<CustomProviderTestResult> {
  try {
    if (isComfyUIProvider(cfg)) {
      await checkComfyUIConnection(createComfyProviderTransport(cfg));
      return { ok: true, status: 200, text: 'ComfyUI 服务已连接；没有提交生成任务。' };
    }
    const result = await fetchCustomProviderModels(cfg);
    return result.ok ? { ok: true, text: `已读取 ${result.models.length} 个模型；未提交生成请求` } : result;
  } catch (error) { return { ok: false, errorMessage: error instanceof Error ? error.message : String(error) }; }
}
