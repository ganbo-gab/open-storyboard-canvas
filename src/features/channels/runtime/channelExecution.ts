import { isTauri } from '@tauri-apps/api/core';
import { createGenerationJob, updateGenerationJob, getGenerationJobRecord, type GenerationJobStatus, type GenerateRequest } from '@/commands/ai';
import { prepareNodeImageSourceWithHeaders, persistVideoSource, loadAudioSourceDataUrl, saveAudioSourceToPath } from '@/commands/image';
import { appDataDir, join } from '@tauri-apps/api/path';
import { useSettingsStore } from '@/stores/settingsStore';
import type { ChannelProfileV2, JsonValue, OperationKind } from '../domain/profile';
import { channelProfileSchema } from '../domain/profile';
import { renderPreview } from '../domain/template';
import type { JobInput, JobRef, Output } from './types';
import { TemplateAdapter } from './templateAdapter';
import { createChannelHttpTransport, resolveChannelRef } from './transport';
import { getChannelCredential, useChannelStore } from '../store/channelStore';

interface JobSnapshot { version: 2; adapter: 'template'; profile: ChannelProfileV2; input: JobInput; submit: Record<string, unknown>; assets?: string[]; outputs?: SavedOutput[] }
type SavedOutput = { kind: 'text'; text: string } | { kind: 'image' | 'video' | 'audio'; url: string; auth: boolean };
const jobs = new Map<string, GenerationJobStatus>();
const active = new Map<string, Promise<void>>();
const loading = new Map<string, Promise<GenerationJobStatus | undefined>>();
const browserJobsKey = 'channel-generation-jobs-v2';
export function isChannelJobId(id: string): boolean { return id.startsWith('custom-local-channel-job-'); }

function readBrowserJobs(): Record<string, GenerationJobStatus> {
  const raw = localStorage.getItem(browserJobsKey);
  return raw ? JSON.parse(raw) as Record<string, GenerationJobStatus> : {};
}
async function saveJob(id: string, patch: Partial<GenerationJobStatus>, create = false): Promise<void> {
  const previous = jobs.get(id);
  const next: GenerationJobStatus = { job_id: id, status: 'queued', created_at: Date.now(), ...previous, ...patch, updated_at: Date.now() };
  // Keep accepted task handles in memory even if disk fails. Never report a persisted success before write completes.
  if (patch.external_task_id) jobs.set(id, next);
  if (isTauri()) {
    if (create) await createGenerationJob({ jobId: id, mediaType: next.media_type === 'video' ? 'video' : next.media_type === 'audio' ? 'audio' : 'image',
      providerId: next.provider_id!, modelId: next.model_id ?? undefined, status: next.status, phase: next.phase,
      pollDescriptor: next.poll_descriptor ?? undefined, networkRoute: next.network_route, resumable: next.resumable });
    else await updateGenerationJob({ jobId: id, status: next.status, phase: next.phase, externalTaskId: next.external_task_id ?? undefined,
      pollDescriptor: next.poll_descriptor ?? undefined, result: next.result ?? undefined, error: next.error ?? '',
      errorCategory: next.error_category ?? '', networkRoute: next.network_route, resumable: next.resumable, lastPollAt: next.last_poll_at ?? undefined });
  } else {
    const saved = readBrowserJobs(); saved[id] = next;
    localStorage.setItem(browserJobsKey, JSON.stringify(saved));
  }
  jobs.set(id, next);
}
function snapshotOf(record: GenerationJobStatus): JobSnapshot {
  const snapshot = record.poll_descriptor as unknown as JobSnapshot;
  if (snapshot?.version !== 2 || !snapshot.input || !snapshot.profile) throw new Error('任务缺少 v2 恢复快照，不会重新提交');
  channelProfileSchema.parse(snapshot.profile);
  return snapshot;
}

/** Only explicitly declared parameter keys flow into templates; transport hints are never merged. */
export function channelJobFromRequest(profile: ChannelProfileV2, modelId: string, request: GenerateRequest, media: 'image' | 'video'): JobInput {
  const model = profile.models.find((entry) => entry.id === modelId);
  if (!model) throw new Error('模型不在渠道声明中');
  const refs: JobRef[] = (['image', 'video', 'audio'] as const).flatMap((kind) => {
    const sources = kind === 'image' ? request.reference_images : kind === 'video' ? request.reference_videos : request.reference_audios;
    return (sources ?? []).map((path, index) => ({ kind, assetId: `${kind}-${index}`, path,
      mime: /^data:([^;,]+)/.exec(path)?.[1] ?? (kind === 'image' ? 'image/png' : kind === 'video' ? 'video/mp4' : 'audio/mpeg') }));
  });
  const operation: OperationKind = media === 'video' ? 'video.generate' : refs.some((ref) => ref.kind === 'image') ? 'image.edit' : 'image.generate';
  const params: Record<string, JsonValue> = {};
  for (const param of model.params) {
    const value = request.extra_params?.[param.key];
    if (value !== undefined) params[param.key] = value as JsonValue;
  }
  return { jobId: '', channelId: profile.id, modelId, operation, prompt: request.prompt, params, refs, count: 1 };
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
  request.onsuccess = () => request.result instanceof Blob ? resolve(request.result) : reject(new Error('本地结果素材不存在'));
  request.onerror = () => reject(request.error);
  try { return URL.createObjectURL(await promise); } finally { db.close(); }
}
async function materialize(id: string, profile: ChannelProfileV2, outputs: Output[], snapshot: JobSnapshot, credential = getChannelCredential(profile.id)): Promise<void> {
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
  const durableSnapshot = { ...snapshot, outputs: saved };
  await saveJob(id, { status: 'materializing', phase: 'download', poll_descriptor: durableSnapshot as unknown as Record<string, unknown>, resumable: saved.length > 0 || Boolean(record.external_task_id) });
  const network = { route: record.network_route ?? 'system', configuredProviderOrigin: new URL(profile.baseUrl).origin,
    customProxyUrl: useSettingsStore.getState().generationNetworkSettings.customProxyUrl };
  for (const [index, output] of outputs.entries()) {
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
      const response = await fetch(source, { headers, credentials: 'omit', redirect: 'error' });
      if (!response.ok) throw new Error(`下载生成结果失败：HTTP ${response.status}`);
      assets.push(await saveBrowserAsset(`${id}:${index}`, await response.blob()));
    }
  }
  await saveJob(id, { status: 'succeeded', phase: 'done', result: assets[0], error: null, resumable: false,
    poll_descriptor: { ...snapshot, assets: isTauri() || snapshot.input.operation === 'chat' ? assets : assets.map((_, index) => `${id}:${index}`) } as unknown as Record<string, unknown> });
}
function restoreOutputs(snapshot: JobSnapshot): Output[] {
  const profile = snapshot.profile; const key = getChannelCredential(profile.id);
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
  const op = snapshot.profile.operations[snapshot.input.operation];
  if (op?.response.mode !== 'async') throw new Error('任务没有可恢复的轮询操作');
  const deadline = Date.now() + op.response.poll.timeoutMin * 60000;
  await saveJob(id, { status: 'running', phase: 'poll', resumable: true });
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const result = await adapter.poll(snapshot.input, jobs.get(id)!.external_task_id!, signal);
    if (result.state === 'done') { await materialize(id, snapshot.profile, result.outputs, snapshot, credential); return; }
    if (result.state === 'failed') {
      // A query access/path failure does not establish that the accepted task
      // failed upstream. Keep its handle so corrected credentials can query it.
      const recoverable = result.error.status !== undefined && [401, 403, 404].includes(result.error.status);
      await saveJob(id, { status: recoverable ? 'recoverable_wait' : 'failed', phase: 'poll',
        error: result.error.message.split(credential || '\u0000').join('[redacted]'), error_category: result.error.category, resumable: recoverable });
      return;
    }
    await saveJob(id, { last_poll_at: Date.now() });
    const { promise, resolve } = Promise.withResolvers<void>(); setTimeout(resolve, op.response.poll.intervalSec * 1000); await promise;
  }
  await saveJob(id, { status: 'unknown', phase: 'poll', error: '查询超时；已保留上游任务 ID，请稍后查询，不会自动重新提交', error_category: 'timeout', resumable: true });
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
  const credential = key ?? getChannelCredential(snapshotOf(record).profile.id);
  const message = (error instanceof Error ? error.message : String(error)).split(credential || '\u0000').join('[redacted]');
  const patch: Partial<GenerationJobStatus> = { status: record.external_task_id || record.status === 'materializing' ? 'recoverable_wait' : record.status === 'submitting' ? 'unknown' : 'failed',
    error: message, error_category: 'channel', resumable: Boolean(record.external_task_id || snapshotOf(record).outputs?.length) };
  try { await saveJob(id, patch); } catch (storageError) {
    jobs.set(id, { ...record, ...patch, status: patch.status === 'failed' ? 'failed' : 'recoverable_wait', error_category: 'storage',
      error: `${message}；任务状态保存失败：${storageError instanceof Error ? storageError.message : String(storageError)}` });
  }
}
export async function submitChannelJob(profile: ChannelProfileV2, input: JobInput, credential = getChannelCredential(profile.id), signal?: AbortSignal): Promise<string> {
  channelProfileSchema.parse(profile);
  renderPreview(profile, input); // Validation before durable creation or paid request.
  if (profile.auth.type !== 'none' && !credential.trim()) throw new Error('渠道未配置 API Key');
  const id = `custom-local-channel-job-${crypto.randomUUID()}`;
  const job = { ...input, jobId: id, channelId: profile.id };
  const snapshot: JobSnapshot = { version: 2, adapter: 'template', profile, input: { ...job, prompt: '', messages: undefined, tools: undefined, toolChoice: undefined, refs: [] }, submit: {} };
  const serialized = JSON.stringify(snapshot);
  if (credential && serialized.includes(JSON.stringify(credential).slice(1, -1))) throw new Error('任务快照含凭据，已阻止保存和提交');
  if (/data:[^,\s]+;base64,/i.test(serialized) || /"[A-Za-z0-9+/_-]{512,}={0,2}"/.test(serialized)) throw new Error('任务快照不能保存素材数据，请使用独立参考素材');
  await saveJob(id, { status: 'queued', phase: 'prepare', media_type: input.operation.startsWith('video') ? 'video' : input.operation.startsWith('audio') ? 'audio' : 'image',
    provider_id: profile.id, model_id: input.modelId, network_route: useSettingsStore.getState().generationNetworkSettings.route,
    poll_descriptor: snapshot as unknown as Record<string, unknown>, resumable: false }, true);
  const work = (async () => {
    await saveJob(id, { status: 'submitting', phase: 'submit' });
    const adapter = adapterFor(snapshot, credential, id);
    const result = await adapter.submit(job, signal);
    if (result.state === 'done') await materialize(id, profile, result.outputs, snapshot, credential);
    else if (result.state === 'submitted') await pollJob(id, snapshot, adapter, credential, signal);
    else await saveJob(id, { status: result.state === 'unknown' ? 'unknown' : 'failed', error: result.error.message.split(credential || '\u0000').join('[redacted]'),
      error_category: result.error.category, resumable: Boolean(jobs.get(id)?.external_task_id) });
  })().catch((error: unknown) => exposeFailure(id, error, credential));
  active.set(id, work); void work.finally(() => active.delete(id));
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
async function hydrateChannelJob(id: string): Promise<GenerationJobStatus | undefined> {
  const cached = jobs.get(id);
  if (cached) return cached;
  const pending = loading.get(id);
  if (pending) return pending;
  const hydration = (async () => {
    let record = isTauri() ? await getGenerationJobRecord(id) : readBrowserJobs()[id];
    if (!record) return undefined;
    if (!isTauri() && record.status === 'succeeded') {
      const snapshot = snapshotOf(record);
      if (snapshot.assets?.length && record.media_type !== 'unknown' && snapshot.input.operation !== 'chat') {
        record = { ...record, result: await restoreBrowserAsset(snapshot.assets[0]) };
      }
    }
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
/** Query/materialize only; never calls submit, including unknown tasks. */
export async function recoverChannelJob(id: string, signal?: AbortSignal): Promise<GenerationJobStatus> {
  if (active.has(id)) return getChannelJob(id);
  const loaded = await hydrateChannelJob(id);
  if (!loaded) throw new Error('任务记录不存在');
  if (active.has(id)) return getChannelJob(id);
  const record = jobs.get(id)!; const snapshot = snapshotOf(record);
  if (record.status === 'succeeded' || record.status === 'failed' || record.status === 'canceled') return getChannelJob(id);
  if (!record.external_task_id && !snapshot.outputs?.length) throw new Error('任务没有上游 task ID 或已保存结果；不会重新提交');
  const key = getChannelCredential(snapshot.profile.id);
  if (snapshot.profile.auth.type !== 'none' && !key) throw new Error('请先重新配置此渠道的凭据再查询');
  const work = (async () => {
    if (snapshot.outputs?.length) await materialize(id, snapshot.profile, restoreOutputs(snapshot), snapshot);
    else await pollJob(id, snapshot, adapterFor(snapshot, key, id), key, signal);
  })().catch((error: unknown) => exposeFailure(id, error));
  active.set(id, work); void work.finally(() => active.delete(id));
  return getChannelJob(id);
}
