import type {
  DepthReliefTaskOptions,
  DepthReliefWorkerInput,
  DepthReliefWorkerOutput,
} from './depthReliefProtocol';

export type DepthReliefEstimate = Extract<DepthReliefWorkerOutput, { type: 'result' }>;

let worker: Worker | undefined;
let scheduled: Promise<void> = Promise.resolve();

function runInWorker(input: DepthReliefWorkerInput, options: DepthReliefTaskOptions): Promise<DepthReliefEstimate> {
  options.signal?.throwIfAborted();
  // Constructing the worker is the lazy-loading boundary: no ONNX runtime or model
  // is loaded while merely opening the stage. The pipeline stays warm between jobs.
  worker ??= new Worker(new URL('./depthRelief.worker.ts', import.meta.url), { type: 'module', name: 'depth-relief' });
  const activeWorker = worker;
  return new Promise((resolve, reject) => {
    const finish = (error?: unknown, result?: DepthReliefEstimate) => {
      activeWorker.removeEventListener('message', onMessage);
      activeWorker.removeEventListener('error', onError);
      activeWorker.removeEventListener('messageerror', onError);
      options.signal?.removeEventListener('abort', onAbort);
      if (error !== undefined) {
        activeWorker.terminate();
        if (worker === activeWorker) worker = undefined;
        reject(error);
      } else if (result) resolve(result);
    };
    const onMessage = ({ data }: MessageEvent<DepthReliefWorkerOutput>) => {
      if (data.type === 'progress') options.onProgress?.(data.progress);
      else if (data.type === 'error') finish(new Error(data.message));
      else if (data.type === 'result') finish(undefined, data);
    };
    const onError = (event: Event) => finish(new Error('message' in event ? String(event.message) : 'Depth worker failed'));
    const onAbort = () => finish(options.signal?.reason ?? new DOMException('Depth estimation cancelled', 'AbortError'));
    activeWorker.addEventListener('message', onMessage);
    activeWorker.addEventListener('error', onError);
    activeWorker.addEventListener('messageerror', onError);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try { activeWorker.postMessage(input, [input.pixels.buffer]); }
    catch (error) { finish(error); }
  });
}

/** Runs real model inference off the UI thread. Input pixel storage is transferred to the worker. */
export function estimateDepthRelief(input: DepthReliefWorkerInput, options: DepthReliefTaskOptions = {}): Promise<DepthReliefEstimate> {
  const task = scheduled.then(() => runInWorker(input, options));
  // ONNX sessions are serialized. A queued cancellation never interrupts another caller's job.
  scheduled = task.then(() => undefined, () => undefined);
  if (!options.signal) return task;
  const { signal } = options;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException('Depth estimation cancelled', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    task.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
