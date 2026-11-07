import { describe, expect, it, vi } from 'vitest';
import type { JobInput } from '../../runtime/types';
import { createComfyUIAdapter, createComfyUIJob, type ComfyUIConfig, type ComfyUIDependencies } from './adapter';

const workflow = {
  '1': { class_type: 'CLIPTextEncode', inputs: { text: '' }, _meta: { title: 'OSC:prompt' } },
  '2': { class_type: 'KSampler', inputs: { seed: 1 } },
  '3': { class_type: 'LoadImage', inputs: { image: 'existing.png' } },
  '9': { class_type: 'SaveImage', inputs: { images: ['2', 0] } },
};
const input: JobInput = { jobId: 'job-1', channelId: 'channel-1', modelId: 'workflow-1', operation: 'image.generate', prompt: 'new prompt', params: { seed: 42 }, refs: [], count: 1 };
const config: ComfyUIConfig = { baseUrl: 'https://server.example/comfy/prompt', workflow, auth: { mode: 'header', name: 'X-Tunnel' } };
const history = { task: { status: { completed: true }, outputs: { '9': { images: [
  { filename: 'first.png', subfolder: 'results', type: 'output' },
  { filename: 'second.png', subfolder: '', type: 'output' },
] } } } };

function dependencies() {
  return { http: vi.fn<ComfyUIDependencies['http']>(), getSecrets: vi.fn<ComfyUIDependencies['getSecrets']>().mockResolvedValue({ apiKey: 'tunnel-secret', comfyOrgKey: 'partner-secret' }) };
}

describe('snapshot-based ComfyUI adapter', () => {
  it('uploads refs, patches the workflow and submits one prompt with independent Partner credentials', async () => {
    const deps = dependencies();
    deps.http.mockResolvedValueOnce({ status: 200, body: { name: 'uploaded.png', subfolder: 'refs' } })
      .mockResolvedValueOnce({ status: 200, body: { prompt_id: 'task' } });
    const job = createComfyUIJob({ ...input, refs: [{ kind: 'image', assetId: 'asset', path: '/tmp/ref.png', mime: 'image/png' }] }, { ...config, comfyOrgKeyRequired: true });
    const adapter = createComfyUIAdapter(deps);
    expect(await adapter.submit(job)).toEqual({ state: 'submitted', taskId: 'task' });
    expect(deps.http).toHaveBeenCalledTimes(2);
    expect(deps.http.mock.calls[0][0]).toMatchObject({ method: 'POST', url: 'https://server.example/comfy/upload/image', headers: { 'X-Tunnel': 'tunnel-secret' },
      body: { mode: 'multipart', fields: [{ name: 'type', value: 'input' }], files: [{ name: 'image', file: { path: '/tmp/ref.png' } }] } });
    expect(deps.http.mock.calls[1][0]).toMatchObject({ method: 'POST', url: 'https://server.example/comfy/prompt', body: { mode: 'json', json: {
      client_id: 'job-1', extra_data: { api_key_comfy_org: 'partner-secret' }, prompt: {
        '1': { inputs: { text: 'new prompt' } }, '2': { inputs: { seed: 42 } }, '3': { inputs: { image: 'refs/uploaded.png' } },
      },
    } } });
    expect(workflow['1'].inputs.text).toBe('');
    expect(workflow['3'].inputs.image).toBe('existing.png');
    const preview = adapter.preview!(job);
    expect(preview.headers).toEqual({ 'X-Tunnel': '***' });
    expect(JSON.stringify(preview)).not.toContain('partner-secret');
  });

  it('recovers from the serialized snapshot after workflow, bindings and base URL edits', async () => {
    const mutable = { ...config, workflow: structuredClone(workflow), bindings: { output: { nodeId: '9', input: '$output' } } };
    const job = createComfyUIJob(input, mutable);
    const deps = dependencies();
    deps.http.mockResolvedValueOnce({ status: 200, body: { prompt_id: 'task' } });
    expect(await createComfyUIAdapter(deps).submit(job)).toMatchObject({ state: 'submitted' });
    mutable.baseUrl = 'http://new-host:9000';
    mutable.workflow['1'].inputs.text = 'changed config';
    mutable.bindings.output.nodeId = 'deleted';
    deps.http.mockResolvedValueOnce({ status: 200, body: history });
    const recovered = JSON.parse(JSON.stringify(job)) as JobInput;
    const result = await createComfyUIAdapter(deps).poll!(recovered, 'task');
    expect(deps.http.mock.calls[1][0]).toMatchObject({ method: 'GET', url: 'https://server.example/comfy/history/task' });
    expect(result).toEqual({ state: 'done', outputs: [
      { kind: 'image', source: { type: 'url', url: 'https://server.example/comfy/view?filename=first.png&subfolder=results&type=output', headers: { 'X-Tunnel': 'tunnel-secret' } } },
      { kind: 'image', source: { type: 'url', url: 'https://server.example/comfy/view?filename=second.png&subfolder=&type=output', headers: { 'X-Tunnel': 'tunnel-secret' } } },
    ] });
  });

  it('persists auth shape, not secret fields accidentally present on input configuration', () => {
    const withSecrets = { ...config, apiKey: 'tunnel-secret', comfyOrgKey: 'partner-secret', auth: { mode: 'header' as const, name: 'X-Tunnel', value: 'tunnel-secret' } };
    const job = createComfyUIJob(input, withSecrets);
    const serialized = JSON.stringify(job);
    expect(serialized).not.toContain('tunnel-secret');
    expect(serialized).not.toContain('partner-secret');
    expect(job.params.comfyuiSnapshot).toMatchObject({ auth: { mode: 'header', name: 'X-Tunnel' } });
  });

  it.each([401, 403, 400])('categorizes explicit HTTP %s rejection as failed', async (status) => {
    const deps = dependencies();
    deps.http.mockResolvedValue({ status, body: { error: { message: 'denied' } } });
    const result = await createComfyUIAdapter(deps).submit(createComfyUIJob(input, config));
    expect(result).toMatchObject({ state: 'failed', error: { category: status === 400 ? 'validation' : 'auth', status, retryable: false } });
    expect(deps.http).toHaveBeenCalledTimes(1);
  });

  it('never retries ambiguous submission failures or success responses without an id', async () => {
    for (const response of [new Error('connection reset'), { status: 502, body: {} }, { status: 200, body: {} }]) {
      const deps = dependencies();
      if (response instanceof Error) deps.http.mockRejectedValue(response); else deps.http.mockResolvedValue(response);
      expect(await createComfyUIAdapter(deps).submit(createComfyUIJob(input, config))).toMatchObject({ state: 'unknown' });
      expect(deps.http).toHaveBeenCalledTimes(1);
    }
  });

  it('validates all bindings and required Partner keys before any HTTP request', async () => {
    const deps = dependencies();
    deps.getSecrets.mockResolvedValue({});
    const adapter = createComfyUIAdapter(deps);
    expect(await adapter.submit(createComfyUIJob(input, { ...config, bindings: { seed: { nodeId: '2', input: 'missing' } } }))).toMatchObject({ state: 'failed', error: { category: 'validation' } });
    expect(await adapter.submit(createComfyUIJob(input, { ...config, comfyOrgKeyRequired: true }))).toMatchObject({ state: 'failed', error: { category: 'validation' } });
    expect(deps.http).not.toHaveBeenCalled();
  });

  it('honors empty custom header values and refuses to leak auth to a cross-origin output endpoint', async () => {
    const deps = dependencies();
    deps.getSecrets.mockResolvedValue({ apiKey: '' });
    deps.http.mockResolvedValueOnce({ status: 200, body: { prompt_id: 'task' } });
    const job = createComfyUIJob(input, config);
    const adapter = createComfyUIAdapter(deps);
    await adapter.submit(job);
    expect(deps.http.mock.calls[0][0].headers).toEqual({ 'X-Tunnel': '' });
    const snapshot = job.params.comfyuiSnapshot as unknown as { urls: { view: string } };
    snapshot.urls.view = 'https://cdn.example/view';
    deps.http.mockResolvedValueOnce({ status: 200, body: history });
    const result = await adapter.poll!(job, 'task');
    expect(result).toMatchObject({ state: 'done' });
    if (result.state === 'done') {
      for (const output of result.outputs) {
        expect(output).toMatchObject({ source: { url: expect.stringContaining('https://cdn.example/view') } });
        expect(JSON.stringify(output)).not.toContain('headers');
      }
    }
  });

  it('uses websocket progress then falls back to history on disconnect', async () => {
    const deps = dependencies();
    deps.http.mockResolvedValueOnce({ status: 200, body: { prompt_id: 'task' } }).mockResolvedValueOnce({ status: 200, body: history });
    const close = vi.fn();
    let callbacks!: Parameters<NonNullable<ComfyUIDependencies['ws']>>[1];
    const ws: ComfyUIDependencies['ws'] = vi.fn((url, handlers, headers) => {
      expect(url).toBe('wss://server.example/comfy/ws?clientId=job-1');
      expect(headers).toEqual({ 'X-Tunnel': 'tunnel-secret' });
      callbacks = handlers;
      return { close };
    });
    const adapter = createComfyUIAdapter({ ...deps, ws });
    const job = createComfyUIJob(input, config);
    await adapter.submit(job);
    callbacks.message({ type: 'executing', data: { prompt_id: 'task', node: '2' } });
    callbacks.message({ type: 'progress', data: { prompt_id: 'other-task', value: 9, max: 10 } });
    callbacks.message({ type: 'progress', data: { prompt_id: 'task', value: 1, max: 4 } });
    expect(await adapter.poll!(job, 'task')).toEqual({ state: 'pending', progress: 0.25, message: '正在执行节点 2' });
    expect(deps.http).toHaveBeenCalledTimes(1);
    callbacks.close();
    expect(await adapter.poll!(job, 'task')).toMatchObject({ state: 'done' });
    expect(deps.http).toHaveBeenCalledTimes(2);
  });

  it('closes a late WebSocket connection after abort without submitting the prompt', async () => {
    const deps = dependencies(); const connection = Promise.withResolvers<{ close(): void }>();
    const ws = vi.fn(() => connection.promise); const close = vi.fn(); const controller = new AbortController();
    const adapter = createComfyUIAdapter({ ...deps, ws });
    const job = createComfyUIJob(input, config);
    const result = adapter.submit(job, controller.signal);
    await vi.waitFor(() => expect(ws).toHaveBeenCalledOnce());
    controller.abort(); connection.resolve({ close });
    expect(await result).toMatchObject({ state: 'failed' });
    expect(close).toHaveBeenCalledOnce(); expect(deps.http).not.toHaveBeenCalled();
  });

  it('resets sampler percentage when execution switches to a new node', async () => {
    const deps = dependencies(); deps.http.mockResolvedValue({ status: 200, body: { prompt_id: 'task' } });
    let callbacks!: Parameters<NonNullable<ComfyUIDependencies['ws']>>[1];
    const onProgress = vi.fn();
    const adapter = createComfyUIAdapter({ ...deps, onProgress, ws: (_url, handlers) => { callbacks = handlers; return { close: vi.fn() }; } });
    const job = createComfyUIJob(input, config); await adapter.submit(job);
    callbacks.message({ type: 'executing', data: { prompt_id: 'task', node: '2' } });
    callbacks.message({ type: 'progress', data: { prompt_id: 'task', value: 4, max: 4 } });
    callbacks.message({ type: 'executing', data: { prompt_id: 'task', node: '3' } });
    expect(onProgress.mock.calls.at(-1)?.[1]).toEqual({ type: 'executing', promptId: 'task', currentNode: '3' });
    expect(await adapter.poll!(job, 'task')).toEqual({ state: 'pending', message: '正在执行节点 3' });
    adapter.dispose(job.jobId);
  });

  it('returns original websocket execution errors without polling or resubmitting', async () => {
    const deps = dependencies();
    deps.http.mockResolvedValue({ status: 200, body: { prompt_id: 'task' } });
    let callbacks!: Parameters<NonNullable<ComfyUIDependencies['ws']>>[1];
    const close = vi.fn();
    const adapter = createComfyUIAdapter({ ...deps, ws: (_url, handlers) => { callbacks = handlers; return { close }; } });
    const job = createComfyUIJob(input, config);
    await adapter.submit(job);
    callbacks.message({ type: 'execution_error', data: { prompt_id: 'task', node: '2', exception_message: 'missing model' } });
    expect(await adapter.poll!(job, 'task')).toMatchObject({ state: 'failed', error: { category: 'upstream', message: 'missing model' } });
    expect(deps.http).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledOnce();
  });

  it('handles pending, terminal history errors and invalid output files', async () => {
    const deps = dependencies();
    const adapter = createComfyUIAdapter(deps);
    const job = createComfyUIJob(input, config);
    deps.http.mockResolvedValueOnce({ status: 200, body: {} });
    expect(await adapter.poll!(job, 'task')).toEqual({ state: 'pending' });
    deps.http.mockResolvedValueOnce({ status: 200, body: { task: { status: { status_str: 'error', messages: [['execution_error', { exception_message: 'CUDA OOM' }]] } } } });
    expect(await adapter.poll!(job, 'task')).toMatchObject({ state: 'failed', error: { message: 'CUDA OOM' } });
    deps.http.mockResolvedValueOnce({ status: 200, body: { task: { status: { completed: true }, outputs: { '9': { images: [{ filename: '../unsafe.png', type: 'output' }] } } } } });
    expect(await adapter.poll!(job, 'task')).toMatchObject({ state: 'failed', error: { category: 'upstream' } });
  });
});
