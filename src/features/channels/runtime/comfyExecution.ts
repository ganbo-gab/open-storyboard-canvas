import { isTauri } from '@tauri-apps/api/core';
import { createGenerationJob, getGenerationJobRecord, updateGenerationJob, normalizeGenerationJobResults, type GenerateRequest, type GenerationJobStatus, type GenerationJobResult } from '@/commands/ai';
import { prepareNodeImageSourceWithHeaders, persistVideoSource } from '@/commands/image';
import { useCustomProvidersStore, type CustomProviderConfig } from '@/stores/customProvidersStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { parseComfyUIConfig, prepareComfyUIWorkflow, suggestComfyUIBindings } from '@/features/canvas/infrastructure/comfyuiGateway';
import { createComfyUIAdapter, createComfyUIJob, type ComfyUIJobSnapshot, type ComfyUIDependencies, type ComfyUIAdapter } from '../adapters/comfyui/adapter';
import type { ComfyUIBindings } from '../adapters/comfyui/bindings';
import { applyComfyUIAuth, resolveComfyUIProviderAuth, resolveComfyUIUrls, type ComfyUIAuth } from '../adapters/comfyui/url';
import { asRecord, nodeInputs, setInput } from '../adapters/comfyui/workflow';
import { createChannelHttpTransport } from './transport';
import type { JobInput, JsonValue, Output } from './types';
import { comfyAdapterSnapshotSchema, comfyExecutionSnapshotSchema, type ComfyRecoveryRoute } from './comfySnapshot';
import { z } from 'zod';
import { secretRefFromToken, secretStore, resolveSecretTokens, resolveSecretValue } from '@/features/secrets/secretStore';
import { createSecretResponseRedactor } from '@/features/secrets/transportSecrets';
import { StoredResultMissingError } from './storedResult';
import { openComfyProgressSocket } from './comfyProgressTransport';
import { readBrowserJobRecords, readBrowserJobRecord } from './browserJobRecords';

interface ComfyExecutionSnapshot {
  version: 2;
  adapter: 'comfyui';
  input: JobInput;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  authPrefix: string;
  headerNames: string[];
  queryNames: string[];
  outputs?: { kind: 'image' | 'video'; url: string }[];
  assets?: string[];
  recoveryRoute?: ComfyRecoveryRoute;
}
interface Secrets { apiKey: string; comfyOrgKey?: string; headers: Record<string, string>; query: Record<string, string> }
const jobs = new Map<string, GenerationJobStatus>();
const active = new Map<string, Promise<void>>();
const loads = new Map<string, Promise<void>>();
const operations = new Map<string, AbortController>();
const routeChanges = new Map<string, Promise<GenerationJobStatus>>();
const credentials = new Map<string, Secrets>();
const browserJobsKey = 'comfy-channel-generation-jobs-v2';
const terminal = (status: GenerationJobStatus['status']) => ['succeeded', 'failed', 'canceled'].includes(status);
export function isComfyChannelJobId(id: string): boolean { return id.startsWith('custom-local-comfy-v2-'); }

function descriptor(record: GenerationJobStatus): ComfyExecutionSnapshot {
  const parsed = comfyExecutionSnapshotSchema.safeParse(record.poll_descriptor);
  if (!parsed.success || !parsed.data.input.params.comfyuiSnapshot) throw new Error('任务缺少 ComfyUI 执行快照；不会重新提交');
  return parsed.data;
}
function adapterSnapshot(snapshot: ComfyExecutionSnapshot): ComfyUIJobSnapshot {
  const original = comfyAdapterSnapshotSchema.parse(snapshot.input.params.comfyuiSnapshot);
  return snapshot.recoveryRoute ? { ...original, urls: resolveComfyUIUrls(snapshot.recoveryRoute.baseUrl), auth: snapshot.recoveryRoute.auth } : original;
}
function executionInput(snapshot: ComfyExecutionSnapshot): JobInput {
  return { ...snapshot.input, params: { ...snapshot.input.params, comfyuiSnapshot: JSON.parse(JSON.stringify(adapterSnapshot(snapshot))) as JsonValue } };
}
function readSecrets(cfg: CustomProviderConfig, model?: string): Secrets {
  const raw = cfg.comfyWorkflows?.workflows.find((entry) => entry.id === (model ?? cfg.comfyWorkflows?.selectedWorkflowId))?.config ?? asRecord(cfg.extraParams?.comfyui);
  return { apiKey: cfg.apiKey?.trim() ?? '', headers: { ...cfg.extraHeaders }, query: { ...cfg.queryParams },
    comfyOrgKey: typeof raw?.comfyOrgKey === 'string' ? raw.comfyOrgKey : typeof cfg.extraParams?.comfyOrgKey === 'string' ? cfg.extraParams.comfyOrgKey : undefined };
}
function secretsFor(id: string, snapshot: ComfyExecutionSnapshot): Secrets {
  const memory = credentials.get(id);
  if (memory) return memory;
  const cfg = useCustomProvidersStore.getState().providers.find((entry) => entry.id === (snapshot.recoveryRoute?.providerId ?? snapshot.input.channelId));
  const auth = adapterSnapshot(snapshot).auth;
  const requiresCredentials = auth.mode !== 'none' || (snapshot.recoveryRoute?.headerNames ?? snapshot.headerNames).length > 0 || (snapshot.recoveryRoute?.queryNames ?? snapshot.queryNames).length > 0;
  if (requiresCredentials && (!cfg || resolveComfyUIUrls(cfg.baseUrl).base !== adapterSnapshot(snapshot).urls.base)) {
    throw new Error('恢复鉴权任务需要原地址的凭据；请显式选择 ComfyUI 恢复连接');
  }
  const secrets = cfg ? readSecrets(cfg) : { apiKey: '', headers: {}, query: {} };
  return secrets;
}
function keyWithPrefix(snapshot: ComfyExecutionSnapshot, secrets: Secrets): string {
  const prefix = snapshot.recoveryRoute?.authPrefix ?? snapshot.authPrefix;
  return secrets.apiKey && prefix ? `${prefix} ${secrets.apiKey}` : secrets.apiKey;
}
function redact(message: string, secrets?: Secrets): string {
  let text = message;
  for (const value of [secrets?.apiKey, secrets?.comfyOrgKey, ...Object.values(secrets?.headers ?? {}), ...Object.values(secrets?.query ?? {})]) {
    if (value) text = text.split(value).join('[redacted]');
  }
  return text.replace(/data:[^\s,]+;base64,[a-z\d+/=]+/gi, '[media omitted]');
}
function assertSafe(value: unknown, secrets: Secrets): void {
  const serialized = JSON.stringify(value);
  if (/data:[^\s,]+;base64,/i.test(serialized)) throw new Error('执行快照不能包含内嵌媒体，请使用服务器文件名');
  for (const key of [secrets.apiKey, secrets.comfyOrgKey, ...Object.entries(secrets.headers).filter(([name]) => /authorization|key|token|secret|cookie/i.test(name)).map(([, item]) => item),
    ...Object.entries(secrets.query).filter(([name]) => /key|token|secret|signature|credential|password/i.test(name)).map(([, item]) => item)]) {
    if (key && serialized.includes(key)) throw new Error('执行快照含凭据，已阻止保存和提交');
  }
  const visit = (item: unknown): void => {
    if (!item || typeof item !== 'object') return;
    for (const [name, child] of Object.entries(item)) {
      if (/^(?:api_key|api_key_comfy_org|authorization|password|access_token|secret)$/i.test(name) && child) throw new Error('工作流含凭据，请改用渠道鉴权配置');
      visit(child);
    }
  };
  visit(value);
}
class ComfyPersistenceError extends Error {
  constructor(cause: unknown) {
    super(`任务状态保存失败：${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'ComfyPersistenceError';
  }
}
async function save(id: string, patch: Partial<GenerationJobStatus>, create = false): Promise<void> {
  const next: GenerationJobStatus = { job_id: id, status: 'queued', created_at: Date.now(), ...jobs.get(id), ...patch, updated_at: Date.now() };
  // An accepted handle must survive even a failed disk write in this process.
  if (patch.external_task_id || patch.result_url || next.status === 'failed' || next.status === 'canceled') jobs.set(id, next);
  try {
    if (isTauri()) {
      if (create) await createGenerationJob({ jobId: id, mediaType: next.media_type === 'video' ? 'video' : 'image', providerId: next.provider_id!, modelId: next.model_id ?? undefined,
        status: next.status, phase: next.phase, pollDescriptor: next.poll_descriptor ?? undefined, networkRoute: next.network_route, resumable: next.resumable });
      else await updateGenerationJob({ jobId: id, status: next.status, phase: next.phase, externalTaskId: next.external_task_id ?? undefined,
        pollDescriptor: next.poll_descriptor ?? undefined, result: next.result ?? undefined, resultUrl: next.result_url ?? undefined,
        error: next.error ?? '', errorCategory: next.error_category ?? '',
        networkRoute: next.network_route, resumable: next.resumable, lastPollAt: next.last_poll_at ?? undefined });
    } else {
      const records = readBrowserJobRecords(browserJobsKey);
      // Blob URLs are process-local; only IndexedDB keys belong in durable records.
      records[id] = { ...next, result: next.status === 'succeeded' ? null : next.result, results: undefined,
        progress: undefined, current_node: undefined, step: undefined, total_steps: undefined, progress_transport: undefined };
      localStorage.setItem(browserJobsKey, JSON.stringify(records));
    }
  } catch (cause) { throw new ComfyPersistenceError(cause); }
  jobs.set(id, next);
}

/** Legacy config is detached; legacy geometry/H3 semantics remain authoritative. */
export function comfyChannelJobFromRequest(cfg: CustomProviderConfig, model: string, request: GenerateRequest, id: string): ComfyExecutionSnapshot {
  const config = parseComfyUIConfig(cfg, model);
  if (request.reference_videos?.length || request.reference_audios?.length) throw new Error('ComfyUI 参考素材目前只支持图片');
  const legacyBindings = { ...suggestComfyUIBindings(config.workflow), ...Object.fromEntries(Object.entries(config.bindings).filter(([name, value]) => name !== 'images' && value)) };
  legacyBindings.images = config.bindings.images.length ? config.bindings.images : suggestComfyUIBindings(config.workflow).images;
  const count = request.reference_images?.length ?? 0;
  const workflow = prepareComfyUIWorkflow(config, request, Array.from({ length: count }, (_, index) => `reference-${index + 1}.png`));
  // Upload names are not known yet. Keep original server filenames in the snapshot.
  for (const binding of legacyBindings.images) setInput(workflow, binding, nodeInputs(config.workflow, binding.nodeId)[binding.input]);
  if (legacyBindings.prompt) setInput(workflow, legacyBindings.prompt, nodeInputs(config.workflow, legacyBindings.prompt.nodeId)[legacyBindings.prompt.input]);
  const bindings: ComfyUIBindings = { prompt: null, negativePrompt: null, seed: null, width: null, height: null, duration: null, output: null };
  const params: Record<string, JsonValue> = {};
  for (const name of ['prompt', 'seed', 'width', 'height', 'duration', 'resolution', 'aspectRatio'] as const) {
    const binding = legacyBindings[name];
    if (!binding) continue;
    Object.assign(bindings, { [name]: binding });
    if (name !== 'prompt') params[name] = nodeInputs(workflow, binding.nodeId)[binding.input] as JsonValue;
  }
  legacyBindings.images.forEach((binding, index) => { bindings[`image${index + 1}`] = binding; });
  if (config.outputNodeIds[0]) bindings.output = { nodeId: config.outputNodeIds[0], input: '$output' };
  const { config: auth, prefix: authPrefix } = resolveComfyUIProviderAuth(cfg);
  const secrets = readSecrets(cfg, model);
  const job = createComfyUIJob({ jobId: id, channelId: cfg.id, modelId: model, prompt: request.prompt, params,
    operation: config.mediaType === 'video' ? 'video.generate' : count ? 'image.edit' : 'image.generate', refs: (request.reference_images ?? []).map((path, index) => ({
      kind: 'image', assetId: `image-${index}`, path, mime: /^data:([^;,]+)/.exec(path)?.[1] ?? 'image/png',
    })), count: 1 }, { baseUrl: cfg.baseUrl, workflow, bindings, auth, mediaKind: config.mediaType,
    comfyOrgKeyRequired: Boolean(secrets.comfyOrgKey), outputNodeIds: config.outputNodeIds });
  const snapshot: ComfyExecutionSnapshot = { version: 2, adapter: 'comfyui', input: { ...job, prompt: '', refs: [] }, pollIntervalMs: config.pollIntervalMs, pollTimeoutMs: config.pollTimeoutMs,
    authPrefix, headerNames: Object.keys(cfg.extraHeaders ?? {}), queryNames: Object.keys(cfg.queryParams ?? {}) };
  assertSafe(snapshot, secrets);
  return snapshot;
}

function dependencies(id: string, snapshot: ComfyExecutionSnapshot, secrets: Secrets): ComfyUIDependencies {
  const network = { ...useSettingsStore.getState().generationNetworkSettings, route: jobs.get(id)?.network_route ?? useSettingsStore.getState().generationNetworkSettings.route };
  const http = createChannelHttpTransport(network);
  const base = adapterSnapshot(snapshot);
  const wsSupported = network.route === 'system' && !['bearer', 'header'].includes(base.auth.mode)
    && !(snapshot.recoveryRoute?.headerNames ?? snapshot.headerNames).length;
  return { getSecrets: async () => ({ apiKey: keyWithPrefix(snapshot, secrets), comfyOrgKey: secrets.comfyOrgKey }),
    ...(wsSupported ? { ws: (async (source, callbacks, headers) => {
      const url = new URL(source);
      const expected = new URL(base.urls.ws);
      if (url.origin !== expected.origin) throw new Error('ComfyUI WebSocket origin mismatch');
      for (const name of snapshot.recoveryRoute?.queryNames ?? snapshot.queryNames) {
        if (secrets.query[name] === undefined) throw new Error('ComfyUI query credential missing');
        url.searchParams.set(name, secrets.query[name]);
      }
      return openComfyProgressSocket(url.href, callbacks, headers);
    }) satisfies NonNullable<ComfyUIDependencies['ws']> } : {}),
    onProgress: (jobId, progress) => {
      const current = jobs.get(jobId);
      if (!current || terminal(current.status) || current.status === 'materializing') return;
      jobs.set(jobId, { ...current, progress_transport: progress ? 'websocket' : 'polling',
        progress: progress?.progress, current_node: progress?.currentNode ?? undefined,
        step: progress?.step, total_steps: progress?.totalSteps });
    },
    http: async (request) => {
      const url = new URL(request.url);
      if (url.origin !== new URL(adapterSnapshot(snapshot).urls.base).origin) throw new Error('拒绝向不同源地址发送 ComfyUI 凭据');
      for (const name of snapshot.recoveryRoute?.queryNames ?? snapshot.queryNames) {
        if (secrets.query[name] === undefined) throw new Error(`请重新配置 ComfyUI 查询参数 ${name}`);
        url.searchParams.set(name, secrets.query[name]);
      }
      const headers = { ...request.headers };
      if (request.body?.mode === 'json') headers['Content-Type'] = 'application/json';
      for (const name of snapshot.recoveryRoute?.headerNames ?? snapshot.headerNames) {
        if (secrets.headers[name] === undefined) throw new Error(`请重新配置 ComfyUI 请求头 ${name}`);
        if (request.body?.mode === 'multipart' && /^(content-type|content-length)$/i.test(name)) continue;
        headers[name] = secrets.headers[name];
      }
      const body = request.body?.mode === 'json' ? { mode: 'json' as const, json: request.body.json as JsonValue }
        : request.body?.mode === 'multipart' ? { mode: 'multipart' as const, fields: request.body.fields, files: request.body.files.map(({ name, file }) => ({ name, path: file.path,
          filename: `canvas-${file.assetId}.${file.mime.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png'}`, mime: file.mime })) } : { mode: 'none' as const };
      const response = await http({ ...request, url: url.href, headers, body });
      let payload: unknown;
      try { payload = JSON.parse(response.bodyText ?? ''); } catch { payload = { error: response.bodyText ?? '' }; }
      return { status: response.status, body: payload };
    } };
}
async function assetDatabase(): Promise<IDBDatabase> {
  const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
  const request = indexedDB.open('comfy-channel-assets-v2', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('assets');
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  return promise;
}
async function browserAsset(key: string, blob?: Blob): Promise<string> {
  const db = await assetDatabase();
  try {
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    const transaction = db.transaction('assets', blob ? 'readwrite' : 'readonly');
    const request = blob ? transaction.objectStore('assets').put(blob, key) : transaction.objectStore('assets').get(key);
    let stored = blob;
    request.onsuccess = () => { if (!blob) stored = request.result as Blob; };
    transaction.oncomplete = () => stored instanceof Blob ? resolve(URL.createObjectURL(stored)) : reject(new StoredResultMissingError());
    transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error);
    return await promise;
  } finally { db.close(); }
}
function authorizedOutput(snapshot: ComfyExecutionSnapshot, secrets: Secrets, source: string): { url: string; headers: Record<string, string> } {
  const url = new URL(source);
  const base = adapterSnapshot(snapshot);
  if (url.origin !== new URL(base.urls.base).origin) return { url: source, headers: {} };
  const auth: ComfyUIAuth = base.auth.mode === 'none' ? { mode: 'none' } : base.auth.mode === 'bearer'
    ? { mode: 'bearer', value: keyWithPrefix(snapshot, secrets) } : { mode: base.auth.mode, name: 'name' in base.auth ? base.auth.name : '', value: keyWithPrefix(snapshot, secrets) };
  for (const name of snapshot.recoveryRoute?.queryNames ?? snapshot.queryNames) {
    if (secrets.query[name] === undefined) throw new Error(`请重新配置 ComfyUI 查询参数 ${name}`);
    url.searchParams.set(name, secrets.query[name]);
  }
  const authorized = applyComfyUIAuth(url.href, auth);
  for (const name of snapshot.recoveryRoute?.headerNames ?? snapshot.headerNames) {
    if (secrets.headers[name] === undefined) throw new Error(`请重新配置 ComfyUI 请求头 ${name}`);
    if (!/^(content-type|content-length)$/i.test(name)) authorized.headers[name] = secrets.headers[name];
  }
  return authorized;
}
async function materialize(id: string, snapshot: ComfyExecutionSnapshot, secrets: Secrets, outputs?: Output[], signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (outputs) {
    snapshot.outputs = outputs.map((output) => {
      if (output.kind !== 'image' && output.kind !== 'video' || output.source.type !== 'url') throw new Error('ComfyUI 返回了不支持的输出');
      const url = new URL(output.source.url);
      const auth = adapterSnapshot(snapshot).auth;
      if (url.origin === new URL(adapterSnapshot(snapshot).urls.base).origin) {
        if (auth.mode === 'query') url.searchParams.delete(auth.name);
        for (const name of snapshot.recoveryRoute?.queryNames ?? snapshot.queryNames) url.searchParams.delete(name);
      }
      return { kind: output.kind, url: url.href };
    });
    assertSafe(snapshot, secrets);
  }
  if (!snapshot.outputs?.length) throw new Error('任务没有可恢复的输出地址');
  await save(id, { status: 'materializing', phase: 'download', poll_descriptor: snapshot as unknown as Record<string, unknown>,
    result_url: snapshot.outputs[0].url, resumable: true });
  const assets: string[] = [];
  const network = { ...useSettingsStore.getState().generationNetworkSettings, route: jobs.get(id)?.network_route ?? 'system', configuredProviderOrigin: new URL(adapterSnapshot(snapshot).urls.base).origin };
  for (const [index, output] of snapshot.outputs.entries()) {
    signal?.throwIfAborted();
    const source = authorizedOutput(snapshot, secrets, output.url);
    if (isTauri()) assets.push(output.kind === 'video' ? await persistVideoSource(source.url, source.headers, network)
      : (await prepareNodeImageSourceWithHeaders(source.url, source.headers, 512, network)).imagePath);
    else {
      const redactor = await createSecretResponseRedactor(source);
      const url = await resolveSecretTokens(source.url, true);
      const headers = await resolveSecretValue(source.headers);
      signal?.throwIfAborted();
      const response = await fetch(url, { headers, signal, credentials: 'omit', redirect: 'error' }).catch((cause: unknown) => {
        throw new Error(redact(redactor.redact(cause instanceof Error ? cause.message : String(cause)), secrets));
      });
      if (!response.ok) throw new Error(`下载 ComfyUI 结果失败：HTTP ${response.status}`);
      assets.push(await browserAsset(`${id}:${index}`, await response.blob()));
    }
    signal?.throwIfAborted();
  }
  await save(id, { status: 'succeeded', phase: 'done', result: assets[0], progress: undefined, current_node: undefined, step: undefined, total_steps: undefined,
    results: assets.map((source, index) => ({ kind: snapshot.outputs![index].kind, source })),
    error: null, error_category: null, resumable: false, local_result_missing: false,
    poll_descriptor: { ...snapshot, assets: isTauri() ? assets : assets.map((_, index) => `${id}:${index}`) } as unknown as Record<string, unknown> });
}
async function poll(id: string, snapshot: ComfyExecutionSnapshot, secrets: Secrets, signal?: AbortSignal, submittedAdapter?: ComfyUIAdapter): Promise<void> {
  const adapter = submittedAdapter ?? createComfyUIAdapter(dependencies(id, snapshot, secrets));
  try {
    const deadline = Date.now() + snapshot.pollTimeoutMs;
    await save(id, { status: 'running', phase: 'poll', error: null, resumable: true,
      progress_transport: jobs.get(id)?.progress_transport ?? 'polling' });
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const result = await adapter.poll!(executionInput(snapshot), jobs.get(id)!.external_task_id!, signal);
      signal?.throwIfAborted();
      if (result.state === 'done') { await materialize(id, snapshot, secrets, result.outputs, signal); return; }
      if (result.state === 'failed') {
        const recoverable = result.error.retryable || ['auth', 'not_found', 'network'].includes(result.error.category);
        await save(id, { status: recoverable ? 'recoverable_wait' : 'failed', phase: 'poll', error: redact(result.error.message, secrets),
          error_category: result.error.category, resumable: recoverable });
        return;
      }
      await save(id, { last_poll_at: Date.now() });
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
      const timer = setTimeout(finish, snapshot.pollIntervalMs);
      const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason); };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      await promise;
    }
    await save(id, { status: 'unknown', phase: 'poll', error: '查询超时；已保留上游任务 ID，不会自动重新提交', error_category: 'timeout', resumable: true });
  } finally { adapter.dispose(id); }
}
async function failure(id: string, cause: unknown, secrets?: Secrets): Promise<void> {
  const record = jobs.get(id);
  if (!record) throw cause;
  const status = terminal(record.status) ? record.status : record.external_task_id ? 'recoverable_wait' : record.status === 'submitting' ? 'unknown' : 'failed';
  const patch: Partial<GenerationJobStatus> = { status, error: redact(cause instanceof Error ? cause.message : String(cause), secrets),
    error_category: cause instanceof ComfyPersistenceError ? 'storage' : 'comfyui', resumable: !terminal(status) && Boolean(record.external_task_id || record.result_url) };
  try { await save(id, patch); } catch { jobs.set(id, { ...record, ...patch, error_category: 'storage' }); }
}
function start(id: string, work: (signal: AbortSignal) => Promise<void>, secrets?: Secrets): Promise<void> {
  const controller = new AbortController();
  const task = Promise.resolve().then(() => work(controller.signal)).catch((cause: unknown) => {
    if (!controller.signal.aborted) return failure(id, cause, secrets);
  });
  active.set(id, task);
  operations.set(id, controller);
  void task.finally(() => {
    if (active.get(id) === task) { active.delete(id); operations.delete(id); credentials.delete(id); }
  }).catch(() => undefined);
  return task;
}
export async function submitComfyChannelJob(cfg: CustomProviderConfig, model: string, request: GenerateRequest): Promise<string> {
  const id = `custom-local-comfy-v2-${crypto.randomUUID()}`;
  const snapshot = comfyChannelJobFromRequest(cfg, model, request, id);
  const secrets = readSecrets(cfg, model);
  const refs = (request.reference_images ?? []).map((path, index) => ({ kind: 'image' as const, assetId: `image-${index}`, path, mime: /^data:([^;,]+)/.exec(path)?.[1] ?? 'image/png' }));
  // The adapter preview validates all bindings before durable creation or upload.
  createComfyUIAdapter(dependencies(id, snapshot, secrets)).preview!({ ...snapshot.input, prompt: request.prompt, refs });
  await save(id, { status: 'queued', phase: 'prepare', provider_id: cfg.id, model_id: model, media_type: adapterSnapshot(snapshot).mediaKind,
    poll_descriptor: snapshot as unknown as Record<string, unknown>, network_route: useSettingsStore.getState().generationNetworkSettings.route, resumable: false }, true);
  credentials.set(id, secrets);
  start(id, async (signal) => {
    await save(id, { status: 'submitting', phase: 'submit' });
    const adapter = createComfyUIAdapter(dependencies(id, snapshot, secrets));
    try {
      const result = await adapter.submit({ ...snapshot.input, prompt: request.prompt, refs }, signal);
      if (result.state === 'submitted') {
        await save(id, { status: 'running', phase: 'poll', external_task_id: result.taskId, resumable: true });
        await poll(id, snapshot, secrets, signal, adapter);
      } else if (result.state === 'done') await materialize(id, snapshot, secrets, result.outputs);
      else await save(id, { status: result.state, phase: 'submit', error: redact(result.error.message, secrets), error_category: result.error.category, resumable: false });
    } finally { adapter.dispose(id); }
  }, secrets);
  return id;
}
export function getComfyChannelJob(id: string): GenerationJobStatus {
  const record = jobs.get(id);
  if (!record) return { job_id: id, status: 'not_found', result: null, error: '任务未加载' };
  const { poll_descriptor: _snapshot, ...publicRecord } = record;
  return publicRecord;
}
async function load(id: string, repairMissingAssets = false): Promise<void> {
  if (jobs.has(id)) return;
  const existing = loads.get(id);
  if (existing) {
    try { return await existing; }
    catch (error) { if (!repairMissingAssets || !(error instanceof StoredResultMissingError)) throw error; }
  }
  const task = (async () => {
    const record = isTauri() ? await getGenerationJobRecord(id) : readBrowserJobRecord(readBrowserJobRecords(browserJobsKey), id);
    if (!record || record.status === 'not_found') return;
    if (record.status === 'succeeded') {
      if (!record.poll_descriptor && record.result && !record.result.startsWith('blob:')) {
        jobs.set(id, { ...record, results: normalizeGenerationJobResults(record) }); return;
      }
      const snapshot = descriptor(record);
      if (record.local_result_missing) {
        const error = new StoredResultMissingError();
        if (!repairMissingAssets || (!record.external_task_id && !snapshot.outputs?.length)) throw error;
        jobs.set(id, { ...record, status: 'recoverable_wait', result: null, results: undefined, resumable: true, error: error.message }); return;
      }
      const results: GenerationJobResult[] = [];
      try { for (const [index, asset] of (snapshot.assets ?? []).entries()) results.push({
        kind: snapshot.outputs?.[index]?.kind ?? (record.media_type === 'video' ? 'video' : 'image'),
        source: isTauri() ? asset : await browserAsset(asset),
      }); } catch (error) {
        if (!isTauri()) results.forEach((result) => URL.revokeObjectURL(result.source));
        if (!repairMissingAssets || !(error instanceof StoredResultMissingError) || (!record.external_task_id && !snapshot.outputs?.length)) throw error;
        jobs.set(id, { ...record, status: 'recoverable_wait', result: null, results: undefined, resumable: true, error: error.message }); return;
      }
      if (!snapshot.assets?.length) results.push(...normalizeGenerationJobResults(record));
      record.result = results[0]?.source ?? record.result;
      record.results = results;
    }
    // Publish only a usable terminal record; failed hydration remains retryable.
    jobs.set(id, record);
    if (['submitting', 'queued', 'running'].includes(record.status) && !record.external_task_id) {
      await save(id, { status: 'unknown', error: '应用在确认提交结果前关闭；不会自动重新提交', resumable: false });
    }
  })();
  loads.set(id, task);
  try { await task; } finally { if (loads.get(id) === task) loads.delete(id); }
}
export async function getComfyChannelJobAsync(id: string): Promise<GenerationJobStatus> {
  await load(id);
  const record = jobs.get(id);
  if (record && !active.has(id) && ['running', 'materializing'].includes(record.status) && record.external_task_id) {
    void recoverComfyChannelJob(id).catch((cause: unknown) => failure(id, cause));
  }
  return getComfyChannelJob(id);
}
/** Recovery is GET/download only, including unknown submissions. */
async function resumeComfyChannelJob(id: string): Promise<GenerationJobStatus> {
  if (!active.has(id) && isTauri() && jobs.get(id)?.status === 'succeeded' && (await getGenerationJobRecord(id))?.local_result_missing) jobs.delete(id);
  await load(id, true);
  const running = active.get(id);
  if (running) { await running; return getComfyChannelJob(id); }
  const record = jobs.get(id);
  if (!record || terminal(record.status)) return getComfyChannelJob(id);
  const snapshot = descriptor(record);
  if (!record.external_task_id && !snapshot.outputs?.length) throw new Error('任务没有上游 prompt ID 或已保存结果地址；不会重新提交');
  const secrets = secretsFor(id, snapshot);
  if (snapshot.recoveryRoute && (snapshot.recoveryRoute.externalTaskId !== record.external_task_id ||
    snapshot.recoveryRoute.originalBaseUrl !== comfyAdapterSnapshotSchema.parse(snapshot.input.params.comfyuiSnapshot).urls.base)) {
    throw new Error('ComfyUI 恢复连接与原任务不匹配');
  }
  if (record.status === 'unknown' && record.external_task_id) await save(id, { status: 'recoverable_wait', resumable: true });
  await start(id, (signal) => snapshot.outputs?.length ? materialize(id, snapshot, secrets, undefined, signal) : poll(id, snapshot, secrets, signal), secrets);
  return getComfyChannelJob(id);
}

export async function recoverComfyChannelJob(id: string): Promise<GenerationJobStatus> {
  return routeChanges.get(id) ?? resumeComfyChannelJob(id);
}

export interface ComfyChannelRecoveryConnection {
  originalBaseUrl: string;
  selectedBaseUrl: string;
  providerId: string;
  externalTaskId: string;
}
export async function getComfyChannelRecoveryConnection(id: string): Promise<ComfyChannelRecoveryConnection> {
  // Reading connection metadata must not hydrate result bytes or contact the old host.
  const record = jobs.get(id) ?? (isTauri() ? await getGenerationJobRecord(id) : readBrowserJobRecord(readBrowserJobRecords(browserJobsKey), id));
  if (!record?.external_task_id) throw new Error('任务没有上游 prompt ID；不会重新提交');
  const snapshot = descriptor(record);
  const original = comfyAdapterSnapshotSchema.parse(snapshot.input.params.comfyuiSnapshot);
  return { originalBaseUrl: original.urls.base, selectedBaseUrl: adapterSnapshot(snapshot).urls.base,
    providerId: snapshot.recoveryRoute?.providerId ?? snapshot.input.channelId, externalTaskId: record.external_task_id };
}

const switchRouteSchema = z.object({ externalTaskId: z.string().min(1), originalBaseUrl: z.string().url(), targetProviderId: z.string().min(1) }).strict();
export type ComfyChannelRouteSwitch = z.infer<typeof switchRouteSchema>;

/** Explicitly switches only GET/history and existing /view handles. The submission snapshot is never rewritten. */
export async function switchComfyChannelJobRoute(id: string, input: ComfyChannelRouteSwitch): Promise<GenerationJobStatus> {
  const request = switchRouteSchema.parse(input);
  if (routeChanges.has(id)) throw new Error('ComfyUI 恢复连接正在切换');
  const task = Promise.resolve().then(async () => {
    if (!active.has(id) && isTauri() && jobs.get(id)?.status === 'succeeded' && (await getGenerationJobRecord(id))?.local_result_missing) jobs.delete(id);
    await load(id, true);
    const record = jobs.get(id);
    if (!record || terminal(record.status) || record.status === 'queued' || record.status === 'submitting' || record.external_task_id !== request.externalTaskId) {
      throw new Error('只能为已确认上游 prompt ID 的原任务切换查询连接');
    }
    const snapshot = descriptor(record);
    const original = comfyAdapterSnapshotSchema.parse(snapshot.input.params.comfyuiSnapshot);
    if (request.originalBaseUrl !== original.urls.base) throw new Error('ComfyUI 恢复连接与原任务地址不匹配');
    const target = useCustomProvidersStore.getState().providers.find((entry) => entry.id === request.targetProviderId);
    if (!target || target.apiStyle !== 'comfyui') throw new Error('请选择已保存的 ComfyUI 连接');
    const urls = resolveComfyUIUrls(target.baseUrl);
    if (new URL(original.urls.base).protocol === 'https:' && new URL(urls.base).protocol !== 'https:') {
      throw new Error('ComfyUI 恢复连接不能从 HTTPS 降级到 HTTP');
    }
    const resolved = resolveComfyUIProviderAuth(target);
    const selectedAuth: ComfyUIAuth = resolved.config.mode === 'header' || resolved.config.mode === 'query'
      ? { mode: resolved.config.mode, name: resolved.config.name, value: '' }
      : resolved.config.mode === 'bearer' ? { mode: 'bearer', value: '' } : { mode: 'none' };
    applyComfyUIAuth(urls.history, selectedAuth);
    const secrets = readSecrets(target);
    for (const value of [secrets.apiKey, ...Object.values(secrets.headers), ...Object.values(secrets.query)]) {
      const ref = secretRefFromToken(value);
      if (ref && !await secretStore.has(ref)) throw new Error('ComfyUI 恢复连接凭据缺失');
    }
    const current = operations.get(id);
    current?.abort(new DOMException('ComfyUI recovery route changed', 'AbortError'));
    await active.get(id);
    const latest = jobs.get(id);
    if (!latest || terminal(latest.status) || latest.external_task_id !== request.externalTaskId) throw new Error('ComfyUI 原任务状态已变化，未切换连接');
    const durable = descriptor(latest);
    const previousView = new URL(adapterSnapshot(durable).urls.view);
    if (durable.outputs?.length) {
      durable.outputs = durable.outputs.map((output) => {
        const source = new URL(output.url);
        if (source.origin !== previousView.origin || source.pathname !== previousView.pathname) throw new Error('ComfyUI 结果地址不是原连接的 /view');
        const next = new URL(urls.view);
        for (const name of ['filename', 'subfolder', 'type']) {
          const value = source.searchParams.get(name);
          if (value !== null) next.searchParams.set(name, value);
        }
        if (!next.searchParams.get('filename')) throw new Error('ComfyUI 结果缺少原文件名');
        return { ...output, url: next.href };
      });
    }
    durable.recoveryRoute = { providerId: target.id, baseUrl: urls.base, originalBaseUrl: original.urls.base, externalTaskId: request.externalTaskId,
      auth: resolved.config, authPrefix: resolved.prefix, headerNames: Object.keys(secrets.headers), queryNames: Object.keys(secrets.query) };
    assertSafe(durable, secrets);
    await save(id, { status: 'recoverable_wait', phase: durable.outputs?.length ? 'download' : 'poll', error: null, error_category: null,
      poll_descriptor: durable as unknown as Record<string, unknown>, ...(durable.outputs?.[0] ? { result_url: durable.outputs[0].url } : {}), resumable: true });
    return resumeComfyChannelJob(id);
  });
  routeChanges.set(id, task);
  try { return await task; } finally { if (routeChanges.get(id) === task) routeChanges.delete(id); }
}
