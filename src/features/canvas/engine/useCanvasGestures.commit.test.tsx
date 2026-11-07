// @vitest-environment jsdom
import { createElement, useRef } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Viewport } from './viewportMath';
import { useCanvasGestures } from './useCanvasGestures';

const state = vi.hoisted(() => ({ viewport: { x: 0, y: 0, zoom: 1 }, start: () => {}, end: (_viewport: Viewport) => {}, commit: vi.fn(), begins: vi.fn() }));
const flow = vi.hoisted(() => ({
  getViewport: () => state.viewport,
  setViewport: vi.fn(async (viewport: Viewport) => { state.start(); state.viewport = viewport; setTimeout(() => state.end(viewport), 0); return true; }),
  screenToFlowPosition: (point: { x: number; y: number }) => point,
}));
const flowStore = { getState: () => ({ minZoom: 0.1, maxZoom: 8 }) };
vi.mock('@xyflow/react', () => ({ useReactFlow: () => flow, useStoreApi: () => flowStore }));

class Pointer extends MouseEvent {
  pointerId = 1;
  constructor(type: string, x = 0, y = 0) { super(type, { bubbles: true, button: 2, clientX: x, clientY: y }); }
}
function Surface() {
  const wrapper = useRef<HTMLDivElement>(null);
  const handlers = useCanvasGestures(wrapper, { onViewportCommit: state.commit, onViewportStart: state.begins });
  state.start = handlers.onMoveStart; state.end = handlers.onMoveEnd;
  return createElement('div', { ref: wrapper, 'data-testid': 'surface' }, createElement('div', { className: 'react-flow__pane', 'data-testid': 'pane' }));
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(16), 16));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
  state.viewport = { x: 0, y: 0, zoom: 1 };
  state.commit.mockClear(); state.begins.mockClear(); flow.setViewport.mockClear();
});
afterEach(() => { cleanup(); vi.runAllTimers(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('custom gesture end integration', () => {
  it.each(['pointerup', 'pointercancel', 'blur'] as const)('commits the pending final transform on %s without per-frame commits', (ending) => {
    render(createElement(Surface));
    fireEvent(screen.getByTestId('pane'), new Pointer('pointerdown'));
    for (let index = 1; index <= 5; index += 1) {
      fireEvent(window, new Pointer('pointermove', index * 20, index * 10));
      act(() => vi.advanceTimersByTime(17));
    }
    expect(flow.setViewport).toHaveBeenCalledTimes(5);
    expect(state.commit).not.toHaveBeenCalled();
    fireEvent(window, new Pointer('pointermove', 121, 66));
    fireEvent(window, ending === 'blur' ? new Event('blur') : new Pointer(ending, 121, 66));
    expect(screen.getByTestId('surface').hasAttribute('data-viewport-transform')).toBe(false);
    expect(state.viewport).toEqual({ x: 121, y: 66, zoom: 1 });
    expect(state.commit).toHaveBeenCalledExactlyOnceWith(state.viewport);
    act(() => vi.runAllTimers());
    expect(state.commit).toHaveBeenCalledOnce();
  });

  it('retains the camera marker through wheel frames and removes it only after the gesture settles', () => {
    render(createElement(Surface));
    const wrapper = screen.getByTestId('surface');
    fireEvent.wheel(screen.getByTestId('pane'), { deltaX: 15, deltaY: 0 });
    expect(wrapper.hasAttribute('data-viewport-transform')).toBe(true);
    act(() => vi.advanceTimersByTime(17));
    expect(wrapper.hasAttribute('data-viewport-transform')).toBe(true);
    expect(state.commit).not.toHaveBeenCalled();
    fireEvent.wheel(screen.getByTestId('pane'), { deltaX: 15, deltaY: 0 });
    act(() => vi.advanceTimersByTime(119));
    expect(wrapper.hasAttribute('data-viewport-transform')).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(wrapper.hasAttribute('data-viewport-transform')).toBe(false);
    expect(state.commit).toHaveBeenCalledOnce();
  });

  it.each(['blur', 'pagehide', 'unmount'] as const)('cleans up a wheel camera marker on %s', (ending) => {
    const mounted = render(createElement(Surface));
    const wrapper = screen.getByTestId('surface');
    fireEvent.wheel(screen.getByTestId('pane'), { deltaX: 15, deltaY: 0 });
    expect(wrapper.hasAttribute('data-viewport-transform')).toBe(true);
    if (ending === 'unmount') mounted.unmount();
    else fireEvent(window, new Event(ending));
    expect(wrapper.hasAttribute('data-viewport-transform')).toBe(false);
    act(() => vi.runAllTimers());
    expect(state.commit).toHaveBeenCalledOnce();
  });

  it('marks native Flow pan and clears it on completion or focus cancellation', () => {
    render(createElement(Surface));
    const wrapper = screen.getByTestId('surface');
    act(() => state.start());
    expect(wrapper.hasAttribute('data-viewport-transform')).toBe(true);
    act(() => { state.viewport = { x: 10, y: 20, zoom: 1 }; state.end(state.viewport); });
    expect(wrapper.hasAttribute('data-viewport-transform')).toBe(false);
    act(() => state.start());
    expect(wrapper.hasAttribute('data-viewport-transform')).toBe(true);
    fireEvent(window, new Event('blur'));
    expect(wrapper.hasAttribute('data-viewport-transform')).toBe(false);
  });

  it('flushes an idle-pending wheel before an outside control and removes ownership on unmount', () => {
    const mounted = render(createElement(Surface));
    fireEvent.wheel(screen.getByTestId('pane'), { deltaX: 12, deltaY: 0 });
    expect(state.commit).not.toHaveBeenCalled();
    fireEvent(document.body, new Pointer('pointerdown'));
    expect(state.commit).toHaveBeenCalledOnce();
    const final = { ...state.viewport };
    mounted.unmount();
    act(() => vi.runAllTimers());
    expect(state.viewport).toEqual(final);
    expect(state.commit).toHaveBeenCalledOnce();
  });
});
