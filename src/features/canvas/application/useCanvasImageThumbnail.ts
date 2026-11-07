import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useStoreApi } from '@xyflow/react';

import { CANVAS_ZOOM_SETTLE_MS } from '@/features/canvas/engine/canvasZoomRendering';
import { useCanvasUiStore } from '@/features/canvas/state/canvasUiStore';
import {
  canvasImageThumbnailCache,
  resolveCanvasImageRequiredPixels,
  selectCanvasImageThumbnailTier,
  type CanvasImageThumbnailCache,
  type CanvasImageThumbnailHandle,
} from './canvasImageThumbnails';
import { DEFAULT_PREVIEW_MAX_DIMENSION, resolveImageDisplayUrl } from './imageData';

/** Snapshot value for "no tier is sharp enough; display the original". */
const ORIGINAL_TIER = 0;

// One browser listener, not one window resize listener for every image on a large canvas.
const displayRatioListeners = new Set<() => void>();
let observedDisplayRatio = 1;
let resolutionQuery: MediaQueryList | null = null;

function watchDisplayRatio(): void {
  resolutionQuery?.removeEventListener('change', notifyDisplayRatio);
  resolutionQuery = window.matchMedia?.(`(resolution: ${window.devicePixelRatio}dppx)`) ?? null;
  resolutionQuery?.addEventListener('change', notifyDisplayRatio);
}

function notifyDisplayRatio(): void {
  if (window.devicePixelRatio === observedDisplayRatio) return;
  observedDisplayRatio = window.devicePixelRatio;
  watchDisplayRatio();
  for (const listener of displayRatioListeners) listener();
}

function subscribeDisplayRatio(listener: () => void): () => void {
  displayRatioListeners.add(listener);
  if (displayRatioListeners.size === 1) {
    observedDisplayRatio = window.devicePixelRatio;
    window.addEventListener('resize', notifyDisplayRatio);
    watchDisplayRatio();
  }
  return () => {
    displayRatioListeners.delete(listener);
    if (displayRatioListeners.size !== 0) return;
    window.removeEventListener('resize', notifyDisplayRatio);
    resolutionQuery?.removeEventListener('change', notifyDisplayRatio);
    resolutionQuery = null;
  };
}

export interface CanvasImageThumbnailInput {
  imageUrl?: string | null;
  previewImageUrl?: string | null;
  /** CSS size of the image box at zoom 1. */
  width: number;
  height: number;
  /** Natural width / height; needed for `cover`. */
  aspectRatio?: number | null;
  fit?: 'contain' | 'cover';
}

export interface CanvasImageThumbnailView {
  /** Thumbnail (or original when required); interim prepared preview; '' while pending. */
  src: string;
  fallbackSrcs: string[];
  /** Untouched original for the viewer; browser asset-media stays a handle and is hydrated on open. */
  viewerSrc: string;
  /** Nothing valid to show yet: render a neutral media box, not a missing-image state. */
  pending: boolean;
}

interface DisplayedThumbnail {
  source: string;
  tier: number;
  url: string;
  handle: CanvasImageThumbnailHandle | null;
}

/** Display URL available without I/O; asset-media needs async hydration. */
function syncDisplayUrl(source: string): string {
  if (!source || source.startsWith('asset-media:')) return '';
  if (source.startsWith('data:') || source.startsWith('blob:')) return source;
  return resolveImageDisplayUrl(source);
}

/**
 * Picks the smallest durable thumbnail that is at least the displayed device pixels, the original
 * only when every tier would undersample. Re-renders only when the tier changes, never per frame;
 * a resolved image stays on screen until the next tier for the same source is ready.
 */
export function useCanvasImageThumbnail(
  { imageUrl, previewImageUrl, width, height, aspectRatio, fit = 'contain' }: CanvasImageThumbnailInput,
  cache: CanvasImageThumbnailCache = canvasImageThumbnailCache,
): CanvasImageThumbnailView {
  const original = typeof imageUrl === 'string' ? imageUrl.trim() : '';
  const preview = typeof previewImageUrl === 'string' ? previewImageUrl.trim() : '';
  const source = original || preview;
  const flowStore = useStoreApi();
  const subscribe = useCallback((listener: () => void) => {
    const offFlow = flowStore.subscribe((state, previous) => {
      if (state.transform[2] !== previous.transform[2]
        && useCanvasUiStore.getState().zoomRendering.thumbnailZoom === undefined) listener();
    });
    const offZoom = useCanvasUiStore.subscribe((state, previous) => {
      if (state.zoomRendering.thumbnailZoom !== previous.zoomRendering.thumbnailZoom) listener();
    });
    const offDisplayRatio = subscribeDisplayRatio(listener);
    return () => { offFlow(); offZoom(); offDisplayRatio(); };
  }, [flowStore]);
  const snapshot = useCallback(() => selectCanvasImageThumbnailTier(resolveCanvasImageRequiredPixels({
    width,
    height,
    zoom: useCanvasUiStore.getState().zoomRendering.thumbnailZoom ?? flowStore.getState().transform[2],
    devicePixelRatio: typeof window === 'undefined' ? 1 : window.devicePixelRatio,
    aspectRatio,
    fit,
  })) ?? ORIGINAL_TIER, [aspectRatio, fit, flowStore, height, width]);
  const tier = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [displayed, setDisplayed] = useState<{ source: string; url: string } | null>(null);
  const displayedRef = useRef<DisplayedThumbnail | null>(null);

  useEffect(() => () => {
    displayedRef.current?.handle?.release();
    displayedRef.current = null;
  }, []);

  useEffect(() => {
    const current = displayedRef.current;
    if (current && current.source !== source) {
      // Never keep another source's pixels: the view ignores them and the lease is returned now.
      current.handle?.release();
      displayedRef.current = null;
    }
    if (!source || source.startsWith('blob:')) return;
    const sameSource = displayedRef.current !== null;
    if (sameSource && displayedRef.current?.tier === tier) return;

    let cancelled = false;
    let handle: CanvasImageThumbnailHandle | null = null;
    let timer: number | undefined;
    const commit = (url: string, owner: CanvasImageThumbnailHandle | null) => {
      const previous = displayedRef.current;
      displayedRef.current = { source, tier, url, handle: owner };
      // The displayed lease now owns the handle; effect cleanup only owns pending work.
      if (handle === owner) handle = null;
      setDisplayed({ source, url });
      if (previous?.handle && previous.handle !== owner) previous.handle.release();
    };
    const hasPreview = Boolean(preview) && preview !== source && !preview.startsWith('blob:');
    const showOriginal = (target = source) => {
      void cache.resolveOriginalDisplayUrl(target).then(
        (url) => { if (!cancelled) commit(url, null); },
        (error: unknown) => {
          if (cancelled) return;
          console.warn('[useCanvasImageThumbnail] original image is unavailable', { error });
          commit('', null);
        },
      );
    };
    const acquireFrom = (candidate: string, next: (() => void) | null) => {
      const acquired = cache.acquire(candidate, tier);
      handle = acquired;
      acquired.promise.then(
        (result) => {
          if (cancelled) {
            acquired.release();
          } else if (next && result.kind === 'original' && Math.max(result.width, result.height) < tier) {
            // The prepared preview is smaller than this tier: only the original can supply the pixels.
            acquired.release();
            next();
          } else {
            commit(result.url, acquired);
          }
        },
        (error: unknown) => {
          acquired.release();
          if (cancelled || (error instanceof Error && error.name === 'AbortError')) return;
          if (next) {
            next();
            return;
          }
          console.warn('[useCanvasImageThumbnail] thumbnail unavailable; using the untouched source', { error });
          // Without thumbnails, keep the legacy choice: the prepared preview while it is sharp enough.
          showOriginal(hasPreview && tier <= DEFAULT_PREVIEW_MAX_DIMENSION ? preview : source);
        },
      );
    };
    const start = () => {
      if (tier === ORIGINAL_TIER) {
        showOriginal();
        return;
      }
      // A prepared preview (≈512px) that already covers the tier avoids decoding the full original.
      if (hasPreview) acquireFrom(preview, () => acquireFrom(source, null));
      else acquireFrom(source, null);
    };
    // First paint for a source starts at once; tier changes wait for the zoom to settle so a
    // continuous gesture does not decode every intermediate tier.
    if (sameSource) timer = window.setTimeout(start, CANVAS_ZOOM_SETTLE_MS);
    else start();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (handle && displayedRef.current?.handle !== handle) handle.release();
    };
  }, [cache, preview, source, tier]);

  const previewDisplay = useMemo(() => (preview && preview !== source ? syncDisplayUrl(preview) : ''), [preview, source]);
  const originalDisplay = useMemo(() => syncDisplayUrl(original), [original]);
  const resolved = displayed && displayed.source === source ? displayed.url : null;
  const src = resolved ?? (source.startsWith('blob:') ? source : previewDisplay);
  const pending = resolved === null && !src && source.length > 0;
  // While pending, no fallback: falling through to the original would mount a full-resolution decode.
  const fallbackSrcs = useMemo(
    () => (pending ? [] : [...new Set([previewDisplay, originalDisplay].filter(Boolean))]),
    [originalDisplay, pending, previewDisplay],
  );
  const viewerSrc = original.startsWith('asset-media:') ? original : originalDisplay;
  return { src, fallbackSrcs, viewerSrc, pending };
}
