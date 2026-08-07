import { beforeEach, describe, expect, it } from 'vitest';

import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { MAX_CANVAS_BATCH_ADD_NODES, useCanvasStore } from './canvasStore';

function resetCanvasStore(): void {
  useCanvasStore.setState({
    nodes: [],
    edges: [],
    selectedNodeId: null,
    activeToolDialog: null,
    history: { past: [], future: [] },
    dragHistorySnapshot: null,
    currentViewport: { x: 0, y: 0, zoom: 1 },
    canvasViewportSize: { width: 1_280, height: 720 },
  });
}

describe('canvasStore.addNodesBatch', () => {
  beforeEach(resetCanvasStore);

  it('adds 500 editable idle nodes in one mutation and removes all of them with one undo', () => {
    let mutationCount = 0;
    const unsubscribe = useCanvasStore.subscribe(() => {
      mutationCount += 1;
    });

    const ids = useCanvasStore.getState().addNodesBatch(Array.from(
      { length: MAX_CANVAS_BATCH_ADD_NODES },
      (_, index) => ({
        type: CANVAS_NODE_TYPES.imageEdit,
        position: { x: (index % 20) * 728, y: Math.floor(index / 20) * 420 },
        dimensions: { width: 680, height: 380 },
        data: {
          displayName: `Prompt ${index + 1}`,
          prompt: `Imported prompt ${index + 1}`,
        },
      }),
    ));
    unsubscribe();

    const importedState = useCanvasStore.getState();
    expect(ids).toHaveLength(500);
    expect(new Set(ids).size).toBe(500);
    expect(importedState.nodes).toHaveLength(500);
    expect(importedState.nodes.every((node) => (
      node.type === CANVAS_NODE_TYPES.imageEdit
      && node.data.isGenerating === false
      && typeof node.data.prompt === 'string'
      && node.measured?.width === 680
      && node.measured?.height === 380
    ))).toBe(true);
    expect(importedState.history.past).toHaveLength(1);
    expect(mutationCount).toBe(1);

    expect(importedState.undo()).toBe(true);
    expect(useCanvasStore.getState().nodes).toHaveLength(0);
    expect(useCanvasStore.getState().undo()).toBe(false);
  });

  it('preserves imported custom names when another node is deleted', () => {
    const [, secondId] = useCanvasStore.getState().addNodesBatch([
      {
        type: CANVAS_NODE_TYPES.imageEdit,
        position: { x: 0, y: 0 },
        data: { displayName: 'Opening shot', prompt: 'Prompt one' },
      },
      {
        type: CANVAS_NODE_TYPES.imageEdit,
        position: { x: 728, y: 0 },
        data: { displayName: 'Final shot', prompt: 'Prompt two' },
      },
    ]);
    const firstId = useCanvasStore.getState().nodes[0].id;

    useCanvasStore.getState().deleteNode(firstId);

    expect(useCanvasStore.getState().nodes).toHaveLength(1);
    expect(useCanvasStore.getState().nodes[0]).toMatchObject({
      id: secondId,
      data: { displayName: 'Final shot' },
    });
  });

  it('rejects batches above the safety limit without changing state', () => {
    expect(() => useCanvasStore.getState().addNodesBatch(Array.from(
      { length: MAX_CANVAS_BATCH_ADD_NODES + 1 },
      () => ({ type: CANVAS_NODE_TYPES.imageEdit, position: { x: 0, y: 0 } }),
    ))).toThrowError(RangeError);
    expect(useCanvasStore.getState().nodes).toEqual([]);
    expect(useCanvasStore.getState().history.past).toEqual([]);
  });

  it('rejects invalid initial dimensions without partially adding the batch', () => {
    expect(() => useCanvasStore.getState().addNodesBatch([
      {
        type: CANVAS_NODE_TYPES.imageEdit,
        position: { x: 0, y: 0 },
        dimensions: { width: 680, height: 380 },
      },
      {
        type: CANVAS_NODE_TYPES.imageEdit,
        position: { x: 728, y: 0 },
        dimensions: { width: 0, height: 380 },
      },
    ])).toThrowError(RangeError);
    expect(useCanvasStore.getState().nodes).toEqual([]);
    expect(useCanvasStore.getState().history.past).toEqual([]);
  });
});
