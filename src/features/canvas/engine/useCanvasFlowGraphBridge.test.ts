// @vitest-environment jsdom
import { createElement } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { ReactFlowProvider, useStoreApi, type ReactFlowState } from '@xyflow/react';
import type { StoreApi } from 'zustand';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanvasEdge, CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';
import { useCanvasFlowGraphBridge } from './useCanvasFlowGraphBridge';

type FlowState = ReactFlowState<CanvasNode, CanvasEdge>;
let flow: Pick<StoreApi<FlowState>, 'getState' | 'setState' | 'subscribe'> | undefined;
let renders = 0;
function Probe() {
  flow = useStoreApi<CanvasNode, CanvasEdge>();
  useCanvasFlowGraphBridge();
  renders += 1;
  return null;
}
function graph() {
  const nodes: CanvasNode[] = [
    { id: 'parent', type: 'groupNode', position: { x: 100, y: 120 }, width: 640, height: 480, measured: { width: 640, height: 480 }, data: { label: 'Parent' } },
    { id: 'child', type: 'textAnnotationNode', parentId: 'parent', position: { x: 40, y: 60 }, width: 220, height: 140, measured: { width: 220, height: 140 }, data: { content: 'Child' } },
    { id: 'target', type: 'aiTextNode', position: { x: 900, y: 120 }, width: 320, height: 220, measured: { width: 320, height: 220 }, data: { prompt: 'Target' } },
  ];
  const edges: CanvasEdge[] = [{ id: 'connection', source: 'child', target: 'target' }];
  return { nodes, edges };
}
function store() {
  if (!flow) throw new Error('Probe is not mounted');
  return flow;
}
function mount() {
  return render(createElement(ReactFlowProvider, null, createElement(Probe)));
}
beforeEach(() => {
  renders = 0;
  flow = undefined;
  const initial = graph();
  useCanvasStore.getState().setCanvasData(initial.nodes, initial.edges);
});
afterEach(cleanup);

describe('canonical canvas to Flow graph publication', () => {
  it('preserves parent geometry and measurements without rendering the assembly for drag frames', () => {
    mount();
    const initialRenders = renders;
    const child = store().getState().nodeLookup.get('child');
    expect(child?.internals.positionAbsolute).toEqual({ x: 140, y: 180 });
    const bounds = { source: [], target: [] };
    if (!child) throw new Error('Child is missing');
    child.internals.handleBounds = bounds;
    for (let x = 101; x <= 110; x++) {
      act(() => useCanvasStore.getState().onNodesChange([{ type: 'position', id: 'parent', position: { x, y: 120 }, dragging: true }]));
    }
    expect(store().getState().nodeLookup.get('child')?.internals.positionAbsolute).toEqual({ x: 150, y: 180 });
    expect(store().getState().parentLookup.get('parent')?.has('child')).toBe(true);
    expect(store().getState().nodeLookup.get('child')?.measured).toMatchObject({ width: 220, height: 140 });
    expect(store().getState().nodeLookup.get('child')?.internals.handleBounds).toBe(bounds);
    expect(store().getState().nodes).toBe(useCanvasStore.getState().nodes);
    expect(renders).toBe(initialRenders);
  });

  it('publishes replacement nodes, edges and their lookups as one coherent graph without echo callbacks', () => {
    mount();
    const onNodesChange = vi.fn();
    const onEdgesChange = vi.fn();
    store().setState({ onNodesChange, onEdgesChange });
    const observations: boolean[] = [];
    const off = store().subscribe((state) => observations.push(state.nodes.length === state.nodeLookup.size
      && state.edges.length === state.edgeLookup.size
      && state.edges.every(edge => state.nodeLookup.has(edge.source) && state.nodeLookup.has(edge.target))));
    const nodes: CanvasNode[] = [
      { id: 'new-source', type: 'uploadNode', position: { x: 10, y: 20 }, data: { imageUrl: null, aspectRatio: '1:1' } },
      { id: 'new-target', type: 'aiTextNode', position: { x: 400, y: 20 }, data: { prompt: 'New target' } },
    ];
    act(() => useCanvasStore.getState().setCanvasData(nodes, [{ id: 'new-edge', source: 'new-source', target: 'new-target' }]));
    off();
    expect(observations).toEqual([true]);
    expect(store().getState().nodeLookup.has('parent')).toBe(false);
    expect(store().getState().edgeLookup.has('connection')).toBe(false);
    expect(store().getState().connectionLookup.size).toBeGreaterThan(0);
    expect(onNodesChange).not.toHaveBeenCalled();
    expect(onEdgesChange).not.toHaveBeenCalled();
  });

  it('shows selection, resize, undo, redo and graph deletion while preserving viewport state', () => {
    mount();
    store().setState({ transform: [45, 67, .7], nodesSelectionActive: true });
    act(() => useCanvasStore.getState().setSelectedNodeIds(['child']));
    expect(store().getState().nodeLookup.get('child')?.selected).toBe(true);
    act(() => useCanvasStore.getState().onNodesChange([{ type: 'dimensions', id: 'child', dimensions: { width: 320, height: 200 } }]));
    expect(store().getState().nodeLookup.get('child')?.measured).toMatchObject({ width: 320, height: 200 });
    act(() => useCanvasStore.getState().onNodesChange([{ type: 'position', id: 'parent', position: { x: 200, y: 220 }, dragging: true }]));
    act(() => useCanvasStore.getState().onNodesChange([{ type: 'position', id: 'parent', position: { x: 200, y: 220 }, dragging: false }]));
    expect(store().getState().nodeLookup.get('child')?.internals.positionAbsolute).toEqual({ x: 240, y: 280 });
    act(() => { expect(useCanvasStore.getState().undo()).toBe(true); });
    expect(store().getState().nodeLookup.get('child')?.internals.positionAbsolute).toEqual({ x: 140, y: 180 });
    act(() => { expect(useCanvasStore.getState().redo()).toBe(true); });
    expect(store().getState().nodeLookup.get('child')?.internals.positionAbsolute).toEqual({ x: 240, y: 280 });
    act(() => useCanvasStore.getState().setSelectedNodeIds([]));
    expect(store().getState().nodesSelectionActive).toBe(false);
    act(() => useCanvasStore.getState().setCanvasData([], []));
    expect(store().getState().nodeLookup.size).toBe(0);
    expect(store().getState().edgeLookup.size).toBe(0);
    expect(store().getState().connectionLookup.size).toBe(0);
    expect(store().getState().transform).toEqual([45, 67, .7]);
  });

  it('unsubscribes on unmount and initializes the next canvas from the current canonical project', () => {
    const mounted = mount();
    const previousFlow = store();
    const previousNodes = previousFlow.getState().nodes;
    mounted.unmount();
    const nodes: CanvasNode[] = [{ id: 'other-project', type: 'textAnnotationNode', position: { x: 50, y: 70 }, data: { content: 'Other' } }];
    act(() => useCanvasStore.getState().setCanvasData(nodes, []));
    expect(previousFlow.getState().nodes).toBe(previousNodes);
    mount();
    expect(store().getState().nodeLookup.has('other-project')).toBe(true);
    expect(store().getState().nodeLookup.has('parent')).toBe(false);
    expect(store().getState().nodeLookup.get('other-project')?.internals.positionAbsolute).toEqual({ x: 50, y: 70 });
  });
});
