import { describe, expect, it, vi } from 'vitest';
import type { CustomProviderConfig } from '@/stores/customProvidersStore';
import type * as TauriCore from '@tauri-apps/api/core';
import type * as AiCommands from '@/commands/ai';
import { customImageProviderConfigToDraft, customImageProviderDraftToConfig } from '../application/customImageProviderConfig';
import { resolveComfyUIUrls } from '@/features/channels/adapters/comfyui/url';
import { submitComfyChannelJob, recoverComfyChannelJob } from '@/features/channels/runtime/comfyExecution';
import { createComfyProviderTransport } from './comfyProviderTransport';
import { checkComfyUIConnection } from './comfyuiGateway';
import { buildCustomProviderRequestDebugPreviewForConfig } from './providerGateway';

const mocks = vi.hoisted(() => ({ http: vi.fn(), create: vi.fn().mockResolvedValue(undefined), update: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@tauri-apps/api/core', async (original) => ({ ...await original<typeof TauriCore>(), isTauri: () => true }));
vi.mock('@/commands/ai', async (original) => ({ ...await original<typeof AiCommands>(), customHttpRequest: mocks.http,
  createGenerationJob: mocks.create, updateGenerationJob: mocks.update }));

function config(mode = 'none'): CustomProviderConfig {
  return { id: 'comfy-connectivity', label: 'Comfy', baseUrl: 'workstation:8188/comfy/prompt', apiStyle: 'comfyui', apiKey: '',
    models: ['workflow'], supportsWebSearch: false, extraParams: { auth: { mode, name: 'access_key', prefix: '' }, comfyui: {
      workflow: { '6': { class_type: 'CLIPTextEncode', inputs: { text: '' } }, '9': { class_type: 'SaveImage', inputs: { images: ['6', 0] } } },
      bindings: { prompt: { nodeId: '6', input: 'text' } }, outputNodeIds: ['9'],
    } } };
}

describe('ComfyUI connection boundary consistency', () => {
  it.each(['workstation:8188', 'workstation:8188/comfy/prompt', 'https://tunnel.example/comfy/history/old'])('previews and saves the same resolved address for %s', (baseUrl) => {
    const provider = { ...config(), baseUrl };
    const saved = customImageProviderDraftToConfig(customImageProviderConfigToDraft(provider), provider.id);
    expect(saved.issues).toEqual([]);
    expect(saved.value?.baseUrl).toBe(resolveComfyUIUrls(baseUrl).base);
  });

  it.each(['none', 'bearer', 'header', 'query'])('uses identical empty-key %s authentication and address for checks and generation', async (mode) => {
    mocks.http.mockReset().mockImplementation(async (request: { method: string }) => request.method === 'GET'
      ? { status: 200, text: '{}' } : { status: 400, text: '{"error":"fixture stops after submit"}' });
    const provider = config(mode);
    await checkComfyUIConnection(createComfyProviderTransport(provider));
    const id = await submitComfyChannelJob(provider, 'workflow', { model: 'workflow', prompt: 'test', size: 'auto', aspect_ratio: 'auto' });
    await recoverComfyChannelJob(id);
    const check = mocks.http.mock.calls[0][0] as { url: string; headers: Record<string, string> };
    const submit = mocks.http.mock.calls[1][0] as { url: string; headers: Record<string, string> };
    expect(check.url).toBe(`http://workstation:8188/comfy/system_stats${mode === 'query' ? '?access_key=' : ''}`);
    expect(submit.url).toBe(`http://workstation:8188/comfy/prompt${mode === 'query' ? '?access_key=' : ''}`);
    const expected = mode === 'header' ? { access_key: '' } : {};
    const { 'Content-Type': _contentType, ...submitHeaders } = submit.headers;
    expect(check.headers).toEqual(expected);
    expect(submitHeaders).toEqual(expected);
  });

  it.each(['workstation:8188/comfy', 'http://workstation:8188/comfy/prompt/', ' workstation：8188/comfy/api/prompt/?old=1#fragment '])(
    'checks and submits the same saved normalized address for %s', async (baseUrl) => {
      mocks.http.mockReset().mockImplementation(async (request: { method: string }) => request.method === 'GET'
        ? { status: 200, text: '{}' } : { status: 400, text: '{"error":"fixture stops after submit"}' });
      const draft = customImageProviderConfigToDraft({ ...config('bearer'), baseUrl, extraParams: {
        ...config().extraParams, auth: { mode: 'bearer', prefix: 'Token' },
      } });
      const saved = customImageProviderDraftToConfig(draft, 'comfy-normalized');
      if (!saved.value) throw new Error(JSON.stringify(saved.issues));
      const client = createComfyProviderTransport(saved.value);
      const preview = buildCustomProviderRequestDebugPreviewForConfig(saved.value, 'workflow', { model: 'workflow', prompt: 'test', size: 'auto', aspect_ratio: 'auto' });
      expect(preview.url).toBe('http://workstation:8188/comfy/prompt');
      expect(preview.headers).not.toHaveProperty('Authorization');
      await checkComfyUIConnection(client);
      const id = await submitComfyChannelJob(saved.value, 'workflow', { model: 'workflow', prompt: 'test', size: 'auto', aspect_ratio: 'auto' });
      await recoverComfyChannelJob(id);
      expect(saved.value.baseUrl).toBe('http://workstation:8188/comfy');
      expect(client.url('/prompt', {})).toBe('http://workstation:8188/comfy/prompt');
      expect(mocks.http.mock.calls.map(([request]) => request.url)).toEqual([
        'http://workstation:8188/comfy/system_stats', 'http://workstation:8188/comfy/prompt',
      ]);
      for (const [request] of mocks.http.mock.calls) expect(request.headers).not.toHaveProperty('Authorization');
    },
  );

  it('keeps non-JSON submission rejection details actionable', async () => {
    mocks.http.mockReset().mockResolvedValue({ status: 401, text: 'Tunnel access denied; configure the tunnel token' });
    const id = await submitComfyChannelJob(config('bearer'), 'workflow', { model: 'workflow', prompt: 'test', size: 'auto', aspect_ratio: 'auto' });
    expect(await recoverComfyChannelJob(id)).toMatchObject({
      status: 'failed', error_category: 'auth', error: expect.stringContaining('configure the tunnel token'),
    });
  });

  it('explains successful HTML responses instead of leaking a JSON parse error', async () => {
    mocks.http.mockReset().mockResolvedValue({ status: 200, text: '<html>Proxy sign in</html>' });
    await expect(checkComfyUIConnection(createComfyProviderTransport(config())))
      .rejects.toThrow(/system_stats.*无效的 JSON.*queue.*登录页/);
  });

  it('redacts credential echoes from connection diagnostics', async () => {
    const provider = { ...config('bearer'), apiKey: 'private-comfy-key', extraHeaders: { 'X-Tunnel': 'private-header' }, queryParams: { token: 'private-query' } };
    mocks.http.mockReset().mockResolvedValue({ status: 403, text: 'denied private-comfy-key private-header private-query' });
    const failure = await checkComfyUIConnection(createComfyProviderTransport(provider)).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain('denied');
    for (const secret of ['private-comfy-key', 'private-header', 'private-query']) expect(String(failure)).not.toContain(secret);
  });

  it.each(['bearer', 'header', 'query'])('masks configured %s auth in previews while applying it to both check and submission', async (mode) => {
    mocks.http.mockReset().mockImplementation(async (request: { method: string }) => request.method === 'GET'
      ? { status: 200, text: '{}' } : { status: 400, text: '{"error":"fixture stops after submit"}' });
    const provider = { ...config(mode), apiKey: 'local-fixture-token' };
    const request = { model: 'workflow', prompt: 'test', size: 'auto', aspect_ratio: 'auto' };
    const preview = buildCustomProviderRequestDebugPreviewForConfig(provider, 'workflow', request);
    expect(JSON.stringify(preview)).not.toContain('local-fixture-token');
    if (mode === 'bearer') expect(preview.headers).toEqual({ Authorization: 'Bearer ***' });
    if (mode === 'header') expect(preview.headers).toEqual({ access_key: '***' });
    if (mode === 'query') expect(new URL(preview.url).searchParams.get('access_key')).toBe('***');
    await checkComfyUIConnection(createComfyProviderTransport(provider));
    const id = await submitComfyChannelJob(provider, 'workflow', request);
    await recoverComfyChannelJob(id);
    for (const [call] of mocks.http.mock.calls) {
      if (mode === 'bearer') expect(call.headers.Authorization).toBe('Bearer local-fixture-token');
      if (mode === 'header') expect(call.headers.access_key).toBe('local-fixture-token');
      if (mode === 'query') expect(new URL(call.url).searchParams.get('access_key')).toBe('local-fixture-token');
    }
  });
});
