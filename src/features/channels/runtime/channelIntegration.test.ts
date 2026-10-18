import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJSONStorage } from 'zustand/middleware';
import { IDBFactory } from 'fake-indexeddb';
const mocks = vi.hoisted(() => ({ native: false, http: vi.fn(), create: vi.fn(), update: vi.fn(), get: vi.fn(), image: vi.fn(), video: vi.fn() }));
vi.mock('@tauri-apps/api/core', async (original) => ({ ...await original<typeof import('@tauri-apps/api/core')>(), isTauri: () => mocks.native }));
vi.mock('@/commands/ai', async (original) => ({ ...await original<typeof import('@/commands/ai')>(), customHttpRequest: mocks.http,
  createGenerationJob: mocks.create, updateGenerationJob: mocks.update, getGenerationJobRecord: mocks.get }));
vi.mock('@/commands/image', async (original) => ({ ...await original<typeof import('@/commands/image')>(), prepareNodeImageSourceWithHeaders: mocks.image, persistVideoSource: mocks.video }));
import { createChannel, updateChannel, deleteChannel, parseProfileImport, testChannelModels, resolveNativeChannelModel } from '../application/channelService';
import { useChannelStore, channelProviderId, getChannelCredential } from '../store/channelStore';
import { useCustomProvidersStore } from '@/stores/customProvidersStore';
import { buildImageModelCatalog } from '@/features/canvas/application/modelCatalog';
import { buildVideoModelCatalog } from '@/features/canvas/application/videoModelCatalog';
import { buildChatModelCatalog } from '@/features/canvas/application/chatModelCatalog';
import { submitCustomProviderJob, getCustomProviderJobAsync, recoverCustomProviderJob, submitCustomVideoJob, submitCustomChatCompletion } from '@/features/canvas/infrastructure/customProviderGateway';
import { getChannelJobAsync, submitChannelJob } from './channelExecution';
import { createChannelHttpTransport, fetchChannelDocument } from './transport';
import { captureSubmitSnapshot } from './submitSnapshot';
import type { ChannelProfileV2 } from '../domain/profile';
import type { JobInput } from './types';
import { createAgentModelTransport } from '@/features/canvas/agent/infrastructure/agentModelGateway';
import { resolveAgentModelReference } from '@/features/canvas/agent/application/agentModelCapabilities';
import { channelChatInput } from '../application/channelService';
import type { AgentModelTurnRequest } from '@/features/canvas/agent/domain/agentModel';
import { comfyChannelJobFromRequest, recoverComfyChannelJob } from './comfyExecution';
import type { CustomProviderConfig } from '@/stores/customProvidersStore';

const values = new Map<string, string>();
const storage: Storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: (key) => { values.delete(key); },
  clear: () => values.clear(), key: (index) => [...values.keys()][index] ?? null, get length() { return values.size; } };
function profile(id = 'native-relay'): ChannelProfileV2 {
  return { version: 2, id, name: 'Native relay', baseUrl: 'https://relay.example', auth: { type: 'bearer' }, operations: {
    'image.generate': { method: 'POST', path: '/images', body: 'json', template: { model: '{{model}}', prompt: '{{prompt}}', quality: '{{param.quality}}' }, response: { mode: 'sync', outputs: [{ path: 'data[*].url', as: 'url' }] } },
    'video.generate': { method: 'POST', path: '/videos', body: 'json', template: { model: '{{model}}', prompt: '{{prompt}}' }, response: { mode: 'sync', outputs: [{ path: 'data[*].url', as: 'url', kind: 'video' }] } },
    chat: { method: 'POST', path: '/chat', body: 'json', template: { model: '{{model}}', messages: '{{messages}}' }, response: { mode: 'sync', outputs: [] } },
    'models.list': { method: 'GET', path: '/models', body: 'none', response: { mode: 'sync', outputs: [] } },
  }, models: [{ id: 'shared/model:latest', label: 'Shared', operations: ['image.generate', 'video.generate', 'chat'], params: [
    { key: 'quality', label: 'Quality', type: 'enum', options: [{ label: 'High', value: 'high' }] },
  ] }] };
}
const requestFor = (id: string, media: 'image' | 'video' = 'image') => ({ model: `custom:${channelProviderId(id, media)}:shared/model:latest`, prompt: 'a tree', size: 'auto', aspect_ratio: 'auto',
  extra_params: { quality: 'high', resolutionType: 'SHOULD-NOT-LEAK', invented: 'not declared' } });
async function settled(id: string) {
  for (let index = 0; index < 100; index += 1) {
    const job = await getCustomProviderJobAsync(id);
    if (['succeeded', 'failed', 'unknown', 'recoverable_wait'].includes(job.status)) return job;
    await vi.advanceTimersByTimeAsync(1);
  }
  throw new Error('job did not settle');
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('localStorage', storage); values.clear();
  useChannelStore.persist.setOptions({ storage: createJSONStorage(() => storage) });
  useCustomProvidersStore.persist.setOptions({ storage: createJSONStorage(() => storage) });
  useChannelStore.setState({ channels: [], migratedLegacyIds: [] }); useCustomProvidersStore.getState().replaceAll([]);
  mocks.native = false; mocks.http.mockReset(); mocks.create.mockReset().mockResolvedValue(undefined);
  mocks.update.mockReset().mockResolvedValue(undefined); mocks.get.mockReset(); mocks.image.mockReset().mockResolvedValue({ imagePath: '/local/output.png' });
  mocks.video.mockReset().mockResolvedValue('/local/output.mp4');
});
afterEach(() => { useChannelStore.setState({ channels: [], migratedLegacyIds: [] }); useCustomProvidersStore.getState().replaceAll([]); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('persistent native channels and intentional legacy routing', () => {
  it('projects all media immediately, preserves special providers, and does not persist projection credentials', async () => {
    const legacy = { id: 'local-comfy', label: 'Local', baseUrl: 'http://127.0.0.1:8188', apiStyle: 'comfyui', apiKey: '', models: ['workflow'], supportsWebSearch: false, extraParams: { arbitraryOldField: { keep: true } } };
    useCustomProvidersStore.getState().addProvider(legacy);
    createChannel(profile(), 'private-v2-key');
    const providers = useCustomProvidersStore.getState().providers;
    expect(providers.find((provider) => provider.id === legacy.id)).toEqual(legacy);
    expect(JSON.parse(storage.getItem('legacy_custom_providers')!)).toContainEqual(legacy);
    expect(buildImageModelCatalog({ customProviders: providers, dreaminaStatus: null, agnesApiKey: '' }).some((entry) => entry.id === requestFor('native-relay').model && entry.usable)).toBe(true);
    expect(buildVideoModelCatalog(providers).some((entry) => entry.id === requestFor('native-relay', 'video').model && entry.usable)).toBe(true);
    expect(buildChatModelCatalog(providers).find((entry) => entry.providerId === channelProviderId('native-relay', 'chat'))).toMatchObject({ usable: true, supportsTools: false, supportsStreaming: false });
    expect(storage.getItem('channels-v2-storage')).not.toContain('private-v2-key');
    expect(storage.getItem('custom-providers-storage')).not.toContain('private-v2-key');
    expect(getChannelCredential('native-relay')).toBe('private-v2-key');
    expect(resolveNativeChannelModel(requestFor('native-relay').model)?.model.id).toBe('shared/model:latest');
    updateChannel('native-relay', { ...profile(), name: 'Renamed' });
    expect(useCustomProvidersStore.getState().providers.find((provider) => provider.id === channelProviderId('native-relay', 'image'))?.label).toBe('Renamed');
    // A second hydrate restores native profiles and all picker projections.
    useChannelStore.setState({ channels: [] });
    const saved = JSON.stringify({ state: { channels: [{ profile: profile(), origin: 'native', migrationIssues: [], createdAt: 1, updatedAt: 1 }], migratedLegacyIds: ['local-comfy'] }, version: 2 });
    storage.setItem('channels-v2-storage', saved); await useChannelStore.persist.rehydrate();
    expect(resolveNativeChannelModel(requestFor('native-relay').model)).not.toBeNull();
    deleteChannel('native-relay');
    expect(resolveNativeChannelModel(requestFor('native-relay').model)).toBeNull();
    expect(useCustomProvidersStore.getState().providers.find((provider) => provider.id === legacy.id)).toEqual(legacy);
  });
  it('round-trips a strict profile from one JSON block and rejects ambiguous/unknown fields', () => {
    expect(parseProfileImport(`Here is the profile:\n\`\`\`json\n${JSON.stringify(profile())}\n\`\`\``)).toMatchObject({ ok: true, profile: profile() });
    expect(parseProfileImport(JSON.stringify({ ...profile(), apiKey: 'do-not-store' }))).toMatchObject({ ok: false, errors: [{ path: 'apiKey' }] });
    expect(parseProfileImport('```json\n{}\n```\n```json\n{}\n```')).toMatchObject({ ok: false });
  });
  it('routes real image/video/chat requests through the exact template and native bridge', async () => {
    mocks.native = true; createChannel(profile(), 'secret');
    mocks.http.mockResolvedValueOnce({ status: 200, text: JSON.stringify({ data: [{ url: 'https://cdn.example/result.png' }] }) });
    const imageId = await submitCustomProviderJob(requestFor('native-relay'));
    expect(imageId).toMatch(/^custom-local-channel-job-/);
    expect(await settled(imageId)).toMatchObject({ status: 'succeeded', result: '/local/output.png' });
    expect(mocks.http.mock.calls[0][0]).toMatchObject({ url: 'https://relay.example/images', method: 'POST', headers: { Authorization: 'Bearer secret' }, body: { model: 'shared/model:latest', prompt: 'a tree', quality: 'high' } });
    expect(mocks.http.mock.calls[0][0].body).not.toHaveProperty('resolutionType');
    expect(JSON.stringify(mocks.create.mock.calls)).not.toContain('Bearer secret');
    mocks.http.mockResolvedValueOnce({ status: 200, text: JSON.stringify({ data: [{ url: 'https://cdn.example/result.mp4' }] }) });
    expect(await settled(await submitCustomVideoJob(requestFor('native-relay', 'video')))).toMatchObject({ status: 'succeeded', result: '/local/output.mp4' });
    mocks.http.mockResolvedValueOnce({ status: 200, text: JSON.stringify({ choices: [{ message: { content: 'actual upstream text' } }] }) });
    const chat = await submitCustomChatCompletion(`custom:${channelProviderId('native-relay', 'chat')}:shared/model:latest`, { messages: [{ role: 'user', content: 'hello' }] });
    expect(chat).toMatchObject({ text: 'actual upstream text', raw: { choices: [{ message: { content: 'actual upstream text' } }] } });
    expect(mocks.http.mock.calls[2][0].body).toEqual({ model: 'shared/model:latest', messages: [{ role: 'user', content: 'hello' }] });
  });
  it('keeps a live delayed submit submitting when polled and then delivers its automatically queried result', async () => {
    mocks.native = true; const config = profile('live-delayed-submit');
    config.operations['image.generate']!.response = { mode: 'async', taskIdPath: 'id', poll: { method: 'GET', path: '/tasks/{{taskId}}', intervalSec: 1, timeoutMin: 1,
      statusPath: 'status', success: ['completed'], failure: ['failed'], outputs: [{ path: 'data[*].url', as: 'url' }] } };
    createChannel(config, 'live-private-key');
    const accepted = Promise.withResolvers<{ status: number; text: string }>();
    const submitStarted = Promise.withResolvers<void>();
    mocks.http.mockImplementationOnce(() => { submitStarted.resolve(); return accepted.promise; })
      .mockResolvedValueOnce({ status: 200, text: JSON.stringify({ status: 'completed', data: [{ url: 'https://cdn.example/live-result.png' }] }) });
    const id = await submitCustomProviderJob(requestFor(config.id));
    await submitStarted.promise;
    expect(await getChannelJobAsync(id)).toMatchObject({ status: 'submitting', resumable: false });
    expect(await getCustomProviderJobAsync(id)).toMatchObject({ status: 'submitting', resumable: false });
    expect(mocks.update.mock.calls.some(([update]) => update.status === 'unknown')).toBe(false);
    expect(mocks.http).toHaveBeenCalledTimes(1);
    accepted.resolve({ status: 200, text: JSON.stringify({ id: 'delayed-accepted-task' }) });
    expect(await settled(id)).toMatchObject({ status: 'succeeded', external_task_id: 'delayed-accepted-task', result: '/local/output.png' });
    expect(mocks.http).toHaveBeenCalledTimes(2);
    expect(mocks.http.mock.calls[1][0]).toMatchObject({ method: 'GET', url: 'https://relay.example/tasks/delayed-accepted-task' });
    expect(mocks.http.mock.calls.filter(([request]) => request.method === 'POST')).toHaveLength(1);
    expect(mocks.update.mock.calls.some(([update]) => update.status === 'unknown')).toBe(false);
  });
  it('round-trips native OpenAI tools through the template into the existing Agent codec', async () => {
    mocks.native = true; const config = profile('agent-tools');
    config.operations.chat = { method: 'POST', path: '/v1/chat/completions', body: 'json',
      template: { model: '{{model}}', messages: '{{messages}}', tools: '{{tools}}', tool_choice: '{{toolChoice}}' }, response: { mode: 'sync', outputs: [] } };
    createChannel(config, 'agent-private-key');
    const catalog = buildChatModelCatalog(useCustomProvidersStore.getState().providers).find((entry) => entry.providerId === channelProviderId(config.id, 'chat'))!;
    expect(catalog).toMatchObject({ supportsTools: true, supportsStreaming: false });
    const turn: AgentModelTurnRequest = { model: resolveAgentModelReference(catalog),
      input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'Inspect current canvas' }] }],
      tools: [{ namespace: 'canvas', name: 'inspect', description: 'Inspect canvas', parameters: { type: 'object', properties: {}, additionalProperties: false }, strict: true }], toolChoice: 'auto' };
    mocks.http.mockResolvedValueOnce({ status: 200, text: JSON.stringify({ id: 'actual-upstream-response', choices: [{ finish_reason: 'tool_calls', message: { content: null,
      tool_calls: [{ id: 'actual-call-id', type: 'function', function: { name: 'canvas__inspect', arguments: '{}' } }] } }] }) });
    const result = await createAgentModelTransport().getResponse(turn);
    expect(result).toMatchObject({ toolCalls: [{ callId: 'actual-call-id', name: 'inspect', namespace: 'canvas', arguments: '{}' }] });
    expect(mocks.http.mock.calls[0][0].body).toMatchObject({ model: 'shared/model:latest', tool_choice: 'auto', tools: [{ type: 'function', function: { name: 'canvas__inspect' } }] });
    expect(mocks.create).not.toHaveBeenCalled();
    const continuation = channelChatInput(config, config.models[0].id, { messages: [
      { role: 'assistant', content: null, tool_calls: [{ id: 'actual-call-id', type: 'function', function: { name: 'canvas__inspect', arguments: '{}' } }] },
      { role: 'tool', content: '{"nodes":[]}', tool_call_id: 'actual-call-id', name: 'canvas__inspect' },
    ], tools: [], tool_choice: 'none' });
    expect(continuation.messages?.[0].tool_calls).toHaveLength(1);
    expect(continuation.messages?.[1]).toMatchObject({ tool_call_id: 'actual-call-id', name: 'canvas__inspect' });
  });
  it('models.list is a free read and does not fall back to a generation submit', async () => {
    mocks.native = true;
    mocks.http.mockResolvedValue({ status: 200, text: JSON.stringify({ data: [{ id: 'available' }] }) });
    expect(await testChannelModels(profile(), 'secret')).toEqual({ ok: true, models: ['available'] });
    expect(mocks.http).toHaveBeenCalledTimes(1); expect(mocks.http.mock.calls[0][0].method).toBe('GET');
    const noList = profile(); delete noList.operations['models.list'];
    expect(await testChannelModels(noList, 'secret')).toMatchObject({ ok: false });
    expect(mocks.http).toHaveBeenCalledTimes(1);
  });
  it('does not replay an ambiguous submit and persists browser unknown state without native fallback', async () => {
    createChannel(profile('ambiguous'), 'private');
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('network disconnected')); vi.stubGlobal('fetch', fetchMock);
    const id = await submitCustomProviderJob(requestFor('ambiguous'));
    expect(await settled(id)).toMatchObject({ status: 'unknown', resumable: false });
    await expect(recoverCustomProviderJob(id)).rejects.toThrow('不会重新提交');
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(mocks.http).not.toHaveBeenCalled();
    expect(JSON.parse(storage.getItem('channel-generation-jobs-v2')!)[id]).toMatchObject({ status: 'unknown' });
    expect(storage.getItem('channel-generation-jobs-v2')).not.toContain('Bearer private');
  });
  it('recovers a persisted dynamic polling snapshot by task ID with GET only', async () => {
    mocks.native = true; const config = profile('recovered');
    config.operations['image.generate']!.response = { mode: 'async', taskIdPath: 'id', poll: { method: 'GET', path: '{{submit.status_url}}', intervalSec: 0.001, timeoutMin: 1,
      statusPath: 'status', success: ['completed'], failure: ['failed'], outputs: [{ path: 'data[*].url', as: 'url' }] } };
    createChannel(config, 'private-recovery-key');
    const id = 'custom-local-channel-job-recovered';
    const input: JobInput = { jobId: id, channelId: config.id, modelId: config.models[0].id, operation: 'image.generate', prompt: '', params: {}, refs: [], count: 1 };
    mocks.get.mockResolvedValue({ job_id: id, status: 'running', provider_id: config.id, external_task_id: 'durable-upstream-id', resumable: true,
      poll_descriptor: { version: 2, adapter: 'template', profile: config, input, submit: { status_url: 'https://relay.example/tasks/durable-upstream-id' } } });
    mocks.http.mockResolvedValue({ status: 200, text: JSON.stringify({ status: 'completed', data: [{ url: 'https://cdn.example/output.png' }] }) });
    await getChannelJobAsync(id);
    expect(await settled(id)).toMatchObject({ status: 'succeeded', result: '/local/output.png' });
    expect(mocks.http).toHaveBeenCalledTimes(1);
    expect(mocks.http.mock.calls[0][0]).toMatchObject({ method: 'GET', url: 'https://relay.example/tasks/durable-upstream-id' });
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('hydrates retained browser media before recovery-first returns or polling caches the successful job', async () => {
    // IndexedDB completion drives this fixture; no timing guesses or generation.
    vi.useRealTimers(); vi.stubGlobal('indexedDB', new IDBFactory());
    const id = 'custom-local-channel-job-browser-recovery-first';
    const config = profile('browser-recovery-first');
    const input: JobInput = { jobId: id, channelId: config.id, modelId: config.models[0].id, operation: 'image.generate', prompt: '', params: {}, refs: [], count: 1 };
    const assetKey = `${id}:0`; const retained = new Blob(['retained image bytes'], { type: 'image/webp' });
    const opened = Promise.withResolvers<IDBDatabase>();
    const request = indexedDB.open('channel-generation-assets', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('assets');
    request.onsuccess = () => opened.resolve(request.result); request.onerror = () => opened.reject(request.error);
    const db = await opened.promise;
    const committed = Promise.withResolvers<void>();
    const transaction = db.transaction('assets', 'readwrite'); transaction.objectStore('assets').put(retained, assetKey);
    transaction.oncomplete = () => committed.resolve(); transaction.onerror = () => committed.reject(transaction.error);
    await committed.promise; db.close();
    storage.setItem('channel-generation-jobs-v2', JSON.stringify({ [id]: { job_id: id, status: 'succeeded', media_type: 'image',
      result: 'blob:expired-previous-process', resumable: false,
      poll_descriptor: { version: 2, adapter: 'template', profile: config, input, submit: {}, assets: [assetKey] } } }));
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fresh-retained-image');
    try {
      const recovered = await recoverCustomProviderJob(id);
      expect(recovered).toMatchObject({ status: 'succeeded', result: 'blob:fresh-retained-image' });
      expect(await getChannelJobAsync(id)).toMatchObject({ status: 'succeeded', result: 'blob:fresh-retained-image' });
      expect(createUrl).toHaveBeenCalledTimes(1);
      const restored = createUrl.mock.calls[0][0];
      expect(restored).toBeInstanceOf(Blob);
      if (restored instanceof Blob) {
        expect(restored.type).toBe('image/webp'); expect(await restored.text()).toBe('retained image bytes');
      }
      expect(mocks.http).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.get).not.toHaveBeenCalled();
    } finally { createUrl.mockRestore(); }
  });
  it.each([false, true])('resumes interrupted synchronous output download with auth=%s and no task ID or submit', async (auth) => {
    mocks.native = true; const config = profile(`materializing-${auth}`); createChannel(config, 'download-private-key');
    const id = `custom-local-channel-job-materializing-${auth}`;
    const input: JobInput = { jobId: id, channelId: config.id, modelId: config.models[0].id, operation: 'image.generate', prompt: '', params: {}, refs: [], count: 1 };
    mocks.get.mockResolvedValue({ job_id: id, status: 'materializing', provider_id: config.id, resumable: true,
      poll_descriptor: { version: 2, adapter: 'template', profile: config, input, submit: {},
        outputs: [{ kind: 'image', url: 'https://relay.example/retained-output.png', auth }] } });
    await getChannelJobAsync(id);
    expect(await settled(id)).toMatchObject({ status: 'succeeded', result: '/local/output.png' });
    expect(mocks.image).toHaveBeenCalledWith('https://relay.example/retained-output.png', auth ? { Authorization: 'Bearer download-private-key' } : {}, 512, expect.any(Object));
    expect(mocks.http).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each([401, 403, 404])('keeps accepted tasks recoverable after polling HTTP %s and queries after credentials are corrected', async (status) => {
    mocks.native = true; const config = profile(`poll-access-${status}`);
    config.operations['image.generate']!.response = { mode: 'async', taskIdPath: 'id', poll: { method: 'GET', path: '/tasks/{{taskId}}', intervalSec: 1, timeoutMin: 1,
      statusPath: 'status', success: ['completed'], failure: ['failed'], outputs: [{ path: 'data[*].url', as: 'url' }] } };
    createChannel(config, 'old-private-key'); const id = `custom-local-channel-job-poll-access-${status}`;
    const input: JobInput = { jobId: id, channelId: config.id, modelId: config.models[0].id, operation: 'image.generate', prompt: '', params: {}, refs: [], count: 1 };
    mocks.get.mockResolvedValue({ job_id: id, status: 'running', provider_id: config.id, external_task_id: 'accepted-task', resumable: true,
      poll_descriptor: { version: 2, adapter: 'template', profile: config, input, submit: {} } });
    mocks.http.mockResolvedValueOnce({ status, text: 'query access unavailable' });
    await getChannelJobAsync(id);
    expect(await settled(id)).toMatchObject({ status: 'recoverable_wait', external_task_id: 'accepted-task', resumable: true });
    await vi.advanceTimersByTimeAsync(1);
    updateChannel(config.id, config, 'corrected-private-key');
    mocks.http.mockResolvedValueOnce({ status: 200, text: JSON.stringify({ status: 'completed', data: [{ url: 'https://cdn.example/recovered.png' }] }) });
    await recoverCustomProviderJob(id); await vi.advanceTimersByTimeAsync(1);
    expect(await settled(id)).toMatchObject({ status: 'succeeded' });
    expect(mocks.http).toHaveBeenCalledTimes(2);
    expect(mocks.http.mock.calls[1][0]).toMatchObject({ method: 'GET', headers: { Authorization: 'Bearer corrected-private-key' } });
    expect(mocks.http.mock.calls.some(([request]) => request.method === 'POST')).toBe(false);
  });
  it('keeps explicit upstream task failure terminal rather than treating it as a query access error', async () => {
    mocks.native = true; const config = profile('upstream-terminal');
    config.operations['image.generate']!.response = { mode: 'async', taskIdPath: 'id', poll: { method: 'GET', path: '/tasks/{{taskId}}', intervalSec: 1, timeoutMin: 1,
      statusPath: 'status', success: ['completed'], failure: ['failed'], outputs: [{ path: 'data[*].url', as: 'url' }] } };
    createChannel(config, 'private-key'); const id = 'custom-local-channel-job-upstream-terminal';
    const input: JobInput = { jobId: id, channelId: config.id, modelId: config.models[0].id, operation: 'image.generate', prompt: '', params: {}, refs: [], count: 1 };
    mocks.get.mockResolvedValue({ job_id: id, status: 'running', provider_id: config.id, external_task_id: 'failed-upstream-task', resumable: true,
      poll_descriptor: { version: 2, adapter: 'template', profile: config, input, submit: {} } });
    mocks.http.mockResolvedValueOnce({ status: 200, text: JSON.stringify({ status: 'failed' }) });
    await getChannelJobAsync(id);
    expect(await settled(id)).toMatchObject({ status: 'failed', resumable: false });
    expect(await recoverCustomProviderJob(id)).toMatchObject({ status: 'failed', resumable: false });
    expect(mocks.http).toHaveBeenCalledTimes(1);
  });
  it('fails before paid submission if durable task creation fails', async () => {
    mocks.native = true; mocks.create.mockRejectedValueOnce(new Error('disk full'));
    const config = profile('disk-failure'); createChannel(config, 'private');
    const input: JobInput = { jobId: '', channelId: config.id, modelId: config.models[0].id, operation: 'image.generate', prompt: 'test', params: {}, refs: [], count: 1 };
    await expect(submitChannelJob(config, input)).rejects.toThrow('disk full'); expect(mocks.http).not.toHaveBeenCalled();
  });
});

describe('ComfyUI snapshot gateway cutover', () => {
  const comfyConfig = (): CustomProviderConfig => ({ id: 'comfy-snapshot', label: 'Comfy', baseUrl: 'http://127.0.0.1:8188/comfy', apiKey: '',
    apiStyle: 'comfyui', models: ['workflow'], supportsWebSearch: false, extraParams: { auth: { mode: 'none' }, comfyui: {
      workflow: { '6': { class_type: 'CLIPTextEncode', inputs: { text: 'saved workflow default' } }, '9': { class_type: 'SaveImage', inputs: { images: ['6', 0] } },
        '10': { class_type: 'SaveImage', inputs: { images: ['6', 0] } } },
      bindings: { prompt: { nodeId: '6', input: 'text' } }, outputNodeIds: ['9', '10'], pollIntervalMs: 500, pollTimeoutMs: 5000,
    } } });
  const comfyRequest = { model: 'custom:comfy-snapshot:workflow', prompt: 'expanded prompt must not persist', size: '1024x1024', aspect_ratio: '1:1' };
  it('maps all legacy output IDs into immutable adapter bindings without expanded prompt or keys', () => {
    const config = comfyConfig(); const snapshot = comfyChannelJobFromRequest(config, 'workflow', comfyRequest, 'job');
    const descriptor = snapshot.input.params.comfyuiSnapshot as { [key: string]: unknown };
    expect(descriptor.outputNodeIds).toEqual(['9', '10']);
    expect(descriptor.bindings).toMatchObject({ prompt: { nodeId: '6', input: 'text' }, output: { nodeId: '9', input: '$output' } });
    expect(snapshot.input.prompt).toBe(''); expect(JSON.stringify(snapshot)).not.toContain(comfyRequest.prompt);
    (config.extraParams!.comfyui as { workflow: Record<string, unknown> }).workflow['6'] = { broken: true };
    expect(descriptor.workflow).toMatchObject({ '6': { class_type: 'CLIPTextEncode', inputs: { text: 'saved workflow default' } } });
  });
  it('routes a single prompt POST through snapshot adapter and uses the second configured output', async () => {
    mocks.native = true; useCustomProvidersStore.getState().addProvider(comfyConfig());
    mocks.http.mockResolvedValueOnce({ status: 200, text: JSON.stringify({ prompt_id: 'snapshot-prompt-id' }) })
      .mockResolvedValueOnce({ status: 200, text: JSON.stringify({ 'snapshot-prompt-id': { outputs: { '10': { images: [{ filename: 'real.png', subfolder: '', type: 'output' }] } } } }) });
    const id = await submitCustomProviderJob(comfyRequest);
    expect(id).toMatch(/^custom-local-comfy-v2-/);
    expect(await settled(id)).toMatchObject({ status: 'succeeded', external_task_id: 'snapshot-prompt-id' });
    expect(mocks.http.mock.calls.filter(([request]) => request.method === 'POST')).toHaveLength(1);
    expect(mocks.http.mock.calls[0][0].body.prompt['6'].inputs.text).toBe(comfyRequest.prompt);
    expect(JSON.stringify(mocks.create.mock.calls)).not.toContain(comfyRequest.prompt);
  });
  it('restores workflow/output snapshot after saved config changes without another prompt POST', async () => {
    mocks.native = true; const config = comfyConfig();
    const id = 'custom-local-comfy-v2-restored'; const snapshot = comfyChannelJobFromRequest(config, 'workflow', comfyRequest, id);
    useCustomProvidersStore.getState().addProvider({ ...config, baseUrl: 'http://changed.example', extraParams: { auth: { mode: 'none' } } });
    mocks.get.mockResolvedValue({ job_id: id, status: 'unknown', external_task_id: 'old-prompt-id', provider_id: config.id, resumable: true, poll_descriptor: snapshot });
    mocks.http.mockResolvedValueOnce({ status: 200, text: JSON.stringify({ 'old-prompt-id': { outputs: { '10': { images: [{ filename: 'restored.png', subfolder: '', type: 'output' }] } } } }) });
    expect(await recoverComfyChannelJob(id)).toMatchObject({ status: 'succeeded' });
    expect(mocks.http).toHaveBeenCalledTimes(1);
    expect(mocks.http.mock.calls[0][0]).toMatchObject({ method: 'GET', url: 'http://127.0.0.1:8188/comfy/history/old-prompt-id' });
  });
  it('never replays an unknown ComfyUI request lacking prompt ID', async () => {
    mocks.native = true; const config = comfyConfig(); const id = 'custom-local-comfy-v2-no-id';
    const snapshot = comfyChannelJobFromRequest(config, 'workflow', comfyRequest, id);
    mocks.get.mockResolvedValue({ job_id: id, status: 'unknown', resumable: false, poll_descriptor: snapshot });
    await expect(recoverComfyChannelJob(id)).rejects.toThrow('不会重新提交');
    expect(mocks.http).not.toHaveBeenCalled();
  });
});

describe('channel transport and minimal recovery snapshots', () => {
  it('does not use browser fetch if the native bridge fails', async () => {
    mocks.native = true; mocks.http.mockRejectedValue(new Error('native bridge unavailable'));
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    await expect(createChannelHttpTransport()({ method: 'GET', url: 'https://relay.example/models', headers: {}, body: { mode: 'none' } })).rejects.toThrow('native bridge unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('retains only declared primitive polling fields, never reconstructs the response', () => {
    const config = profile(); config.operations['image.generate']!.response = { mode: 'async', taskIdPath: 'id', poll: { method: 'GET', path: '{{submit.status_url}}', intervalSec: 1, timeoutMin: 1, success: [], failure: [], outputs: [] } };
    expect(captureSubmitSnapshot(config, 'image.generate', { id: 'task', status_url: 'https://relay.example/tasks/task', api_key: 'private', nested: { prompt: 'private' } }, 'private')).toEqual({ status_url: 'https://relay.example/tasks/task' });
    expect(() => captureSubmitSnapshot(config, 'image.generate', { status_url: 'https://other.example/task' }, 'private')).toThrow('不可安全持久化');
    expect(() => captureSubmitSnapshot(config, 'image.generate', { status_url: 'https://relay.example/task?token=private' }, 'private')).toThrow();
  });
  it('bounds native documentation reads and never attaches channel credentials', async () => {
    mocks.native = true; mocks.http.mockResolvedValue({ status: 200, text: 'document' });
    expect(await fetchChannelDocument('https://docs.example/api')).toBe('document');
    expect(mocks.http.mock.calls[0][0]).toMatchObject({ method: 'GET', maxResponseBytes: 204800 });
    expect(mocks.http.mock.calls[0][0].headers).not.toHaveProperty('Authorization');
    await expect(fetchChannelDocument('https://docs.example/api?api_key=secret')).rejects.toThrow('密钥参数');
  });
});
