// @vitest-environment jsdom
import { createElement, useRef } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { createStore } from 'zustand';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanvasStore } from '@/stores/canvasStore';
import type { CanvasNode } from '../domain/canvasNodes';
import { registerCanvasViewportFlush } from '../application/canvasViewportCommit';
import { useCanvasViewportEdges } from './useCanvasViewportEdges';

const flow = createStore(() => ({ transform: [0, 0, .1] as [number, number, number], paneDragging: false,
  edges: [{ id: 'edge', source: 's', target: 't' }] }));
vi.mock('@xyflow/react', () => ({ useStoreApi: () => flow }));
const gpu = vi.hoisted(() => ({ draw: vi.fn(() => true), setEdges: vi.fn(() => true), dispose: vi.fn(), lost: () => {}, available: true }));
vi.mock('../edges/viewportEdgeRenderer', () => ({ createViewportEdgeRenderer: (_canvas: HTMLCanvasElement, lost: () => void) => {
  gpu.lost = lost; return gpu.available ? gpu : null;
} }));
vi.mock('../edges/viewportEdgeGeometry', () => ({ buildViewportEdgeGeometry: () => new Float32Array(84) }));
const snapshot = vi.hoisted(() => ({ pending: false, release: () => {} }));
vi.mock('../edges/viewportEdgeSnapshot', () => ({ MIN_VIEWPORT_EDGES: 160, readViewportEdgeStroke: () => null,
  collectViewportEdgeSnapshot: async (layer: Element, _expected: number, current: () => boolean) => {
    if (snapshot.pending) await new Promise<void>(resolve => { snapshot.release = resolve; });
    if (!current()) return null;
    return { inputs: [{ path: 'M0 0 L100 100', color: [1, 1, 1, .26], width: 1.6, miterLimit: 4 }],
      sources: new Map([['edge', 'M0 0 L100 100']]), elements: [layer.querySelector('svg')] };
  },
}));
function Surface() {
  const ref = useRef<HTMLDivElement>(null);
  useCanvasViewportEdges(ref);
  return createElement('div', { ref, 'data-testid': 'root' }, createElement('div', { className: 'react-flow__viewport' },
    createElement('div', { className: 'react-flow__edges' }, createElement('svg', {}, createElement('g', { className: 'react-flow__edge', 'data-id': 'edge' }, createElement('path', { className: 'canvas-edge__base', d: 'M0 0 L100 100' }))))));
}
let moving = false, unregister = () => {};
beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(16), 16));
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => window.clearTimeout(handle));
  moving = false; gpu.available = true; snapshot.pending = false;
  gpu.draw.mockReset().mockReturnValue(true); gpu.setEdges.mockReset().mockReturnValue(true); gpu.dispose.mockReset();
  flow.setState({ transform: [0, 0, .1], paneDragging: false });
  useCanvasStore.setState({ nodes: [], edges: Array.from({ length: 160 }, (_, i) => ({ id: `e${i}`, source: 's', target: 't' })) });
  unregister = registerCanvasViewportFlush(() => {}, () => moving);
});
afterEach(() => { cleanup(); unregister(); vi.clearAllTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const prepare = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(200); }); };
const pan = () => { act(() => { moving = true; flow.setState({ transform: [20, 10, .1] }); }); };

describe('viewport edge rendering lifecycle', () => {
  it('keeps SVG hit targets interactive while cached ink avoids a redraw at camera stop', async () => {
    render(createElement(Surface));
    const root = screen.getByTestId('root');
    expect(root.hasAttribute('data-viewport-edges')).toBe(false);
    await prepare();
    expect(root.hasAttribute('data-viewport-edge-cache-ready')).toBe(true);
    expect(root.querySelector('svg')?.hasAttribute('data-viewport-edge-cached')).toBe(true);
    pan();
    expect(gpu.draw).toHaveBeenCalledWith({ x: 20, y: 10, zoom: .1 }, 1000, 800, expect.any(Number));
    expect(root.hasAttribute('data-viewport-edges')).toBe(true);
    moving = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(17); });
    expect(root.hasAttribute('data-viewport-edges')).toBe(false);
    expect(root.hasAttribute('data-viewport-edge-cache-ready')).toBe(true);
    expect(root.querySelector('.react-flow__edge')).not.toBeNull();
  });
  it('restores vector artwork on edge focus and redraws cached ink when focus leaves', async () => {
    render(createElement(Surface)); await prepare();
    const root = screen.getByTestId('root'), edge = root.querySelector('.react-flow__edge');
    if (!edge) throw new Error('Edge fixture missing');
    act(() => edge.dispatchEvent(new FocusEvent('focusin', { bubbles: true })));
    expect(root.hasAttribute('data-viewport-edge-cache-ready')).toBe(false);
    const draws = gpu.draw.mock.calls.length;
    act(() => edge.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body })));
    expect(root.hasAttribute('data-viewport-edge-cache-ready')).toBe(true);
    expect(gpu.draw.mock.calls.length).toBeGreaterThan(draws);
  });
  it('never hides original ink if preparing the first GPU frame fails', async () => {
    gpu.draw.mockReturnValue(false); render(createElement(Surface)); await prepare();
    expect(screen.getByTestId('root').hasAttribute('data-viewport-edge-cache-ready')).toBe(false);
    expect(screen.getByTestId('root').querySelector('path')).not.toBeNull();
  });
  it('restores editable SVG immediately when graph geometry changes during movement', async () => {
    render(createElement(Surface)); await prepare(); pan();
    act(() => { useCanvasStore.setState({ edges: [...useCanvasStore.getState().edges] }); });
    expect(screen.getByTestId('root').hasAttribute('data-viewport-edges')).toBe(false);
  });
  it('does not rebuild edge geometry for unrelated node content updates', async () => {
    const node: CanvasNode = { id: 's', type: 'aiTextNode', position: { x: 0, y: 0 }, data: { prompt: 'before' } };
    useCanvasStore.setState({ nodes: [node] });
    render(createElement(Surface)); await prepare(); pan();
    act(() => useCanvasStore.setState({ nodes: [{ ...node, data: { prompt: 'after' } }] }));
    expect(screen.getByTestId('root').hasAttribute('data-viewport-edges')).toBe(true);
    expect(gpu.setEdges).toHaveBeenCalledOnce();
  });
  it('restores SVG when a presentation filter removes an edge without changing the canonical graph', async () => {
    render(createElement(Surface)); await prepare(); pan();
    act(() => flow.setState({ edges: [] }));
    expect(screen.getByTestId('root').hasAttribute('data-viewport-edges')).toBe(false);
    expect(useCanvasStore.getState().edges).toHaveLength(160);
  });
  it.each(['draw failure', 'context lost', 'blur'] as const)('preserves SVG when %s occurs', async reason => {
    render(createElement(Surface)); await prepare();
    if (reason === 'draw failure') gpu.draw.mockReturnValue(false);
    pan();
    if (reason === 'context lost') act(() => gpu.lost());
    if (reason === 'blur') act(() => window.dispatchEvent(new Event('blur')));
    expect(screen.getByTestId('root').hasAttribute('data-viewport-edges')).toBe(false);
    expect(screen.getByTestId('root').querySelector('path')?.getAttribute('d')).toBe('M0 0 L100 100');
  });
  it('never hides SVG on devices without WebGL2', async () => {
    gpu.available = false; render(createElement(Surface)); await prepare(); pan();
    expect(gpu.draw).not.toHaveBeenCalled();
    expect(screen.getByTestId('root').hasAttribute('data-viewport-edges')).toBe(false);
  });
  it('discards a late preparation after navigating away and releases all graphics', async () => {
    snapshot.pending = true;
    const mounted = render(createElement(Surface)); await prepare();
    const root = screen.getByTestId('root'); mounted.unmount();
    await act(async () => { snapshot.release(); await Promise.resolve(); });
    expect(gpu.setEdges).not.toHaveBeenCalled();
    expect(root.hasAttribute('data-viewport-edges')).toBe(false);
    expect(root.querySelector('canvas')).toBeNull();
  });
  it('respects user-hidden connections during a camera gesture', async () => {
    render(createElement(Surface)); await prepare();
    screen.getByTestId('root').setAttribute('data-edges-hidden', ''); pan();
    expect(screen.getByTestId('root').hasAttribute('data-viewport-edges')).toBe(false);
  });
});
