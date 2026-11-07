import { beforeEach, describe, expect, it } from 'vitest';
import type { CanvasEdge, CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from './canvasStore';

function fixture() {
  const nodes: CanvasNode[] = [
    { id: 'note', type: 'textAnnotationNode', position: { x: 0, y: 0 }, measured: { width: 320, height: 220 }, data: { content: 'First' } },
    { id: 'target', type: 'aiTextNode', position: { x: 600, y: 0 }, measured: { width: 320, height: 220 }, data: { prompt: 'Target' } },
  ];
  const edges: CanvasEdge[] = [{ id: 'link', source: 'note', target: 'target' }];
  useCanvasStore.setState({ nodes, edges, revision: 0, selectedNodeId: null, history: { past: [], future: [] }, dragHistorySnapshot: null });
}

beforeEach(fixture);

describe('canvas redundant Flow changes', () => {
  it('does not invalidate a prepared graph transaction when Flow repeats an unchanged position', () => {
    const prepared = useCanvasStore.getState();
    useCanvasStore.getState().onNodesChange([{ type: 'position', id: 'note', position: { x: 0, y: 0 } }]);

    const revision = useCanvasStore.getState().commitGraphTransaction({
      expectedRevision: prepared.revision,
      nodes: prepared.nodes.map(node => node.id === 'note' ? { ...node, data: { ...node.data, content: 'Approved edit' } } : node),
      edges: prepared.edges,
      selectedNodeId: null,
    });

    expect(revision).toBe(1);
    expect(useCanvasStore.getState().nodes[0].data.content).toBe('Approved edit');
    expect(useCanvasStore.getState().history.past).toHaveLength(1);
    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(useCanvasStore.getState().nodes[0].data.content).toBe('First');
  });

  it('does not propagate repeated selection, measurement or empty change batches', () => {
    useCanvasStore.getState().setSelectedNodeIds(['note']);
    useCanvasStore.getState().onEdgesChange([{ type: 'select', id: 'link', selected: true }]);
    const before = useCanvasStore.getState();
    let notifications = 0;
    const stop = useCanvasStore.subscribe(() => { notifications++; });
    try {
      useCanvasStore.getState().setSelectedNodeIds(['note']);
      useCanvasStore.getState().setSelectedNode('note');
      useCanvasStore.getState().onNodesChange([{ type: 'select', id: 'note', selected: true }]);
      useCanvasStore.getState().onNodesChange([{ type: 'dimensions', id: 'note', dimensions: { width: 320, height: 220 } }]);
      useCanvasStore.getState().onEdgesChange([{ type: 'select', id: 'link', selected: true }]);
      useCanvasStore.getState().onNodesChange([]);
      useCanvasStore.getState().onEdgesChange([]);
    } finally { stop(); }
    expect(notifications).toBe(0);
    expect(useCanvasStore.getState()).toBe(before);
    expect(useCanvasStore.getState().selectedNodeId).toBe('note');
    expect(useCanvasStore.getState().edges[0].selected).toBe(true);
  });

  it('keeps a drag open through identical frames, then commits and undoes its final position once', () => {
    useCanvasStore.getState().onNodesChange([{ type: 'position', id: 'note', position: { x: 40, y: 50 }, dragging: true }]);
    const moving = useCanvasStore.getState();
    let notifications = 0;
    const stop = useCanvasStore.subscribe(() => { notifications++; });
    try {
      useCanvasStore.getState().onNodesChange([{ type: 'position', id: 'note', position: { x: 40, y: 50 }, dragging: true }]);
    } finally { stop(); }
    expect(notifications).toBe(0);
    expect(useCanvasStore.getState().revision).toBe(moving.revision);
    expect(useCanvasStore.getState().dragHistorySnapshot).toBe(moving.dragHistorySnapshot);
    expect(useCanvasStore.getState().history.past).toHaveLength(0);

    useCanvasStore.getState().onNodesChange([{ type: 'position', id: 'note', position: { x: 40, y: 50 }, dragging: false }]);
    expect(useCanvasStore.getState().nodes[0].dragging).toBe(false);
    expect(useCanvasStore.getState().dragHistorySnapshot).toBeNull();
    expect(useCanvasStore.getState().history.past).toHaveLength(1);
    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(useCanvasStore.getState().nodes[0].position).toEqual({ x: 0, y: 0 });
    expect(useCanvasStore.getState().redo()).toBe(true);
    expect(useCanvasStore.getState().nodes[0].position).toEqual({ x: 40, y: 50 });
  });

  it('preserves ordered changes for one node rather than comparing every item to the original snapshot', () => {
    useCanvasStore.getState().onNodesChange([
      { type: 'select', id: 'note', selected: true },
      { type: 'select', id: 'note', selected: false },
      { type: 'dimensions', id: 'note', dimensions: { width: 400, height: 300 } },
      { type: 'dimensions', id: 'note', dimensions: { width: 320, height: 220 } },
      { type: 'position', id: 'note', position: { x: 10, y: 20 } },
      { type: 'position', id: 'note', position: { x: 0, y: 0 } },
    ]);
    const node = useCanvasStore.getState().nodes[0];
    expect(node.selected).toBe(false);
    expect(node.measured).toEqual({ width: 320, height: 220 });
    expect(node.position).toEqual({ x: 0, y: 0 });
    expect(useCanvasStore.getState().selectedNodeId).toBeNull();
  });

  it('does not drop explicit resize attributes or the release event when measurements are unchanged', () => {
    useCanvasStore.getState().onNodesChange([{ type: 'dimensions', id: 'note', dimensions: { width: 400, height: 300 }, resizing: true, setAttributes: true }]);
    useCanvasStore.getState().onNodesChange([{ type: 'dimensions', id: 'note', dimensions: { width: 400, height: 300 }, resizing: false, setAttributes: true }]);
    expect(useCanvasStore.getState().nodes[0]).toMatchObject({ width: 400, height: 300, resizing: false, measured: { width: 400, height: 300 } });
    expect(useCanvasStore.getState().history.past).toHaveLength(1);
    expect(useCanvasStore.getState().dragHistorySnapshot).toBeNull();
    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(useCanvasStore.getState().nodes[0].measured).toEqual({ width: 320, height: 220 });
  });
});
