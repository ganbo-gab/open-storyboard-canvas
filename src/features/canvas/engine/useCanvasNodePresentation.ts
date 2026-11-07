import { useCallback } from 'react';
import { useStore, type InternalNode, type ReactFlowState } from '@xyflow/react';

/** Geometry and dragging are owned by React Flow's wrapper, not by the node body. */
function samePresentation(previous: InternalNode | undefined, next: InternalNode | undefined): boolean {
  return previous === next || (previous !== undefined && next !== undefined
    && previous.id === next.id
    && previous.type === next.type
    && previous.data === next.data
    && previous.selected === next.selected
    && previous.width === next.width
    && previous.height === next.height
    && previous.measured?.width === next.measured?.width
    && previous.measured?.height === next.measured?.height);
}

export function useCanvasNodePresentation(nodeId: string): InternalNode | undefined {
  const select = useCallback((state: ReactFlowState) => state.nodeLookup.get(nodeId), [nodeId]);
  return useStore(select, samePresentation);
}
