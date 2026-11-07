import { saveAsset, getAssetDisplaySource } from '@/features/assets/application/assetCatalog';
import { loadImageElement } from '@/features/canvas/application/imageData';
import {
  DEFAULT_DEPTH_RELIEF_PARAMETERS,
  depthReliefParametersSchema,
  depthReliefSchema,
  type DepthRelief,
  type DepthReliefMap,
  type DepthReliefParameters,
} from '../domain/depthRelief';
import { estimateDepthRelief } from './depthReliefEstimator';
import type { DepthReliefDevice, DepthReliefTaskOptions } from './depthReliefProtocol';

export type { DepthReliefProgress, DepthReliefTaskOptions } from './depthReliefProtocol';
export { DEPTH_RELIEF_MODEL_ID, DEPTH_RELIEF_MODEL_BYTES } from './depthReliefProtocol';

export interface BuildDepthReliefRequest {
  imageUrl: string;
  name: string;
  projectId?: string;
  nodeId?: string;
  params?: Partial<DepthReliefParameters>;
}

export interface BuiltDepthRelief {
  relief: DepthRelief;
  imageAssetId: string;
  depthAssetId: string;
  /** Actual depth PNG dimensions (input is limited to 1536px on its longest side). */
  width: number;
  height: number;
  device: DepthReliefDevice;
}

function withAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  // ES2020 is the app target; Promise.withResolvers is not available on all supported webviews.
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException('Depth relief cancelled', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

async function loadReliefImage(source: string, signal?: AbortSignal): Promise<HTMLImageElement> {
  signal?.throwIfAborted();
  const displaySource = await withAbort(getAssetDisplaySource(source), signal);
  return await withAbort(loadImageElement(displaySource), signal);
}

function imagePixels(image: HTMLImageElement, maxDimension = Infinity): ImageData {
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  if (!sourceWidth || !sourceHeight) throw new Error('Relief source image is empty');
  const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sourceWidth * scale));
  canvas.height = Math.max(1, Math.round(sourceHeight * scale));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Canvas image decoding is unavailable');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

/** Lossless grayscale PNG; no display colour-map or temporary blob URL is persisted. */
export function encodeDepthReliefPng(data: Uint8Array, width: number, height: number): string {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || data.length !== width * height) {
    throw new Error('Invalid estimated depth dimensions');
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas PNG encoding is unavailable');
  const pixels = context.createImageData(width, height);
  for (let index = 0; index < data.length; index += 1) {
    const offset = index * 4;
    pixels.data[offset] = data[index];
    pixels.data[offset + 1] = data[index];
    pixels.data[offset + 2] = data[index];
    pixels.data[offset + 3] = 255;
  }
  context.putImageData(pixels, 0, 0);
  return canvas.toDataURL('image/png');
}

/**
 * Estimates real monocular depth in a worker, then commits both images through the
 * existing durable asset boundary. Does not mutate the stage or call a paid provider.
 * Cancellation interrupts active inference/download; completed asset writes may remain
 * in the library, but no stale relief is returned for adoption.
 */
export async function buildDepthRelief(request: BuildDepthReliefRequest, options: DepthReliefTaskOptions = {}): Promise<BuiltDepthRelief> {
  options.signal?.throwIfAborted();
  if (!request.imageUrl.trim() || !request.name.trim()) throw new Error('Relief image and name are required');
  const params = depthReliefParametersSchema.parse({ ...DEFAULT_DEPTH_RELIEF_PARAMETERS, ...request.params });
  const image = await loadReliefImage(request.imageUrl, options.signal);
  const input = imagePixels(image, 1536);
  const estimated = await estimateDepthRelief({ pixels: input.data, width: input.width, height: input.height }, options);
  options.signal?.throwIfAborted();
  const png = encodeDepthReliefPng(estimated.data, estimated.width, estimated.height);
  options.onProgress?.({ phase: 'saving', device: estimated.device });
  const metadata = { stageRelief: true, model: 'onnx-community/depth-anything-v2-small', width: estimated.width, height: estimated.height };
  const imageAsset = await saveAsset({
    kind: 'image', source: request.imageUrl, name: request.name.trim(), origin: 'generated',
    projectId: request.projectId, nodeId: request.nodeId, metadata: { ...metadata, role: 'relief-image' },
  });
  options.signal?.throwIfAborted();
  const depthAsset = await saveAsset({
    kind: 'image', source: png, name: `${request.name.trim()} · depth`, origin: 'generated',
    projectId: request.projectId, nodeId: request.nodeId, metadata: { ...metadata, role: 'relief-depth', inverseDepth: true },
  });
  options.signal?.throwIfAborted();
  const relief = depthReliefSchema.parse({ ...params, imageUrl: imageAsset.source, depthUrl: depthAsset.source });
  options.onProgress?.({ phase: 'complete', device: estimated.device });
  return { relief, imageAssetId: imageAsset.id, depthAssetId: depthAsset.id, width: estimated.width, height: estimated.height, device: estimated.device };
}

/** Resolves browser asset-media handles and desktop file paths before creating a mesh. */
export async function loadDepthReliefSources(relief: DepthRelief, signal?: AbortSignal): Promise<{ image: HTMLImageElement; depth: DepthReliefMap }> {
  const parsed = depthReliefSchema.parse(relief);
  const [image, depthImage] = await Promise.all([
    loadReliefImage(parsed.imageUrl, signal), loadReliefImage(parsed.depthUrl, signal),
  ]);
  signal?.throwIfAborted();
  const pixels = imagePixels(depthImage);
  const data = new Float32Array(pixels.width * pixels.height);
  for (let index = 0; index < data.length; index += 1) data[index] = pixels.data[index * 4] / 255;
  return { image, depth: { width: pixels.width, height: pixels.height, data } };
}
