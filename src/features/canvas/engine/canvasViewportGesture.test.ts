import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CANVAS_WHEEL_IDLE_MS, createCanvasViewportGesture, type CanvasViewportGesture } from './canvasViewportGesture';
import type { Viewport } from './viewportMath';
import { flushPendingCanvasViewport, isCanvasViewportInteractionActive, isCustomCanvasViewportGestureActive, registerCanvasViewportFlush } from '../application/canvasViewportCommit';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function fixture() {
  let viewport: Viewport = { x: 0, y: 0, zoom: 1 };
  const commits: Viewport[] = [];
  const onStart = vi.fn();
  const apply = vi.fn((next: Viewport) => {
    viewport = { ...next };
    // Match D3's synchronous start and zero-delay move-end emitted by programmatic transforms.
    gesture.onMoveStart();
    setTimeout(() => gesture.onMoveEnd(next), 0);
  });
  const gesture: CanvasViewportGesture = createCanvasViewportGesture({
    readViewport: () => viewport,
    applyViewport: apply,
    onStart,
    onCommit: (value) => commits.push(value),
    requestFrame: (callback) => Number(setTimeout(callback, 16)),
    cancelFrame: (handle) => clearTimeout(handle),
    setTimer: (callback, delay) => Number(setTimeout(callback, delay)),
    clearTimer: (handle) => clearTimeout(handle),
  });
  return { gesture, apply, commits, onStart, viewport: () => viewport, externalMove: (value: Viewport) => { viewport = value; gesture.onMoveStart(); gesture.onMoveEnd(value); } };
}

describe('custom viewport gesture commits', () => {
  it('keeps every visible frame live without canonical commits, then commits the queued last frame once', () => {
    const view = fixture();
    for (let index = 1; index <= 20; index += 1) {
      view.gesture.schedule({ x: index * 10, y: index, zoom: 1 });
      vi.advanceTimersByTime(17);
    }
    expect(view.apply).toHaveBeenCalledTimes(20);
    expect(view.commits).toEqual([]);
    expect(view.onStart).toHaveBeenCalledOnce();
    view.gesture.schedule({ x: 209, y: 30, zoom: 1 });
    view.gesture.finish();
    expect(view.viewport()).toEqual({ x: 209, y: 30, zoom: 1 });
    expect(view.commits).toEqual([{ x: 209, y: 30, zoom: 1 }]);
    vi.runAllTimers();
    expect(view.commits).toHaveLength(1);
    expect(view.gesture.isActive()).toBe(false);
  });

  it('accumulates multiple inputs before a frame and settles wheel pan/zoom after the last input', () => {
    const view = fixture();
    view.gesture.schedule({ x: 12, y: 20, zoom: 1 }, true);
    expect(view.gesture.currentViewport()).toEqual({ x: 12, y: 20, zoom: 1 });
    view.gesture.schedule({ x: 24, y: 40, zoom: 1.2 }, true);
    vi.advanceTimersByTime(100);
    expect(view.apply).toHaveBeenCalledOnce();
    expect(view.commits).toEqual([]);
    view.gesture.schedule({ x: 28, y: 44, zoom: 1.3 }, true);
    vi.advanceTimersByTime(CANVAS_WHEEL_IDLE_MS - 1);
    expect(view.commits).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(view.commits).toEqual([{ x: 28, y: 44, zoom: 1.3 }]);
  });

  it('preserves native and other programmatic move ends and rejects stale transform callbacks', () => {
    const view = fixture();
    view.externalMove({ x: 50, y: 30, zoom: 2 });
    expect(view.commits).toEqual([{ x: 50, y: 30, zoom: 2 }]);
    view.gesture.onMoveEnd({ x: 0, y: 0, zoom: 1 });
    expect(view.commits).toHaveLength(1);
  });

  it('commits the actual Flow transform and does not assume the requested viewport was accepted verbatim', () => {
    const actual = { x: 5, y: 6, zoom: 8 };
    const onCommit = vi.fn();
    const view = createCanvasViewportGesture({ readViewport: () => actual, applyViewport: vi.fn(), onStart: vi.fn(), onCommit,
      requestFrame: (callback) => Number(setTimeout(callback, 16)), cancelFrame: clearTimeout,
      setTimer: (callback, delay) => Number(setTimeout(callback, delay)), clearTimer: clearTimeout });
    view.schedule({ x: 5, y: 6, zoom: 30 });
    view.finish();
    expect(onCommit).toHaveBeenCalledWith(actual);
    view.onMoveEnd(actual);
    expect(onCommit).toHaveBeenCalledOnce();
  });

  it('flushes before an explicit snapshot and removes old ownership after unmount/replacement', () => {
    const first = fixture();
    const unregister = registerCanvasViewportFlush(first.gesture.finish, first.gesture.isActive);
    expect(isCustomCanvasViewportGestureActive()).toBe(false);
    first.gesture.schedule({ x: 21, y: 43, zoom: 1.5 }, true);
    expect(isCustomCanvasViewportGestureActive()).toBe(true);
    flushPendingCanvasViewport();
    expect(isCustomCanvasViewportGestureActive()).toBe(false);
    expect(first.commits).toEqual([{ x: 21, y: 43, zoom: 1.5 }]);
    const second = fixture();
    const unregisterSecond = registerCanvasViewportFlush(second.gesture.finish, second.gesture.isActive);
    unregister(); first.gesture.dispose();
    second.gesture.schedule({ x: 80, y: 90, zoom: 2 }, true);
    expect(isCustomCanvasViewportGestureActive()).toBe(true);
    flushPendingCanvasViewport();
    expect(second.commits).toEqual([{ x: 80, y: 90, zoom: 2 }]);
    unregisterSecond(); second.gesture.dispose();
    expect(isCustomCanvasViewportGestureActive()).toBe(false);
    flushPendingCanvasViewport();
    vi.runAllTimers();
    expect(first.commits).toHaveLength(1);
    expect(second.commits).toHaveLength(1);
  });
});

it('defers cold media during native grab/Space pan and releases the owner without blocking the next canvas', () => {
  let grabbing = false;
  const unregister = registerCanvasViewportFlush(() => {}, () => false, () => grabbing);
  expect(isCanvasViewportInteractionActive()).toBe(false);
  grabbing = true;
  expect(isCanvasViewportInteractionActive()).toBe(true);
  expect(isCustomCanvasViewportGestureActive()).toBe(false);
  grabbing = false;
  expect(isCanvasViewportInteractionActive()).toBe(false);
  grabbing = true;
  unregister();
  expect(isCanvasViewportInteractionActive()).toBe(false);
});
