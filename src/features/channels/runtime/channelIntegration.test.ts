import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJSONStorage } from 'zustand/middleware';
import { IDBFactory } from 'fake-indexeddb';
import type * as ImageCommands from '@/commands/image';
const mocks = vi.hoisted(() => ({ native: false, http: vi.fn(), create: vi.fn(), update: vi.fn(), get: vi.fn(), image: vi.fn(), video: vi.fn(), load: vi.fn(), audio: vi.fn() }));
vi.mock('@tauri-apps/api/core', async (original) => ({ ...await original<typeof import('@tauri-apps/api/core')>(), isTauri: () => mocks.native }));
vi.mock('@/commands/ai', async (original) => ({ ...await original<typeof import('@/commands/ai')>(), customHttpRequest: mocks.http,
  createGenerationJob: mocks.create, updateGenerationJob: mocks.update, getGenerationJobRecord: mocks.get }));
vi.mock('@/commands/image', async (original) => ({ ...await original<typeof ImageCommands>(), prepareNodeImageSourceWithHeaders: mocks.image, persistVideoSource: mocks.video, loadImage: mocks.load, loadAudioSourceDataUrl: mocks.audio }));
import { createChannel, updateChannel, deleteChannel, parseProfileImport, testChannelModels, resolveNativeChannelModel } from '../application/channelService';
import { useChannelStore, channelProviderId, getChannelCredential } from '../store/channelStore';
import { useCustomProvidersStore } from '@/stores/customProvidersStore';
import { buildImageModelCatalog } from '@/features/canvas/application/modelCatalog';
import { buildVideoModelCatalog } from '@/features/canvas/application/videoModelCatalog';
import { buildChatModelCatalog } from '@/features/canvas/application/chatModelCatalog';
import { submitCustomProviderJob, getCustomProviderJobAsync, recoverCustomProviderJob, submitCustomVideoJob, buildCustomProviderRequestDebugPreview } from '@/features/canvas/infrastructure/providerGateway';
import { submitCustomChatCompletion } from './channelChat';
import { authorizeChannelJob, channelJobFromRequest, getChannelJobAsync, submitChannelJob, waitForChannelJob } from './channelExecution';
import { renderPreview } from '../domain/template';
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
import type { GenerateRequest } from '@/commands/ai';
import { buildGenerateVideoDebugPreview, tauriAiGateway } from '@/features/canvas/infrastructure/tauriAiGateway';
import { revealChannelCredential, useMemorySecretVault } from '@/features/secrets/testSupport';
import * as secretVault from '@/features/secrets/secretStore';

useMemorySecretVault();

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
function slottedProfile(): ChannelProfileV2 {
  const config = profile('slotted');
  config.models[0].modes = [
    { id: 'frames', label: '首尾帧', operation: 'video.generate', slots: [
      { key: 'first_frame', label: '首帧', kind: 'image', min: 1, max: 1 },
      { key: 'last_frame', label: '尾帧', kind: 'image', max: 1 },
    ], params: [{ key: 'frame_strength', label: 'Strength', type: 'number' }], endpoint: {
      method: 'POST', path: '/frames', body: 'json', imageEncoding: 'data-url',
      template: { model: '{{model}}', first: '{{slotFirst.first_frame}}', last: '{{slot.last_frame}}', strength: '{{param.frame_strength}}' },
      response: { mode: 'sync', outputs: [{ path: 'data[*].url', as: 'url', kind: 'video' }] },
    } },
    { id: 'text', label: '文生', operation: 'video.generate', slots: [] },
  ];
  return config;
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
beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal('localStorage', storage); values.clear();
  useChannelStore.persist.setOptions({ storage: createJSONStorage(() => storage) });
  useCustomProvidersStore.persist.setOptions({ storage: createJSONStorage(() => storage) });
  useChannelStore.setState({ channels: [], migratedLegacyIds: [] }); await useCustomProvidersStore.getState().replaceAll([]);
  mocks.native = false; mocks.http.mockReset(); mocks.create.mockReset().mockResolvedValue(undefined);
  mocks.update.mockReset().mockResolvedValue(undefined); mocks.get.mockReset(); mocks.image.mockReset().mockResolvedValue({ imagePath: '/local/output.png' });
  mocks.video.mockReset().mockResolvedValue('/local/output.mp4');
  mocks.load.mockReset().mockResolvedValue('data:image/png;base64,FRAME');
  mocks.audio.mockReset().mockResolvedValue('data:audio/mpeg;base64,AUDIO');
});
afterEach(async () => { useChannelStore.setState({ channels: [], migratedLegacyIds: [] }); await useCustomProvidersStore.getState().replaceAll([]); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('persistent channels and independent special adapters', () => {
  it.each(['completed', 'business-error'] as const)('restores the old GRSAI task snapshot and handles its %s query without resubmission', async (outcome) => {
    mocks.native = true; const config = profile(`restored-grsai-${outcome}`); config.baseUrl = 'https://grsai.dakka.com.cn';
    config.operations['image.generate']!.response = { mode: 'async', taskIdPath: 'data.id', poll: { method: 'POST', path: '/v1/draw/result', template: { id: '{{taskId}}' },
      intervalSec: 2, timeoutMin: 2, statusPath: 'data.status', success: ['succeeded'], failure: ['failed'], outputs: [{ path: 'data.results[0].url', as: 'url' }] } };
    await createChannel(config, 'fixture-key');
    const id = `custom-local-channel-job-restored-grsai-${outcome}`;
    const input: JobInput = { jobId: id, channelId: config.id, modelId: config.models[0].id, operation: 'image.generate', prompt: '', params: {}, refs: [], count: 1 };
    mocks.get.mockResolvedValue({ job_id: id, provider_id: config.id, status: 'unknown', phase: 'poll', external_task_id: 'original-grsai-task',
      error_category: 'timeout', resumable: true, poll_descriptor: { version: 2, adapter: 'template', profile: config, input, submit: {} } });
    mocks.http.mockResolvedValueOnce({ status: 200, text: JSON.stringify(outcome === 'completed'
      ? { code: 0, data: { status: 'success', results: [{ url: 'https://cdn.example/original-grsai.png' }] } }
      : { code: -22, msg: 'fixture query unavailable', data: null }) });
    await recoverCustomProviderJob(id);
    const result = await waitForChannelJob(id);
    expect(result).toMatchObject({ external_task_id: 'original-grsai-task', status: outcome === 'completed' ? 'succeeded' : 'recoverable_wait' });
    if (outcome === 'completed') expect(result.result).toBe('/local/output.png');
    else expect(result).toMatchObject({ resumable: true, error: expect.stringContaining('code -22') });
    await vi.advanceTimersByTimeAsync(120000);
    expect(mocks.http).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ url: 'https://grsai.dakka.com.cn/v1/draw/result', method: 'POST', body: { id: 'original-grsai-task' } }));
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.image).toHaveBeenCalledTimes(outcome === 'completed' ? 1 : 0);
  });
  it('publishes every downloaded native output including mixed video and tail-frame results', async () => {
    mocks.native = true; const config = profile('all-outputs');
    config.operations['video.generate']!.response = { mode: 'sync', outputs: [
      { path: 'videos[*]', as: 'url', kind: 'video' }, { path: 'last_frame', as: 'url', kind: 'image' },
    ] };
    await createChannel(config, 'all-output-key');
    mocks.video.mockResolvedValueOnce('/local/one.mp4').mockResolvedValueOnce('/local/two.mp4');
    mocks.image.mockResolvedValueOnce({ imagePath: '/local/tail.png' });
    mocks.http.mockResolvedValueOnce({ status: 200, text: JSON.stringify({ videos: ['https://cdn.example/one.mp4', 'https://cdn.example/two.mp4'], last_frame: 'https://cdn.example/tail.png' }) });
    expect(await settled(await submitCustomVideoJob(requestFor(config.id, 'video')))).toMatchObject({ status: 'succeeded', result: '/local/one.mp4', results: [
      { kind: 'video', source: '/local/one.mp4' }, { kind: 'video', source: '/local/two.mp4' }, { kind: 'image', source: '/local/tail.png' },
    ] });
  });
  it('retains bounded verbatim upstream job and chat failures with status and redacted secrets', async () => {
    mocks.native = true; const config = profile('upstream-error'); await createChannel(config, 'private-upstream-key');
    const raw = '{"error":{"message":"verbatim provider reason","key":"private-upstream-key"}}';
    mocks.http.mockResolvedValueOnce({ status: 403, text: raw.replace('private-upstream-key', getChannelCredential(config.id)) });
    const failed = await settled(await submitCustomProviderJob(requestFor(config.id)));
    expect(failed).toMatchObject({ status: 'failed', error_status: 403, error_raw: raw.replace('private-upstream-key', '[redacted]') });
    expect(failed.error).toContain('HTTP 403'); expect(failed.error).toContain('verbatim provider reason'); expect(JSON.stringify(failed)).not.toContain('private-upstream-key');
    mocks.http.mockResolvedValueOnce({ status: 401, text: raw.replace('private-upstream-key', getChannelCredential(config.id)) });
    await expect(submitCustomChatCompletion(`custom:${channelProviderId(config.id, 'chat')}:${config.models[0].id}`, { messages: [{ role: 'user', content: 'hello' }] }))
      .rejects.toMatchObject({ status: 401, upstreamMessage: raw.replace('private-upstream-key', '[redacted]'), message: expect.stringContaining('verbatim provider reason') });
  });
  it('bounds diagnostic text before exposing and persisting upstream failures', async () => {
    mocks.native = true; const config = profile('bounded-upstream-error'); await createChannel(config, 'bounded-secret');
    mocks.http.mockResolvedValueOnce({ status: 404, text: `verbatim prefix ${getChannelCredential(config.id)} ${'x'.repeat(5000)}` });
    const failed = await settled(await submitCustomProviderJob(requestFor(config.id)));
    expect(failed.error_raw).toHaveLength(2000); expect(failed.error?.length).toBeLessThanOrEqual(2000);
    expect(failed.error_raw).toMatch(/^verbatim prefix \[redacted\] /);
    expect(failed.error).toContain('https://relay.example/images');
    const saved = mocks.update.mock.calls.at(-1)![0].pollDescriptor.failure;
    expect(saved).toMatchObject({ status: 404, raw: failed.error_raw });
    expect(JSON.stringify(saved)).not.toContain('bounded-secret');
  });
  it('projects and executes mode-only chat and audio channels', async () => {
    mocks.native = true; const config = profile('mode-only-chat-audio'); const model = config.models[0];
    model.operations = []; model.modes = [{ id: 'chat', label: 'Chat', operation: 'chat' }, { id: 'audio', label: 'Audio', operation: 'audio.generate', slots: [], endpoint: {
      method: 'POST', path: '/audio', body: 'json', template: { text: '{{prompt}}' }, response: { mode: 'sync', outputs: [{ path: 'audio', as: 'url', kind: 'audio' }] },
    } }];
    await createChannel(config, 'mode-only-key');
    expect(useCustomProvidersStore.getState().providers).toContainEqual(expect.objectContaining({ id: `channel-${config.id}-audio`, mediaType: 'audio', models: [model.id] }));
    mocks.http.mockResolvedValueOnce({ status: 200, text: JSON.stringify({ choices: [{ message: { content: 'mode-only works' } }] }) });
    expect(await submitCustomChatCompletion(`custom:${channelProviderId(config.id, 'chat')}:${model.id}`, { messages: [{ role: 'user', content: 'hello' }] })).toMatchObject({ text: 'mode-only works' });
  });
  it('rejects URL-only local references with slot metadata before persistence and HTTP', async () => {
    mocks.native = true; const config = slottedProfile();
    config.models[0].modes![0].endpoint!.imageEncoding = 'url'; await createChannel(config, 'url-only-key');
    await expect(submitCustomVideoJob({ ...requestFor(config.id, 'video'), channel_mode_id: 'frames', reference_slots: { first_frame: ['data:image/png;base64,AA=='] } }))
      .rejects.toMatchObject({ code: 'reference.needsPublicUrl', slotKey: 'first_frame' });
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.http).not.toHaveBeenCalled();
  });
  it('projects all media immediately, preserves special providers, and does not persist projection credentials', async () => {
    const legacy = { id: 'local-comfy', label: 'Local', baseUrl: 'http://127.0.0.1:8188', apiStyle: 'comfyui', apiKey: '', models: ['workflow'], supportsWebSearch: false, extraParams: { arbitraryOldField: { keep: true } } };
    await useCustomProvidersStore.getState().addProvider(legacy);
    await createChannel(profile(), 'private-v2-key');
    const providers = useCustomProvidersStore.getState().providers;
    expect(providers.find((provider) => provider.id === legacy.id)).toMatchObject(legacy);
    await vi.waitFor(() => expect(JSON.parse(storage.getItem('legacy_custom_providers')!)).toContainEqual(expect.objectContaining(legacy)));
    expect(buildImageModelCatalog({ customProviders: providers, dreaminaStatus: null }).some((entry) => entry.id === requestFor('native-relay').model && entry.usable)).toBe(true);
    expect(buildVideoModelCatalog(providers).some((entry) => entry.id === requestFor('native-relay', 'video').model && entry.usable)).toBe(true);
    expect(buildChatModelCatalog(providers).find((entry) => entry.providerId === channelProviderId('native-relay', 'chat'))).toMatchObject({ usable: true, supportsTools: false, supportsStreaming: false });
    expect(storage.getItem('channels-v2-storage')).not.toContain('private-v2-key');
    expect(storage.getItem('custom-providers-storage')).not.toContain('private-v2-key');
    expect(await revealChannelCredential('native-relay')).toBe('private-v2-key');
    expect(resolveNativeChannelModel(requestFor('native-relay').model)?.model.id).toBe('shared/model:latest');
    await updateChannel('native-relay', { ...profile(), name: 'Renamed' });
    expect(useCustomProvidersStore.getState().providers.find((provider) => provider.id === channelProviderId('native-relay', 'image'))?.label).toBe('Renamed');
    // A second hydrate restores native profiles and all picker projections.
    useChannelStore.setState({ channels: [] });
    const saved = JSON.stringify({ state: { channels: [{ profile: profile(), origin: 'native', migrationIssues: [], createdAt: 1, updatedAt: 1 }], migratedLegacyIds: ['local-comfy'] }, version: 2 });
    storage.setItem('channels-v2-storage', saved); await useChannelStore.persist.rehydrate();
    expect(resolveNativeChannelModel(requestFor('native-relay').model)).not.toBeNull();
    deleteChannel('native-relay');
    expect(resolveNativeChannelModel(requestFor('native-relay').model)).toBeNull();
    expect(useCustomProvidersStore.getState().providers.find((provider) => provider.id === legacy.id)).toEqual({ ...legacy, credentialRef: undefined, credentialState: 'missing' });
  });
  it('round-trips a strict profile from one JSON block and rejects ambiguous/unknown fields', () => {
    expect(parseProfileImport(`Here is the profile:\n\`\`\`json\n${JSON.stringify(profile())}\n\`\`\``)).toMatchObject({ ok: true, profile: profile() });
    expect(parseProfileImport(JSON.stringify({ ...profile(), apiKey: 'do-not-store' }))).toMatchObject({ ok: false, errors: [{ path: 'apiKey' }] });
    expect(parseProfileImport('```json\n{}\n```\n```json\n{}\n```')).toMatchObject({ ok: false });
  });
  it('routes real image/video/chat requests through the exact template and native bridge', async () => {
    mocks.native = true; await createChannel(profile(), 'secret');
    mocks.http.mockResolvedValueOnce({ status: 200, text: JSON.stringify({ data: [{ url: 'https://cdn.example/result.png' }] }) });
    const imageId = await submitCustomProviderJob(requestFor('native-relay'));
    expect(imageId).toMatch(/^custom-local-channel-job-/);
    expect(await settled(imageId)).toMatchObject({ status: 'succeeded', result: '/local/output.png' });
    expect(mocks.http.mock.calls[0][0]).toMatchObject({ url: 'https://relay.example/images', method: 'POST', headers: { Authorization: `Bearer ${getChannelCredential('native-relay')}` }, body: { model: 'shared/model:latest', prompt: 'a tree', quality: 'high' } });
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
    await createChannel(config, 'live-private-key');
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
    await createChannel(config, 'agent-private-key');
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
    await createChannel(profile('ambiguous'), 'private');
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
    await createChannel(config, 'private-recovery-key');
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
  it.each([false, true])('hydrates every retained browser result before recovery-first returns (mixed=%s)', async (mixed) => {
    // IndexedDB completion drives this fixture; no timing guesses or generation.
    vi.useRealTimers(); vi.stubGlobal('indexedDB', new IDBFactory());
    const id = `custom-local-channel-job-browser-recovery-first-${mixed}`;
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
    if (mixed) transaction.objectStore('assets').put(new Blob(['video bytes'], { type: 'video/mp4' }), `${id}:1`);
    transaction.oncomplete = () => committed.resolve(); transaction.onerror = () => committed.reject(transaction.error);
    await committed.promise; db.close();
    storage.setItem('channel-generation-jobs-v2', JSON.stringify({ [id]: { job_id: id, status: 'succeeded', media_type: 'image',
      result: 'blob:expired-previous-process', resumable: false,
      poll_descriptor: { version: 2, adapter: 'template', profile: config, input, submit: {},
        assets: mixed ? [assetKey, `${id}:1`] : [assetKey], ...(mixed ? { assetKinds: ['image', 'video'] } : {}) } } }));
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce('blob:fresh-retained-image').mockReturnValue('blob:fresh-retained-video');
    try {
      const recovered = await recoverCustomProviderJob(id);
      expect(recovered).toMatchObject({ status: 'succeeded', result: 'blob:fresh-retained-image' });
      expect(recovered.results).toEqual(mixed ? [{ kind: 'image', source: 'blob:fresh-retained-image' }, { kind: 'video', source: 'blob:fresh-retained-video' }]
        : [{ kind: 'image', source: 'blob:fresh-retained-image' }]);
      expect(await getChannelJobAsync(id)).toMatchObject({ status: 'succeeded', result: 'blob:fresh-retained-image' });
      expect(createUrl).toHaveBeenCalledTimes(mixed ? 2 : 1);
      const restored = createUrl.mock.calls[0][0];
      expect(restored).toBeInstanceOf(Blob);
      if (restored instanceof Blob) {
        expect(restored.type).toBe('image/webp'); expect(await restored.text()).toBe('retained image bytes');
      }
      expect(mocks.http).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.get).not.toHaveBeenCalled();
    } finally { createUrl.mockRestore(); }
  });
  it.each([false, true])('resumes interrupted synchronous output download with auth=%s and no task ID or submit', async (auth) => {
    mocks.native = true; const config = profile(`materializing-${auth}`); await createChannel(config, 'download-private-key');
    const id = `custom-local-channel-job-materializing-${auth}`;
    const input: JobInput = { jobId: id, channelId: config.id, modelId: config.models[0].id, operation: 'image.generate', prompt: '', params: {}, refs: [], count: 1 };
    mocks.get.mockResolvedValue({ job_id: id, status: 'materializing', provider_id: config.id, resumable: true,
      poll_descriptor: { version: 2, adapter: 'template', profile: config, input, submit: {},
        outputs: [{ kind: 'image', url: 'https://relay.example/retained-output.png', auth }] } });
    await getChannelJobAsync(id);
    expect(await settled(id)).toMatchObject({ status: 'succeeded', result: '/local/output.png' });
    expect(mocks.image).toHaveBeenCalledWith('https://relay.example/retained-output.png', auth ? { Authorization: `Bearer ${getChannelCredential(config.id)}` } : {}, 512, expect.any(Object));
    expect(mocks.http).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
  });
  it('retrieves saved synchronous output URLs after browser bytes disappear without a generation submit', async () => {
    vi.useRealTimers(); vi.stubGlobal('indexedDB', new IDBFactory());
    const config = profile('missing-browser-result'); config.auth = { type: 'none' };
    const id = 'custom-local-channel-job-missing-browser-result';
    const input: JobInput = { jobId: id, channelId: config.id, modelId: config.models[0].id, operation: 'image.generate', prompt: '', params: {}, refs: [], count: 1 };
    storage.setItem('channel-generation-jobs-v2', JSON.stringify({ [id]: { job_id: id, status: 'succeeded', media_type: 'image',
      poll_descriptor: { version: 2, adapter: 'template', profile: config, input, submit: {}, assets: [`${id}:0`],
        outputs: [{ kind: 'image', url: 'https://cdn.example/original.png', auth: false }] } } }));
    await expect(getChannelJobAsync(id)).rejects.toThrow(/本地结果素材不存在/);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Blob(['old result bytes'], { type: 'image/png' })));
    vi.stubGlobal('fetch', fetcher);
    await recoverCustomProviderJob(id);
    await vi.waitFor(async () => expect(await getChannelJobAsync(id)).toMatchObject({ status: 'succeeded' }));
    const result = await getChannelJobAsync(id);
    expect(result.results).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledOnce(); expect(fetcher.mock.calls[0][0]).toBe('https://cdn.example/original.png');
    expect(fetcher.mock.calls[0][1]?.method).not.toBe('POST');
    expect(mocks.create).not.toHaveBeenCalled();
    URL.revokeObjectURL(result.result!);
  });

  it('recovers a native successful result only after native storage reports missing bytes', async () => {
    mocks.native = true; const config = profile('native-missing-result'); config.auth = { type: 'none' };
    const id = 'custom-local-channel-job-native-missing-result';
    const input: JobInput = { jobId: id, channelId: config.id, modelId: config.models[0].id, operation: 'image.generate', prompt: '', params: {}, refs: [], count: 1 };
    mocks.get.mockResolvedValue({ job_id: id, status: 'succeeded', local_result_missing: true, result: '/missing/result.png',
      poll_descriptor: { version: 2, adapter: 'template', profile: config, input, submit: {}, assets: ['/missing/result.png'],
        outputs: [{ kind: 'image', url: 'https://cdn.example/original-native.png', auth: false }] } });
    await expect(getChannelJobAsync(id)).rejects.toThrow(/本地结果素材不存在/);
    await recoverCustomProviderJob(id); await vi.advanceTimersByTimeAsync(1);
    expect(await settled(id)).toMatchObject({ status: 'succeeded', local_result_missing: false, result: '/local/output.png' });
    expect(mocks.image).toHaveBeenCalledOnce();
    expect(mocks.http).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
  });

  it('keeps an accepted completed task recoverable while its result payload is not ready', async () => {
    mocks.native = true; const config = profile('eventual-result'); config.auth = { type: 'none' };
    config.operations['image.generate']!.response = { mode: 'async', taskIdPath: 'id', poll: { method: 'GET', path: '/tasks/{{taskId}}', intervalSec: 1, timeoutMin: 1,
      statusPath: 'status', success: ['done'], failure: ['failed'], outputs: [{ path: 'data[*].url', as: 'url' }] } };
    mocks.http.mockResolvedValueOnce({ status: 200, text: '{"id":"accepted-original"}' }).mockResolvedValueOnce({ status: 200, text: '{"status":"done","data":[]}' });
    const id = await submitChannelJob(config, { jobId: '', channelId: config.id, modelId: config.models[0].id, operation: 'image.generate', prompt: 'test', params: {}, refs: [], count: 1 });
    expect(await settled(id)).toMatchObject({ status: 'recoverable_wait', resumable: true });
    mocks.http.mockResolvedValueOnce({ status: 200, text: '{"status":"done","data":[{"url":"https://cdn.example/eventual.png"}]}' });
    await recoverCustomProviderJob(id); await vi.advanceTimersByTimeAsync(1);
    expect(await settled(id)).toMatchObject({ status: 'succeeded' });
    expect(mocks.http.mock.calls.map(([call]) => call.method)).toEqual(['POST', 'GET', 'GET']);
  });

  it('does not let an unknown history row block a valid old result or overwrite the unknown row', async () => {
    const id = 'custom-local-channel-job-legacy-single';
    const future = { job_id: 'future-job', status: 'new-state', version: 99, untouched: ['keep', 'all'] };
    storage.setItem('channel-generation-jobs-v2', JSON.stringify({ 'future-job': future, [id]: { job_id: id, status: 'succeeded', result: '/old/saved.png', media_type: 'image' } }));
    expect(await getChannelJobAsync(id)).toMatchObject({ status: 'succeeded', results: [{ kind: 'image', source: '/old/saved.png' }] });
    const config = profile('preserve-unknown-history'); config.auth = { type: 'none' };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"error":"request rejected"}', { status: 400 })); vi.stubGlobal('fetch', fetcher);
    const created = await submitChannelJob(config, { jobId: '', channelId: config.id, modelId: config.models[0].id, operation: 'image.generate', prompt: 'test', params: {}, refs: [], count: 1 });
    await settled(created);
    expect(JSON.parse(storage.getItem('channel-generation-jobs-v2')!)['future-job']).toEqual(future);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([401, 403, 404])('keeps accepted tasks recoverable after polling HTTP %s and queries after credentials are corrected', async (status) => {
    mocks.native = true; const config = profile(`poll-access-${status}`);
    config.operations['image.generate']!.response = { mode: 'async', taskIdPath: 'id', poll: { method: 'GET', path: '/tasks/{{taskId}}', intervalSec: 1, timeoutMin: 1,
      statusPath: 'status', success: ['completed'], failure: ['failed'], outputs: [{ path: 'data[*].url', as: 'url' }] } };
    await createChannel(config, 'old-private-key'); const id = `custom-local-channel-job-poll-access-${status}`;
    const input: JobInput = { jobId: id, channelId: config.id, modelId: config.models[0].id, operation: 'image.generate', prompt: '', params: {}, refs: [], count: 1 };
    mocks.get.mockResolvedValue({ job_id: id, status: 'running', provider_id: config.id, external_task_id: 'accepted-task', resumable: true,
      poll_descriptor: { version: 2, adapter: 'template', profile: config, input, submit: {} } });
    mocks.http.mockResolvedValueOnce({ status, text: 'query access unavailable' });
    await getChannelJobAsync(id);
    expect(await settled(id)).toMatchObject({ status: 'recoverable_wait', external_task_id: 'accepted-task', resumable: true });
    await vi.advanceTimersByTimeAsync(1);
    await updateChannel(config.id, config, 'corrected-private-key');
    mocks.http.mockResolvedValueOnce({ status: 200, text: JSON.stringify({ status: 'completed', data: [{ url: 'https://cdn.example/recovered.png' }] }) });
    await recoverCustomProviderJob(id); await vi.advanceTimersByTimeAsync(1);
    expect(await settled(id)).toMatchObject({ status: 'succeeded' });
    expect(mocks.http).toHaveBeenCalledTimes(2);
    expect(mocks.http.mock.calls[1][0]).toMatchObject({ method: 'GET', headers: { Authorization: `Bearer ${getChannelCredential(config.id)}` } });
    expect(mocks.http.mock.calls.some(([request]) => request.method === 'POST')).toBe(false);
  });
  it('pauses an accepted job on vault denial and recovers its original result without another generation', async () => {
    mocks.native = true; const config = profile('vault-poll-recovery');
    config.operations['image.generate']!.response = { mode: 'async', taskIdPath: 'data.id', poll: { method: 'POST', path: '/draw/result', template: { id: '{{taskId}}' }, intervalSec: 2, timeoutMin: 2,
      statusPath: 'data.status', success: ['succeeded'], failure: ['failed'], outputs: [{ path: 'data.results[*].url', as: 'url' }] } };
    await createChannel(config, 'private-key');
    mocks.http.mockResolvedValueOnce({ status: 200, text: '{"data":{"id":"original-paid-task"}}' })
      .mockRejectedValueOnce('{"state":"locked","code":"storage_locked"}');
    const id = await submitCustomProviderJob(requestFor(config.id));
    expect(await settled(id)).toMatchObject({ status: 'recoverable_wait', error_category: 'credential', external_task_id: 'original-paid-task', resumable: true });
    await vi.advanceTimersByTimeAsync(120000);
    await getChannelJobAsync(id); expect(mocks.http).toHaveBeenCalledTimes(2);
    mocks.http.mockResolvedValueOnce({ status: 200, text: '{"data":{"status":"succeeded","results":[{"url":"https://cdn.example/result.png"}]}}' });
    await recoverCustomProviderJob(id);
    expect(await settled(id)).toMatchObject({ status: 'succeeded', result: '/local/output.png' });
    expect(mocks.http.mock.calls.map(([request]) => new URL(request.url).pathname)).toEqual(['/images', '/draw/result', '/draw/result']);
    expect(mocks.http.mock.calls[2][0].body).toEqual({ id: 'original-paid-task' });
  });
  it('never submits or queries automatically after a pre-send vault denial, including explicit authorization', async () => {
    mocks.native = true; const config = profile('vault-submit-denied');
    await createChannel(config, 'fixture-key');
    mocks.http.mockRejectedValueOnce('{"state":"locked","code":"storage_locked"}');
    const id = await submitCustomProviderJob(requestFor(config.id));
    expect(await waitForChannelJob(id)).toMatchObject({ status: 'failed', error_category: 'credential', resumable: false });
    expect((await getChannelJobAsync(id)).external_task_id).toBeUndefined();
    const authorize = vi.spyOn(secretVault, 'retrySecretAccess').mockResolvedValue(true);
    await authorizeChannelJob(id);
    await recoverCustomProviderJob(id);
    await vi.advanceTimersByTimeAsync(120000);
    expect(authorize).toHaveBeenCalledOnce();
    expect(mocks.http).toHaveBeenCalledOnce();
    expect(mocks.image).not.toHaveBeenCalled();
    expect(mocks.create).toHaveBeenCalledOnce();
  });
  it('retains sync output handles when download authorization fails and only downloads on recovery', async () => {
    mocks.native = true; const config = profile('vault-download-denied');
    config.operations['image.generate']!.response = { mode: 'sync', outputs: [{ url: '/files/original.png', kind: 'image', auth: true }] };
    await createChannel(config, 'fixture-key');
    mocks.http.mockResolvedValueOnce({ status: 200, text: '{}' });
    mocks.image.mockRejectedValueOnce('{"state":"locked","code":"storage_locked"}');
    const id = await submitCustomProviderJob(requestFor(config.id));
    expect(await waitForChannelJob(id)).toMatchObject({ status: 'recoverable_wait', phase: 'download', error_category: 'credential', resumable: true });
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ pollDescriptor: expect.objectContaining({
      outputs: [{ kind: 'image', url: 'https://relay.example/files/original.png', auth: true }],
    }) }));
    await vi.advanceTimersByTimeAsync(120000);
    await getChannelJobAsync(id);
    expect(mocks.image).toHaveBeenCalledOnce();
    const authorize = vi.spyOn(secretVault, 'retrySecretAccess').mockResolvedValue(true);
    await authorizeChannelJob(id);
    expect(mocks.image).toHaveBeenCalledOnce();
    await recoverCustomProviderJob(id);
    const recovered = await waitForChannelJob(id);
    expect(recovered).toMatchObject({ status: 'succeeded', result: '/local/output.png', resumable: false });
    expect(recovered.error).toBeNull(); expect(recovered.error_category).toBeUndefined();
    expect(mocks.http).toHaveBeenCalledOnce(); expect(mocks.image).toHaveBeenCalledTimes(2);
    expect(authorize).toHaveBeenCalledOnce(); expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.image.mock.calls[1].slice(0, 2)).toEqual(['https://relay.example/files/original.png', { Authorization: `Bearer ${getChannelCredential(config.id)}` }]);
  });
  it.each(['poll', 'download'] as const)('hydrates a paused %s denial without requests and resumes only the saved original work', async (phase) => {
    mocks.native = true; const config = profile(`vault-reload-${phase}`);
    config.operations['image.generate']!.response = { mode: 'async', taskIdPath: 'id', poll: { method: 'POST', path: '/draw/result', template: { id: '{{taskId}}' }, intervalSec: 2, timeoutMin: 2,
      statusPath: 'status', success: ['done'], failure: ['failed'], outputs: [{ path: 'data[*].url', as: 'url' }] } };
    await createChannel(config, 'fixture-key');
    const id = `custom-local-channel-job-vault-reload-${phase}`;
    const input: JobInput = { jobId: id, channelId: config.id, modelId: config.models[0].id, operation: 'image.generate', prompt: '', params: {}, refs: [], count: 1 };
    mocks.get.mockResolvedValue({ job_id: id, provider_id: config.id, status: 'recoverable_wait', phase, external_task_id: 'original-before-restart',
      error_category: 'credential', resumable: true, error: '系统凭据尚未授权', poll_descriptor: { version: 2, adapter: 'template', profile: config, input, submit: {},
        ...(phase === 'download' ? { outputs: [{ kind: 'image', url: 'https://relay.example/original.png', auth: true }] } : {}),
        failure: { category: 'credential', message: '系统凭据尚未授权' } } });
    expect(await getChannelJobAsync(id)).toMatchObject({ status: 'recoverable_wait', error_category: 'credential', external_task_id: 'original-before-restart' });
    await vi.advanceTimersByTimeAsync(120000);
    expect(mocks.http).not.toHaveBeenCalled(); expect(mocks.image).not.toHaveBeenCalled();
    const authorize = vi.spyOn(secretVault, 'retrySecretAccess').mockRejectedValueOnce(new secretVault.SecretStoreError('locked', 'vault-locked')).mockResolvedValue(true);
    await expect(authorizeChannelJob(id)).rejects.toMatchObject({ state: 'locked' });
    expect(mocks.http).not.toHaveBeenCalled(); expect(mocks.image).not.toHaveBeenCalled();
    await authorizeChannelJob(id);
    expect(mocks.http).not.toHaveBeenCalled(); expect(mocks.image).not.toHaveBeenCalled();
    if (phase === 'poll') mocks.http.mockResolvedValueOnce({ status: 200, text: '{"status":"done","data":[{"url":"https://cdn.example/recovered.png"}]}' });
    await recoverCustomProviderJob(id);
    const recovered = await waitForChannelJob(id);
    expect(recovered).toMatchObject({ status: 'succeeded', external_task_id: 'original-before-restart', result: '/local/output.png' });
    expect(recovered.error_category).toBeUndefined();
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.image).toHaveBeenCalledOnce();
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(mocks.http).toHaveBeenCalledTimes(phase === 'poll' ? 1 : 0);
    if (phase === 'poll') expect(mocks.http).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://relay.example/draw/result', method: 'POST', body: { id: 'original-before-restart' } }));
  });
  it('keeps download authorization failures paused in memory even when the failure record cannot be saved', async () => {
    mocks.native = true; const config = profile('vault-download-storage-failure');
    await createChannel(config, 'fixture-key');
    mocks.http.mockResolvedValueOnce({ status: 200, text: '{"data":[{"url":"https://cdn.example/original.png"}]}' });
    mocks.image.mockRejectedValueOnce('{"state":"locked","code":"storage_locked"}');
    mocks.update.mockImplementation(async (patch) => { if (patch.errorCategory === 'credential') throw new Error('disk unavailable'); });
    const id = await submitCustomProviderJob(requestFor(config.id));
    await expect(waitForChannelJob(id)).resolves.toMatchObject({ status: 'recoverable_wait', error_category: 'credential', resumable: true, error: expect.stringContaining('任务状态保存失败') });
    await vi.advanceTimersByTimeAsync(120000);
    await getChannelJobAsync(id);
    expect(mocks.http).toHaveBeenCalledOnce(); expect(mocks.image).toHaveBeenCalledOnce();
  });
  it('retains the last upstream polling status and original text when the query deadline expires', async () => {
    mocks.native = true; const config = profile('poll-upstream-timeout');
    config.operations['image.generate']!.response = { mode: 'async', taskIdPath: 'id', poll: { method: 'GET', path: '/tasks/{{taskId}}', intervalSec: 0.001, timeoutMin: 0.0001,
      statusPath: 'status', success: ['completed'], failure: ['failed'], outputs: [{ path: 'data[*].url', as: 'url' }] } };
    await createChannel(config, 'poll-private-key'); const id = 'custom-local-channel-job-poll-upstream-timeout';
    const input: JobInput = { jobId: id, channelId: config.id, modelId: config.models[0].id, operation: 'image.generate', prompt: '', params: {}, refs: [], count: 1 };
    mocks.get.mockResolvedValue({ job_id: id, status: 'running', provider_id: config.id, external_task_id: 'accepted-task', resumable: true,
      poll_descriptor: { version: 2, adapter: 'template', profile: config, input, submit: {} } });
    mocks.http.mockResolvedValue({ status: 503, text: `provider maintenance ${getChannelCredential(config.id)}` });
    await getChannelJobAsync(id);
    const failed = await settled(id);
    expect(failed).toMatchObject({ status: 'unknown', error_status: 503, error_raw: 'provider maintenance [redacted]' });
    expect(failed.error).toContain('HTTP 503'); expect(failed.error).toContain('provider maintenance [redacted]');
    expect(mocks.http.mock.calls.every(([request]) => request.method === 'GET')).toBe(true);
  });
  it('keeps explicit upstream task failure terminal rather than treating it as a query access error', async () => {
    mocks.native = true; const config = profile('upstream-terminal');
    config.operations['image.generate']!.response = { mode: 'async', taskIdPath: 'id', poll: { method: 'GET', path: '/tasks/{{taskId}}', intervalSec: 1, timeoutMin: 1,
      statusPath: 'status', success: ['completed'], failure: ['failed'], outputs: [{ path: 'data[*].url', as: 'url' }] } };
    await createChannel(config, 'private-key'); const id = 'custom-local-channel-job-upstream-terminal';
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
    const config = profile('disk-failure'); await createChannel(config, 'private');
    const input: JobInput = { jobId: '', channelId: config.id, modelId: config.models[0].id, operation: 'image.generate', prompt: 'test', params: {}, refs: [], count: 1 };
    await expect(submitChannelJob(config, input)).rejects.toThrow('disk full'); expect(mocks.http).not.toHaveBeenCalled();
  });
  it('maps canvas size hints onto declared options only; explicit params stay strict', () => {
    const config = profile('size-hints');
    config.models[0].params.push(
      { key: 'size', label: 'Size', type: 'enum', default: '1024x1024', options: ['1024x1024', '1536x1024'].map((value) => ({ label: value, value })) },
      { key: 'imageSize', label: 'Image size', type: 'enum', options: ['1K', '2K'].map((value) => ({ label: value, value })) },
    );
    const job = (size: string, extra: Record<string, unknown> = {}) => channelJobFromRequest(config, config.models[0].id,
      { model: 'm', prompt: 'p', size, aspect_ratio: 'auto', extra_params: extra }, 'image');
    // The canvas default '2k' is no pixel size: `size` keeps its channel default, `imageSize` gets '2K'.
    expect(job('2k').params).toEqual({ imageSize: '2K' });
    expect(job('1536x1024').params).toEqual({ size: '1536x1024' });
    // A value the user set explicitly is never coerced; an undeclared one fails before sending.
    expect(job('2K', { imageSize: '2k' }).params).toEqual({ imageSize: '2k' });
    expect(() => renderPreview(config, job('2K', { imageSize: '2k' }))).toThrow('不符合声明');
  });
  it('maps explicit mode params and slotted refs without accepting display labels or undeclared fields', () => {
    const config = profile('request-mode');
    config.models[0].modes = [{ id: 'frames', label: '首帧', operation: 'video.generate', params: [
      { key: 'quality', label: '质量', type: 'enum', required: true, options: [{ label: '标准', value: 'standard' }] },
      { key: 'seconds', label: '秒数', type: 'number', min: 2, max: 8, required: true },
    ], slots: [{ key: 'first_frame', label: '首帧', kind: 'image', min: 1, max: 1 }] }];
    const refs = [{ kind: 'image' as const, slot: 'first_frame', path: '/frame.png', mime: 'image/png', assetId: 'frame' }];
    const request = { model: 'm', prompt: 'p', size: 'auto', aspect_ratio: 'auto', reference_images: ['must-not-use'], extra_params: { quality: 'standard', seconds: 5, invented: 'never sent' } };
    const input = channelJobFromRequest(config, config.models[0].id, request, 'video', { modeId: 'frames', refs });
    expect(input).toMatchObject({ operation: 'video.generate', modeId: 'frames', refs, params: { quality: 'standard', seconds: 5 } });
    expect(input.params).not.toHaveProperty('invented');
    for (const extra_params of [{ quality: '标准', seconds: 5 }, { quality: 'standard', seconds: 9 }, { quality: 'standard' }, { quality: 'standard', seconds: false }]) {
      expect(() => channelJobFromRequest(config, config.models[0].id, { ...request, extra_params }, 'video', { modeId: 'frames', refs })).toThrow('参数');
    }
  });
  it('routes selected/default slots through the same preview and native media resolver', async () => {
    mocks.native = true;
    await createChannel(slottedProfile(), 'slot-key');
    const request: GenerateRequest = { ...requestFor('slotted', 'video'), channel_mode_id: 'frames',
      reference_slots: { last_frame: ['/last.png'], first_frame: ['https://media.example/first.png'] },
      reference_images: ['ignored-legacy.png'] };
    const preview = buildCustomProviderRequestDebugPreview(request);
    expect(preview.body).toEqual({ model: 'shared/model:latest', first: '<image 1: png>', last: ['<image 2: png>'] });
    expect(buildCustomProviderRequestDebugPreview({ ...request, channel_mode_id: undefined })).toEqual(preview);
    const payload = { prompt: request.prompt, model: request.model, size: request.size, aspectRatio: request.aspect_ratio,
      channelModeId: request.channel_mode_id, referenceSlots: request.reference_slots, extraParams: request.extra_params };
    expect((await buildGenerateVideoDebugPreview(payload)).providerRequest).toEqual(preview);
    expect(mocks.image).not.toHaveBeenCalled();
    expect(mocks.load).not.toHaveBeenCalled();
    mocks.load.mockImplementation(async (path: string) => `data:image/png;base64,${path === '/last.png' ? 'LAST' : 'FIRST'}`);
    mocks.http.mockResolvedValueOnce({ status: 200, text: JSON.stringify({ data: [{ url: 'https://cdn.example/result.mp4' }] }) });
    expect(await settled(await tauriAiGateway.submitGenerateVideoJob(payload))).toMatchObject({ status: 'succeeded' });
    expect(mocks.create.mock.calls[0][0].pollDescriptor.input.modeId).toBe('frames');
    expect(mocks.image).toHaveBeenCalledWith('https://media.example/first.png', {});
    expect(mocks.load).toHaveBeenCalledTimes(2);
    expect(mocks.load).toHaveBeenCalledWith('/last.png');
    expect(mocks.load).toHaveBeenCalledWith('/local/output.png');
    expect(mocks.http.mock.calls[0][0].body).toEqual({ model: 'shared/model:latest', first: 'data:image/png;base64,FIRST', last: ['data:image/png;base64,LAST'] });
    expect(mocks.http).toHaveBeenCalledOnce();
  });
  it.each([
    [{}, '首帧'],
    [{ first_frame: ['/a.png', '/b.png'] }, '首帧'],
    [{ first_frame: ['/a.png'], last_frame: ['/b.png', '/c.png'] }, '尾帧'],
    [{ first_frame: ['/a.png'], invented: [] }, '未声明'],
    [{ first_frame: ['data:video/mp4;base64,AAAA'] }, '只接受'],
    [{ first_frame: ['https://media.example/clip.mp4?token=private'] }, '只接受'],
    [{ first_frame: ['asset-media:audio%2Fwav:hash'] }, '只接受'],
  ] satisfies Array<[Record<string, string[]>, string]>)('rejects invalid slots before saving or sending: %j', async (reference_slots, message) => {
    mocks.native = true; await createChannel(slottedProfile(), 'slot-key');
    const request = { ...requestFor('slotted', 'video'), channel_mode_id: 'frames', reference_slots };
    expect(() => buildCustomProviderRequestDebugPreview(request)).toThrow(message);
    await expect(submitCustomVideoJob(request)).rejects.toThrow(message);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.http).not.toHaveBeenCalled();
    expect(mocks.image).not.toHaveBeenCalled();
  });
  it('discards parameters unique to the previously selected mode', async () => {
    await createChannel(slottedProfile(), 'slot-key');
    const request = { ...requestFor('slotted', 'video'), extra_params: { frame_strength: 'invalid old value' }, channel_mode_id: 'text', reference_slots: {} };
    expect(buildCustomProviderRequestDebugPreview(request).body).toEqual({ model: 'shared/model:latest', prompt: 'a tree' });
  });
  it('preserves legacy generic references and parameters without a slot map', async () => {
    const config = profile('generic-refs');
    config.models[0].refs = { image: 2 };
    config.operations['image.generate']!.template = { prompt: '{{prompt}}', images: '{{images}}' };
    await createChannel(config, 'legacy-key');
    const request = { ...requestFor(config.id), reference_images: ['/a.png', '/b.png'] };
    expect(buildCustomProviderRequestDebugPreview(request).body).toEqual({ prompt: 'a tree', images: ['<image 1: png>', '<image 2: png>'] });
    const input = channelJobFromRequest(config, config.models[0].id, request, 'image');
    expect(input.refs.map((ref) => ref.path)).toEqual(request.reference_images);
    expect(input.refs.every((ref) => ref.slot === undefined)).toBe(true);
  });
  it('persists the selected mode and uses its endpoint response parser and dynamic submit snapshot', async () => {
    mocks.native = true; const config = profile('mode-submit');
    config.models[0].modes = [{ id: 'text', label: '文生视频', operation: 'video.generate', endpoint: {
      method: 'POST', path: '/mode-submit', body: 'json', template: { prompt: '{{prompt}}', mode: '{{mode}}' },
      response: { mode: 'async', taskIdPath: 'task.id', poll: { method: 'GET', path: '{{submit.links.status}}', intervalSec: 1, timeoutMin: 1,
        statusPath: 'state', success: ['done'], failure: ['error'], outputs: [{ path: 'result.video', as: 'url', kind: 'video' }] } },
    } }];
    await createChannel(config, 'mode-private-key');
    mocks.http.mockResolvedValueOnce({ status: 200, text: JSON.stringify({ task: { id: 'mode-task' }, links: { status: 'https://relay.example/mode-poll/mode-task' } }) })
      .mockResolvedValueOnce({ status: 200, text: JSON.stringify({ state: 'done', result: { video: 'https://cdn.example/mode.mp4' } }) });
    const input = channelJobFromRequest(config, config.models[0].id, requestFor(config.id, 'video'), 'video', { modeId: 'text' });
    const id = await submitChannelJob(config, input);
    expect(await settled(id)).toMatchObject({ status: 'succeeded', result: '/local/output.mp4' });
    expect(mocks.create.mock.calls[0][0].pollDescriptor.input.modeId).toBe('text');
    expect(mocks.http.mock.calls.map(([request]) => [request.method, request.url])).toEqual([
      ['POST', 'https://relay.example/mode-submit'], ['GET', 'https://relay.example/mode-poll/mode-task'],
    ]);
    expect(mocks.update.mock.calls.some(([update]) => update.pollDescriptor?.submit?.links?.status === 'https://relay.example/mode-poll/mode-task')).toBe(true);
  });
  it('recovers the saved mode override with stripped required refs and never submits again', async () => {
    mocks.native = true; const config = profile('mode-recovered');
    config.models[0].modes = [{ id: 'frames', label: '首尾帧', operation: 'video.generate',
      slots: [{ key: 'first_frame', label: '首帧', kind: 'image', min: 1, max: 1 }], endpoint: {
        method: 'POST', path: '/frames-submit', body: 'json', template: { first: '{{slotFirst.first_frame}}' },
        response: { mode: 'async', taskIdPath: 'task', poll: { method: 'GET', path: '/frames/{{mode}}/{{taskId}}', intervalSec: 1, timeoutMin: 1,
          statusPath: 'state', success: ['done'], failure: ['failed'], outputs: [{ path: 'video', as: 'url', kind: 'video' }] } },
      } }];
    await createChannel(config, 'mode-recovery-key');
    const id = 'custom-local-channel-job-mode-recovery';
    const input: JobInput = { jobId: id, channelId: config.id, modelId: config.models[0].id, modeId: 'frames', operation: 'video.generate', prompt: '', params: {}, refs: [], count: 1 };
    mocks.get.mockResolvedValue({ job_id: id, status: 'running', provider_id: config.id, external_task_id: 'saved-task', resumable: true,
      poll_descriptor: { version: 2, adapter: 'template', profile: config, input, submit: {} } });
    mocks.http.mockResolvedValueOnce({ status: 200, text: JSON.stringify({ state: 'done', video: 'https://cdn.example/recovered-mode.mp4' }) });
    await getChannelJobAsync(id);
    expect(await settled(id)).toMatchObject({ status: 'succeeded', result: '/local/output.mp4' });
    expect(mocks.http).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ method: 'GET', url: 'https://relay.example/frames/frames/saved-task' }));
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('projects mode-only models with full typed choices and stable channel references instead of lossy labels', async () => {
    const config = profile('mode-catalog');
    config.models[0].operations = [];
    config.models[0].modes = [{ id: 'wide', label: '宽屏', operation: 'video.generate', params: [
      { key: 'aspectRatio', label: '比例', type: 'enum', options: [{ label: '宽屏', value: '16:9' }] },
      { key: 'size', label: '尺寸', type: 'enum', options: [{ label: '高清', value: { width: 1920, height: 1080 } }] },
    ], slots: [{ key: 'first_frame', label: '首帧', kind: 'image', max: 1 }], endpoint: {
      method: 'POST', path: '/mode-only', body: 'json', template: { model: '{{model}}' }, response: { mode: 'sync', outputs: [] },
    } }];
    await createChannel(config, 'mode-catalog-key');
    const catalog = buildVideoModelCatalog(useCustomProvidersStore.getState().providers);
    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toMatchObject({ channelModelRef: { profileId: config.id, modelId: config.models[0].id },
      supportedAspectRatios: ['16:9'], supportedResolutions: [], inputSchema: { images: { enabled: true, max: 1 } },
      modes: [{ mode: { id: 'wide' }, params: expect.arrayContaining([expect.objectContaining({ key: 'size', options: [{ label: '高清', value: { width: 1920, height: 1080 } }] })]) }],
    });
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
    mocks.native = true; await useCustomProvidersStore.getState().addProvider(comfyConfig());
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
    await useCustomProvidersStore.getState().addProvider({ ...config, baseUrl: 'http://changed.example', extraParams: { auth: { mode: 'none' } } });
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
