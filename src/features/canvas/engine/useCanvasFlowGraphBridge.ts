import { useEffect } from 'react';
import { useStoreApi, type ReactFlowState } from '@xyflow/react';
import { adoptUserNodes, updateConnectionLookup } from '@xyflow/system';

import type { CanvasEdge, CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore, type CanvasState } from '@/stores/canvasStore';

export interface CanvasFlowGraphStore {
  getState(): ReactFlowState<CanvasNode, CanvasEdge>;
  setState(patch: Partial<ReactFlowState<CanvasNode, CanvasEdge>>): void;
}

/** Same-version Flow core preserves measured internals, parents, selection and edge lookups atomically. */
export function publishCanvasGraphToFlow(
  flowStore: CanvasFlowGraphStore,
  source: Pick<CanvasState, 'nodes' | 'edges'>,
): void {
  const target = flowStore.getState();
  const nodesChanged = target.nodes !== source.nodes;
  const edgesChanged = target.edges !== source.edges;
  if (!nodesChanged && !edgesChanged) return;
  let nodesInitialized = target.nodesInitialized;
  let nodesSelectionActive = target.nodesSelectionActive;
  if (nodesChanged) {
    const adopted = adoptUserNodes(source.nodes, target.nodeLookup, target.parentLookup, {
      nodeOrigin: target.nodeOrigin,
      nodeExtent: target.nodeExtent,
      elevateNodesOnSelect: target.elevateNodesOnSelect,
      checkEquality: true,
      zIndexMode: target.zIndexMode,
    });
    nodesInitialized = adopted.nodesInitialized;
    nodesSelectionActive = nodesSelectionActive && adopted.hasSelectedNodes;
  }
  if (edgesChanged) updateConnectionLookup(target.connectionLookup, target.edgeLookup, source.edges);
  flowStore.setState({ nodes: source.nodes, edges: source.edges, nodesInitialized, nodesSelectionActive });
  // Let Flow own queued fit-view/resolver flags, after both sides of the graph are already complete.
  if (nodesChanged && target.fitViewQueued && nodesInitialized) flowStore.getState().setNodes(source.nodes);
}

/**
 * canvasStore remains the graph authority. Forward immutable graph changes directly to Flow's
 * render store instead of re-rendering the entire <ReactFlow> assembly for every drag frame.
 * Flow still reports all edits through onNodesChange/onEdgesChange, including measurements.
 */
export function useCanvasFlowGraphBridge(): void {
  const flowStore = useStoreApi<CanvasNode, CanvasEdge>();
  useEffect(() => {
    const synchronize = () => publishCanvasGraphToFlow(flowStore, useCanvasStore.getState());
    synchronize();
    return useCanvasStore.subscribe((state, previous) => {
      if (state.nodes !== previous.nodes || state.edges !== previous.edges) synchronize();
    });
  }, [flowStore]);
}
