import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DepthReliefWorkerInput, DepthReliefWorkerOutput } from './depthReliefProtocol';

class TestWorker extends EventTarget {
  static instances: TestWorker[] = [];
  readonly inputs: DepthReliefWorkerInput[] = [];
  readonly terminate = vi.fn();
  constructor() { super(); TestWorker.instances.push(this); }
  postMessage(input: DepthReliefWorkerInput): void { this.inputs.push(input); }
  send(data: DepthReliefWorkerOutput): void { this.dispatchEvent(new MessageEvent('message', { data })); }
}

const pixels = (): DepthReliefWorkerInput => ({ width: 2, height: 1, pixels: new Uint8ClampedArray(8) });
const result: DepthReliefWorkerOutput = { type: 'result', width: 2, height: 1, data: new Uint8Array([0, 255]), device: 'wasm' };

beforeEach(() => { vi.resetModules(); TestWorker.instances = []; vi.stubGlobal('Worker', TestWorker); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('depth relief inference scheduling', () => {
  it('loads no worker until requested, forwards progress, and reuses the warm pipeline worker', async () => {
    const { estimateDepthRelief } = await import('./depthReliefEstimator');
    expect(TestWorker.instances).toHaveLength(0);
    const onProgress = vi.fn();
    const first = estimateDepthRelief(pixels(), { onProgress });
    await Promise.resolve();
    const worker = TestWorker.instances[0];
    worker.send({ type: 'progress', progress: { phase: 'loading-model', progress: 50, loaded: 50, total: 100 } });
    worker.send(result);
    await expect(first).resolves.toEqual(result);
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'loading-model', progress: 50 }));
    const second = estimateDepthRelief(pixels());
    await Promise.resolve();
    expect(TestWorker.instances).toHaveLength(1);
    expect(worker.inputs).toHaveLength(2);
    worker.send(result);
    await expect(second).resolves.toEqual(result);
  });

  it('physically terminates active inference on abort and starts a fresh worker for the next job', async () => {
    const { estimateDepthRelief } = await import('./depthReliefEstimator');
    const controller = new AbortController();
    const first = estimateDepthRelief(pixels(), { signal: controller.signal });
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    controller.abort();
    await rejected;
    expect(TestWorker.instances[0].terminate).toHaveBeenCalledTimes(1);
    const second = estimateDepthRelief(pixels());
    await Promise.resolve();
    const nextWorker = TestWorker.instances[1];
    expect(nextWorker).toBeDefined();
    nextWorker.send(result);
    await expect(second).resolves.toEqual(result);
  });

  it('cancels a queued request immediately without terminating another request', async () => {
    const { estimateDepthRelief } = await import('./depthReliefEstimator');
    const first = estimateDepthRelief(pixels());
    await Promise.resolve();
    const worker = TestWorker.instances[0];
    const controller = new AbortController();
    const queued = estimateDepthRelief(pixels(), { signal: controller.signal });
    const rejected = expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;
    expect(worker.terminate).not.toHaveBeenCalled();
    worker.send(result);
    await expect(first).resolves.toEqual(result);
    await Promise.resolve();
    expect(worker.inputs).toHaveLength(1);
  });

  it('rejects worker failures without leaving the request queue blocked', async () => {
    const { estimateDepthRelief } = await import('./depthReliefEstimator');
    const first = estimateDepthRelief(pixels());
    const rejected = expect(first).rejects.toThrow('Model download failed');
    await Promise.resolve();
    TestWorker.instances[0].send({ type: 'error', message: 'Model download failed' });
    await rejected;
    const second = estimateDepthRelief(pixels());
    await Promise.resolve();
    TestWorker.instances[1].send(result);
    await expect(second).resolves.toEqual(result);
  });
});
