import { describe, expect, it, vi } from 'vitest';

import {
  CANVAS_ZOOM_SETTLE_MS,
  IDLE_CANVAS_ZOOM_RENDERING,
  createCanvasZoomRendering,
  type CanvasZoomRendering,
} from './canvasZoomRendering';

function createHarness(wholeGraphMounted = true, initialZoom = 0.15) {
  let nextHandle = 1;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const frames = new Map<number, () => void>();
  const states: CanvasZoomRendering[] = [];
  const canKeepAllNodesRendered = vi.fn(() => wholeGraphMounted);
  const isViewportGestureActive = vi.fn(() => false);
  const lifecycle = createCanvasZoomRendering({
    initialZoom,
    canKeepAllNodesRendered,
    isViewportGestureActive,
    publish: (state) => states.push(state),
    scheduler: {
      setTimeout(callback, delay) {
        const handle = nextHandle++;
        timers.set(handle, { callback, delay });
        return handle;
      },
      clearTimeout: (handle) => { timers.delete(handle); },
      requestAnimationFrame(callback) {
        const handle = nextHandle++;
        frames.set(handle, callback);
        return handle;
      },
      cancelAnimationFrame: (handle) => { frames.delete(handle); },
    },
  });
  return {
    ...lifecycle,
    states,
    timers,
    frames,
    canKeepAllNodesRendered,
    isViewportGestureActive,
    settle() {
      for (const [handle, timer] of [...timers]) {
        timers.delete(handle);
        expect(timer.delay).toBe(CANVAS_ZOOM_SETTLE_MS);
        timer.callback();
      }
    },
    frame() {
      for (const [handle, callback] of [...frames]) {
        frames.delete(handle);
        callback();
      }
    },
  };
}

describe('canvas zoom rendering lifecycle', () => {
  it('leaves unchanged zoom notifications idle', () => {
    const harness = createHarness();
    harness.observe(0.15);
    harness.observe(0.15);
    expect(harness.states).toEqual([]);
    expect(harness.timers.size).toBe(0);
    expect(harness.canKeepAllNodesRendered).not.toHaveBeenCalled();
  });

  it('retains an already-mounted far graph without publishing per-frame updates', () => {
    const harness = createHarness();
    for (const zoom of [0.2, 0.35, 0.6, 0.8, 0.3, 0.15]) harness.observe(zoom);
    expect(harness.states).toEqual([{ keepAllNodesRendered: true, simplifyNodes: true, thumbnailZoom: 0.15 }]);
    expect(harness.canKeepAllNodesRendered).toHaveBeenCalledTimes(1);
    expect(harness.timers.size).toBe(1);
  });

  it('holds a fully mounted far graph while panning and postpones culling until the last movement settles', () => {
    const harness = createHarness();
    harness.observePan();
    const canceledTimer = [...harness.timers.values()][0].callback;
    harness.observePan();
    harness.observePan();
    expect(harness.states).toEqual([{ keepAllNodesRendered: true, simplifyNodes: true, thumbnailZoom: 0.15 }]);
    expect(harness.canKeepAllNodesRendered).toHaveBeenCalledOnce();
    expect(harness.timers.size).toBe(1);
    canceledTimer();
    expect(harness.states).toHaveLength(1);
    harness.settle();
    expect(harness.states.at(-1)).toEqual({ keepAllNodesRendered: false, simplifyNodes: true, thumbnailZoom: 0.15 });
    harness.frame();
    expect(harness.states.at(-1)?.simplifyNodes).toBe(true);
    harness.frame();
    expect(harness.states.at(-1)).toEqual(IDLE_CANVAS_ZOOM_RENDERING);
    expect(harness.states).toHaveLength(3);
  });

  it('does not release a retained graph during long frames while a pointer pan is still owned', () => {
    const harness = createHarness();
    harness.isViewportGestureActive.mockReturnValue(true);
    harness.observePan();
    const oldTimer = [...harness.timers.values()][0].callback;
    for (let i = 0; i < 4; i += 1) harness.settle();
    oldTimer();
    expect(harness.states).toEqual([{ keepAllNodesRendered: true, simplifyNodes: true, thumbnailZoom: 0.15 }]);
    expect(harness.canKeepAllNodesRendered).toHaveBeenCalledOnce();
    expect(harness.timers.size).toBe(1);
    expect(harness.frames.size).toBe(0);
    harness.isViewportGestureActive.mockReturnValue(false);
    harness.settle();
    expect(harness.states.at(-1)).toEqual({ keepAllNodesRendered: false, simplifyNodes: true, thumbnailZoom: 0.15 });
    harness.frame(); harness.frame();
    expect(harness.states.at(-1)).toEqual(IDLE_CANVAS_ZOOM_RENDERING);
  });

  it('cancels the active-pointer recheck when the canvas leaves', () => {
    const harness = createHarness();
    harness.isViewportGestureActive.mockReturnValue(true);
    harness.observePan(); harness.settle();
    const lateTimer = [...harness.timers.values()][0].callback;
    harness.dispose();
    lateTimer();
    expect(harness.timers.size).toBe(0);
    expect(harness.frames.size).toBe(0);
    expect(harness.states.at(-1)).toEqual(IDLE_CANVAS_ZOOM_RENDERING);
  });

  it.each([
    { wholeGraphMounted: false, zoom: 0.15, checks: 1 },
    { wholeGraphMounted: true, zoom: 0.4, checks: 0 },
    { wholeGraphMounted: true, zoom: 0.8, checks: 0 },
  ])('keeps normal culling when panning at $zoom with wholeGraphMounted=$wholeGraphMounted', ({ wholeGraphMounted, zoom, checks }) => {
    const harness = createHarness(wholeGraphMounted, zoom);
    for (let i = 0; i < 20; i += 1) harness.observePan();
    expect(harness.canKeepAllNodesRendered).toHaveBeenCalledTimes(checks);
    expect(harness.states).toEqual([]);
    harness.settle();
    expect(harness.states).toEqual([]);
    expect(harness.frames.size).toBe(0);
  });

  it('shares one retained graph and idle timer across pan, zoom and pan again', () => {
    const harness = createHarness();
    harness.observePan();
    harness.observe(0.8);
    const canceledTimer = [...harness.timers.values()][0].callback;
    harness.observePan();
    canceledTimer();
    expect(harness.states).toEqual([{ keepAllNodesRendered: true, simplifyNodes: true, thumbnailZoom: 0.15 }]);
    expect(harness.canKeepAllNodesRendered).toHaveBeenCalledOnce();
    harness.settle(); harness.frame(); harness.frame();
    expect(harness.states.at(-1)).toEqual(IDLE_CANVAS_ZOOM_RENDERING);
  });

  it('does not disable culling when a close-up pan later zooms into the far graph', () => {
    const harness = createHarness(true, 0.8);
    harness.observePan();
    harness.observe(0.2);
    harness.observePan();
    expect(harness.canKeepAllNodesRendered).not.toHaveBeenCalled();
    expect(harness.states).toEqual([{ keepAllNodesRendered: false, simplifyNodes: true }]);
  });

  it('resumes panning during detail release without allowing the old frame to reset the new gesture', () => {
    const harness = createHarness();
    harness.observePan(); harness.settle(); harness.frame();
    const canceledRelease = [...harness.frames.values()][0];
    harness.observePan();
    canceledRelease();
    expect(harness.states.at(-1)).toEqual({ keepAllNodesRendered: true, simplifyNodes: true, thumbnailZoom: 0.15 });
    expect(harness.frames.size).toBe(0);
    harness.settle(); harness.frame(); harness.frame();
    expect(harness.states.at(-1)).toEqual(IDLE_CANVAS_ZOOM_RENDERING);
  });

  it('cleans up retained pan state and ignores already-delivered timers or frames after leaving', () => {
    const harness = createHarness();
    harness.observePan();
    const timer = [...harness.timers.values()][0].callback;
    harness.settle();
    const frame = [...harness.frames.values()][0];
    harness.dispose();
    const states = harness.states.length;
    timer(); frame(); harness.observePan(); harness.observe(0.8);
    expect(harness.states).toHaveLength(states);
    expect(harness.states.at(-1)).toEqual(IDLE_CANVAS_ZOOM_RENDERING);
    expect(harness.timers.size).toBe(0);
    expect(harness.frames.size).toBe(0);
  });

  it('restores visibility culling before upgrading node detail at rest', () => {
    const harness = createHarness();
    harness.observe(0.8);
    harness.settle();
    expect(harness.states.at(-1)).toEqual({ keepAllNodesRendered: false, simplifyNodes: true, thumbnailZoom: 0.15 });
    harness.frame();
    expect(harness.states.at(-1)?.simplifyNodes).toBe(true);
    harness.frame();
    expect(harness.states.at(-1)).toEqual(IDLE_CANVAS_ZOOM_RENDERING);
    expect(harness.frames.size).toBe(0);
  });

  it('never eagerly mounts the whole graph when a close-up had culled nodes', () => {
    const harness = createHarness(false);
    harness.observe(0.4);
    harness.observe(0.8);
    harness.observe(0.2);
    expect(harness.states.every((state) => !state.keepAllNodesRendered)).toBe(true);
    expect(harness.states.at(-1)?.simplifyNodes).toBe(true);
  });

  it('keeps close-up editors and media mounted when a gesture never enters far zoom', () => {
    const harness = createHarness(false, 0.8);
    harness.observe(0.75);
    harness.observe(0.65);
    harness.settle();
    expect(harness.states.every((state) => !state.simplifyNodes)).toBe(true);
    expect(harness.canKeepAllNodesRendered).not.toHaveBeenCalled();
    expect(harness.frames.size).toBe(0);
  });

  it('holds low detail only after a close-up gesture actually crosses the far threshold', () => {
    const harness = createHarness(false, 0.8);
    harness.observe(0.6);
    expect(harness.states).toEqual([]);
    harness.observe(0.3);
    harness.observe(0.8);
    expect(harness.states.at(-1)).toEqual({ keepAllNodesRendered: false, simplifyNodes: true });
    harness.settle();
    harness.frame();
    harness.frame();
    expect(harness.states.at(-1)).toEqual(IDLE_CANVAS_ZOOM_RENDERING);
  });

  it('cancels a pending detail upgrade without disabling culling again when another zoom starts close-up', () => {
    const harness = createHarness();
    harness.observe(0.4);
    harness.settle();
    harness.frame();
    harness.observe(0.6);
    harness.frame();
    expect(harness.states.at(-1)).toEqual({ keepAllNodesRendered: false, simplifyNodes: true });
    expect(harness.timers.size).toBe(1);
    harness.settle();
    harness.frame();
    harness.frame();
    expect(harness.states.at(-1)).toEqual(IDLE_CANVAS_ZOOM_RENDERING);
  });

  it('drops the held pixel zoom when a new gesture starts after culling to a subset', () => {
    const harness = createHarness();
    harness.observe(0.8);
    harness.settle();
    harness.canKeepAllNodesRendered.mockReturnValue(false);
    harness.observe(1.2);
    expect(harness.states.at(-1)).toEqual({ keepAllNodesRendered: false, simplifyNodes: true });
    harness.frame();
    expect(harness.frames.size).toBe(0);
    expect(harness.timers.size).toBe(1);
  });

  it('clears timers and frame callbacks when leaving the project', () => {
    const harness = createHarness();
    harness.observe(0.4);
    harness.settle();
    harness.frame();
    harness.dispose();
    harness.observe(0.8);
    harness.frame();
    harness.settle();
    expect(harness.timers.size).toBe(0);
    expect(harness.frames.size).toBe(0);
    expect(harness.states.at(-1)).toEqual(IDLE_CANVAS_ZOOM_RENDERING);
  });
});
