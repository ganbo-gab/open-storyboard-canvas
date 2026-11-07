import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetRecord } from '@/features/assets/application/assetCatalog';
import type { DepthReliefEstimate } from './depthReliefEstimator';
import { buildDepthRelief, encodeDepthReliefPng, loadDepthReliefSources } from './depthRelief';

const dependencies = vi.hoisted(() => ({
  saveAsset: vi.fn(), getAssetDisplaySource: vi.fn(), loadImageElement: vi.fn(), estimateDepthRelief: vi.fn(),
}));
vi.mock('@/features/assets/application/assetCatalog', () => ({ saveAsset: dependencies.saveAsset, getAssetDisplaySource: dependencies.getAssetDisplaySource }));
vi.mock('@/features/canvas/application/imageData', () => ({ loadImageElement: dependencies.loadImageElement }));
vi.mock('./depthReliefEstimator', () => ({ estimateDepthRelief: dependencies.estimateDepthRelief }));

const png = 'data:image/png;base64,AA==';
let encodedPixels: ImageData | undefined;
let decodedPixels: Uint8ClampedArray;

beforeEach(() => {
  vi.clearAllMocks();
  encodedPixels = undefined;
  decodedPixels = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]);
  dependencies.getAssetDisplaySource.mockImplementation(async (source: string) => source.startsWith('asset-media:') ? `blob:display:${source}` : source);
  dependencies.loadImageElement.mockResolvedValue({ width: 2, height: 1, naturalWidth: 2, naturalHeight: 1 } as HTMLImageElement);
  dependencies.estimateDepthRelief.mockResolvedValue({ type: 'result', data: new Uint8Array([0, 255]), width: 2, height: 1, device: 'wasm' } satisfies DepthReliefEstimate);
  dependencies.saveAsset.mockImplementation(async (input: Omit<AssetRecord, 'id' | 'createdAt' | 'favorite'>) => ({
    ...input, id: String(input.metadata.role), source: `asset-media:image%2Fpng:${input.metadata.role}`,
    createdAt: 1, favorite: false,
  } satisfies AssetRecord));
  vi.stubGlobal('document', {
    createElement: () => ({
      width: 0, height: 0,
      getContext: () => ({
        drawImage: vi.fn(),
        createImageData: (width: number, height: number) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
        getImageData: (_x: number, _y: number, width: number, height: number) => ({ width, height, data: decodedPixels }),
        putImageData: (pixels: ImageData) => { encodedPixels = pixels; },
      }),
      toDataURL: () => png,
    }),
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('depth relief application service', () => {
  it('returns durable image/depth references after saving a lossless inverse-depth PNG', async () => {
    const onProgress = vi.fn();
    const result = await buildDepthRelief({ imageUrl: '/reference.png', name: 'Set', projectId: 'project', nodeId: 'stage' }, { onProgress });
    expect(result).toMatchObject({
      relief: { imageUrl: 'asset-media:image%2Fpng:relief-image', depthUrl: 'asset-media:image%2Fpng:relief-depth', widthM: 12, depthM: 3 },
      imageAssetId: 'relief-image', depthAssetId: 'relief-depth', width: 2, height: 1, device: 'wasm',
    });
    expect(encodedPixels?.data).toEqual(new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]));
    expect(dependencies.saveAsset).toHaveBeenLastCalledWith(expect.objectContaining({
      source: png, kind: 'image', origin: 'generated', projectId: 'project', nodeId: 'stage',
      metadata: expect.objectContaining({ role: 'relief-depth', inverseDepth: true }),
    }));
    expect(onProgress.mock.calls.map((call) => call[0].phase)).toEqual(['saving', 'complete']);
  });

  it('does not return an adoptable relief or save assets after cancellation of inference', async () => {
    const controller = new AbortController();
    dependencies.estimateDepthRelief.mockImplementation(async () => {
      controller.abort();
      return { type: 'result', data: new Uint8Array([0, 255]), width: 2, height: 1, device: 'wasm' } satisfies DepthReliefEstimate;
    });
    await expect(buildDepthRelief({ imageUrl: '/reference.png', name: 'Set' }, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(dependencies.saveAsset).not.toHaveBeenCalled();
  });

  it('does not adopt partial saves when PNG persistence fails', async () => {
    dependencies.saveAsset.mockResolvedValueOnce({ id: 'image', source: '/persisted-image.png' })
      .mockRejectedValueOnce(new Error('Storage quota exceeded'));
    await expect(buildDepthRelief({ imageUrl: '/reference.png', name: 'Set' })).rejects.toThrow('Storage quota exceeded');
    expect(dependencies.saveAsset).toHaveBeenCalledTimes(2);
  });

  it('resolves persisted browser media for renderer loading and preserves inverse-depth polarity', async () => {
    const sources = await loadDepthReliefSources({ imageUrl: 'asset-media:image%2Fpng:image', depthUrl: 'asset-media:image%2Fpng:depth', widthM: 12, depthM: 3, fovDeg: 55, segments: 128 });
    expect(dependencies.loadImageElement).toHaveBeenCalledWith('blob:display:asset-media:image%2Fpng:image');
    expect(dependencies.loadImageElement).toHaveBeenCalledWith('blob:display:asset-media:image%2Fpng:depth');
    expect(sources.depth).toEqual({ width: 2, height: 1, data: new Float32Array([0, 1]) });
  });

  it('rejects malformed model output rather than storing a fake or truncated map', () => {
    expect(() => encodeDepthReliefPng(new Uint8Array(1), 2, 2)).toThrow('dimensions');
  });
});
