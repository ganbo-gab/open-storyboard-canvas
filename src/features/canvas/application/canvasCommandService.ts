import { useCanvasStore } from '@/stores/canvasStore';

import { CanvasCommandRegistry } from './canvasCommandRegistry';
import { CanvasGenerationFacade } from './canvasGenerationFacade';
import { canvasNavigationFacade } from './canvasNavigationFacade';
import { canvasEventBus, canvasNodeFactory } from './canvasServices';
import { canvasToolProcessor } from './canvasServices';
import { CanvasToolWorkflowFacade } from './canvasToolWorkflowFacade';

const canvasCommandStore = {
  getSnapshot: () => {
    const state = useCanvasStore.getState();
    return {
      nodes: state.nodes,
      edges: state.edges,
      selectedNodeId: state.selectedNodeId,
      revision: Number.isSafeInteger(state.revision) && state.revision >= 0 ? state.revision : 0,
    };
  },
  commitGraphTransaction: (input: {
    expectedRevision: number;
    nodes: ReturnType<typeof useCanvasStore.getState>['nodes'];
    edges: ReturnType<typeof useCanvasStore.getState>['edges'];
    selectedNodeId: string | null;
  }) => useCanvasStore.getState().commitGraphTransaction(input),
  setSelection: (nodeIds: string[]) => {
    const selectedIds = new Set(nodeIds);
    useCanvasStore.setState((state) => ({
      nodes: state.nodes.map((node) => {
        const selected = selectedIds.has(node.id);
        return Boolean(node.selected) === selected ? node : { ...node, selected };
      }),
      selectedNodeId: nodeIds.length === 1 ? nodeIds[0] : null,
    }));
  },
};

export const canvasGenerationFacade = new CanvasGenerationFacade(canvasEventBus);
export const canvasToolWorkflowFacade = new CanvasToolWorkflowFacade({
  getNodes: () => useCanvasStore.getState().nodes,
  addDerivedExportNode: (...args) => useCanvasStore.getState().addDerivedExportNode(...args),
  addStoryboardSplitNode: (...args) => useCanvasStore.getState().addStoryboardSplitNode(...args),
  addEdge: (...args) => useCanvasStore.getState().addEdge(...args),
}, canvasToolProcessor);

export const canvasCommandRegistry = new CanvasCommandRegistry({
  store: canvasCommandStore,
  nodeFactory: canvasNodeFactory,
  navigation: canvasNavigationFacade,
  generation: canvasGenerationFacade,
  tools: canvasToolWorkflowFacade,
  eventBus: canvasEventBus,
});
