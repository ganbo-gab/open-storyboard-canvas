import type { EdgeChange, NodeChange } from '@xyflow/react';
import { getSharedCanvasNodeIndex } from '@/features/canvas/application/canvasGraphIndex';
import type { CanvasEdge, CanvasNode } from '@/features/canvas/domain/canvasNodes';

export function isCanvasMeasurementChange(change: NodeChange<CanvasNode>): boolean {
  return change.type === 'dimensions' && change.resizing === undefined && !change.setAttributes;
}

/** Filter against immutable node identity, never numeric revision (selection/measurement do not bump it). */
export function filterRedundantCanvasNodeChanges(
  changes: NodeChange<CanvasNode>[],
  nodes: CanvasNode[],
  hasPendingInteraction: boolean,
): NodeChange<CanvasNode>[] {
  if (changes.length === 0) return changes;
  const byId = getSharedCanvasNodeIndex(nodes);
  const touched = new Set<string>();
  return changes.filter((change) => {
    if (change.type === 'add') return true;
    // A preceding effective change can replace any field. Let Flow apply the remainder in order.
    if (touched.has(change.id)) return true;
    const node = byId.get(change.id);
    if (change.type === 'select') {
      if (!node || Boolean(node.selected) === change.selected) return false;
    } else if (change.type === 'position') {
      const startsInteraction = change.dragging === true && !hasPendingInteraction;
      const endsInteraction = change.dragging === false && hasPendingInteraction;
      if (!node && !endsInteraction) return false;
      if (node && !startsInteraction && !endsInteraction
        && (!change.position || (node.position.x === change.position.x && node.position.y === change.position.y))
        && (change.dragging === undefined || node.dragging === change.dragging)) return false;
    } else if (change.type === 'dimensions' && isCanvasMeasurementChange(change)) {
      if (!node || !change.dimensions || (node.measured?.width === change.dimensions.width
        && node.measured?.height === change.dimensions.height)) return false;
    }
    touched.add(change.id);
    return true;
  });
}

export function filterRedundantCanvasEdgeChanges(
  changes: EdgeChange<CanvasEdge>[],
  edges: CanvasEdge[],
): EdgeChange<CanvasEdge>[] {
  if (!changes.some((change) => change.type === 'select')) return changes;
  const byId = new Map(edges.map((edge) => [edge.id, edge]));
  const touched = new Set<string>();
  return changes.filter((change) => {
    if (change.type === 'add') return true;
    if (touched.has(change.id)) return true;
    const edge = byId.get(change.id);
    if (change.type === 'select' && (!edge || Boolean(edge.selected) === change.selected)) return false;
    touched.add(change.id);
    return true;
  });
}
