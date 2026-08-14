import {
  CANVAS_NODE_TYPES,
  isTagGroupNode,
  isTagNode,
  type CanvasEdge,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';
import {
  nodeHasSourceHandle,
  nodeHasTargetHandle,
} from '@/features/canvas/domain/nodeRegistry';

const TAG_GROUP_REFERENCE_TARGET_TYPES = new Set<CanvasNode['type']>([
  CANVAS_NODE_TYPES.imageEdit,
  CANVAS_NODE_TYPES.aiVideo,
  CANVAS_NODE_TYPES.aiText,
  CANVAS_NODE_TYPES.aiAudio,
  CANVAS_NODE_TYPES.storyboardGen,
  CANVAS_NODE_TYPES.panorama,
]);

export interface CanvasConnectionValidation {
  valid: boolean;
  code?: 'missing-node' | 'unsupported' | 'self-connection' | 'duplicate' | 'tag-source-conflict' | 'tag-cycle' | 'tag-group-target';
  message?: string;
  existingEdgeId?: string;
}

function graphReaches(
  startNodeId: string,
  targetNodeId: string,
  edges: CanvasEdge[],
): boolean {
  const outgoingBySource = new Map<string, string[]>();
  edges.forEach((edge) => {
    const targets = outgoingBySource.get(edge.source);
    if (targets) targets.push(edge.target);
    else outgoingBySource.set(edge.source, [edge.target]);
  });
  const pending = [startNodeId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const currentId = pending.pop() as string;
    if (currentId === targetNodeId) return true;
    if (visited.has(currentId)) continue;
    visited.add(currentId);
    (outgoingBySource.get(currentId) ?? []).forEach((targetId) => pending.push(targetId));
  }
  return false;
}

export function validateCanvasConnection(
  sourceNodeId: string,
  targetNodeId: string,
  nodes: CanvasNode[],
  edges: CanvasEdge[],
): CanvasConnectionValidation {
  const source = nodes.find((node) => node.id === sourceNodeId);
  const target = nodes.find((node) => node.id === targetNodeId);
  if (!source || !target) {
    return { valid: false, code: 'missing-node', message: 'Cannot connect missing source or target node.' };
  }
  if (source.id === target.id) {
    return { valid: false, code: 'self-connection', message: 'A node cannot connect to itself.' };
  }
  if (!nodeHasSourceHandle(source.type) || !nodeHasTargetHandle(target.type)) {
    return { valid: false, code: 'unsupported', message: `Nodes ${source.id} and ${target.id} are not connectable.` };
  }
  if (isTagGroupNode(source) && !TAG_GROUP_REFERENCE_TARGET_TYPES.has(target.type)) {
    return {
      valid: false,
      code: 'tag-group-target',
      message: `Tag group ${source.id} can only connect to a supported AI generation node.`,
    };
  }
  const existing = edges.find((edge) => edge.source === source.id && edge.target === target.id);
  if (existing) {
    return {
      valid: true,
      code: 'duplicate',
      message: `Connection ${existing.id} already exists.`,
      existingEdgeId: existing.id,
    };
  }
  if (isTagNode(source) || isTagNode(target)) {
    if (graphReaches(target.id, source.id, edges)) {
      return {
        valid: false,
        code: 'tag-cycle',
        message: `Connecting ${source.id} to ${target.id} would create a tag cycle.`,
      };
    }
  }
  if (isTagNode(target)) {
    const conflictingSourceEdge = edges.find((edge) => edge.target === target.id && edge.source !== source.id);
    if (conflictingSourceEdge) {
      return {
        valid: false,
        code: 'tag-source-conflict',
        message: `Tag ${target.id} already has an upstream source.`,
        existingEdgeId: conflictingSourceEdge.id,
      };
    }
  }
  return { valid: true };
}
