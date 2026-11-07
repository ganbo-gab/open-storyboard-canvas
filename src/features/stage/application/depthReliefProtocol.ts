export type DepthReliefDevice = 'webgpu' | 'wasm';
export interface DepthReliefProgress {
  phase: 'loading-model' | 'estimating' | 'saving' | 'complete';
  device?: DepthReliefDevice;
  status?: string;
  file?: string;
  /** Download percentage, when the runtime knows the total size. */
  progress?: number;
  loaded?: number;
  total?: number;
}

export interface DepthReliefWorkerInput {
  pixels: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
}

export type DepthReliefWorkerOutput =
  | { type: 'progress'; progress: DepthReliefProgress }
  | { type: 'result'; data: Uint8Array<ArrayBuffer>; width: number; height: number; device: DepthReliefDevice }
  | { type: 'error'; message: string };

export interface DepthReliefTaskOptions {
  signal?: AbortSignal;
  onProgress?: (progress: DepthReliefProgress) => void;
}

export const DEPTH_RELIEF_MODEL_ID = 'onnx-community/depth-anything-v2-small';
/** Pin the verified fp32 asset so browser cache entries and reported download sizes stay reproducible. */
export const DEPTH_RELIEF_MODEL_REVISION = '4472b7362082ad9968fee890ca0f1e5aca36b93d';
export const DEPTH_RELIEF_MODEL_BYTES = 99_060_839;
