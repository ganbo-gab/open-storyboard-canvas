import { useCanvasStore, type CanvasState } from '@/stores/canvasStore';
import { withCanvasHistoryAgentTurn } from '@/stores/canvasHistory';

export interface GenerationCanvasMutations {
  addNode: CanvasState['addNode'];
  addEdge: CanvasState['addEdge'];
  updateNodeData: CanvasState['updateNodeData'];
  replaceNodeType: CanvasState['replaceNodeType'];
}

/** Capture provenance, not mutable global context, across provider awaits. */
export function generationCanvasMutations(agentTurnId?: string): GenerationCanvasMutations {
  const state = useCanvasStore.getState();
  if (!agentTurnId) return state;
  return {
    addNode: (type, position, data) => withCanvasHistoryAgentTurn(agentTurnId, () => state.addNode(type, position, {
      ...data, generationAgentTurnId: agentTurnId,
    })),
    addEdge: (source, target, options) => withCanvasHistoryAgentTurn(agentTurnId, () => state.addEdge(source, target, options)),
    updateNodeData: (nodeId, data) => withCanvasHistoryAgentTurn(agentTurnId, () => state.updateNodeData(nodeId, {
      ...data, generationAgentTurnId: agentTurnId,
    })),
    replaceNodeType: (nodeId, type, data) => withCanvasHistoryAgentTurn(agentTurnId, () => state.replaceNodeType(nodeId, type, data)),
  };
}
