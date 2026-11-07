import { env, pipeline, RawImage, type DepthEstimationPipeline, type DepthEstimationOutput } from '@huggingface/transformers';
import {
  DEPTH_RELIEF_MODEL_ID,
  DEPTH_RELIEF_MODEL_REVISION,
  type DepthReliefDevice,
  type DepthReliefProgress,
  type DepthReliefWorkerInput,
  type DepthReliefWorkerOutput,
} from './depthReliefProtocol';

// This module is loaded only inside a dedicated module worker. Terminating that worker
// interrupts both model downloads and ONNX inference, including non-interruptible WASM calls.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<DepthReliefWorkerInput>) => void) | null;
  postMessage: (message: DepthReliefWorkerOutput, transfer?: Transferable[]) => void;
};

let estimator: DepthEstimationPipeline | undefined;
let device: DepthReliefDevice = 'wasm';

function report(progress: DepthReliefProgress): void {
  scope.postMessage({ type: 'progress', progress: { ...progress, device } });
}

async function createPipeline(target: DepthReliefDevice) {
  env.allowLocalModels = false;
  // Tauri's custom origin and npm run dev do not require COOP/COEP headers.
  // A single WASM thread avoids SharedArrayBuffer requirements on both origins.
  if (env.backends.onnx.wasm) env.backends.onnx.wasm.numThreads = 1;
  return await pipeline('depth-estimation', DEPTH_RELIEF_MODEL_ID, {
    device: target,
    dtype: 'fp32',
    revision: DEPTH_RELIEF_MODEL_REVISION,
    progress_callback: (event) => report({
      phase: 'loading-model', status: event.status,
      ...('file' in event ? { file: event.file } : {}),
      ...('progress' in event ? { progress: event.progress, loaded: event.loaded, total: event.total } : {}),
    }),
  });
}

scope.onmessage = async ({ data: input }) => {
  try {
    if (!estimator) {
      device = typeof navigator !== 'undefined' && 'gpu' in navigator ? 'webgpu' : 'wasm';
      report({ phase: 'loading-model' });
      try { estimator = await createPipeline(device); }
      catch (error) {
        if (device !== 'webgpu') throw error;
        device = 'wasm';
        report({ phase: 'loading-model', status: 'fallback' });
        estimator = await createPipeline(device);
      }
    }
    report({ phase: 'estimating' });
    const image = new RawImage(input.pixels, input.width, input.height, 4);
    let output: DepthEstimationOutput;
    try { output = await estimator(image); }
    catch (error) {
      if (device !== 'webgpu') throw error;
      await estimator.dispose();
      estimator = undefined;
      device = 'wasm';
      report({ phase: 'loading-model', status: 'fallback' });
      estimator = await createPipeline(device);
      report({ phase: 'estimating' });
      output = await estimator(image);
    }
    // The genuine Depth Anything V2 pipeline yields a per-image normalized inverse-depth image.
    const { depth } = output;
    const buffer = depth.data.buffer;
    if (!(buffer instanceof ArrayBuffer)) throw new Error('Depth model returned non-transferable pixels');
    const data = new Uint8Array(buffer, depth.data.byteOffset, depth.width * depth.height);
    scope.postMessage({ type: 'result', data, width: depth.width, height: depth.height, device }, [data.buffer]);
  } catch (error) {
    scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
