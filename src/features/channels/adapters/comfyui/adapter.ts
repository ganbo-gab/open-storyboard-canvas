import type { ChannelAdapter, ChannelError, JobInput, JobRef, JsonValue, MediaKind, Output, PollResult, SubmitResult } from '../../runtime/types';
import { detectComfyUIBindings, type ComfyUIBindings } from './bindings';
import { parseComfyUIProgress, type ComfyUIProgress } from './progress';
import { applyComfyUIAuth, comfyUIHistoryUrl, comfyUIViewUrl, comfyUIWebSocketUrl, resolveComfyUIUrls, type ComfyUIAuth, type ComfyUIResolvedUrls } from './url';
import { asRecord, cloneWorkflow, historyError, nonemptyString, outputFile, safeKey, setInput, uploadedImageName, type ComfyUIWorkflow } from './workflow';

export type ComfyUIAuthConfig = { mode: 'none' | 'bearer' } | { mode: 'header' | 'query'; name: string };
export interface ComfyUIConfig {
  baseUrl: string;
  workflow: unknown;
  bindings?: ComfyUIBindings;
  outputNodeIds?: string[];
  auth?: ComfyUIAuthConfig;
  comfyOrgKeyRequired?: boolean;
  mediaKind?: MediaKind;
}
export interface ComfyUIJobSnapshot {
  workflow: ComfyUIWorkflow;
  bindings: ComfyUIBindings;
  outputNodeIds?: string[];
  urls: ComfyUIResolvedUrls;
  auth: ComfyUIAuthConfig;
  comfyOrgKeyRequired: boolean;
  mediaKind: MediaKind;
}
export interface ComfyUIHttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: { mode: 'json'; json: unknown } | { mode: 'multipart'; fields: { name: string; value: string }[]; files: { name: string; file: JobRef }[] };
  signal?: AbortSignal;
}
export interface ComfyUIDependencies {
  http(request: ComfyUIHttpRequest): Promise<{ status: number; body: unknown }>;
  getSecrets(channelId: string): Promise<{ apiKey?: string; comfyOrgKey?: string }>;
  ws?(url: string, callbacks: { message(data: unknown): void; close(): void; error(): void }, headers: Record<string, string>): { close(): void };
}

/** Call before persisting the job. No credential values enter the snapshot. */
export function createComfyUIJob(job: JobInput, config: ComfyUIConfig): JobInput {
  const workflow = cloneWorkflow(config.workflow);
  const detected = detectComfyUIBindings(workflow, job.refs.length);
  const bindings: ComfyUIBindings = {};
  for (const [parameter, detection] of Object.entries(detected)) {
    if (detection.binding) bindings[parameter as keyof ComfyUIBindings] = detection.binding;
  }
  Object.assign(bindings, config.bindings);
  const auth: ComfyUIAuthConfig = config.auth?.mode === 'header' || config.auth?.mode === 'query'
    ? { mode: config.auth.mode, name: config.auth.name } : { mode: config.auth?.mode ?? 'none' };
  const snapshot: ComfyUIJobSnapshot = {
    workflow, bindings, urls: resolveComfyUIUrls(config.baseUrl), auth,
    ...(config.outputNodeIds ? { outputNodeIds: [...config.outputNodeIds] } : {}),
    comfyOrgKeyRequired: config.comfyOrgKeyRequired === true, mediaKind: config.mediaKind ?? (job.operation === 'video.generate' ? 'video' : job.operation === 'audio.generate' ? 'audio' : 'image'),
  };
  return { ...job, params: { ...job.params, comfyuiSnapshot: JSON.parse(JSON.stringify(snapshot)) as JsonValue } };
}

function readSnapshot(job: JobInput): ComfyUIJobSnapshot {
  const value = asRecord(job.params.comfyuiSnapshot);
  const urls = asRecord(value?.urls);
  const auth = asRecord(value?.auth);
  if (!value || !urls || !auth || !['none', 'bearer', 'header', 'query'].includes(String(auth.mode))) throw new Error('任务缺少 ComfyUI 工作流快照，请重新提交。');
  for (const name of ['base', 'prompt', 'history', 'view', 'ws', 'objectInfo', 'systemStats', 'upload']) {
    if (typeof urls[name] !== 'string') throw new Error('ComfyUI 地址快照无效。');
  }
  const snapshot = { ...value, workflow: cloneWorkflow(value.workflow) } as unknown as ComfyUIJobSnapshot;
  if (!asRecord(value.bindings)) throw new Error('ComfyUI 绑定快照无效。');
  if (!['image', 'video', 'audio'].includes(snapshot.mediaKind)) throw new Error('ComfyUI 输出类型无效。');
  return snapshot;
}

function channelError(message: string, status?: number): ChannelError {
  const category = status === 401 || status === 403 ? 'auth'
    : status === 404 ? 'not_found' : status === 413 ? 'too_large' : status === 429 ? 'rate_limit'
    : status !== undefined && (status >= 500 || status < 400) ? 'upstream' : status !== undefined ? 'validation' : 'network';
  return { category, message, ...(status === undefined ? {} : { status }), retryable: category === 'network' || category === 'upstream' || category === 'rate_limit' };
}

function patchWorkflow(snapshot: ComfyUIJobSnapshot, job: JobInput, uploadedNames: string[]): ComfyUIWorkflow {
  const workflow = cloneWorkflow(snapshot.workflow);
  if (!snapshot.bindings.prompt) throw new Error('请选择 ComfyUI 提示词节点及其输入字段。');
  for (const [parameter, binding] of Object.entries(snapshot.bindings)) {
    if (!binding) continue;
    if (!safeKey(binding.nodeId) || !Object.prototype.hasOwnProperty.call(workflow, binding.nodeId)) throw new Error(`ComfyUI 绑定节点 ${binding.nodeId} 不存在。`);
    if (parameter === 'output') continue;
    const image = /^image([1-9]\d*)$/.exec(parameter);
    const value = parameter === 'prompt' ? job.prompt : image ? uploadedNames[Number(image[1]) - 1] : job.params[parameter];
    // Validate all configured bindings before uploads, even if a value is unused.
    const inputs = asRecord(workflow[binding.nodeId].inputs);
    if (!inputs || !safeKey(binding.input) || !Object.prototype.hasOwnProperty.call(inputs, binding.input)) throw new Error(`ComfyUI 节点 ${binding.nodeId} 没有输入字段 ${binding.input}。`);
    if (value !== undefined) setInput(workflow, binding, value);
  }
  job.refs.forEach((ref, index) => {
    if (ref.kind !== 'image') throw new Error('ComfyUI 参考素材目前只支持图片。');
    if (!snapshot.bindings[`image${index + 1}`]) throw new Error(`请选择 ComfyUI 参考图 ${index + 1} 的输入字段。`);
  });
  return workflow;
}

/** Secrets are resolved at execution time, independently of persisted configuration. */
export function createComfyUIAdapter(dependencies: ComfyUIDependencies): ChannelAdapter {
  const sessions = new Map<string, { socket: { close(): void }; progress?: ComfyUIProgress; updatedAt?: number; taskId?: string }>();
  const stop = (jobId: string) => {
    const session = sessions.get(jobId);
    sessions.delete(jobId);
    session?.socket.close();
  };
  const credentials = async (job: JobInput, snapshot: ComfyUIJobSnapshot, submitting = false): Promise<{ auth: ComfyUIAuth; comfyOrgKey?: string }> => {
    const secrets = await dependencies.getSecrets(job.channelId);
    if (submitting && snapshot.comfyOrgKeyRequired && !secrets.comfyOrgKey) throw new Error('请配置 Comfy 账号 API Key。');
    const auth: ComfyUIAuth = snapshot.auth.mode === 'none' ? { mode: 'none' }
      : snapshot.auth.mode === 'bearer' ? { mode: 'bearer', value: secrets.apiKey ?? '' }
      : { mode: snapshot.auth.mode, name: 'name' in snapshot.auth ? snapshot.auth.name : '', value: secrets.apiKey ?? '' };
    return { auth, comfyOrgKey: snapshot.comfyOrgKeyRequired ? secrets.comfyOrgKey : undefined };
  };
  return {
    async submit(job, signal): Promise<SubmitResult> {
      let promptSent = false;
      let networkStarted = false;
      try {
        const snapshot = readSnapshot(job);
        patchWorkflow(snapshot, job, job.refs.map((_, index) => `reference-${index}.png`));
        const { auth, comfyOrgKey } = await credentials(job, snapshot, true);
        const promptAuth = applyComfyUIAuth(snapshot.urls.prompt, auth);
        const uploaded: string[] = [];
        networkStarted = true;
        for (const ref of job.refs) {
          const response = await dependencies.http({ method: 'POST', ...applyComfyUIAuth(snapshot.urls.upload, auth), signal,
            body: { mode: 'multipart', fields: [{ name: 'type', value: 'input' }], files: [{ name: 'image', file: ref }] } });
          if (response.status < 200 || response.status >= 300) return { state: 'failed', error: channelError('ComfyUI 参考图上传失败。', response.status) };
          uploaded.push(uploadedImageName(response.body));
        }
        const workflow = patchWorkflow(snapshot, job, uploaded);
        stop(job.jobId);
        if (dependencies.ws) {
          const wsAuth = applyComfyUIAuth(comfyUIWebSocketUrl(snapshot.urls, job.jobId), auth);
          try {
            const socket = dependencies.ws(wsAuth.url, {
              message(data) {
                const session = sessions.get(job.jobId);
                const progress = parseComfyUIProgress(data);
                if (session && progress && (!progress.promptId || !session.taskId || progress.promptId === session.taskId)) {
                  session.progress = { ...session.progress, ...progress };
                  session.updatedAt = Date.now();
                }
              },
              close() { sessions.delete(job.jobId); }, error() { stop(job.jobId); },
            }, wsAuth.headers);
            sessions.set(job.jobId, { socket });
          } catch { /* WebSocket is optional; history polling remains available. */ }
        }
        signal?.addEventListener('abort', () => stop(job.jobId), { once: true });
        signal?.throwIfAborted();
        promptSent = true;
        const response = await dependencies.http({ method: 'POST', ...promptAuth, signal,
          body: { mode: 'json', json: { prompt: workflow, client_id: job.jobId, ...(comfyOrgKey ? { extra_data: { api_key_comfy_org: comfyOrgKey } } : {}) } } });
        const payload = asRecord(response.body);
        const taskId = nonemptyString(payload?.prompt_id);
        if (response.status >= 200 && response.status < 300 && taskId) {
          const session = sessions.get(job.jobId);
          if (session) session.taskId = taskId;
          return { state: 'submitted', taskId };
        }
        stop(job.jobId);
        const error = channelError(nonemptyString(asRecord(payload?.error)?.message) || nonemptyString(payload?.error) || 'ComfyUI 提交未返回有效任务 ID。', response.status);
        const failed = response.status >= 400 && response.status < 500 || response.status < 500 && Boolean(payload?.error);
        if (!failed) error.retryable = false;
        return { state: failed ? 'failed' : 'unknown', error };
      } catch (cause) {
        stop(job.jobId);
        const error = channelError(cause instanceof Error ? cause.message : 'ComfyUI 请求失败。');
        if (!networkStarted) { error.category = 'validation'; error.retryable = false; }
        if (promptSent) error.retryable = false;
        return { state: promptSent ? 'unknown' : 'failed', error };
      }
    },
    async poll(job, taskId, signal): Promise<PollResult> {
      try {
        const snapshot = readSnapshot(job);
        const session = sessions.get(job.jobId);
        const progress = session?.progress;
        if (progress?.error && (!progress.promptId || progress.promptId === taskId)) {
          stop(job.jobId);
          return { state: 'failed', error: { category: 'upstream', message: progress.error, retryable: false } };
        }
        if (progress && session?.updatedAt && Date.now() - session.updatedAt < 15_000 && !progress.completed && progress.type !== 'executed') {
          return { state: 'pending', ...(progress.progress === undefined ? {} : { progress: progress.progress }), ...(progress.currentNode ? { message: `正在执行节点 ${progress.currentNode}` } : {}) };
        }
        const { auth } = await credentials(job, snapshot);
        const response = await dependencies.http({ method: 'GET', ...applyComfyUIAuth(comfyUIHistoryUrl(snapshot.urls, taskId), auth), signal });
        if (response.status < 200 || response.status >= 300) return { state: 'failed', error: channelError('ComfyUI 查询任务失败。', response.status) };
        const root = asRecord(response.body);
        const entry = asRecord(root?.[taskId]) ?? (root?.outputs ? root : null);
        if (!entry) return { state: 'pending' };
        const failure = historyError(entry);
        if (failure) {
          stop(job.jobId);
          return { state: 'failed', error: { category: 'upstream', message: failure, retryable: false } };
        }
        const outputs: Output[] = [];
        const nodes = asRecord(entry.outputs) ?? {};
        const selection = snapshot.bindings.output;
        const nodeIds = snapshot.outputNodeIds?.length ? snapshot.outputNodeIds : selection ? [selection.nodeId] : Object.keys(nodes);
        const seen = new Set<string>();
        for (const nodeId of nodeIds) {
          for (const files of Object.values(asRecord(nodes[nodeId]) ?? {})) {
            if (!Array.isArray(files)) continue;
            for (const raw of files) {
              const file = outputFile(raw, snapshot.mediaKind);
              if (!file) continue;
              let url = comfyUIViewUrl(snapshot.urls, { ...file });
              const sameOrigin = new URL(url).origin === new URL(snapshot.urls.prompt).origin;
              const authorized = sameOrigin ? applyComfyUIAuth(url, auth) : { url, headers: {} };
              url = authorized.url;
              if (seen.has(url)) continue;
              seen.add(url);
              outputs.push({ kind: snapshot.mediaKind, source: { type: 'url', url, ...(Object.keys(authorized.headers).length ? { headers: authorized.headers } : {}) } });
            }
          }
        }
        if (outputs.length) { stop(job.jobId); return { state: 'done', outputs }; }
        const status = asRecord(entry.status);
        if (status?.completed === true || status?.status_str === 'success') {
          stop(job.jobId);
          return { state: 'failed', error: { category: 'upstream', message: 'ComfyUI 已完成，但所选输出节点没有可用文件。', retryable: false } };
        }
        return { state: 'pending' };
      } catch (cause) {
        return { state: 'failed', error: channelError(cause instanceof Error ? cause.message : 'ComfyUI 查询失败。') };
      }
    },
    preview(job) {
      const snapshot = readSnapshot(job);
      const auth: ComfyUIAuth = snapshot.auth.mode === 'none' ? { mode: 'none' } : snapshot.auth.mode === 'bearer' ? { mode: 'bearer', value: '***' }
        : { mode: snapshot.auth.mode, name: 'name' in snapshot.auth ? snapshot.auth.name : '', value: '***' };
      const authorized = applyComfyUIAuth(snapshot.urls.prompt, auth);
      return { method: 'POST', ...authorized, body: { mode: 'json', json: { prompt: patchWorkflow(snapshot, job, job.refs.map((ref) => ref.path.split(/[\\/]/).pop() ?? 'reference.png')) as JsonValue,
        client_id: job.jobId, ...(snapshot.comfyOrgKeyRequired ? { extra_data: { api_key_comfy_org: '***' } } : {}) } } };
    },
  };
}
