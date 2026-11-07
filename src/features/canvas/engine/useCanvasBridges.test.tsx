// @vitest-environment jsdom
import { createElement, useRef } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { createStore } from 'zustand';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useCanvasBridges } from './useCanvasBridges';
import { useCanvasUiStore } from '../state/canvasUiStore';
import { registerCanvasViewportFlush } from '../application/canvasViewportCommit';

const flow = createStore(() => ({ transform: [0, 0, 1], nodeLookup: new Map([['node', {}]]), paneDragging: false }));
const reactFlow = { getNodes: () => [], fitView: async () => true };
vi.mock('@xyflow/react', () => ({ useStoreApi: () => flow, useReactFlow: () => reactFlow }));

function Surface() {
  const ref = useRef<HTMLDivElement>(null);
  useCanvasBridges(ref);
  return createElement('div', { ref, 'data-testid': 'surface' }, createElement('div', { className: 'react-flow__node' }));
}
beforeEach(() => {
  vi.useFakeTimers();
  flow.setState({ transform: [0, 0, 1], nodeLookup: new Map([['node', {}]]), paneDragging: false });
  useCanvasUiStore.getState().reset();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(16), 16));
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => window.clearTimeout(handle));
});
afterEach(() => { cleanup(); vi.clearAllTimers(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('updates readable chrome to the new near zoom during the same transform notification', () => {
  render(createElement(Surface));
  act(() => flow.setState({ transform: [0, 0, 1.5] }));
  expect(screen.getByTestId('surface').style.getPropertyValue('--canvas-ui-scale')).toBe('0.6667');
  act(() => flow.setState({ transform: [0, 0, 2] }));
  expect(screen.getByTestId('surface').style.getPropertyValue('--canvas-ui-scale')).toBe('0.6000');
});

it('retains already mounted far nodes when zooming in across the detail threshold', () => {
  render(createElement(Surface));
  act(() => flow.setState({ transform: [0, 0, 0.2] }));
  act(() => vi.advanceTimersByTime(160));
  act(() => flow.setState({ transform: [0, 0, 0.6] }));
  expect(useCanvasUiStore.getState().zoomRendering).toMatchObject({ keepAllNodesRendered: true, simplifyNodes: true, thumbnailZoom: 0.2 });
  act(() => vi.advanceTimersByTime(160));
  expect(screen.getByTestId('surface').style.getPropertyValue('--canvas-ui-scale')).toBe('1.6667');
});

it('keeps an already-mounted far graph through repeated XY movement and releases culling after idle', () => {
  flow.setState({ transform: [0, 0, 0.1] });
  render(createElement(Surface));
  const wrapper = screen.getByTestId('surface');
  const countMounted = vi.spyOn(wrapper, 'querySelectorAll');
  const writeScale = vi.spyOn(wrapper.style, 'setProperty');
  const states: unknown[] = [];
  const unsubscribe = useCanvasUiStore.subscribe((next, previous) => {
    if (next.zoomRendering !== previous.zoomRendering) states.push(next.zoomRendering);
  });
  act(() => flow.setState({ transform: [20, 50, 0.1] }));
  expect(useCanvasUiStore.getState().zoomRendering).toEqual({ keepAllNodesRendered: true, simplifyNodes: true, thumbnailZoom: 0.1 });
  act(() => vi.advanceTimersByTime(100));
  act(() => flow.setState({ transform: [300, 50, 0.1] }));
  act(() => flow.setState({ transform: [300, 150, 0.1] }));
  expect(states).toHaveLength(1);
  expect(countMounted).toHaveBeenCalledOnce();
  expect(writeScale).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(119));
  expect(useCanvasUiStore.getState().zoomRendering.keepAllNodesRendered).toBe(true);
  act(() => vi.advanceTimersByTime(1));
  expect(useCanvasUiStore.getState().zoomRendering).toEqual({ keepAllNodesRendered: false, simplifyNodes: true, thumbnailZoom: 0.1 });
  act(() => vi.advanceTimersByTime(31));
  expect(useCanvasUiStore.getState().zoomRendering.simplifyNodes).toBe(true);
  act(() => vi.advanceTimersByTime(1));
  expect(useCanvasUiStore.getState().zoomRendering).toEqual({ keepAllNodesRendered: false, simplifyNodes: false });
  expect(states).toHaveLength(3);
  unsubscribe(); countMounted.mockRestore(); writeScale.mockRestore();
});

it.each([
  { zoom: 0.1, canonical: 2, checks: 1 },
  { zoom: 0.6, canonical: 1, checks: 0 },
])('keeps culling for a partial graph or close-up pan at $zoom', ({ zoom, canonical, checks }) => {
  flow.setState({ transform: [0, 0, zoom], nodeLookup: new Map(Array.from({ length: canonical }, (_, index) => [`node-${index}`, {}])) });
  render(createElement(Surface));
  const countMounted = vi.spyOn(screen.getByTestId('surface'), 'querySelectorAll');
  act(() => {
    flow.setState({ transform: [10, 0, zoom] });
    flow.setState({ transform: [20, 0, zoom] });
    flow.setState({ transform: [20, 10, zoom] });
  });
  expect(useCanvasUiStore.getState().zoomRendering).toEqual({ keepAllNodesRendered: false, simplifyNodes: false });
  expect(countMounted).toHaveBeenCalledTimes(checks);
  act(() => vi.advanceTimersByTime(200));
  expect(useCanvasUiStore.getState().zoomRendering).toEqual({ keepAllNodesRendered: false, simplifyNodes: false });
  countMounted.mockRestore();
});

it('shares far-pan retention with mixed XY/zoom notifications and clears it on unmount', () => {
  flow.setState({ transform: [0, 0, 0.1] });
  const mounted = render(createElement(Surface));
  const wrapper = screen.getByTestId('surface');
  const countMounted = vi.spyOn(wrapper, 'querySelectorAll');
  act(() => flow.setState({ transform: [20, 50, 0.1] }));
  act(() => flow.setState({ transform: [40, 100, 0.6] }));
  act(() => flow.setState({ transform: [300, 100, 0.6] }));
  expect(countMounted).toHaveBeenCalledOnce();
  expect(useCanvasUiStore.getState().zoomRendering).toEqual({ keepAllNodesRendered: true, simplifyNodes: true, thumbnailZoom: 0.1 });
  mounted.unmount();
  act(() => { vi.runAllTimers(); flow.setState({ transform: [400, 120, 0.1] }); });
  expect(useCanvasUiStore.getState().zoomRendering).toEqual({ keepAllNodesRendered: false, simplifyNodes: false });
  expect(wrapper.hasAttribute('data-far-zoom')).toBe(false);
  countMounted.mockRestore();
});

it.each(['custom', 'native'] as const)('keeps retention during a long %s pointer pan, then restores culling after release', (kind) => {
  flow.setState({ transform: [0, 0, 0.1] });
  render(createElement(Surface));
  const wrapper = screen.getByTestId('surface');
  if (kind === 'custom') wrapper.dataset.panning = 'true';
  else flow.setState({ paneDragging: true });
  act(() => flow.setState({ transform: [10, 20, 0.1] }));
  act(() => vi.advanceTimersByTime(700));
  expect(useCanvasUiStore.getState().zoomRendering.keepAllNodesRendered).toBe(true);
  act(() => flow.setState({ transform: [30, 40, 0.1] }));
  act(() => vi.advanceTimersByTime(600));
  expect(useCanvasUiStore.getState().zoomRendering.keepAllNodesRendered).toBe(true);
  if (kind === 'custom') delete wrapper.dataset.panning;
  else flow.setState({ paneDragging: false });
  act(() => vi.advanceTimersByTime(120));
  expect(useCanvasUiStore.getState().zoomRendering).toEqual({ keepAllNodesRendered: false, simplifyNodes: true, thumbnailZoom: 0.1 });
  act(() => vi.advanceTimersByTime(32));
  expect(useCanvasUiStore.getState().zoomRendering).toEqual({ keepAllNodesRendered: false, simplifyNodes: false });
});

it('does not mistake a node-drag marker for active viewport panning', () => {
  flow.setState({ transform: [0, 0, 0.1] });
  render(createElement(Surface));
  const wrapper = screen.getByTestId('surface');
  wrapper.dataset.pointerTransform = '';
  act(() => flow.setState({ transform: [20, 40, 0.1] }));
  act(() => vi.advanceTimersByTime(152));
  expect(wrapper.hasAttribute('data-pointer-transform')).toBe(true);
  expect(useCanvasUiStore.getState().zoomRendering).toEqual({ keepAllNodesRendered: false, simplifyNodes: false });
});

it('holds a far graph while the wheel owner is active even when transform frames arrive after the idle delay', () => {
  flow.setState({ transform: [0, 0, 0.1] });
  let wheelActive = true;
  const unregister = registerCanvasViewportFlush(() => {}, () => wheelActive);
  try {
    render(createElement(Surface));
    const wrapper = screen.getByTestId('surface');
    act(() => flow.setState({ transform: [10, 20, 0.125] }));
    // The registered wheel owner is the source of truth; no pan/viewport DOM
    // marker is present, and the next rAF transform is delayed by a long frame.
    expect(wrapper.hasAttribute('data-panning')).toBe(false);
    expect(wrapper.hasAttribute('data-viewport-transform')).toBe(false);
    act(() => vi.advanceTimersByTime(720));
    expect(useCanvasUiStore.getState().zoomRendering).toEqual({ keepAllNodesRendered: true, simplifyNodes: true, thumbnailZoom: 0.1 });
    act(() => flow.setState({ transform: [20, 40, 0.6] }));
    act(() => vi.advanceTimersByTime(600));
    expect(wrapper.hasAttribute('data-far-zoom')).toBe(true);
    expect(useCanvasUiStore.getState().zoomRendering.keepAllNodesRendered).toBe(true);
    wheelActive = false;
    act(() => vi.advanceTimersByTime(120));
    expect(useCanvasUiStore.getState().zoomRendering).toEqual({ keepAllNodesRendered: false, simplifyNodes: true, thumbnailZoom: 0.1 });
    act(() => vi.advanceTimersByTime(32));
    expect(useCanvasUiStore.getState().zoomRendering).toEqual({ keepAllNodesRendered: false, simplifyNodes: false });
    expect(wrapper.hasAttribute('data-far-zoom')).toBe(false);
    act(() => vi.advanceTimersByTime(600));
    expect(vi.getTimerCount()).toBe(0);
  } finally { unregister(); }
});

it('releases after the wheel owner unregisters even if a viewport DOM marker remains', () => {
  flow.setState({ transform: [0, 0, 0.1] });
  const unregister = registerCanvasViewportFlush(() => {}, () => true);
  try {
    const mounted = render(createElement(Surface));
    const wrapper = screen.getByTestId('surface');
    wrapper.dataset.viewportTransform = '';
    act(() => flow.setState({ transform: [0, 0, 0.6] }));
    act(() => vi.advanceTimersByTime(360));
    expect(useCanvasUiStore.getState().zoomRendering.keepAllNodesRendered).toBe(true);
    unregister();
    act(() => vi.advanceTimersByTime(152));
    expect(wrapper.hasAttribute('data-viewport-transform')).toBe(true);
    expect(wrapper.hasAttribute('data-far-zoom')).toBe(false);
    expect(useCanvasUiStore.getState().zoomRendering).toEqual({ keepAllNodesRendered: false, simplifyNodes: false });
    mounted.unmount();
    act(() => vi.advanceTimersByTime(600));
    expect(vi.getTimerCount()).toBe(0);
  } finally { unregister(); }
});

it('keeps a restored far graph promoted across the detail threshold until culling and both release frames complete', () => {
  flow.setState({ transform: [0, 0, 0.1] });
  render(createElement(Surface));
  const wrapper = screen.getByTestId('surface');
  expect(wrapper.hasAttribute('data-far-zoom')).toBe(true);
  const toggle = vi.spyOn(wrapper, 'toggleAttribute');
  act(() => flow.setState({ transform: [500, 100, 0.1] }));
  act(() => flow.setState({ transform: [500, 100, 0.2] }));
  act(() => flow.setState({ transform: [500, 100, 0.399] }));
  expect(toggle).not.toHaveBeenCalled();
  act(() => flow.setState({ transform: [500, 100, 0.4] }));
  expect(wrapper.hasAttribute('data-far-zoom')).toBe(true);
  expect(toggle).not.toHaveBeenCalled();
  expect(useCanvasUiStore.getState().zoomRendering).toMatchObject({ keepAllNodesRendered: true, simplifyNodes: true, thumbnailZoom: 0.1 });
  act(() => flow.setState({ transform: [800, 250, 0.6] }));
  act(() => flow.setState({ transform: [900, 300, 0.6] }));
  expect(toggle).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(120));
  expect(useCanvasUiStore.getState().zoomRendering.keepAllNodesRendered).toBe(false);
  expect(wrapper.hasAttribute('data-far-zoom')).toBe(true);
  expect(toggle).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(31));
  expect(wrapper.hasAttribute('data-far-zoom')).toBe(true);
  act(() => vi.advanceTimersByTime(1));
  expect(useCanvasUiStore.getState().zoomRendering).toEqual({ keepAllNodesRendered: false, simplifyNodes: false });
  expect(wrapper.hasAttribute('data-far-zoom')).toBe(false);
  expect(toggle).toHaveBeenCalledExactlyOnceWith('data-far-zoom', false);
  act(() => flow.setState({ transform: [950, 400, 0.6] }));
  expect(toggle).toHaveBeenCalledOnce();
  toggle.mockRestore();
});

it('does not hold promotion for a partially mounted far graph that zooms close-up', () => {
  flow.setState({ transform: [0, 0, 0.1], nodeLookup: new Map([['one', {}], ['two', {}]]) });
  render(createElement(Surface));
  const wrapper = screen.getByTestId('surface');
  const toggle = vi.spyOn(wrapper, 'toggleAttribute');
  act(() => flow.setState({ transform: [0, 0, 0.6] }));
  expect(useCanvasUiStore.getState().zoomRendering).toEqual({ keepAllNodesRendered: false, simplifyNodes: true });
  expect(wrapper.hasAttribute('data-far-zoom')).toBe(false);
  expect(toggle).toHaveBeenCalledExactlyOnceWith('data-far-zoom', false);
  act(() => vi.advanceTimersByTime(152));
  expect(toggle).toHaveBeenCalledOnce();
  toggle.mockRestore();
});

it('does not promote an existing close-up subset during pan or a zoom that stays close-up', () => {
  flow.setState({ transform: [0, 0, 0.6] });
  render(createElement(Surface));
  const wrapper = screen.getByTestId('surface');
  const toggle = vi.spyOn(wrapper, 'toggleAttribute');
  act(() => flow.setState({ transform: [100, 100, 0.6] }));
  act(() => flow.setState({ transform: [200, 200, 1] }));
  act(() => vi.advanceTimersByTime(152));
  expect(wrapper.hasAttribute('data-far-zoom')).toBe(false);
  expect(toggle).not.toHaveBeenCalled();
  toggle.mockRestore();
});

it('releases far-zoom promotion on exit and does not apply late transforms to the old surface', () => {
  flow.setState({ transform: [0, 0, 0.1] });
  const mounted = render(createElement(Surface));
  const wrapper = screen.getByTestId('surface');
  expect(wrapper.hasAttribute('data-far-zoom')).toBe(true);
  act(() => flow.setState({ transform: [0, 0, 0.8] }));
  expect(wrapper.hasAttribute('data-far-zoom')).toBe(true);
  act(() => flow.setState({ transform: [0, 0, 0.2] }));
  expect(wrapper.hasAttribute('data-far-zoom')).toBe(true);
  mounted.unmount();
  act(() => { vi.runAllTimers(); flow.setState({ transform: [0, 0, 0.1] }); });
  expect(wrapper.hasAttribute('data-far-zoom')).toBe(false);
  expect(useCanvasUiStore.getState().zoomRendering).toEqual({ keepAllNodesRendered: false, simplifyNodes: false });
});
