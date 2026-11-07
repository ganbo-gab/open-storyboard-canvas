import { CANVAS_NODE_TYPES, isTagGroupNode, type CanvasEdge, type CanvasNode, type CanvasNodeData } from '../domain/canvasNodes';
import { resolveNodeDisplayName } from '../domain/nodeDisplay';
import { buildDuplicateEdge, cloneNodeData, resolveAbsoluteNodePosition } from './clipboardIO';
import { normalizeBatchStacks } from '../application/stacks';

export interface CanvasNodeCopy {
  sourceNodeId: string;
  nodeId: string;
  /** Absolute canvas position; children of a copied group keep their relative position. */
  position?: { x: number; y: number };
}

export interface DuplicatedCanvasGraph {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  idMap: Map<string, string>;
}

function copyData(source: CanvasNode, name: string, idMap: Map<string, string>): CanvasNodeData {
  const data = cloneNodeData(source.data);
  data.displayName = name;
  if (source.type === CANVAS_NODE_TYPES.group) data.label = name;
  if ('isGenerating' in data) data.isGenerating = false;
  if ('isStreaming' in data) data.isStreaming = false;
  for (const key of [
    'generationStartedAt', 'generationJobId', 'generationLastJobId', 'generationProviderId',
    'generationClientSessionId', 'generationError', 'generationErrorDetails', 'generationRetryResultUrl',
  ]) {
    if (key in data) data[key] = null;
  }
  for (const key of ['generationStoryboardMetadata', 'generationDebugContext', 'generationJobState', 'generationJobPhase']) {
    delete data[key];
  }
  if (typeof data.resultNodeId === 'string') data.resultNodeId = idMap.get(data.resultNodeId) ?? null;
  if (isTagGroupNode(source)) {
    data.memberNodeIds = source.data.memberNodeIds.map((id) => idMap.get(id) ?? id);
    if (source.data.legacyMemberTagIds) data.legacyMemberTagIds = source.data.legacyMemberTagIds.map((id) => idMap.get(id) ?? id);
  }
  return data;
}

/** Shared by ⌘D, internal paste and Agent duplicate commands. Callers choose the edge set:
 * paste supplies only internal edges; duplicate supplies every edge touching the selection.
 * Every selected endpoint is remapped exactly once, leaving external endpoints unchanged.
 */
export function duplicateCanvasGraph(input: {
  sourceNodes: CanvasNode[];
  sourceEdges: CanvasEdge[];
  existingNodes: CanvasNode[];
  existingEdges: CanvasEdge[];
  copies: CanvasNodeCopy[];
  offset?: { x: number; y: number };
}): DuplicatedCanvasGraph {
  const idMap = new Map(input.copies.map((copy) => [copy.sourceNodeId, copy.nodeId]));
  const sourceMap = new Map([...input.existingNodes, ...input.sourceNodes].map((node) => [node.id, node]));
  const occupiedNames = new Set(input.existingNodes.map((node) => resolveNodeDisplayName(node.type, node.data)));
  // Copied stacks have independent membership; a partial single-result copy is always visible.
  const copiedBatches = new Map<string, string[]>();
  for (const copy of input.copies) {
    const source = sourceMap.get(copy.sourceNodeId);
    if (typeof source?.data.batchId !== 'string') continue;
    const members = copiedBatches.get(source.data.batchId);
    if (members) members.push(copy.nodeId); else copiedBatches.set(source.data.batchId, [copy.nodeId]);
  }
  const nodes = input.copies.map((copy): CanvasNode => {
    const source = sourceMap.get(copy.sourceNodeId);
    if (!source) throw new Error(`Cannot duplicate missing node ${copy.sourceNodeId}.`);
    const base = resolveNodeDisplayName(source.type, source.data);
    let name = `${base}-副本`;
    for (let index = 2; occupiedNames.has(name); index += 1) name = `${base}-副本${index}`;
    occupiedNames.add(name);
    const parentId = source.parentId ? idMap.get(source.parentId) : undefined;
    const absolute = resolveAbsoluteNodePosition(source, sourceMap);
    const data = copyData(source, name, idMap);
    const batch = typeof source.data.batchId === 'string' ? copiedBatches.get(source.data.batchId) : undefined;
    if (batch) {
      data.batchId = `batch-copy:${batch[0]}`;
      data.batchCollapsed = batch.length > 1 && source.data.batchCollapsed === true;
      data.batchPrimary = batch.length === 1 || source.data.batchPrimary === true;
      data.batchTotal = batch.length;
    }
    const offset = input.offset ?? { x: 44, y: 30 };
    return {
      ...cloneNodeData(source),
      id: copy.nodeId,
      data,
      parentId,
      extent: parentId ? source.extent : undefined,
      position: parentId ? { ...source.position } : copy.position ?? { x: absolute.x + offset.x, y: absolute.y + offset.y },
      selected: false,
      dragging: false,
      hidden: false,
    };
  });
  const existingNodeIds = new Set(input.existingNodes.map((node) => node.id));
  const edgeIds = new Set(input.existingEdges.map((edge) => edge.id));
  const edges = input.sourceEdges.flatMap((edge) => {
    const source = idMap.get(edge.source);
    const target = idMap.get(edge.target);
    if (!source && !target) return [];
    // An internal clipboard can outlive its external neighbors or originating canvas.
    if ((!source && !existingNodeIds.has(edge.source)) || (!target && !existingNodeIds.has(edge.target))) return [];
    return [buildDuplicateEdge(edge, source ?? edge.source, target ?? edge.target, edgeIds)];
  });
  return { nodes: normalizeBatchStacks(nodes), edges, idMap };
}
