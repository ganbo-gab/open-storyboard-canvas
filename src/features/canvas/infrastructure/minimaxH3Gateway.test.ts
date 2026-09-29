import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerateRequest } from '@/commands/ai';

const mocks = vi.hoisted(() => ({ http: vi.fn(), create: vi.fn(), update: vi.fn(), get: vi.fn(), persist: vi.fn() }));
vi.mock('@/commands/ai', async (original) => ({
  ...await original<typeof import('@/commands/ai')>(),
  customHttpRequest: mocks.http, createGenerationJob: mocks.create, updateGenerationJob: mocks.update, getGenerationJobRecord: mocks.get,
}));
vi.mock('@/commands/image', async (original) => ({ ...await original<typeof import('@/commands/image')>(), persistVideoSource: mocks.persist }));

import { useCustomProvidersStore } from '@/stores/customProvidersStore';
import { DEFAULT_GENERATION_NETWORK_SETTINGS, useSettingsStore } from '@/stores/settingsStore';
import { MINIMAX_H3_PRESET } from '../application/minimaxH3';
import { getCustomProviderJob, recoverCustomProviderJob, submitCustomVideoJob } from './customProviderGateway';

const provider = () => ({ ...MINIMAX_H3_PRESET.template, id: 'h3-test', apiKey: 'minimax-secret' });
const request: GenerateRequest = { model: 'custom:h3-test:MiniMax-H3', prompt: 'follow cyclist', size: '768P', aspect_ratio: '16:9' };
const response = (payload: unknown, status = 200) => ({ status, text: JSON.stringify(payload) });
const completed = { task: { id: 'h3-job', status: 'succeeded', content: { url: 'https://cdn.example/h3.mp4' } } };
const restored = (id: string) => ({ job_id: id, status: 'recoverable_wait', media_type: 'video', provider_id: 'h3-test', model_id: 'MiniMax-H3', external_task_id: 'h3-job', network_route: 'system', resumable: true });
async function settled(id: string) {
  await vi.waitFor(() => expect(['queued', 'submitting', 'running', 'materializing']).not.toContain(getCustomProviderJob(id).status), { timeout: 3000 });
  return getCustomProviderJob(id);
}

beforeEach(() => {
  vi.stubGlobal('window', { setTimeout: globalThis.setTimeout });
  (globalThis as typeof globalThis & { isTauri?: boolean }).isTauri = true;
  mocks.create.mockResolvedValue(undefined);
  mocks.update.mockResolvedValue(undefined);
  mocks.persist.mockResolvedValue('/local/h3.mp4');
  useSettingsStore.getState().setGenerationNetworkSettings(DEFAULT_GENERATION_NETWORK_SETTINGS);
  useCustomProvidersStore.getState().replaceAll([provider()]);
});
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); delete (globalThis as typeof globalThis & { isTauri?: boolean }).isTauri; useCustomProvidersStore.getState().replaceAll([]); });

describe('MiniMax H3 gateway lifecycle', () => {
  it('POSTs exactly once, persists task id, GETs the V2 result and strips credentials on CDN download', async () => {
    mocks.http.mockResolvedValueOnce(response({ task_id: 'h3-job' })).mockResolvedValueOnce(response(completed));
    const job = await settled(await submitCustomVideoJob(request));
    expect(job).toMatchObject({ status: 'succeeded', result: '/local/h3.mp4', external_task_id: 'h3-job' });
    expect(mocks.http).toHaveBeenCalledTimes(2);
    expect(mocks.http.mock.calls[0][0]).toMatchObject({ method: 'POST', url: 'https://api.minimax.io/v2/video_generation', headers: { Authorization: 'Bearer minimax-secret' }, body: {
      model: 'MiniMax-H3', content: [{ type: 'text', text: request.prompt }], duration: 5, resolution: '768P', ratio: '16:9',
    } });
    expect(mocks.http.mock.calls[1][0]).toMatchObject({ method: 'GET', url: 'https://api.minimax.io/v2/query/video_generation/h3-job' });
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ externalTaskId: 'h3-job', pollDescriptor: { method: 'GET', pathTemplate: '/v2/query/video_generation/{taskId}' } }));
    expect(mocks.persist).toHaveBeenCalledWith('https://cdn.example/h3.mp4', undefined, expect.objectContaining({ configuredProviderOrigin: 'https://api.minimax.io' }));
    expect(JSON.stringify(mocks.create.mock.calls) + JSON.stringify(mocks.update.mock.calls)).not.toContain('minimax-secret');
  });
  it('waits through queued and running without mistaking echoed input URLs for output', async () => {
    const config = provider();
    config.extraParams = { ...config.extraParams, videoPollIntervalMs: 500 };
    useCustomProvidersStore.getState().replaceAll([config]);
    mocks.http.mockResolvedValueOnce(response({ task_id: 'h3-job' }))
      .mockResolvedValueOnce(response({ task: { status: 'queued', content: { url: 'https://cdn.example/input.mp4' } } }))
      .mockResolvedValueOnce(response({ task: { status: 'running' } }))
      .mockResolvedValueOnce(response(completed));
    expect(await settled(await submitCustomVideoJob(request))).toMatchObject({ status: 'succeeded' });
    expect(mocks.http.mock.calls.map(([call]) => call.method)).toEqual(['POST', 'GET', 'GET', 'GET']);
    expect(mocks.persist).toHaveBeenCalledTimes(1);
    expect(mocks.persist.mock.calls[0][0]).toBe('https://cdn.example/h3.mp4');
  });
  it('recovers a durable task using GET only', async () => {
    mocks.get.mockResolvedValue(restored('h3-restored'));
    mocks.http.mockResolvedValue(response(completed));
    expect(await recoverCustomProviderJob('h3-restored')).toMatchObject({ status: 'succeeded', result: '/local/h3.mp4' });
    expect(mocks.http).toHaveBeenCalledTimes(1);
    expect(mocks.http.mock.calls[0][0].method).toBe('GET');
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each(['failed', 'cancelled'])('treats %s as terminal even when payload includes a media URL', async (status) => {
    mocks.http.mockResolvedValueOnce(response({ task_id: 'h3-job' })).mockResolvedValueOnce(response({ task: { status, error: 'provider failure', content: { url: 'https://cdn.example/not-a-result.mp4' } } }));
    expect(await settled(await submitCustomVideoJob(request))).toMatchObject({ status: 'failed', error_category: 'provider', resumable: false });
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.http).toHaveBeenCalledTimes(2);
  });
  it('does not mark a terminal failure recoverable after restart', async () => {
    mocks.get.mockResolvedValue(restored('h3-restored-failed'));
    mocks.http.mockResolvedValue(response({ task: { status: 'failed', error: 'rejected' } }));
    expect(await recoverCustomProviderJob('h3-restored-failed')).toMatchObject({ status: 'failed', resumable: false });
    expect(mocks.http).toHaveBeenCalledTimes(1);
  });
  it('keeps a handle after a failed query and resumes it without submitting again', async () => {
    mocks.http.mockResolvedValueOnce(response({ task_id: 'h3-job' })).mockResolvedValueOnce(response({ error: { message: 'temporarily unavailable' } }, 403));
    const job = await settled(await submitCustomVideoJob(request));
    expect(job).toMatchObject({ status: 'recoverable_wait', external_task_id: 'h3-job' });
    mocks.get.mockResolvedValue({ ...restored(job.job_id), ...job });
    mocks.http.mockResolvedValueOnce(response(completed));
    expect(await recoverCustomProviderJob(job.job_id)).toMatchObject({ status: 'succeeded' });
    expect(mocks.http.mock.calls.map(([call]) => call.method)).toEqual(['POST', 'GET', 'GET']);
  });
  it('does not repeat an ambiguous paid POST', async () => {
    mocks.http.mockRejectedValue(new Error('network timeout'));
    expect(await settled(await submitCustomVideoJob(request))).toMatchObject({ status: 'unknown' });
    expect(mocks.http).toHaveBeenCalledTimes(1);
  });
  it('rejects missing credentials and invalid parameters before any HTTP', async () => {
    useCustomProvidersStore.getState().replaceAll([{ ...provider(), apiKey: '' }]);
    expect(await settled(await submitCustomVideoJob(request))).toMatchObject({ status: 'failed' });
    useCustomProvidersStore.getState().replaceAll([provider()]);
    expect(await settled(await submitCustomVideoJob({ ...request, extra_params: { duration: 16 } }))).toMatchObject({ status: 'failed' });
    expect(mocks.http).not.toHaveBeenCalled();
  });
  it('keeps the generated result URL if download fails, then downloads without any POST or GET query', async () => {
    mocks.http.mockResolvedValueOnce(response({ task_id: 'h3-job' })).mockResolvedValueOnce(response(completed));
    mocks.persist.mockRejectedValueOnce(new Error('download failed'));
    const job = await settled(await submitCustomVideoJob(request));
    expect(job).toMatchObject({ status: 'recoverable_wait', result_url: 'https://cdn.example/h3.mp4' });
    mocks.get.mockResolvedValue({ ...restored(job.job_id), ...job });
    expect(await recoverCustomProviderJob(job.job_id)).toMatchObject({ status: 'succeeded' });
    expect(mocks.http).toHaveBeenCalledTimes(2);
    expect(mocks.persist).toHaveBeenCalledTimes(2);
  });
});
