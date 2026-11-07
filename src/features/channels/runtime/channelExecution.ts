import { isTauri } from '@tauri-apps/api/core';
import { z } from 'zod';
import { createGenerationJob, updateGenerationJob, getGenerationJobRecord, normalizeGenerationJobResults, type GenerationJobResult, type GenerationJobStatus, type GenerateRequest } from '@/commands/ai';
import { prepareNodeImageSourceWithHeaders, persistVideoSource, loadAudioSourceDataUrl, saveAudioSourceToPath } from '@/commands/image';
import { appDataDir, join } from '@tauri-apps/api/path';
import { useSettingsStore } from '@/stores/settingsStore';
import type { ChannelProfileV2, JsonValue, OperationKind, ParamSpec } from '../domain/profile';
import { channelProfileSchema, RATIO_PARAM_KEYS, SIZE_PARAM_KEYS } from '../domain/profile';
import { resolveJobOperation, resolveParamValue, validateChannelReferenceUrls } from '../domain/template';
import type { ChannelError, JobInput, JobRef, Output } from './types';
import { TemplateAdapter } from './templateAdapter';
import { createChannelHttpTransport, resolveChannelRef } from './transport';
import { getChannelCredential, useChannelStore } from '../store/channelStore';
import { channelNativeCountParam, resolveModelMode } from '../application/modelModes';
import { isImageModeOperation, resolveImageMode } from '../application/imageModeSelection';
import { channelRequestOptions } from './requestReferences';
import { formatChannelError, safeChannelError, redactChannelErrorText, classifyTransportError } from '../domain/errors';
import { credentialFailureOf } from '@/features/secrets/credentialFailure';
import { importGeneratedModelOutput, ModelDownloadError } from '@/features/stage/application/imageTo3dMaterialization';
import { previewChannelSmokeRequest } from './channelSmokeRequest';
import { secretRefFromToken, retrySecretAccess } from '@/features/secrets/secretStore';
import { planCredentialMigration } from '@/features/secrets/credentialMigration';
import { StoredResultMissingError } from './storedResult';
import { readBrowserJobRecords, readBrowserJobRecord } from './browserJobRecords';

interface JobSnapshot { version: 2; adapter: 'template'; credentialSource?: 'transient'; profile: ChannelProfileV2; input: JobInput; submit: Record<string, unknown>; assets?: string[]; assetKinds?: GenerationJobResult['kind'][]; outputs?: SavedOutput[];
  failure?: { category: string; message: string; raw?: string; status?: number } }
const snapshotCredentialSchema = z.object({ credentialSource: z.literal('transient').optional() });
type SavedOutput = { kind: 'text'; text: string } | { kind: 'image' | 'video' | 'audio' | 'model'; url: string; auth: boolean };
const jobs = new Map<string, GenerationJobStatus>();
const active = new Map<string, Promise<void>>();
// Credentials belong to one accepted job, never a profile-wide draft or durable record.
// Keep vault tokens opaque so every resumed request still passes through vault locking.
const jobCredentials = new Map<string, string>();
const loading = new Map<string, Promise<GenerationJobStatus | undefined>>();
const observers = new Map<string, Set<(job: GenerationJobStatus) => void>>();
export function subscribeChannelJob(id: string, listener: (job: GenerationJobStatus) => void): () => void {
  const listeners = observers.get(id) ?? new Set(); listeners.add(listener); observers.set(id, listeners);
  return () => { listeners.delete(listener); if (!listeners.size) observers.delete(id); };
}
/** Waits for the current submit/recovery attempt; it never submits a replacement task. */
export async function waitForChannelJob(id: string, signal?: AbortSignal): Promise<GenerationJobStatus> {
  signal?.throwIfAborted();
  await getChannelJobAsync(id);
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const abort = () => reject(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  void Promise.resolve(active.get(id)).then(resolve, reject);
  try { await promise; return getChannelJob(id); }
  finally { signal?.removeEventListener('abort', abort); }
}
const browserJobsKey = 'channel-generation-jobs-v2';
export function isChannelJobId(id: string): boolean { return id.startsWith('custom-local-channel-job-'); }

async function saveJob(id: string, patch: Partial<GenerationJobStatus>, create = false): Promise<void> {
  const previous = jobs.get(id);
  const next: GenerationJobStatus = { job_id: id, status: 'queued', created_at: Date.now(), ...previous, ...patch, updated_at: Date.now() };
  // Keep accepted task handles in memory even if disk fails. Never report a persisted success before write completes.
  if (patch.external_task_id) jobs.set(id, next);
  if (isTauri()) {
    if (create) await createGenerationJob({ jobId: id, mediaType: next.media_type === 'model' ? 'model' : next.media_type === 'video' ? 'video' : next.media_type === 'audio' ? 'audio' : 'image',
      providerId: next.provider_id!, modelId: next.model_id ?? undefined, status: next.status, phase: next.phase,
      pollDescriptor: next.poll_descriptor ?? undefined, networkRoute: next.network_route, resumable: next.resumable });
    else await updateGenerationJob({ jobId: id, status: next.status, phase: next.phase, externalTaskId: next.external_task_id ?? undefined,
      pollDescriptor: next.poll_descriptor ?? undefined, result: next.result ?? undefined, error: next.error ?? '',
      errorCategory: next.error_category ?? '', networkRoute: next.network_route, resumable: next.resumable, lastPollAt: next.last_poll_at ?? undefined });
  } else {
    const saved = readBrowserJobRecords(browserJobsKey); saved[id] = next;
    localStorage.setItem(browserJobsKey, JSON.stringify(saved));
  }
  jobs.set(id, next);
  for (const listener of observers.get(id) ?? []) listener(getChannelJob(id));
}
function snapshotOf(record: GenerationJobStatus): JobSnapshot {
  const snapshot = record.poll_descriptor as unknown as JobSnapshot;
  if (snapshot?.version !== 2 || !snapshot.input || !snapshot.profile) throw new Error('任务缺少 v2 恢复快照，不会重新提交');
  snapshotCredentialSchema.parse(snapshot);
  channelProfileSchema.parse(snapshot.profile);
  // Older browser snapshots accidentally retained chatPayload. Recovery never
  // needs those messages; keep them out of every subsequent durable update.
  return { ...snapshot, input: recoveryInput(snapshot.input) };
}

function recoveryInput(job: JobInput): JobInput {
  return { jobId: job.jobId, channelId: job.channelId, modelId: job.modelId,
    ...(job.modeId ? { modeId: job.modeId } : {}), operation: job.operation,
    prompt: '', params: job.params, refs: [], count: job.count };
}

function channelFailurePatch(error: ChannelError, credential: string, snapshot: JobSnapshot): Partial<GenerationJobStatus> {
  const safe = safeChannelError(error, credential);
  snapshot.failure = { category: safe.category, message: safe.message, raw: safe.upstreamMessage, status: safe.status };
  return { error: formatChannelError(safe), error_category: safe.category, error_status: safe.status, error_raw: safe.upstreamMessage,
    poll_descriptor: snapshot as unknown as Record<string, unknown> };
}

/**
 * Only explicitly declared parameter keys flow into templates; transport hints are never merged.
 * Explicit `extra_params` stay strict (an invalid value fails validation). The canvas-level
 * `size`/`aspect_ratio` hints only fill a declared enum when they name one of its options
 * (case-insensitively, so `1k` reaches `1K`); otherwise the channel's own default applies.
 */
export interface ChannelRequestOptions { modeId?: string; refs?: JobRef[] }
export function channelJobFromRequest(profile: ChannelProfileV2, modelId: string, request: GenerateRequest, media: 'image' | 'video' | 'audio', options: ChannelRequestOptions = {}): JobInput {
  const model = profile.models.find((entry) => entry.id === modelId);
  if (!model) throw new Error('模型不在渠道声明中');
  const requestedModeId = options.modeId ?? request.channel_mode_id;
  const prepared = options.refs === undefined ? channelRequestOptions(profile, modelId, { ...request, channel_mode_id: requestedModeId }) : options;
  let refs: JobRef[] = prepared.refs ?? (['image', 'video', 'audio'] as const).flatMap((kind) => {
    const sources = kind === 'image' ? request.reference_images : kind === 'video' ? request.reference_videos : request.reference_audios;
    return (sources ?? []).map((path, index) => ({ kind, assetId: `${kind}-${index}`, path,
      mime: /^data:([^;,]+)/.exec(path)?.[1] ?? (kind === 'image' ? 'image/png' : kind === 'video' ? 'video/mp4' : 'audio/mpeg') }));
  });
  const imageModes = Boolean(model.modes?.length) && model.modes!.every(mode => isImageModeOperation(mode.operation));
  const resolvedModeId = prepared.modeId ?? requestedModeId;
  const resolved = media === 'image' && imageModes ? resolveImageMode(model, refs.filter(ref => ref.kind === 'image').length, resolvedModeId)
    : resolveModelMode(model, resolvedModeId);
  if (media === 'image' && imageModes && refs.some(ref => ref.slot === undefined)) {
    const slots = resolved.slots.filter(slot => slot.kind === 'image');
    if (slots.length !== 1 || refs.some(ref => ref.kind !== 'image' || ref.slot !== undefined)) throw new Error('请手动分配当前模式的参考素材槽位');
    const slot = slots[0];
    if (refs.length < (slot.min ?? 0) || refs.length > slot.max) throw new Error(`槽位 ${slot.label} 需要 ${slot.min ?? 0}–${slot.max} 个参考素材`);
    refs = refs.map(ref => ({ ...ref, slot: slot.key }));
  }
  const operation: OperationKind = model.modes ? resolved.operation : media === 'video' ? 'video.generate' : media === 'audio' ? 'audio.generate' : refs.some((ref) => ref.kind === 'image') && model.operations.includes('image.edit') ? 'image.edit' : 'image.generate';
  if (model.modes && !operation.startsWith(`${media}.`)) throw new Error('模型模式与生成媒介不一致');
  const params: Record<string, JsonValue> = {};
  const optionFor = (param: ParamSpec, value: unknown, loose: boolean) => param.options?.find((entry) => entry.label === String(value)
    || JSON.stringify(entry.value) === JSON.stringify(value)
    || (loose && entry.label.toLowerCase() === String(value).toLowerCase()));
  for (const param of resolved.params) {
    const explicit = request.extra_params?.[param.key];
    if (explicit !== undefined) {
      const value = z.json().safeParse(explicit);
      if (!value.success) throw new Error(`参数 ${param.label} 必须是 JSON 值`);
      params[param.key] = model.modes ? value.data : optionFor(param, value.data, false)?.value ?? value.data;
      continue;
    }
    const hint = SIZE_PARAM_KEYS.includes(param.key) ? request.size
      : RATIO_PARAM_KEYS.includes(param.key) ? request.aspect_ratio : undefined;
    if (hint === undefined || hint === null || hint === '') continue;
    if (model.modes) { resolveParamValue(param, hint); params[param.key] = hint; continue; }
    if (param.type !== 'enum') { params[param.key] = hint; continue; }
    const option = optionFor(param, hint, true);
    if (option) params[param.key] = option.value;
  }
  const countParam = channelNativeCountParam(profile, modelId, resolved.mode.id);
  if (countParam && request.count !== undefined) params[countParam.key] = request.count;
  if (model.modes) for (const param of resolved.params) resolveParamValue(param, params[param.key]);
  return { jobId: '', channelId: profile.id, modelId, ...(model.modes || resolvedModeId ? { modeId: resolved.mode.id } : {}), operation, prompt: request.prompt, params, refs,
    count: countParam ? Number(resolveParamValue(countParam, params[countParam.key]) ?? 1) : 1 };
}
export function profileForProjection(config: { extraParams?: Record<string, unknown> }): ChannelProfileV2 | undefined {
  const id = config.extraParams?.channelProfileId;
  if (typeof id !== 'string') return undefined;
  const profile = useChannelStore.getState().channels.find((entry) => entry.origin === 'native' && entry.profile.id === id)?.profile;
  if (!profile) throw new Error('渠道配置不存在，请重新选择模型');
  return profile;
}

async function browserAssetStore(): Promise<IDBDatabase> {
  const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
  const request = indexedDB.open('channel-generation-assets', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('assets');
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  return promise;
}
async function saveBrowserAsset(key: string, blob: Blob): Promise<string> {
  const db = await browserAssetStore(); const { promise, resolve, reject } = Promise.withResolvers<void>();
  const transaction = db.transaction('assets', 'readwrite'); transaction.objectStore('assets').put(blob, key);
  transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error);
  try { await promise; } finally { db.close(); }
  return URL.createObjectURL(blob);
}
async function restoreBrowserAsset(key: string): Promise<string> {
  const db = await browserAssetStore(); const { promise, resolve, reject } = Promise.withResolvers<Blob>();
  const request = db.transaction('assets').objectStore('assets').get(key);
  request.onsuccess = () => request.result instanceof Blob ? resolve(request.result) : reject(new StoredResultMissingError());
  request.onerror = () => reject(request.error);
  try { return URL.createObjectURL(await promise); } finally { db.close(); }
}
async function materialize(id: string, profile: ChannelProfileV2, outputs: Output[], snapshot: JobSnapshot, credential = getChannelCredential(profile.id), signal?: AbortSignal): Promise<void> {
  if (snapshot.input.operation === 'model.generate' && !outputs.some((output) => output.kind === 'model')) {
    throw new ModelDownloadError('invalid_model', '上游完成响应没有模型文件，未报告生成成功。');
  }
  const assets: string[] = [];
  const saved: SavedOutput[] = [];
  const key = credential;
  // Persist recoverable remote handles before download. Headers and provider auth
  // query values are reconstructed from the current credential, not stored.
  for (const output of outputs) {
    if (output.kind === 'text') { saved.push(output); continue; }
    if (output.source.type !== 'url') continue;
    const url = new URL(output.source.url);
    const auth = Boolean(output.source.headers && Object.keys(output.source.headers).length);
    if (profile.auth.type === 'query' && url.origin === new URL(profile.baseUrl).origin && url.searchParams.get(profile.auth.name) === key) url.searchParams.delete(profile.auth.name);
    if (key && url.href.includes(key)) throw new Error('结果地址含凭据，无法安全持久化');
    saved.push({ kind: output.kind, url: url.href, auth: auth || (profile.auth.type === 'query' && output.source.url !== url.href) });
  }
  const record = jobs.get(id)!;
  const durableSnapshot = { ...snapshot, outputs: saved, failure: undefined };
  await saveJob(id, { status: 'materializing', phase: 'download', error: null, error_category: undefined, error_status: undefined, error_raw: undefined,
    poll_descriptor: durableSnapshot as unknown as Record<string, unknown>, resumable: saved.length > 0 || Boolean(record.external_task_id) });
  const network = { route: record.network_route ?? 'system', configuredProviderOrigin: new URL(profile.baseUrl).origin,
    customProxyUrl: useSettingsStore.getState().generationNetworkSettings.customProxyUrl };
  for (const [index, output] of outputs.entries()) {
    signal?.throwIfAborted();
    if (output.kind === 'model') {
      assets.push(await importGeneratedModelOutput(id, index, output.source, network, { signal,
        onImport: () => saveJob(id, { phase: 'import' }) }));
      continue;
    }
    if (output.kind === 'text') { assets.push(output.text); continue; }
    const source = output.source.type === 'url' ? output.source.url : `data:${output.source.mime};base64,${output.source.data}`;
    const headers = output.source.type === 'url' ? output.source.headers ?? {} : {};
    if (isTauri()) {
      if (output.kind === 'image') assets.push((await prepareNodeImageSourceWithHeaders(source, headers, 512, network)).imagePath);
      else if (output.kind === 'video') assets.push(await persistVideoSource(source, headers, network));
      else {
        // Audio's existing downloader has no provider-header contract. Fetch only
        // unauthenticated outputs rather than dropping required authentication.
        if (Object.keys(headers).length) throw new Error('音频结果下载暂不支持自定义鉴权头，请使用公开下载链接');
        const data = await loadAudioSourceDataUrl(source);
        const mime = /^data:audio\/([^;,]+)/.exec(data)?.[1] ?? 'mpeg';
        const extension = mime === 'mpeg' ? 'mp3' : mime.replace(/[^a-z0-9]/gi, '');
        assets.push(await saveAudioSourceToPath(data, await join(await appDataDir(), `${id}-${index}.${extension}`)));
      }
    } else {
      const response = await fetch(source, { headers, signal, credentials: 'omit', redirect: 'error' });
      if (!response.ok) throw new Error(`下载生成结果失败：HTTP ${response.status}`);
      assets.push(await saveBrowserAsset(`${id}:${index}`, await response.blob()));
    }
  }
  const assetKinds = outputs.map((output) => output.kind);
  signal?.throwIfAborted();
  await saveJob(id, { status: 'succeeded', phase: 'done', result: assets[record.media_type === 'model' ? assetKinds.indexOf('model') : 0],
    local_result_missing: false,
    results: assets.map((source, index) => ({ kind: assetKinds[index], source, ...(assetKinds[index] === 'model' ? { importedModelId: source } : {}) })), error: null, error_category: undefined, error_status: undefined, error_raw: undefined, resumable: false,
    poll_descriptor: { ...durableSnapshot, failure: undefined, assetKinds, assets: isTauri() ? assets : assets.map((asset, index) => assetKinds[index] === 'text' || assetKinds[index] === 'model' ? asset : `${id}:${index}`) } as unknown as Record<string, unknown> });
}
function restoreOutputs(snapshot: JobSnapshot, key: string): Output[] {
  const profile = snapshot.profile;
  return (snapshot.outputs ?? []).map((output): Output => {
    if (output.kind === 'text') return output;
    const url = new URL(output.url); const headers: Record<string, string> = {};
    if (output.auth) {
      if (url.origin !== new URL(profile.baseUrl).origin) throw new Error('拒绝向不同源结果地址附加渠道密钥');
      if (!key && profile.auth.type !== 'none') throw new Error('查询需要重新配置渠道凭据');
      if (profile.auth.type === 'bearer') headers.Authorization = `Bearer ${key}`;
      else if (profile.auth.type === 'header') headers[profile.auth.name] = `${profile.auth.prefix ?? ''}${key}`;
      else if (profile.auth.type === 'query') url.searchParams.set(profile.auth.name, key);
    }
    return { kind: output.kind, source: { type: 'url', url: url.href, headers } };
  });
}
async function pollJob(id: string, snapshot: JobSnapshot, adapter: TemplateAdapter, credential: string, signal?: AbortSignal): Promise<void> {
  const op = resolveJobOperation(snapshot.profile, snapshot.input);
  if (op?.response.mode !== 'async') throw new Error('任务没有可恢复的轮询操作');
  const deadline = Date.now() + op.response.poll.timeoutMin * 60000;
  snapshot.failure = undefined;
  await saveJob(id, { status: 'running', phase: 'poll', resumable: true, error: null, error_category: undefined, error_status: undefined, error_raw: undefined,
    poll_descriptor: snapshot as unknown as Record<string, unknown> });
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const result = await adapter.poll(snapshot.input, jobs.get(id)!.external_task_id!, signal);
    if (result.state === 'done') { await materialize(id, snapshot.profile, result.outputs, snapshot, credential, signal); return; }
    if (result.state === 'failed') {
      // A query access/path failure does not establish that the accepted task
      // failed upstream. Keep its handle so corrected credentials can query it.
      const recoverable = result.error.category === 'credential' || result.error.retryable || (result.error.status !== undefined && [401, 403, 404].includes(result.error.status));
      await saveJob(id, { status: recoverable ? 'recoverable_wait' : 'failed', phase: 'poll',
        ...channelFailurePatch(result.error, credential, snapshot), resumable: recoverable });
      return;
    }
    await saveJob(id, { last_poll_at: Date.now(), ...(result.diagnostic ? channelFailurePatch(result.diagnostic, credential, snapshot) : {}) });
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, op.response.poll.intervalSec * 1000);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    await promise;
  }
  const lastError = jobs.get(id)?.error;
  await saveJob(id, { status: 'unknown', phase: 'poll', error: `查询超时；已保留上游任务 ID，请稍后查询，不会自动重新提交${lastError ? `\n${lastError}` : ''}`.slice(0, 2000), error_category: 'timeout', resumable: true });
}
function adapterFor(snapshot: JobSnapshot, credential: string, id: string): TemplateAdapter {
  return new TemplateAdapter({ profile: snapshot.profile, apiKey: credential, http: createChannelHttpTransport({
    ...useSettingsStore.getState().generationNetworkSettings, route: jobs.get(id)?.network_route ?? useSettingsStore.getState().generationNetworkSettings.route,
  }), resolveRef: resolveChannelRef, getSubmitResponse: () => snapshot.submit,
  onSubmitted: async (_, taskId, submit) => {
    snapshot.submit = submit;
    await saveJob(id, { status: 'running', phase: 'poll', external_task_id: taskId, resumable: true,
      poll_descriptor: snapshot as unknown as Record<string, unknown> });
  } });
}
async function exposeFailure(id: string, error: unknown, key?: string): Promise<void> {
  const record = jobs.get(id); if (!record) throw error;
  const snapshot = snapshotOf(record);
  const credential = key ?? jobCredentials.get(id) ?? getChannelCredential(snapshot.profile.id);
  const credentialFailure = credentialFailureOf(error);
  const message = (error instanceof Error ? error.message : String(error)).split(credential || '\u0000').join('[redacted]');
  const patch: Partial<GenerationJobStatus> = credentialFailure ? {
    status: record.external_task_id || snapshot.outputs?.length ? 'recoverable_wait' : 'failed',
    ...channelFailurePatch(classifyTransportError(error).error, credential, snapshot),
    resumable: Boolean(record.external_task_id || snapshot.outputs?.length),
  } : { status: record.external_task_id || record.status === 'materializing' ? 'recoverable_wait' : record.status === 'submitting' ? 'unknown' : 'failed',
    error: message, error_category: error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'channel',
    resumable: Boolean(record.external_task_id || snapshot.outputs?.length) };
  try { await saveJob(id, patch); } catch (storageError) {
    jobs.set(id, { ...record, ...patch, status: patch.status === 'failed' ? 'failed' : 'recoverable_wait', error_category: credentialFailure ? 'credential' : 'storage',
      error: `${patch.error ?? message}；任务状态保存失败：${redactChannelErrorText(storageError instanceof Error ? storageError.message : String(storageError), credential)}` });
  }
}
export async function submitChannelJob(profile: ChannelProfileV2, input: JobInput, credential = getChannelCredential(profile.id), signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  channelProfileSchema.parse(profile);
  previewChannelSmokeRequest(profile, input); // Validation before durable creation or paid request.
  validateChannelReferenceUrls(profile, input);
  if (profile.auth.type !== 'none' && !credential.trim()) throw new Error('渠道未配置 API Key');
  const id = `custom-local-channel-job-${crypto.randomUUID()}`;
  const model = profile.models.find((entry) => entry.id === input.modelId);
  const job = { ...input, ...(model?.modes ? { modeId: resolveModelMode(model, input.modeId).mode.id } : {}), jobId: id, channelId: profile.id };
  const snapshot: JobSnapshot = { version: 2, adapter: 'template',
    ...(profile.auth.type !== 'none' && !secretRefFromToken(credential) ? { credentialSource: 'transient' as const } : {}),
    profile, input: recoveryInput(job), submit: {} };
  const serialized = JSON.stringify(snapshot);
  if (credential && serialized.includes(JSON.stringify(credential).slice(1, -1))) throw new Error('任务快照含凭据，已阻止保存和提交');
  if (/data:[^,\s]+;base64,/i.test(serialized) || /"[A-Za-z0-9+/_-]{512,}={0,2}"/.test(serialized)) throw new Error('任务快照不能保存素材数据，请使用独立参考素材');
  await saveJob(id, { status: 'queued', phase: 'prepare', media_type: input.operation.startsWith('model') ? 'model' : input.operation.startsWith('video') ? 'video' : input.operation.startsWith('audio') ? 'audio' : 'image',
    provider_id: profile.id, model_id: input.modelId, network_route: useSettingsStore.getState().generationNetworkSettings.route,
    poll_descriptor: snapshot as unknown as Record<string, unknown>, resumable: false }, true);
  jobCredentials.set(id, credential);
  const work = (async () => {
    signal?.throwIfAborted();
    await saveJob(id, { status: 'submitting', phase: 'submit' });
    const adapter = adapterFor(snapshot, credential, id);
    const result = await adapter.submit(job, signal);
    if (result.state === 'done') await materialize(id, profile, result.outputs, snapshot, credential, signal);
    else if (result.state === 'submitted') await pollJob(id, snapshot, adapter, credential, signal);
    else await saveJob(id, { status: result.state === 'unknown' ? 'unknown' : 'failed',
      ...channelFailurePatch(result.error, credential, snapshot), resumable: Boolean(jobs.get(id)?.external_task_id) });
  })().catch((error: unknown) => exposeFailure(id, error, credential));
  active.set(id, work); void work.finally(() => {
    active.delete(id);
    if (!jobs.get(id)?.resumable) jobCredentials.delete(id);
  });
  return id;
}
export function getChannelJob(id: string): GenerationJobStatus {
  const record = jobs.get(id);
  if (!record) return { job_id: id, status: 'not_found', result: null, error: '任务未加载' };
  // Never expose profile/input/snapshot internals through the public polling DTO.
  const { poll_descriptor: _snapshot, ...publicRecord } = record;
  return publicRecord;
}
/** Never publish a saved successful browser result until its durable bytes have
 * a fresh process-local URL. Recovery-first and polling-first share this path.
 */
async function hydrateChannelJob(id: string, repairMissingAssets = false): Promise<GenerationJobStatus | undefined> {
  const cached = jobs.get(id);
  if (cached) return cached;
  const pending = loading.get(id);
  if (pending) {
    try { return await pending; }
    catch (error) { if (!repairMissingAssets || !(error instanceof StoredResultMissingError)) throw error; }
  }
  const hydration = (async () => {
    let record = isTauri() ? await getGenerationJobRecord(id) : readBrowserJobRecord(readBrowserJobRecords(browserJobsKey), id);
    if (!record || record.status === 'not_found') return undefined;
    if (record.status === 'succeeded' && !record.poll_descriptor && record.result && !record.result.startsWith('blob:')) {
      record = { ...record, results: normalizeGenerationJobResults(record) };
      jobs.set(id, record); return record;
    }
    const snapshot = snapshotOf(record);
    if (snapshot.failure) record = { ...record, error_status: snapshot.failure.status, error_raw: snapshot.failure.raw };
    if (record.status === 'succeeded' && record.local_result_missing) {
      const error = new StoredResultMissingError();
      if (!repairMissingAssets || (!record.external_task_id && !snapshot.outputs?.length)) throw error;
      record = { ...record, status: 'recoverable_wait', result: null, results: undefined, resumable: true, error: error.message };
      jobs.set(id, record); return record;
    }
    if (record.status === 'succeeded' && snapshot.assets?.length) {
      const defaultKind = snapshot.input.operation === 'chat' ? 'text' : record.media_type === 'video' || record.media_type === 'audio' || record.media_type === 'model' ? record.media_type : 'image';
      const results: GenerationJobResult[] = [];
      try { for (const [index, asset] of snapshot.assets.entries()) {
        const kind = snapshot.assetKinds?.[index] ?? defaultKind;
        const source = !isTauri() && kind !== 'text' && kind !== 'model' ? await restoreBrowserAsset(asset) : asset;
        results.push({ kind, source, ...(kind === 'model' ? { importedModelId: asset } : {}) });
      } } catch (error) {
        if (!isTauri()) results.forEach((result) => { if (result.source.startsWith('blob:')) URL.revokeObjectURL(result.source); });
        if (!repairMissingAssets || !(error instanceof StoredResultMissingError) || (!record.external_task_id && !snapshot.outputs?.length)) throw error;
        record = { ...record, status: 'recoverable_wait', result: null, results: undefined, resumable: true, error: error.message };
        jobs.set(id, record); return record;
      }
      record = { ...record, result: (record.media_type === 'model' ? results.find((result) => result.kind === 'model') : results[0])?.source, results };
    } else if (record.status === 'succeeded') record = { ...record, results: normalizeGenerationJobResults(record) };
    jobs.set(id, record);
    return record;
  })();
  loading.set(id, hydration);
  try { return await hydration; } finally { if (loading.get(id) === hydration) loading.delete(id); }
}
export async function getChannelJobAsync(id: string): Promise<GenerationJobStatus> {
  const record = await hydrateChannelJob(id);
  if (!record || active.has(id)) return getChannelJob(id);
  if (record.status === 'submitting' && !record.external_task_id) {
    await saveJob(id, { status: 'unknown', error: '应用在确认提交结果前关闭；上游可能已受理，不会自动重新提交', resumable: false });
  } else if ((record.status === 'running' && record.external_task_id)
    || (record.status === 'materializing' && snapshotOf(record).outputs?.length)) {
    void recoverChannelJob(id).catch((error: unknown) => exposeFailure(id, error));
  }
  return getChannelJob(id);
}
/** User clicks reauthorize: unlock this job's saved credentials without starting or replaying a request. */
export async function authorizeChannelJob(id: string): Promise<void> {
  const record = await hydrateChannelJob(id);
  if (!record) throw new Error('任务记录不存在');
  const snapshot = snapshotOf(record);
  const key = jobCredentials.get(id) ?? getChannelCredential(snapshot.profile.id);
  const refs = planCredentialMigration({ apiKey: key, ...snapshot.profile }, 'channel', snapshot.profile.id).refs;
  const unique = refs.filter((ref, i) => refs.findIndex((other) => other.namespace === ref.namespace && other.id === ref.id) === i);
  if (!unique.length) throw new Error('没有可重新授权的系统凭据，请到渠道设置中补充 API Key。');
  for (const ref of unique) if (!await retrySecretAccess(ref)) throw new Error('系统凭据已不存在，请到渠道设置中重新填写 API Key。');
}
/** Query/materialize only; never submits. A reloaded transient job requires an explicit replacement credential. */
export async function recoverChannelJob(id: string, signal?: AbortSignal, credential?: string): Promise<GenerationJobStatus> {
  if (active.has(id)) return getChannelJob(id);
  if (isTauri() && jobs.get(id)?.status === 'succeeded' && (await getGenerationJobRecord(id))?.local_result_missing) jobs.delete(id);
  const loaded = await hydrateChannelJob(id, true);
  if (!loaded) throw new Error('任务记录不存在');
  if (active.has(id)) return getChannelJob(id);
  const record = jobs.get(id)!;
  if (record.status === 'succeeded' || record.status === 'failed' || record.status === 'canceled') return getChannelJob(id);
  const snapshot = snapshotOf(record);
  if (!record.external_task_id && !snapshot.outputs?.length) throw new Error('任务没有上游 task ID 或已保存结果；不会重新提交');
  const key = credential ?? jobCredentials.get(id) ?? (snapshot.credentialSource === 'transient' ? '' : getChannelCredential(snapshot.profile.id));
  if (snapshot.profile.auth.type !== 'none' && !key.trim()) throw new Error('请先重新配置此任务的凭据再查询');
  const recoverySnapshot: JobSnapshot = credential === undefined ? snapshot : { ...snapshot, credentialSource: 'transient' };
  // Reserve the active attempt before awaiting persistence. Concurrent callers
  // must not start a second query while replacement ownership is being saved.
  const prepared = credential === undefined ? Promise.resolve() : saveJob(id, {
    poll_descriptor: recoverySnapshot as unknown as Record<string, unknown>,
  }).then(() => { jobCredentials.set(id, key); });
  const work = (async () => {
    await prepared;
    if (record.status === 'unknown' && record.external_task_id) await saveJob(id, { status: 'recoverable_wait', resumable: true });
    if (recoverySnapshot.outputs?.length) await materialize(id, recoverySnapshot.profile, restoreOutputs(recoverySnapshot, key), recoverySnapshot, key, signal);
    else await pollJob(id, recoverySnapshot, adapterFor(recoverySnapshot, key, id), key, signal);
  })().catch((error: unknown) => exposeFailure(id, error, key));
  active.set(id, work); void work.finally(() => {
    active.delete(id);
    if (!jobs.get(id)?.resumable) jobCredentials.delete(id);
  });
  try { await prepared; }
  catch (error) { throw new Error(redactChannelErrorText(error instanceof Error ? error.message : String(error), key)); }
  return getChannelJob(id);
}
