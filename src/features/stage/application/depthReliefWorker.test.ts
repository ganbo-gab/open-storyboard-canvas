import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DepthReliefWorkerInput, DepthReliefWorkerOutput } from './depthReliefProtocol';

const runtime = vi.hoisted(() => {
  const infer = vi.fn(async (_image: unknown) => ({ depth: { width: 2, height: 1, data: new Uint8Array([0, 255]) } }));
  const dispose = vi.fn(async () => undefined);
  const estimator = Object.assign(infer, { dispose });
  return {
    infer, dispose, estimator,
    pipeline: vi.fn(async (_task: string, _model: string, _options: Record<string, unknown>) => estimator),
    env: { allowLocalModels: true, backends: { onnx: { wasm: { numThreads: 4 } } } },
  };
});

vi.mock('@huggingface/transformers', () => ({
  pipeline: runtime.pipeline, env: runtime.env,
  RawImage: class {
    constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number, readonly channels: number) {}
  },
}));

interface TestScope {
  onmessage: ((event: MessageEvent<DepthReliefWorkerInput>) => Promise<void>) | null;
  postMessage: (message: DepthReliefWorkerOutput, transfer?: Transferable[]) => void;
}

let scope: TestScope;
const input: DepthReliefWorkerInput = { width: 2, height: 1, pixels: new Uint8ClampedArray(8) };

beforeEach(() => {
  vi.resetModules();
  runtime.pipeline.mockReset().mockResolvedValue(runtime.estimator);
  runtime.infer.mockReset().mockImplementation(async () => ({ depth: { width: 2, height: 1, data: new Uint8Array([0, 255]) } }));
  runtime.dispose.mockClear();
  scope = { onmessage: null, postMessage: vi.fn() };
  vi.stubGlobal('self', scope);
  vi.stubGlobal('navigator', {});
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('real depth worker orchestration (model mocked only at the inference boundary)', () => {
  it('uses the verified Depth Anything model with fp32 WASM and retains its pipeline for subsequent images', async () => {
    await import('./depthRelief.worker');
    expect(runtime.pipeline).not.toHaveBeenCalled();
    await scope.onmessage!(new MessageEvent('message', { data: input }));
    expect(runtime.pipeline).toHaveBeenCalledWith('depth-estimation', 'onnx-community/depth-anything-v2-small', expect.objectContaining({ device: 'wasm', dtype: 'fp32' }));
    expect(runtime.env.backends.onnx.wasm.numThreads).toBe(1);
    expect(scope.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'result', data: new Uint8Array([0, 255]), device: 'wasm' }), expect.any(Array));
    await scope.onmessage!(new MessageEvent('message', { data: input }));
    expect(runtime.pipeline).toHaveBeenCalledTimes(1);
    expect(runtime.infer).toHaveBeenCalledTimes(2);
  });

  it('falls back to WASM when a present WebGPU API cannot initialize the model', async () => {
    vi.stubGlobal('navigator', { gpu: {} });
    runtime.pipeline.mockRejectedValueOnce(new Error('No GPU adapter'));
    await import('./depthRelief.worker');
    await scope.onmessage!(new MessageEvent('message', { data: input }));
    expect(runtime.pipeline.mock.calls.map((call) => call[2].device)).toEqual(['webgpu', 'wasm']);
    expect(scope.postMessage).toHaveBeenCalledWith({ type: 'progress', progress: { phase: 'loading-model', status: 'fallback', device: 'wasm' } });
    expect(scope.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'result', device: 'wasm' }), expect.any(Array));
  });

  it('also falls back after a WebGPU inference failure, disposing the unusable GPU session', async () => {
    vi.stubGlobal('navigator', { gpu: {} });
    runtime.infer.mockRejectedValueOnce(new Error('Unsupported GPU operator'));
    await import('./depthRelief.worker');
    await scope.onmessage!(new MessageEvent('message', { data: input }));
    expect(runtime.dispose).toHaveBeenCalledTimes(1);
    expect(runtime.pipeline.mock.calls.map((call) => call[2].device)).toEqual(['webgpu', 'wasm']);
    expect(scope.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'result', device: 'wasm' }), expect.any(Array));
  });

  it('reports a real runtime error when neither backend can load, never emits fake depth', async () => {
    runtime.pipeline.mockRejectedValue(new Error('Network unavailable'));
    await import('./depthRelief.worker');
    await scope.onmessage!(new MessageEvent('message', { data: input }));
    expect(scope.postMessage).toHaveBeenCalledWith({ type: 'error', message: 'Network unavailable' });
    expect(runtime.infer).not.toHaveBeenCalled();
  });
});
