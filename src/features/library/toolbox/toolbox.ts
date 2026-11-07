import { CANVAS_NODE_TYPES, type CanvasNode, type CanvasEdge } from '@/features/canvas/domain/canvasNodes';
import { canvasCapabilityManifest } from '@/features/canvas/domain/canvasCapabilities';
import { duplicateCanvasGraph, type DuplicatedCanvasGraph } from '@/features/canvas/clipboard/canvasDuplication';
import { cloneNodeData, collectNodeIdsWithDescendants, createUiNodeId, getNodeSize, resolveAbsoluteNodePosition, sortNodesForDuplication } from '@/features/canvas/clipboard/clipboardIO';
import { externalizeAssetMedia } from '@/features/assets/application/assetMediaStorage';

export interface ToolboxTemplate {
  id: string;
  name: string;
  color?: string;
  createdAt: number;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  bounds: { x: number; y: number; width: number; height: number };
}
export class ToolboxError extends Error {
  constructor(public readonly code: 'not-group' | 'invalid-template' | 'cycle' | 'id-collision' | 'revision-conflict', message: string, public readonly nodeIds: string[] = []) { super(message); this.name = 'ToolboxError'; }
}
/** Captures synchronously before externalizing media, so concurrent canvas edits cannot change the snapshot. */
export async function saveGroupAsTemplate(groupNodeId: string, nodes: CanvasNode[], edges: CanvasEdge[], options: { name?: string; color?: string; id?: string; createdAt?: number; externalize?: typeof externalizeAssetMedia } = {}): Promise<ToolboxTemplate> {
  const group = nodes.find(node => node.id === groupNodeId);
  if (!group || group.type !== CANVAS_NODE_TYPES.group) throw new ToolboxError('not-group', 'Select a group to save as a template');
  const ids = new Set(collectNodeIdsWithDescendants(nodes, [groupNodeId]));
  const nodeMap = new Map(nodes.map(node => [node.id, node]));
  const origin = resolveAbsoluteNodePosition(group, nodeMap);
  const captured = sortNodesForDuplication(nodes.filter(node => ids.has(node.id))).map(node => {
    const copy = cloneNodeData(node);
    copy.selected = false; copy.dragging = false;
    if (copy.id === groupNodeId) { copy.position = { x: 0, y: 0 }; delete copy.parentId; delete copy.extent; }
    if (Array.isArray(copy.data.memberNodeIds)) copy.data.memberNodeIds = copy.data.memberNodeIds.filter((id: unknown) => typeof id === 'string' && ids.has(id));
    return copy;
  });
  let minX = origin.x; let minY = origin.y; let maxX = origin.x; let maxY = origin.y;
  for (const node of nodes) {
    if (!ids.has(node.id)) continue;
    const point = resolveAbsoluteNodePosition(node, nodeMap); const size = getNodeSize(node);
    minX = Math.min(minX, point.x); minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x + size.width); maxY = Math.max(maxY, point.y + size.height);
  }
  const template: ToolboxTemplate = { id: options.id ?? `template:${crypto.randomUUID()}`, name: options.name?.trim() || String(group.data.displayName ?? group.data.label ?? 'Group'), color: options.color, createdAt: options.createdAt ?? Date.now(), nodes: captured, edges: edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)).map(edge => cloneNodeData(edge)), bounds: { x: minX - origin.x, y: minY - origin.y, width: maxX - minX, height: maxY - minY } };
  return await (options.externalize ?? externalizeAssetMedia)(template);
}
export function instantiateTemplate(template: ToolboxTemplate, position: { x: number; y: number }, options: { existingNodes?: CanvasNode[]; existingEdges?: CanvasEdge[]; createNodeId?: (node: CanvasNode) => string } = {}): DuplicatedCanvasGraph {
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y) || !template.nodes.length || new Set(template.nodes.map(node => node.id)).size !== template.nodes.length) throw new ToolboxError('invalid-template', 'Invalid template graph or position');
  const ids = new Set(template.nodes.map(node => node.id));
  if (template.edges.some(edge => !ids.has(edge.source) || !ids.has(edge.target)) || template.nodes.some(node => node.parentId && !ids.has(node.parentId))) throw new ToolboxError('invalid-template', 'Template contains an external connection');
  const existingNodes = options.existingNodes ?? [];
  const occupied = new Set([...existingNodes.map(node => node.id), ...ids]);
  const copies = sortNodesForDuplication(template.nodes).map(node => {
    const nodeId = options.createNodeId?.(node) ?? createUiNodeId(node.type);
    if (occupied.has(nodeId)) throw new ToolboxError('id-collision', 'Template instance ids must be fresh');
    occupied.add(nodeId); return { sourceNodeId: node.id, nodeId };
  });
  const graph = duplicateCanvasGraph({ sourceNodes: template.nodes, sourceEdges: template.edges, existingNodes, existingEdges: options.existingEdges ?? [], copies, offset: { x: position.x - template.bounds.x, y: position.y - template.bounds.y } });
  for (const node of graph.nodes) {
    for (const key of Object.keys(node.data)) {
      if (key.startsWith('generation') || ['batchId', 'batchIndex', 'batchTotal', 'batchPrimary', 'batchCollapsed', 'lastRunInputHash', 'lastPreparedPayload', 'lastPayloadDiagnostics', 'lastError'].includes(key)) delete node.data[key];
    }
    if ('isGenerating' in node.data) node.data.isGenerating = false;
    node.hidden = false;
    if ('isStreaming' in node.data) node.data.isStreaming = false;
    if (typeof node.data.sourceAiNodeId === 'string') node.data.sourceAiNodeId = graph.idMap.get(node.data.sourceAiNodeId) ?? null;
  }
  return graph;
}
/** Includes non-generation intermediates when ordering dependencies, then emits only enabled generators. */
export function executionOrder(subgraph: Pick<ToolboxTemplate, 'nodes' | 'edges'>): string[] {
  const nodes = new Map(subgraph.nodes.map(node => [node.id, node]));
  const incoming = new Map(subgraph.nodes.map(node => [node.id, 0]));
  const outgoing = new Map<string, Set<string>>();
  for (const edge of subgraph.edges) {
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) continue;
    const targets = outgoing.get(edge.source) ?? new Set<string>();
    if (!targets.has(edge.target)) incoming.set(edge.target, incoming.get(edge.target)! + 1);
    targets.add(edge.target); outgoing.set(edge.source, targets);
  }
  const ready = subgraph.nodes.filter(node => incoming.get(node.id) === 0).map(node => node.id);
  const order: string[] = [];
  for (let index = 0; index < ready.length; index++) {
    const id = ready[index]; order.push(id);
    for (const target of outgoing.get(id) ?? []) { const degree = incoming.get(target)! - 1; incoming.set(target, degree); if (degree === 0) ready.push(target); }
  }
  if (order.length !== nodes.size) throw new ToolboxError('cycle', 'Group contains a dependency cycle', [...incoming].filter(([, count]) => count > 0).map(([id]) => id));
  const generators = new Set<string>(canvasCapabilityManifest.generationNodeTypes);
  return order.filter(id => { const node = nodes.get(id)!; return generators.has(node.type) && node.data.enabled !== false; });
}
