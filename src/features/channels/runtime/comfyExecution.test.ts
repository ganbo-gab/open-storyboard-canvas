import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Tauri from '@tauri-apps/api/core';
import type * as AI from '@/commands/ai';
import type { CustomHttpRequest, CreateGenerationJobRequest, UpdateGenerationJobRequest, GenerationJobStatus } from '@/commands/ai';
import { createJSONStorage } from 'zustand/middleware';
import { IDBFactory } from 'fake-indexeddb';
import { useCustomProvidersStore, type CustomProviderConfig } from '@/stores/customProvidersStore';
import { useMemorySecretVault } from '@/features/secrets/testSupport';
import { comfyChannelJobFromRequest, getComfyChannelJob, getComfyChannelJobAsync, getComfyChannelRecoveryConnection, recoverComfyChannelJob, submitComfyChannelJob, switchComfyChannelJobRoute } from './comfyExecution';
import { comfyExecutionSnapshotSchema } from './comfySnapshot';
import { secretStore, SecretStoreError } from '@/features/secrets/secretStore';

const mocks = vi.hoisted(() => ({ native: true, http: vi.fn(), create: vi.fn(), update: vi.fn(), get: vi.fn(), image: vi.fn() }));
vi.mock('@tauri-apps/api/core', async (original) => ({ ...await original<typeof Tauri>(), isTauri: () => mocks.native }));
vi.mock('@/commands/ai', async (original) => ({ ...await original<typeof AI>(), customHttpRequest: mocks.http,
  createGenerationJob: mocks.create, updateGenerationJob: mocks.update, getGenerationJobRecord: mocks.get }));
vi.mock('@/commands/image', () => ({ prepareNodeImageSourceWithHeaders: mocks.image, persistVideoSource: vi.fn() }));
useMemorySecretVault();
const records = new Map<string, GenerationJobStatus>();
const values = new Map<string, string>();
const storage: Storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: (key) => { values.delete(key); },
  clear: () => values.clear(), key: (index) => [...values.keys()][index] ?? null, get length() { return values.size; } };
const request = { model: 'workflow', prompt: 'runtime prompt must remain ephemeral', size: 'auto', aspect_ratio: 'auto' };
function provider(id = 'original', baseUrl = 'http://127.0.0.1:8188'): CustomProviderConfig {
  return { id, label: id, baseUrl, apiStyle: 'comfyui', apiKey: '', models: ['workflow'], supportsWebSearch: false, extraParams: { auth: { mode: 'none' }, comfyui: {
    workflow: { '6': { class_type: 'CLIPTextEncode', inputs: { text: 'saved' } }, '9': { class_type: 'SaveImage', inputs: { images: ['6', 0] } } },
    bindings: { prompt: { nodeId: '6', input: 'text' } }, outputNodeIds: ['9'], pollIntervalMs: 500, pollTimeoutMs: 5000,
  } } };
}
function history(taskId: string) { return { [taskId]: { status: { completed: true }, outputs: { '9': { images: [{ filename: 'result.png', subfolder: 'outputs', type: 'output' }] } } } }; }
function retain(id: string, cfg = provider(), taskId = 'original-prompt') {
  records.set(id, { job_id: id, status: 'recoverable_wait', external_task_id: taskId, provider_id: cfg.id, resumable: true,
    poll_descriptor: { ...comfyChannelJobFromRequest(cfg, 'workflow', request, id) } });
}
beforeEach(async () => {
  mocks.native = true;
  records.clear(); values.clear(); vi.stubGlobal('localStorage', storage);
  useCustomProvidersStore.persist.setOptions({ storage: createJSONStorage(() => storage) });
  await useCustomProvidersStore.getState().replaceAll([]);
  mocks.get.mockReset().mockImplementation(async (id: string) => structuredClone(records.get(id)));
  mocks.create.mockReset().mockImplementation(async (value: CreateGenerationJobRequest) => {
    records.set(value.jobId!, { job_id: value.jobId!, status: value.status ?? 'queued', provider_id: value.providerId, poll_descriptor: structuredClone(value.pollDescriptor) });
  });
  mocks.update.mockReset().mockImplementation(async (value: UpdateGenerationJobRequest) => {
    const previous = records.get(value.jobId)!;
    records.set(value.jobId, { ...previous, status: value.status ?? previous.status, external_task_id: value.externalTaskId ?? previous.external_task_id,
      poll_descriptor: structuredClone(value.pollDescriptor ?? previous.poll_descriptor), result_url: value.resultUrl ?? previous.result_url,
      error: value.error, resumable: value.resumable });
  });
  mocks.http.mockReset(); mocks.image.mockReset().mockResolvedValue({ imagePath: '/isolated/result.png' });
});
afterEach(async () => { await useCustomProvidersStore.getState().replaceAll([]); vi.unstubAllGlobals(); });

describe('ComfyUI original-task recovery routing', () => {
  it('shares the live socket across submit and poll and exposes real node/step progress', async () => {
    class Socket {
      static instances: Socket[] = [];
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      close = vi.fn(() => this.onclose?.());
      constructor(readonly url: string) { Socket.instances.push(this); queueMicrotask(() => this.onopen?.()); }
    }
    vi.stubGlobal('WebSocket', Socket);
    const queried = Promise.withResolvers<void>(); const response = Promise.withResolvers<{ status: number; text: string }>();
    mocks.http.mockImplementation(async (call: CustomHttpRequest) => {
      if (call.method === 'POST') return { status: 200, text: '{"prompt_id":"live-task"}' };
      queried.resolve(); return response.promise;
    });
    const id = await submitComfyChannelJob(provider('live-progress'), 'workflow', request);
    await queried.promise;
    expect(Socket.instances).toHaveLength(1);
    const socket = Socket.instances[0];
    expect(socket.url).toContain(`clientId=${id}`);
    socket.onmessage?.({ data: JSON.stringify({ type: 'executing', data: { prompt_id: 'live-task', node: '6' } }) });
    socket.onmessage?.({ data: JSON.stringify({ type: 'progress', data: { prompt_id: 'live-task', value: 3, max: 12 } }) });
    expect(getComfyChannelJob(id)).toMatchObject({ progress: 0.25, current_node: '6', step: 3, total_steps: 12, progress_transport: 'websocket' });
    socket.onmessage?.({ data: JSON.stringify({ type: 'progress', data: { prompt_id: 'another-task', value: 12, max: 12 } }) });
    expect(getComfyChannelJob(id).progress).toBe(0.25);
    response.resolve({ status: 200, text: JSON.stringify(history('live-task')) });
    expect(await recoverComfyChannelJob(id)).toMatchObject({ status: 'succeeded' });
    expect(socket.close).toHaveBeenCalledOnce();
    expect(mocks.http.mock.calls.filter(([call]) => call.method === 'POST')).toHaveLength(1);
    expect(JSON.stringify(records.get(id)?.poll_descriptor)).not.toContain('progress_transport');
  });

  it('keeps header-authenticated connections on polling without leaking keys into WebSocket URLs', async () => {
    const ctor = vi.fn(); vi.stubGlobal('WebSocket', ctor);
    const cfg = { ...provider('header-poll'), apiKey: 'fixture-header-key', extraParams: { ...provider().extraParams, auth: { mode: 'bearer' } } };
    mocks.http.mockResolvedValueOnce({ status: 200, text: '{"prompt_id":"header-task"}' }).mockResolvedValueOnce({ status: 503, text: '{}' });
    const id = await submitComfyChannelJob(cfg, 'workflow', request);
    expect(await recoverComfyChannelJob(id)).toMatchObject({ status: 'recoverable_wait', progress_transport: 'polling' });
    expect(ctor).not.toHaveBeenCalled(); expect(getComfyChannelJob(id).progress).toBeUndefined();
  });
  it('isolates running workflows, bindings and server address from active config edits', async () => {
    const cfg = provider(); await useCustomProvidersStore.getState().addProvider(cfg);
    const queried = Promise.withResolvers<void>(); const response = Promise.withResolvers<{ status: number; text: string }>();
    mocks.http.mockImplementation(async (call: CustomHttpRequest) => {
      if (call.method === 'POST') return { status: 200, text: '{"prompt_id":"running-original"}' };
      queried.resolve(); return response.promise;
    });
    const id = await submitComfyChannelJob(cfg, 'workflow', request); await queried.promise;
    await useCustomProvidersStore.getState().updateComfyWorkflow(cfg.id, 'workflow', { name: 'Edited', config: {
      workflow: { changed: { class_type: 'InvalidNewNode', inputs: {} } }, outputNodeIds: ['changed'],
    } });
    await useCustomProvidersStore.getState().updateProvider(cfg.id, { baseUrl: 'http://127.0.0.1:9999' });
    response.resolve({ status: 200, text: JSON.stringify(history('running-original')) });
    expect(await recoverComfyChannelJob(id)).toMatchObject({ status: 'succeeded', external_task_id: 'running-original' });
    expect(mocks.http.mock.calls.map(([call]) => call.url)).toEqual(['http://127.0.0.1:8188/prompt', 'http://127.0.0.1:8188/history/running-original']);
    expect(mocks.image.mock.calls[0][0]).toContain('http://127.0.0.1:8188/view?');
    const saved = comfyExecutionSnapshotSchema.parse(records.get(id)!.poll_descriptor);
    expect(JSON.stringify(saved)).not.toContain(request.prompt); expect(JSON.stringify(saved)).not.toContain('InvalidNewNode');
    expect(mocks.http.mock.calls.filter(([call]) => call.method === 'POST')).toHaveLength(1);
  });

  it('persists the selected non-secret route before query and uses only its own credentials', async () => {
    const id = 'custom-local-comfy-v2-explicit-route'; retain(id);
    await useCustomProvidersStore.getState().addProvider({ ...provider('replacement', 'http://127.0.0.1:8288/proxy'), apiKey: 'new-route-private-key',
      extraHeaders: { 'X-Tunnel': 'new-route-private-header' }, extraParams: { ...provider().extraParams, auth: { mode: 'header', name: 'X-API-Key', prefix: 'Token' } } });
    const selected = useCustomProvidersStore.getState().providers.find((entry) => entry.id === 'replacement')!;
    mocks.http.mockImplementation(async (call: CustomHttpRequest) => {
      const saved = comfyExecutionSnapshotSchema.parse(records.get(id)!.poll_descriptor);
      expect(saved.recoveryRoute).toMatchObject({ providerId: selected.id, baseUrl: 'http://127.0.0.1:8288/proxy', externalTaskId: 'original-prompt' });
      expect(call.method).toBe('GET'); expect(call.headers).toMatchObject({ 'X-API-Key': `Token ${selected.apiKey}`, 'X-Tunnel': selected.extraHeaders!['X-Tunnel'] });
      return { status: 200, text: JSON.stringify(history('original-prompt')) };
    });
    expect(await switchComfyChannelJobRoute(id, { externalTaskId: 'original-prompt', originalBaseUrl: provider().baseUrl, targetProviderId: selected.id })).toMatchObject({ status: 'succeeded' });
    expect(mocks.http).toHaveBeenCalledTimes(1);
    expect(mocks.http.mock.calls[0][0].url).toBe('http://127.0.0.1:8288/proxy/history/original-prompt');
    const saved = JSON.stringify(records.get(id));
    for (const secret of ['new-route-private-key', 'new-route-private-header']) expect(saved).not.toContain(secret);
    expect(await getComfyChannelRecoveryConnection(id)).toEqual({ originalBaseUrl: provider().baseUrl, selectedBaseUrl: selected.baseUrl, providerId: selected.id, externalTaskId: 'original-prompt' });
    expect(mocks.image.mock.calls[0][0]).toContain('http://127.0.0.1:8288/proxy/view?');
  });

  it('suppresses a late old-route result while switching an in-flight history query', async () => {
    const id = 'custom-local-comfy-v2-late-query'; retain(id);
    await useCustomProvidersStore.getState().addProvider(provider('late-target', 'http://127.0.0.1:8388'));
    const queried = Promise.withResolvers<void>(); const late = Promise.withResolvers<{ status: number; text: string }>();
    mocks.http.mockImplementation(async (call: CustomHttpRequest) => {
      if (call.url.includes(':8188/')) { queried.resolve(); return late.promise; }
      return { status: 200, text: JSON.stringify(history('original-prompt')) };
    });
    const old = recoverComfyChannelJob(id); await queried.promise;
    const abort = vi.spyOn(AbortController.prototype, 'abort');
    const switched = switchComfyChannelJobRoute(id, { externalTaskId: 'original-prompt', originalBaseUrl: provider().baseUrl, targetProviderId: 'late-target' });
    await vi.waitFor(() => expect(abort).toHaveBeenCalled());
    late.resolve({ status: 200, text: JSON.stringify(history('original-prompt')) });
    await old; expect(await switched).toMatchObject({ status: 'succeeded' });
    expect(mocks.image).toHaveBeenCalledTimes(1); expect(mocks.image.mock.calls[0][0]).toContain(':8388/view?');
    expect(mocks.http.mock.calls.every(([call]) => call.method === 'GET')).toBe(true);
    abort.mockRestore();
  });

  it.each(['task', 'origin', 'missing', 'downgrade', 'credential-url'])('rejects an unsafe %s switch without HTTP', async (kind) => {
    const id = `custom-local-comfy-v2-unsafe-${kind}`; const cfg = provider('original', 'https://original.example'); retain(id, cfg);
    const targetUrl = kind === 'downgrade' ? 'http://target.example' : kind === 'credential-url' ? 'https://user:password@target.example' : 'https://target.example';
    await useCustomProvidersStore.getState().addProvider(provider('unsafe-target', targetUrl));
    await expect(switchComfyChannelJobRoute(id, { externalTaskId: kind === 'task' ? 'other-prompt' : 'original-prompt',
      originalBaseUrl: kind === 'origin' ? 'https://other.example' : cfg.baseUrl, targetProviderId: kind === 'missing' ? 'not-saved' : 'unsafe-target' })).rejects.toThrow();
    expect(mocks.http).not.toHaveBeenCalled(); expect(mocks.image).not.toHaveBeenCalled();
    expect(comfyExecutionSnapshotSchema.parse(records.get(id)!.poll_descriptor).recoveryRoute).toBeUndefined();
  });

  it('rejects a locked replacement credential before switching or issuing HTTP', async () => {
    const id = 'custom-local-comfy-v2-locked-route'; retain(id);
    await useCustomProvidersStore.getState().addProvider({ ...provider('locked-target', 'http://127.0.0.1:8588'), apiKey: 'locked-route-private-key',
      extraParams: { ...provider().extraParams, auth: { mode: 'bearer' } } });
    vi.mocked(secretStore.has).mockRejectedValue(new SecretStoreError('locked', 'fixture-locked'));
    await expect(switchComfyChannelJobRoute(id, { externalTaskId: 'original-prompt', originalBaseUrl: provider().baseUrl, targetProviderId: 'locked-target' }))
      .rejects.toMatchObject({ state: 'locked' });
    expect(mocks.http).not.toHaveBeenCalled();
    expect(comfyExecutionSnapshotSchema.parse(records.get(id)!.poll_descriptor).recoveryRoute).toBeUndefined();
  });

  it('resolves vault-backed browser result credentials only at the download boundary', async () => {
    mocks.native = false; vi.stubGlobal('indexedDB', new IDBFactory());
    const cfg = { ...provider('browser-auth'), apiKey: 'browser-download-private-key', extraParams: { ...provider().extraParams, auth: { mode: 'bearer' } } };
    await useCustomProvidersStore.getState().addProvider(cfg);
    const saved = useCustomProvidersStore.getState().providers.find((entry) => entry.id === cfg.id)!;
    const id = 'custom-local-comfy-v2-browser-auth-download';
    const snapshot = comfyChannelJobFromRequest(saved, 'workflow', request, id);
    snapshot.outputs = [{ kind: 'image', url: `${cfg.baseUrl}/view?filename=original.png&type=output` }];
    values.set('comfy-channel-generation-jobs-v2', JSON.stringify({ [id]: { job_id: id, status: 'materializing', external_task_id: 'browser-original', poll_descriptor: snapshot } }));
    const fetchResult = vi.fn().mockResolvedValue(new Response(new Blob(['fixture media']), { status: 200 }));
    vi.stubGlobal('fetch', fetchResult);
    expect(await recoverComfyChannelJob(id)).toMatchObject({ status: 'succeeded' });
    expect(fetchResult.mock.calls[0][1].headers).toMatchObject({ Authorization: 'Bearer browser-download-private-key' });
    expect(values.get('comfy-channel-generation-jobs-v2')).not.toContain('browser-download-private-key');
  });

  it('blocks locked browser downloads before HTTP and redacts resolved-key network errors', async () => {
    mocks.native = false; vi.stubGlobal('indexedDB', new IDBFactory());
    const cfg = { ...provider('browser-locked'), apiKey: 'browser-error-private-key', extraParams: { ...provider().extraParams, auth: { mode: 'bearer' } } };
    await useCustomProvidersStore.getState().addProvider(cfg);
    const saved = useCustomProvidersStore.getState().providers.find((entry) => entry.id === cfg.id)!;
    const id = 'custom-local-comfy-v2-browser-locked-download'; const snapshot = comfyChannelJobFromRequest(saved, 'workflow', request, id);
    snapshot.outputs = [{ kind: 'image', url: `${cfg.baseUrl}/view?filename=original.png&type=output` }];
    values.set('comfy-channel-generation-jobs-v2', JSON.stringify({ [id]: { job_id: id, status: 'materializing', external_task_id: 'browser-original', poll_descriptor: snapshot } }));
    const fetchResult = vi.fn().mockRejectedValue(new Error('download denied browser-error-private-key'));
    vi.stubGlobal('fetch', fetchResult);
    vi.mocked(secretStore.get).mockRejectedValueOnce(new SecretStoreError('locked', 'fixture-locked'));
    expect(await recoverComfyChannelJob(id)).toMatchObject({ status: 'recoverable_wait' });
    expect(fetchResult).not.toHaveBeenCalled();
    const result = await recoverComfyChannelJob(id);
    expect(result.error).toContain('download denied'); expect(result.error).not.toContain('browser-error-private-key');
    expect(values.get('comfy-channel-generation-jobs-v2')).not.toContain('browser-error-private-key');
  });

  it('reads the original recovery connection without hydrating absent browser result bytes', async () => {
    mocks.native = false;
    const database = new IDBFactory(); vi.stubGlobal('indexedDB', database);
    const open = vi.spyOn(database, 'open');
    const id = 'custom-local-comfy-v2-metadata-with-missing-bytes';
    values.set('comfy-channel-generation-jobs-v2', JSON.stringify({ [id]: { job_id: id, status: 'succeeded', external_task_id: 'retained-prompt', result: null,
      poll_descriptor: { ...comfyChannelJobFromRequest(provider(), 'workflow', request, id), assets: [`${id}:0`] } } }));
    expect(await getComfyChannelRecoveryConnection(id)).toMatchObject({ originalBaseUrl: provider().baseUrl, externalTaskId: 'retained-prompt' });
    expect(open).not.toHaveBeenCalled(); expect(mocks.http).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
  });
  it('switches the original completed job with missing local bytes to a replacement download route', async () => {
    const id = 'custom-local-comfy-v2-switch-missing-bytes';
    const snapshot = { ...comfyChannelJobFromRequest(provider(), 'workflow', request, id), assets: ['/missing.png'], outputs: [{ kind: 'image', url: 'http://127.0.0.1:8188/view?filename=original.png&type=output' }] };
    records.set(id, { job_id: id, status: 'succeeded', local_result_missing: true, external_task_id: 'original-prompt', poll_descriptor: snapshot });
    await useCustomProvidersStore.getState().addProvider(provider('replacement-missing', 'http://127.0.0.1:8788'));
    expect(await getComfyChannelRecoveryConnection(id)).toMatchObject({ externalTaskId: 'original-prompt' });
    const result = await switchComfyChannelJobRoute(id, { externalTaskId: 'original-prompt', originalBaseUrl: provider().baseUrl, targetProviderId: 'replacement-missing' });
    expect(result).toMatchObject({ status: 'succeeded', external_task_id: 'original-prompt' });
    expect(mocks.image.mock.calls.at(-1)?.[0]).toContain('http://127.0.0.1:8788/view?filename=original.png');
    expect(mocks.http).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
  });

  it('retries failed browser asset hydration without publishing an incomplete success or submitting again', async () => {
    mocks.native = false;
    const database = new IDBFactory();
    vi.stubGlobal('indexedDB', database);
    const id = 'custom-local-comfy-v2-browser-hydration-retry';
    const assetKey = `${id}:0`;
    const snapshot = { ...comfyChannelJobFromRequest(provider(), 'workflow', request, id), assets: [assetKey] };
    values.set('comfy-channel-generation-jobs-v2', JSON.stringify({ [id]: {
      job_id: id, status: 'succeeded', external_task_id: 'retained-prompt', result: null, poll_descriptor: snapshot,
    } }));
    const open = vi.spyOn(database, 'open');
    const first = getComfyChannelJobAsync(id);
    const joined = getComfyChannelJobAsync(id);
    const settled = Promise.allSettled([first, joined]);
    expect(getComfyChannelJob(id).status).toBe('not_found');
    const failures = await settled;
    expect(failures.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(open).toHaveBeenCalledTimes(1);
    expect(getComfyChannelJob(id).status).toBe('not_found');

    const repaired = Promise.withResolvers<void>();
    const repair = database.open('comfy-channel-assets-v2', 1);
    repair.onerror = () => repaired.reject(repair.error);
    repair.onsuccess = () => {
      const db = repair.result;
      const transaction = db.transaction('assets', 'readwrite');
      transaction.objectStore('assets').put(new Blob(['repaired stored media']), assetKey);
      transaction.oncomplete = () => { db.close(); repaired.resolve(); };
      transaction.onerror = () => { db.close(); repaired.reject(transaction.error); };
      transaction.onabort = () => { db.close(); repaired.reject(transaction.error); };
    };
    await repaired.promise;
    const [retried, shared] = await Promise.all([getComfyChannelJobAsync(id), getComfyChannelJobAsync(id)]);
    expect(retried).toMatchObject({ status: 'succeeded', external_task_id: 'retained-prompt', result: expect.stringMatching(/^blob:/) });
    expect(shared.result).toBe(retried.result);
    expect(open).toHaveBeenCalledTimes(3);
    expect(await (await fetch(retried.result!)).text()).toBe('repaired stored media');
    expect(await recoverComfyChannelJob(id)).toMatchObject({ status: 'succeeded', result: retried.result });
    expect(mocks.http).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    URL.revokeObjectURL(retried.result!);
  });

  it('reloads the selected public route and queries the same original prompt without submitting', async () => {
    const id = 'custom-local-comfy-v2-route-reload'; retain(id);
    await useCustomProvidersStore.getState().addProvider(provider('reload-target', 'http://127.0.0.1:8488'));
    mocks.http.mockResolvedValue({ status: 503, text: '{"error":"temporarily offline"}' });
    expect(await switchComfyChannelJobRoute(id, { externalTaskId: 'original-prompt', originalBaseUrl: provider().baseUrl, targetProviderId: 'reload-target' })).toMatchObject({ status: 'recoverable_wait' });
    const providers = structuredClone(useCustomProvidersStore.getState().providers);
    // Dynamic imports intentionally model a fresh executor/store module after application reload.
    vi.resetModules();
    const reloaded = await import('./comfyExecution');
    const { useCustomProvidersStore: reloadedStore } = await import('@/stores/customProvidersStore');
    reloadedStore.persist.setOptions({ storage: createJSONStorage(() => storage) }); await reloadedStore.getState().replaceAll(providers);
    mocks.http.mockReset().mockResolvedValue({ status: 200, text: JSON.stringify(history('original-prompt')) });
    expect(await reloaded.recoverComfyChannelJob(id)).toMatchObject({ status: 'succeeded', external_task_id: 'original-prompt' });
    expect(mocks.http.mock.calls.map(([call]) => [call.method, call.url])).toEqual([['GET', 'http://127.0.0.1:8488/history/original-prompt']]);
    expect(await reloaded.getComfyChannelRecoveryConnection(id)).toMatchObject({ selectedBaseUrl: 'http://127.0.0.1:8488', externalTaskId: 'original-prompt' });
    await reloadedStore.getState().replaceAll([]);
  });
});
