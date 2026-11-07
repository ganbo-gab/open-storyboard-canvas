import { createServer, type Server } from 'node:http';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJSONStorage } from 'zustand/middleware';
import type { CustomProviderConfig } from '@/stores/customProvidersStore';
import type { ComfyUITransport } from '@/features/canvas/infrastructure/comfyuiGateway';
import { inspectComfyUIConnection } from '../application/comfyConnection';

const values = new Map<string, string>();
const storage: Storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: (key) => { values.delete(key); },
  clear: () => values.clear(), key: (index) => [...values.keys()][index] ?? null, get length() { return values.size; } };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=', 'base64');
const servers: Server[] = [];
const calls: { server: string; method: string; path: string }[] = [];
let submitted: unknown[]; let ready: boolean; let queueState: 'queued' | 'running'; let filenames: string[];
async function listen(name: string): Promise<string> {
  const listening = Promise.withResolvers<void>();
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    calls.push({ server: name, method: request.method ?? '', path });
    response.setHeader('content-type', 'application/json');
    if (request.method === 'POST' && path === '/prompt') {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => { submitted.push(JSON.parse(Buffer.concat(chunks).toString())); response.end('{"prompt_id":"accepted-once"}'); });
      return;
    }
    if (path === '/system_stats') { response.end('{"system":{"comfyui_version":"loopback-fixture-only"}}'); return; }
    if (path === '/queue') { response.end(JSON.stringify({ queue_running: queueState === 'running' ? [[0, 'accepted-once']] : [], queue_pending: queueState === 'queued' ? [[0, 'accepted-once']] : [] })); return; }
    if (path === '/history/accepted-once') {
      if (!ready || name === 'original') { response.statusCode = 503; response.end('{"error":"loopback route temporarily unavailable"}'); return; }
      response.end(JSON.stringify({ 'accepted-once': { status: { completed: true }, outputs: { '9': { images: filenames.map((filename) => ({ filename, subfolder: 'test-only', type: 'output' })) } } } })); return;
    }
    if (path === '/view') {
      response.setHeader('content-type', 'image/png'); response.end(png); return;
    }
    response.statusCode = 404; response.end('{"error":"unknown fixture endpoint"}');
  });
  servers.push(server); server.listen(0, '127.0.0.1', listening.resolve); await listening.promise;
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Loopback address missing');
  return `http://127.0.0.1:${address.port}`;
}
function control(baseUrl: string): Pick<ComfyUITransport, 'json'> {
  return { json: async (path, method, body) => {
    const response = await fetch(new URL(path, baseUrl), { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }), redirect: 'error', credentials: 'omit' });
    if (!response.ok) throw new Error(`Loopback control HTTP ${response.status}`);
    return response.json();
  } };
}
function provider(baseUrl: string): CustomProviderConfig {
  return { id: 'loopback-comfy', label: 'Loopback fixture only', baseUrl, apiKey: '', apiStyle: 'comfyui', models: ['original-workflow'], supportsWebSearch: false,
    extraParams: { auth: { mode: 'none' }, comfyui: { workflow: {
      '6': { class_type: 'CLIPTextEncode', inputs: { text: 'saved original' } }, '9': { class_type: 'SaveImage', inputs: { images: ['6', 0] } },
    }, bindings: { prompt: { nodeId: '6', input: 'text' } }, outputNodeIds: ['9'], pollIntervalMs: 500, pollTimeoutMs: 5000 } } };
}
beforeEach(() => {
  vi.resetModules(); vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('localStorage', storage); storage.clear();
  submitted = []; ready = false; queueState = 'queued'; filenames = ['fixture.png']; calls.length = 0;
});
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections(); const closed = Promise.withResolvers<void>(); server.close(() => closed.resolve()); await closed.promise;
  }
  vi.unstubAllGlobals();
});

describe('actual TCP ComfyUI loopback recovery', () => {
  it('publishes every batch output and restores all durable assets after a fresh executor loads', async () => {
    const baseUrl = await listen('replacement'); ready = true; filenames = ['first.png', 'second.png'];
    // Fresh imports are intentional: this scenario crosses the process-local job/URL cache boundary.
    const { useCustomProvidersStore } = await import('@/stores/customProvidersStore');
    useCustomProvidersStore.persist.setOptions({ storage: createJSONStorage(() => storage) });
    await useCustomProvidersStore.getState().replaceAll([provider(baseUrl)]);
    const runtime = await import('./comfyExecution');
    const cfg = useCustomProvidersStore.getState().providers[0];
    const id = await runtime.submitComfyChannelJob(cfg, 'original-workflow', { model: 'original-workflow', prompt: 'one batch', size: 'auto', aspect_ratio: 'auto' });
    const result = await runtime.recoverComfyChannelJob(id);
    expect(result.results).toHaveLength(2);
    expect(result.results?.map((item) => item.kind)).toEqual(['image', 'image']);
    const durable = storage.getItem('comfy-channel-generation-jobs-v2')!;
    expect(durable).not.toContain('blob:');
    const requests = [...calls]; vi.resetModules();
    const reloaded = await import('./comfyExecution');
    const restored = await reloaded.getComfyChannelJobAsync(id);
    expect(restored.results).toHaveLength(2);
    for (const item of restored.results ?? []) expect(Buffer.from(await (await fetch(item.source)).arrayBuffer())).toEqual(png);
    expect(calls).toEqual(requests);
    expect(submitted).toHaveLength(1);
    for (const item of [...result.results ?? [], ...restored.results ?? []]) URL.revokeObjectURL(item.source);
  });
  it('submits once, persists a selected replacement route, reloads and retrieves the original PNG', async () => {
    const original = await listen('original'); const replacement = await listen('replacement');
    // Fresh imports intentionally exercise executor/store cache loss across a simulated application reload.
    const { useCustomProvidersStore } = await import('@/stores/customProvidersStore');
    useCustomProvidersStore.persist.setOptions({ storage: createJSONStorage(() => storage) });
    await useCustomProvidersStore.getState().replaceAll([provider(original)]);
    const runtime = await import('./comfyExecution');
    const cfg = useCustomProvidersStore.getState().providers.find((entry) => entry.id === 'loopback-comfy')!;
    const id = await runtime.submitComfyChannelJob(cfg, 'original-workflow', { model: 'original-workflow', prompt: 'one actual HTTP submit', size: 'auto', aspect_ratio: 'auto' });
    expect(await runtime.recoverComfyChannelJob(id)).toMatchObject({ status: 'recoverable_wait', external_task_id: 'accepted-once' });
    const queued = await inspectComfyUIConnection(control(original));
    expect(queued).toMatchObject({ reachable: true, status: 'queued', queue: { pending: 1, running: 0 }, system: { version: 'loopback-fixture-only' } });
    expect(queued.system?.devices).toBeUndefined();
    queueState = 'running'; expect(await inspectComfyUIConnection(control(original))).toMatchObject({ status: 'running', queue: { pending: 0, running: 1 } });
    await useCustomProvidersStore.getState().updateProvider(cfg.id, { baseUrl: replacement });
    await useCustomProvidersStore.getState().updateComfyWorkflow(cfg.id, 'original-workflow', { name: 'edited later', config: {
      workflow: { changed: { class_type: 'DifferentWorkflow', inputs: {} } }, outputNodeIds: ['changed'],
    } });
    expect(await runtime.switchComfyChannelJobRoute(id, { externalTaskId: 'accepted-once', originalBaseUrl: original, targetProviderId: cfg.id })).toMatchObject({ status: 'recoverable_wait' });
    const configs = structuredClone(useCustomProvidersStore.getState().providers);
    vi.resetModules();
    const { useCustomProvidersStore: reloadedStore } = await import('@/stores/customProvidersStore');
    reloadedStore.persist.setOptions({ storage: createJSONStorage(() => storage) }); await reloadedStore.getState().replaceAll(configs);
    const reloaded = await import('./comfyExecution'); ready = true;
    const result = await reloaded.recoverComfyChannelJob(id);
    expect(result).toMatchObject({ status: 'succeeded', external_task_id: 'accepted-once' });
    expect(await reloaded.getComfyChannelRecoveryConnection(id)).toEqual({ originalBaseUrl: original, selectedBaseUrl: replacement, providerId: cfg.id, externalTaskId: 'accepted-once' });
    const decoded = Buffer.from(await (await fetch(result.result!)).arrayBuffer());
    expect(decoded).toEqual(png); expect(decoded.readUInt32BE(16)).toBe(1); expect(decoded.readUInt32BE(20)).toBe(1);
    expect(submitted).toEqual([{ prompt: { '6': { class_type: 'CLIPTextEncode', inputs: { text: 'one actual HTTP submit' } },
      '9': { class_type: 'SaveImage', inputs: { images: ['6', 0] } } }, client_id: id }]);
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(calls.filter((call) => call.path === '/view')).toEqual([{ server: 'replacement', method: 'GET', path: '/view' }]);
    expect(calls.filter((call) => call.path === '/history/accepted-once')).toEqual([
      { server: 'original', method: 'GET', path: '/history/accepted-once' }, { server: 'replacement', method: 'GET', path: '/history/accepted-once' },
      { server: 'replacement', method: 'GET', path: '/history/accepted-once' },
    ]);
    await reloadedStore.getState().replaceAll([]); URL.revokeObjectURL(result.result!);
  });
  it('retries hydration after storage repair with one actual submit and no replacement task', async () => {
    const baseUrl = await listen('replacement');
    const assets = new IDBFactory();
    vi.stubGlobal('indexedDB', assets);
    ready = true;
    // Fresh imports are required to exercise executor cache loss at the reload boundary.
    const { useCustomProvidersStore } = await import('@/stores/customProvidersStore');
    useCustomProvidersStore.persist.setOptions({ storage: createJSONStorage(() => storage) });
    await useCustomProvidersStore.getState().replaceAll([provider(baseUrl)]);
    const runtime = await import('./comfyExecution');
    const cfg = useCustomProvidersStore.getState().providers.find((entry) => entry.id === 'loopback-comfy')!;
    const id = await runtime.submitComfyChannelJob(cfg, 'original-workflow', {
      model: 'original-workflow', prompt: 'retain this one original task', size: 'auto', aspect_ratio: 'auto',
    });
    const completed = await runtime.recoverComfyChannelJob(id);
    expect(completed).toMatchObject({ status: 'succeeded', external_task_id: 'accepted-once' });
    const requestsBeforeReload = [...calls];
    vi.resetModules();
    vi.stubGlobal('indexedDB', new IDBFactory());
    const reloaded = await import('./comfyExecution');
    const failed = await Promise.allSettled([reloaded.getComfyChannelJobAsync(id), reloaded.getComfyChannelJobAsync(id)]);
    expect(failed.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(reloaded.getComfyChannelJob(id).status).toBe('not_found');

    vi.stubGlobal('indexedDB', assets);
    const recovered = await reloaded.recoverComfyChannelJob(id);
    expect(recovered).toMatchObject({ status: 'succeeded', external_task_id: 'accepted-once', result: expect.stringMatching(/^blob:/) });
    expect(Buffer.from(await (await fetch(recovered.result!)).arrayBuffer())).toEqual(png);
    expect(calls).toEqual(requestsBeforeReload);
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(submitted).toHaveLength(1);
    await useCustomProvidersStore.getState().replaceAll([]);
    URL.revokeObjectURL(completed.result!); URL.revokeObjectURL(recovered.result!);
  });
  it('explicitly retrieves an old completed batch when local bytes are missing without resubmitting', async () => {
    const baseUrl = await listen('replacement'); ready = true; filenames = ['old-one.png', 'old-two.png'];
    const { useCustomProvidersStore } = await import('@/stores/customProvidersStore');
    useCustomProvidersStore.persist.setOptions({ storage: createJSONStorage(() => storage) });
    await useCustomProvidersStore.getState().replaceAll([provider(baseUrl)]);
    const runtime = await import('./comfyExecution');
    const id = await runtime.submitComfyChannelJob(useCustomProvidersStore.getState().providers[0], 'original-workflow', {
      model: 'original-workflow', prompt: 'keep this original task', size: 'auto', aspect_ratio: 'auto',
    });
    const original = await runtime.recoverComfyChannelJob(id);
    expect(original.results).toHaveLength(2);
    vi.resetModules(); vi.stubGlobal('indexedDB', new IDBFactory());
    const reloaded = await import('./comfyExecution');
    await expect(reloaded.getComfyChannelJobAsync(id)).rejects.toThrow(/本地结果素材不存在/);
    const recovered = await reloaded.recoverComfyChannelJob(id);
    expect(recovered).toMatchObject({ status: 'succeeded', external_task_id: 'accepted-once' });
    expect(recovered.results).toHaveLength(2);
    expect(calls.filter((call) => call.path === '/view')).toHaveLength(4);
    expect(submitted).toHaveLength(1);
    for (const item of [...original.results ?? [], ...recovered.results ?? []]) URL.revokeObjectURL(item.source);
  });
});
