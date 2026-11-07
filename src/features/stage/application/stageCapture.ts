import { z } from 'zod';
import type { BlueprintNodeData } from '@/features/canvas/domain/canvasNodes';
import type { StageWorkspace } from '../domain/stage';

export const STAGE_FOUR_VIEWS = ['front', 'right', 'back', 'left'] as const;
export type StageFourView = typeof STAGE_FOUR_VIEWS[number];
export interface StageCapturedImage { assetId: string }
export interface StageFourViewImage extends StageCapturedImage { view: StageFourView }
export interface StageCaptureRequest { view: 'current' | 'shot' | StageFourView; timeSeconds?: number }
export const stageCapturedImageSchema = z.object({ assetId: z.string().trim().min(1) }).strict();
export const stageFourViewImagesSchema = z.array(stageCapturedImageSchema.extend({ view: z.enum(STAGE_FOUR_VIEWS) }).strict())
  .length(4).refine((images) => new Set(images.map((image) => image.view)).size === 4, 'Every four-view angle is required.')
  .refine((images) => new Set(images.map((image) => image.assetId)).size === 4, 'Every view must produce its own image asset.');

export interface StageViewportBridge {
  /** Create/persist a new real image through the existing screenshot workflow. */
  capture: (signal?: AbortSignal) => Promise<StageCapturedImage>;
  /** No fallback to the current frame. Must restore scene, camera and playback. */
  captureAt?: (timeSeconds: number, signal?: AbortSignal) => Promise<StageCapturedImage>;
  captureFourViews?: (timeSeconds?: number, signal?: AbortSignal) => Promise<StageFourViewImage[]>;
  setWorkspace?: (workspace: StageWorkspace) => void;
}

/**
 * Renderer-owned integration boundary, with no React or graph writes. snapshot freezes
 * one scene/time for the whole batch. A live-mutating adapter must supply suspend and
 * uncancellable restore for scene/camera/playhead/preview/playing, including failure.
 * Isolated offscreen adapters omit both because they never mutate that live state.
 * render returns a real freshly rendered image, never a cached prior screenshot.
 * persistImage/discardImage use the real media and global asset catalog APIs.
 */
export type StageCaptureAdapter<State> = {
  snapshot: (requests: readonly StageCaptureRequest[]) => State;
  render: (request: StageCaptureRequest, state: State, signal?: AbortSignal) => Blob | Promise<Blob>;
  persistImage: (image: Blob, request: StageCaptureRequest, signal?: AbortSignal) => Promise<StageCapturedImage>;
  discardImage: (assetId: string) => Promise<void>;
  setWorkspace?: (workspace: StageWorkspace) => void;
} & (
  | { suspend: (state: State) => void; restore: (state: State) => void | Promise<void> }
  | { suspend?: undefined; restore?: undefined }
);

export function assertStageCaptureActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Stage capture was cancelled.', 'AbortError');
}

// The shell may overlay its project library, but every input that can change
// exported pixels or sampling must still belong to the current store document.
const CAPTURE_DATA_KEYS = [
  'items', 'mode', 'backgroundPanoramaUrl', 'backgroundImageUrl', 'customActionPoses',
  'camera', 'lighting', 'motionProject', 'aspectFrame', 'aspectRatio', 'screenshotResolution',
] as const satisfies readonly (keyof BlueprintNodeData)[];

/** Compare immutable inputs, never relabel a previous React render as current store data. */
export function assertStageCaptureDataCurrent(rendered: BlueprintNodeData, current: BlueprintNodeData): void {
  if (CAPTURE_DATA_KEYS.some((key) => !Object.is(rendered[key], current[key]))) {
    throw new Error('Stage render synchronization is not ready for the current scene.');
  }
}

/** Serial ownership lasts through restore and persistence; cancellation never races restore. */
export function createStageCaptureBridge<State>(adapter: StageCaptureAdapter<State>): StageViewportBridge {
  let busy = false;
  const capture = async (requests: StageCaptureRequest[], signal?: AbortSignal): Promise<StageCapturedImage[]> => {
    assertStageCaptureActive(signal);
    if (busy) throw new Error('A stage capture is already in progress.');
    busy = true;
    const persisted: StageCapturedImage[] = [];
    try {
      const state = adapter.snapshot(requests);
      const rendered: Array<{ request: StageCaptureRequest; image: Blob }> = [];
      try {
        adapter.suspend?.(state);
        for (const request of requests) {
          assertStageCaptureActive(signal);
          const image = await adapter.render(request, state, signal);
          assertStageCaptureActive(signal);
          if (!(image instanceof Blob) || image.size === 0 || !image.type.startsWith('image/')) throw new Error('Stage renderer did not export a real image.');
          rendered.push({ request, image });
        }
      } finally {
        // Await in-flight renderer work before restore, even after abort. Never let a
        // late render overwrite the restored scene or resume a superseded playback.
        await adapter.restore?.(state);
      }
      for (const { request, image } of rendered) {
        assertStageCaptureActive(signal);
        const result = stageCapturedImageSchema.parse(await adapter.persistImage(image, request, signal));
        persisted.push(result);
        assertStageCaptureActive(signal);
      }
      if (new Set(persisted.map((image) => image.assetId)).size !== persisted.length) throw new Error('Stage captures must persist distinct image assets.');
      return persisted;
    } catch (error) {
      const cleanup = await Promise.allSettled([...new Set(persisted.map((image) => image.assetId))].map((id) => adapter.discardImage(id)));
      const failures = cleanup.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length) throw Object.assign(new Error('Stage capture failed and some image assets could not be removed.'), { errors: [error, ...failures] });
      throw error;
    } finally {
      busy = false;
    }
  };
  return {
    capture: async (signal) => (await capture([{ view: 'current' }], signal))[0],
    captureAt: async (timeSeconds, signal) => (await capture([{ view: 'shot', timeSeconds }], signal))[0],
    captureFourViews: async (timeSeconds, signal) => {
      const images = await capture(STAGE_FOUR_VIEWS.map((view) => ({ view, ...(timeSeconds !== undefined ? { timeSeconds } : {}) })), signal);
      return images.map((image, index) => ({ ...image, view: STAGE_FOUR_VIEWS[index] }));
    },
    ...(adapter.setWorkspace ? { setWorkspace: adapter.setWorkspace } : {}),
  };
}
