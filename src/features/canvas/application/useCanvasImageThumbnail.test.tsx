// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { ReactFlowProvider, useStoreApi, type ReactFlowState } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreApi } from 'zustand';

import { CANVAS_ZOOM_SETTLE_MS } from '@/features/canvas/engine/canvasZoomRendering';
import { useCanvasUiStore } from '@/features/canvas/state/canvasUiStore';
import type { CanvasImageThumbnailCache, CanvasImageThumbnailResult } from './canvasImageThumbnails';
import {
  useCanvasImageThumbnail,
  type CanvasImageThumbnailInput,
  type CanvasImageThumbnailView,
} from './useCanvasImageThumbnail';

interface Request {
  source: string;
  tier: number;
  released: number;
  resolve(result: CanvasImageThumbnailResult): void;
  reject(error: unknown): void;
}

let flowStore: Pick<StoreApi<ReactFlowState>, 'getState' | 'setState'> | undefined;
let view: CanvasImageThumbnailView | undefined;
let renders = 0;
let requests: Request[] = [];
let cache: CanvasImageThumbnailCache;

function Probe(input: CanvasImageThumbnailInput) {
  flowStore = useStoreApi();
  view = useCanvasImageThumbnail(input, cache);
  renders += 1;
  return null;
}

function mount(input: CanvasImageThumbnailInput) {
  const result = render(<ReactFlowProvider><Probe {...input} /></ReactFlowProvider>);
  return {
    rerender: (next: CanvasImageThumbnailInput) => result.rerender(<ReactFlowProvider><Probe {...next} /></ReactFlowProvider>),
    unmount: result.unmount,
  };
}

function zoom(value: number) {
  act(() => flowStore?.setState({ transform: [0, 0, value] }));
}

async function settle(request: Request, result: Partial<CanvasImageThumbnailResult> & { url: string }) {
  await act(async () => request.resolve({ kind: 'thumbnail', width: 4096, height: 2304, ...result }));
}

const ORIGINAL = 'asset-media:image%2Fpng:' + 'c'.repeat(64);
const NODE = { imageUrl: ORIGINAL, width: 400, height: 300 };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
  useCanvasUiStore.getState().reset();
  flowStore = undefined;
  view = undefined;
  renders = 0;
  requests = [];
  cache = {
    acquire(source, tier) {
      const { promise, resolve, reject } = Promise.withResolvers<CanvasImageThumbnailResult>();
      const request: Request = { source, tier, released: 0, resolve, reject };
      requests.push(request);
      return { promise, release: () => { request.released += 1; } };
    },
    resolveIdentity: async () => null,
    resolveOriginalDisplayUrl: vi.fn(async (source: string) => `blob:original:${source}`),
    stats: () => ({ live: 0, idle: 0, heavyActive: 0, heavyQueued: 0, generated: 0, durableHits: 0, failures: 0 }),
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useCanvasImageThumbnail', () => {
  it('requests the tier covering box × zoom × DPR and shows a neutral pending state, not the original', async () => {
    mount(NODE);
    expect(requests.map(({ source, tier }) => ({ source, tier }))).toEqual([{ source: ORIGINAL, tier: 1024 }]);
    expect(view).toMatchObject({ src: '', pending: true, fallbackSrcs: [], viewerSrc: ORIGINAL });
    await settle(requests[0], { url: 'blob:thumb-1024' });
    expect(view).toMatchObject({ src: 'blob:thumb-1024', pending: false });
  });

  it('does not rerender for viewport changes inside a tier', async () => {
    mount(NODE);
    await settle(requests[0], { url: 'blob:thumb-1024' });
    const settled = renders;
    zoom(1.1);
    zoom(0.9);
    act(() => flowStore?.setState({ transform: [120, -40, 0.9] }));
    expect(renders).toBe(settled);
    expect(requests).toHaveLength(1);
  });

  it('holds image pixels through retained zoom and culling, then restores exact device-pixel sizing', async () => {
    mount(NODE);
    await settle(requests[0], { url: 'blob:thumb-1024' });
    zoom(0.15);
    act(() => vi.advanceTimersByTime(CANVAS_ZOOM_SETTLE_MS));
    await settle(requests[1], { url: 'blob:thumb-256' });
    act(() => useCanvasUiStore.getState().setZoomRendering({ keepAllNodesRendered: true, simplifyNodes: true, thumbnailZoom: 0.15 }));
    const before = renders;
    zoom(8);
    act(() => vi.advanceTimersByTime(1000));
    expect(renders).toBe(before);
    expect(requests).toHaveLength(2);
    expect(cache.resolveOriginalDisplayUrl).not.toHaveBeenCalled();
    act(() => useCanvasUiStore.getState().setZoomRendering({ keepAllNodesRendered: false, simplifyNodes: true, thumbnailZoom: 0.15 }));
    act(() => vi.advanceTimersByTime(1000));
    expect(view?.src).toBe('blob:thumb-256');
    await act(async () => {
      useCanvasUiStore.getState().setZoomRendering({ keepAllNodesRendered: false, simplifyNodes: false });
      vi.advanceTimersByTime(CANVAS_ZOOM_SETTLE_MS);
    });
    await act(async () => vi.advanceTimersByTime(CANVAS_ZOOM_SETTLE_MS));
    expect(cache.resolveOriginalDisplayUrl).toHaveBeenCalledExactlyOnceWith(ORIGINAL);
    expect(view?.src).toBe(`blob:original:${ORIGINAL}`);
  });

  it('uses the held far pixel size for image bodies mounted in the middle of retained zoom', async () => {
    act(() => useCanvasUiStore.getState().setZoomRendering({ keepAllNodesRendered: true, simplifyNodes: true, thumbnailZoom: 0.15 }));
    mount(NODE);
    expect(requests[0].tier).toBe(256);
    await settle(requests[0], { url: 'blob:thumb-256' });
    zoom(8);
    act(() => vi.advanceTimersByTime(1000));
    expect(requests).toHaveLength(1);
    expect(cache.resolveOriginalDisplayUrl).not.toHaveBeenCalled();
    expect(view?.src).toBe('blob:thumb-256');
  });

  it('thaws when only the held pixel zoom clears, even while detail is still simplified', async () => {
    act(() => useCanvasUiStore.getState().setZoomRendering({ keepAllNodesRendered: false, simplifyNodes: true, thumbnailZoom: 0.15 }));
    mount(NODE);
    await settle(requests[0], { url: 'blob:thumb-256' });
    act(() => useCanvasUiStore.getState().setZoomRendering({ keepAllNodesRendered: false, simplifyNodes: true }));
    await act(async () => vi.advanceTimersByTime(CANVAS_ZOOM_SETTLE_MS));
    expect(requests[1].tier).toBe(1024);
    expect(view?.src).toBe('blob:thumb-256');
    await settle(requests[1], { url: 'blob:thumb-1024' });
    expect(view?.src).toBe('blob:thumb-1024');
  });

  it('upgrades for a display DPR change without requiring a viewport movement', async () => {
    mount(NODE);
    await settle(requests[0], { url: 'blob:thumb-1024' });
    const before = renders;
    act(() => window.dispatchEvent(new Event('resize')));
    expect(renders).toBe(before);
    act(() => {
      Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 4 });
      window.dispatchEvent(new Event('resize'));
    });
    act(() => vi.advanceTimersByTime(CANVAS_ZOOM_SETTLE_MS));
    expect(requests[1].tier).toBe(2048);
    expect(view?.src).toBe('blob:thumb-1024');
    await settle(requests[1], { url: 'blob:thumb-2048' });
    expect(view?.src).toBe('blob:thumb-2048');
  });

  it('keeps the current thumbnail until the next tier is ready after zoom settles, then releases it', async () => {
    mount(NODE);
    await settle(requests[0], { url: 'blob:thumb-1024' });
    zoom(2);
    expect(requests).toHaveLength(1);
    await act(async () => vi.advanceTimersByTime(CANVAS_ZOOM_SETTLE_MS));
    expect(requests[1]).toMatchObject({ source: ORIGINAL, tier: 2048 });
    expect(view?.src).toBe('blob:thumb-1024');
    await settle(requests[1], { url: 'blob:thumb-2048' });
    expect(view?.src).toBe('blob:thumb-2048');
    expect(requests[0].released).toBe(1);
    expect(requests[1].released).toBe(0);
  });

  it('falls back to the hydrated original when every tier would undersample', async () => {
    mount({ ...NODE, width: 1600, height: 900 });
    expect(requests).toHaveLength(0);
    await act(async () => {});
    expect(cache.resolveOriginalDisplayUrl).toHaveBeenCalledWith(ORIGINAL);
    expect(view?.src).toBe(`blob:original:${ORIGINAL}`);
  });

  it('never shows a stale source and releases late results for replaced sources', async () => {
    const view1 = mount(NODE);
    const next = 'asset-media:image%2Fpng:' + 'd'.repeat(64);
    view1.rerender({ ...NODE, imageUrl: next });
    expect(requests[0].released).toBe(1);
    expect(requests[1].source).toBe(next);
    await settle(requests[0], { url: 'blob:stale' });
    expect(view?.src).toBe('');
    expect(view?.pending).toBe(true);
    await settle(requests[1], { url: 'blob:fresh' });
    expect(view?.src).toBe('blob:fresh');
  });

  it('drops a displayed thumbnail immediately when the source changes', async () => {
    const view1 = mount(NODE);
    await settle(requests[0], { url: 'blob:thumb-a' });
    view1.rerender({ ...NODE, imageUrl: '/app/images/next.png' });
    expect(requests[0].released).toBe(1);
    expect(view?.src).toBe('');
  });

  it('uses the original after a thumbnail failure instead of reporting a fake success', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mount(NODE);
    await act(async () => requests[0].reject(new Error('decode failed')));
    expect(view?.src).toBe(`blob:original:${ORIGINAL}`);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('prefers a prepared preview that covers the tier and escalates to the original when it is too small', async () => {
    const preview = '/app/images/preview.png';
    mount({ ...NODE, previewImageUrl: preview });
    expect(requests[0]).toMatchObject({ source: preview, tier: 1024 });
    await settle(requests[0], { url: '/preview-display', kind: 'original', width: 512, height: 288 });
    expect(requests[0].released).toBe(1);
    expect(requests[1]).toMatchObject({ source: ORIGINAL, tier: 1024 });
    await settle(requests[1], { url: 'blob:thumb-1024' });
    expect(view?.src).toBe('blob:thumb-1024');
  });

  it('serves a far-zoom tier from the prepared preview without touching the original', async () => {
    const preview = '/app/images/preview.png';
    mount({ ...NODE, previewImageUrl: preview });
    zoom(0.3);
    await act(async () => {});
    const farRequest = requests.find((request) => request.tier === 256);
    expect(farRequest?.source).toBe(preview);
    await settle(farRequest!, { url: 'blob:preview-256', kind: 'thumbnail', width: 512, height: 288 });
    expect(view?.src).toBe('blob:preview-256');
    expect(requests.some((request) => request.source === ORIGINAL)).toBe(false);
  });

  it('releases its lease on unmount', async () => {
    const mounted = mount(NODE);
    await settle(requests[0], { url: 'blob:thumb-1024' });
    mounted.unmount();
    expect(requests[0].released).toBe(1);
  });
});
