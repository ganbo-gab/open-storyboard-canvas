// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import type { ReactFlowInstance } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore, type Project } from '@/stores/projectStore';
import type { CanvasEdge, CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { useCanvasPersistence } from './useCanvasPersistence';

const originalProjects = useProjectStore.getState();
let saves: Array<{ nodes: CanvasNode[]; edges: CanvasEdge[] }>;
let renders: number;
const flow = {
  getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
  setViewport: async () => true,
} as unknown as ReactFlowInstance;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(16), 16));
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => window.clearTimeout(handle));
  saves = [];
  renders = 0;
  const nodes: CanvasNode[] = [{ id: 'note', type: 'textAnnotationNode', position: { x: 0, y: 0 }, data: { content: 'first' } }];
  const project: Project = { id: 'persistence-test', name: 'Persistence test', createdAt: 0, updatedAt: 0, nodeCount: 1, nodes, edges: [], viewport: { x: 0, y: 0, zoom: 1 }, history: { past: [], future: [] } };
  useProjectStore.setState({ currentProjectId: project.id, currentProject: project, getCurrentProject: () => project, saveCurrentProject: (savedNodes, edges) => { saves.push({ nodes: savedNodes, edges }); } });
});
afterEach(() => {
  cleanup();
  useProjectStore.setState(originalProjects, true);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function mountPersistence() {
  const mounted = renderHook(() => {
    renders += 1;
    return useCanvasPersistence(flow);
  });
  act(() => vi.advanceTimersByTime(17));
  return mounted;
}

describe('canvas persistence without graph render subscriptions', () => {
  it('does not rerender the Canvas or persist per drag frame, then saves the final state once', () => {
    mountPersistence();
    const initialRenders = renders;
    expect(saves).toHaveLength(0);
    for (let x = 1; x <= 20; x++) {
      act(() => useCanvasStore.getState().onNodesChange([{ type: 'position', id: 'note', position: { x, y: x }, dragging: true }]));
    }
    act(() => vi.advanceTimersByTime(500));
    expect(renders).toBe(initialRenders);
    expect(saves).toHaveLength(0);
    act(() => useCanvasStore.getState().onNodesChange([{ type: 'position', id: 'note', position: { x: 20, y: 20 }, dragging: false }]));
    act(() => vi.advanceTimersByTime(139));
    expect(saves).toHaveLength(0);
    act(() => vi.advanceTimersByTime(1));
    expect(saves).toHaveLength(1);
    expect(saves[0].nodes[0].position).toEqual({ x: 20, y: 20 });
    expect(renders).toBe(initialRenders);
  });

  it('does not save transient node selection but still saves measurements without a revision change', () => {
    mountPersistence();
    const revision = useCanvasStore.getState().revision;
    for (const selected of [true, false, true]) {
      act(() => useCanvasStore.getState().onNodesChange([{ type: 'select', id: 'note', selected }]));
      act(() => vi.advanceTimersByTime(500));
    }
    expect(useCanvasStore.getState().nodes[0].selected).toBe(true);
    expect(useCanvasStore.getState().revision).toBe(revision);
    expect(saves).toEqual([]);
    act(() => useCanvasStore.getState().onNodesChange([
      { type: 'dimensions', id: 'note', dimensions: { width: 380, height: 240 } },
    ]));
    act(() => vi.advanceTimersByTime(140));
    expect(useCanvasStore.getState().revision).toBe(revision);
    expect(saves.map(save => save.nodes[0].measured)).toEqual([{ width: 380, height: 240 }]);
  });

  it('coalesces content edits and cancels scheduled work when the canvas unmounts', () => {
    const mounted = mountPersistence();
    act(() => useCanvasStore.getState().updateNodeData('note', { content: 'edited' }));
    act(() => vi.advanceTimersByTime(100));
    mounted.unmount();
    act(() => useCanvasStore.getState().updateNodeData('note', { content: 'after unmount' }));
    act(() => vi.advanceTimersByTime(500));
    expect(saves).toHaveLength(0);
  });
});
