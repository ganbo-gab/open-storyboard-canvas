import {
  CANVAS_NODE_TYPES,
  isTagGroupNode,
  isTagNode,
  type CanvasEdge,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';
import { nodeHasSourceHandle, nodeHasTargetHandle } from '@/features/canvas/domain/nodeRegistry';

const TAG_GROUP_REFERENCE_TARGET_TYPES = new Set<CanvasNode['type']>([
  CANVAS_NODE_TYPES.imageEdit,
  CANVAS_NODE_TYPES.aiVideo,
  CANVAS_NODE_TYPES.aiText,
  CANVAS_NODE_TYPES.aiAudio,
  CANVAS_NODE_TYPES.storyboardGen,
  CANVAS_NODE_TYPES.panorama,
]);

const MATERIAL_TYPES = new Set<CanvasNode['type']>([
  CANVAS_NODE_TYPES.upload,
  CANVAS_NODE_TYPES.exportImage,
  CANVAS_NODE_TYPES.video,
  CANVAS_NODE_TYPES.audio,
]);

export type ConnectionKind = 'image' | 'video' | 'audio' | 'text' | 'stage';
export type ConnectionRejectReason =
  | { type: 'missingNode'; endpoint: 'source' | 'target' }
  | { type: 'selfConnection' }
  | { type: 'targetIsMaterial' }
  | { type: 'sourceNotConnectable' }
  | { type: 'targetNotConnectable' }
  | { type: 'invalidHandle'; endpoint: 'source' | 'target'; handleId: string }
  | { type: 'kindMismatch'; expected: readonly ConnectionKind[]; actual: ConnectionKind }
  | { type: 'cycle' }
  | { type: 'duplicate'; existingEdgeId: string }
  | { type: 'tagSourceConflict'; existingEdgeId: string }
  | { type: 'tagGroupTarget' };

export type ConnectionExplanation = { ok: true } | { ok: false; reason: ConnectionRejectReason };

export interface ConnectionHandles {
  sourceHandle?: string | null;
  targetHandle?: string | null;
  /** Include the current graph to explain duplicate, cycle, and tag-proxy failures. */
  nodes?: readonly CanvasNode[];
  edges?: readonly CanvasEdge[];
}

export interface CanvasConnectionOptions {
  /** Internal generation/tool result wiring, never a manual reference connection. */
  provenance?: 'generationResult';
}

const INPUT_KINDS: Partial<Record<CanvasNode['type'], readonly ConnectionKind[]>> = {
  [CANVAS_NODE_TYPES.imageEdit]: ['image', 'text'],
  [CANVAS_NODE_TYPES.storyboardGen]: ['image', 'text'],
  [CANVAS_NODE_TYPES.storyboardSplit]: ['image'],
  [CANVAS_NODE_TYPES.panorama]: ['image', 'text'],
  [CANVAS_NODE_TYPES.aiText]: ['text', 'image'],
  [CANVAS_NODE_TYPES.aiAudio]: ['text', 'audio'],
  [CANVAS_NODE_TYPES.aiVideo]: ['image', 'video', 'audio', 'text'],
  [CANVAS_NODE_TYPES.textAnnotation]: ['text'],
  [CANVAS_NODE_TYPES.jsonCard]: ['text'],
  [CANVAS_NODE_TYPES.blueprint]: ['image', 'text'],
};

const OUTPUT_KINDS: Partial<Record<CanvasNode['type'], ConnectionKind>> = {
  [CANVAS_NODE_TYPES.upload]: 'image',
  [CANVAS_NODE_TYPES.exportImage]: 'image',
  [CANVAS_NODE_TYPES.imageEdit]: 'image',
  [CANVAS_NODE_TYPES.storyboardGen]: 'image',
  [CANVAS_NODE_TYPES.storyboardSplit]: 'image',
  [CANVAS_NODE_TYPES.panorama]: 'image',
  [CANVAS_NODE_TYPES.video]: 'video',
  [CANVAS_NODE_TYPES.aiVideo]: 'video',
  [CANVAS_NODE_TYPES.audio]: 'audio',
  [CANVAS_NODE_TYPES.aiAudio]: 'audio',
  [CANVAS_NODE_TYPES.textAnnotation]: 'text',
  [CANVAS_NODE_TYPES.jsonCard]: 'text',
  [CANVAS_NODE_TYPES.aiText]: 'text',
  [CANVAS_NODE_TYPES.blueprint]: 'stage',
};

function graphReaches(startNodeId: string, targetNodeId: string, edges: readonly CanvasEdge[]): boolean {
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = outgoing.get(edge.source);
    if (targets) targets.push(edge.target);
    else outgoing.set(edge.source, [edge.target]);
  }
  const pending = [startNodeId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const id = pending.pop() as string;
    if (id === targetNodeId) return true;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const target of outgoing.get(id) ?? []) pending.push(target);
  }
  return false;
}

function outputKinds(node: CanvasNode, nodes: readonly CanvasNode[], edges: readonly CanvasEdge[], visiting = new Set<string>()): ConnectionKind[] {
  if (visiting.has(node.id)) return [];
  const kind = OUTPUT_KINDS[node.type];
  if (kind) return [kind];
  visiting.add(node.id);
  const sourceIds = isTagGroupNode(node)
    ? node.data.memberNodeIds
    : isTagNode(node) ? edges.filter((edge) => edge.target === node.id).map((edge) => edge.source) : [];
  const kinds: ConnectionKind[] = [];
  for (const id of sourceIds) {
    const source = nodes.find((candidate) => candidate.id === id);
    if (source) kinds.push(...outputKinds(source, nodes, edges, visiting));
  }
  visiting.delete(node.id);
  return kinds;
}

/** Explains new manual/reference connections. Persisted generation-to-result provenance
 * edges remain intact; material/result cards cannot be the target of a new reference edge.
 * Omitted handles mean the standard right-output/left-input whole-card drop targets.
 */
function inspectConnection(
  source: CanvasNode | null | undefined,
  target: CanvasNode | null | undefined,
  handles: ConnectionHandles,
  provenance?: 'generationResult',
): ConnectionExplanation {
  if (!source) return { ok: false, reason: { type: 'missingNode', endpoint: 'source' } };
  if (!target) return { ok: false, reason: { type: 'missingNode', endpoint: 'target' } };
  if (source.id === target.id) return { ok: false, reason: { type: 'selfConnection' } };
  if (MATERIAL_TYPES.has(target.type) && provenance !== 'generationResult') return { ok: false, reason: { type: 'targetIsMaterial' } };
  if (!nodeHasSourceHandle(source.type)) return { ok: false, reason: { type: 'sourceNotConnectable' } };
  if (!nodeHasTargetHandle(target.type)) return { ok: false, reason: { type: 'targetNotConnectable' } };
  if (handles.sourceHandle && handles.sourceHandle !== 'source') return { ok: false, reason: { type: 'invalidHandle', endpoint: 'source', handleId: handles.sourceHandle } };
  if (handles.targetHandle && handles.targetHandle !== 'target') return { ok: false, reason: { type: 'invalidHandle', endpoint: 'target', handleId: handles.targetHandle } };
  if (isTagGroupNode(source) && !TAG_GROUP_REFERENCE_TARGET_TYPES.has(target.type)) return { ok: false, reason: { type: 'tagGroupTarget' } };
  const edges = handles.edges ?? [];
  const existing = edges.find((edge) => edge.source === source.id && edge.target === target.id);
  if (existing) return { ok: false, reason: { type: 'duplicate', existingEdgeId: existing.id } };
  if (graphReaches(target.id, source.id, edges)) return { ok: false, reason: { type: 'cycle' } };
  if (isTagNode(target)) {
    const conflict = edges.find((edge) => edge.target === target.id && edge.source !== source.id);
    if (conflict) return { ok: false, reason: { type: 'tagSourceConflict', existingEdgeId: conflict.id } };
  }
  const expected = INPUT_KINDS[target.type];
  if (expected) {
    const actual = outputKinds(source, handles.nodes ?? [source, target], edges).find((kind) => !expected.includes(kind));
    if (actual) return { ok: false, reason: { type: 'kindMismatch', expected, actual } };
  }
  return { ok: true };
}

export function explainConnection(
  source: CanvasNode | null | undefined,
  target: CanvasNode | null | undefined,
  handles: ConnectionHandles = {},
): ConnectionExplanation {
  return inspectConnection(source, target, handles);
}

/**
 * Whether a user may drag a connection into this node type. Material/result cards keep their
 * physical target handle (internal generation-result edges) but refuse manual input.
 */
export function nodeAcceptsManualInput(type: CanvasNode['type']): boolean {
  return nodeHasTargetHandle(type) && !MATERIAL_TYPES.has(type);
}

export interface CanvasConnectionValidation {
  valid: boolean;
  code?: 'missing-node' | 'unsupported' | 'self-connection' | 'duplicate' | 'tag-source-conflict' | 'tag-cycle' | 'tag-group-target' | 'target-material' | 'kind-mismatch' | 'cycle';
  message?: string;
  existingEdgeId?: string;
  reason?: ConnectionRejectReason;
}

/** Command/store validation keeps exact duplicates idempotent; drag validation uses
 * explainConnection directly so a duplicate target still shows the rejection reason.
 */
export function validateCanvasConnection(sourceNodeId: string, targetNodeId: string, nodes: CanvasNode[], edges: CanvasEdge[], options: CanvasConnectionOptions = {}): CanvasConnectionValidation {
  const source = nodes.find((node) => node.id === sourceNodeId);
  const target = nodes.find((node) => node.id === targetNodeId);
  const explanation = inspectConnection(source, target, { nodes, edges }, options.provenance);
  if (explanation.ok) return { valid: true };
  const reason = explanation.reason;
  switch (reason.type) {
    case 'missingNode': return { valid: false, code: 'missing-node', message: `Cannot connect missing ${reason.endpoint} node.`, reason };
    case 'selfConnection': return { valid: false, code: 'self-connection', message: 'A node cannot connect to itself.', reason };
    case 'targetIsMaterial': return { valid: false, code: 'target-material', message: 'Material and media result nodes can only be upstream references.', reason };
    case 'sourceNotConnectable':
    case 'targetNotConnectable':
    case 'invalidHandle': return { valid: false, code: 'unsupported', message: 'Connect the source output to a supported target input.', reason };
    case 'tagGroupTarget': return { valid: false, code: 'tag-group-target', message: 'Tag groups can only connect to supported AI generation nodes.', reason };
    case 'duplicate': return { valid: true, code: 'duplicate', existingEdgeId: reason.existingEdgeId, message: `Connection ${reason.existingEdgeId} already exists.`, reason };
    case 'cycle': return { valid: false, code: source && target && (isTagNode(source) || isTagNode(target)) ? 'tag-cycle' : 'cycle', message: 'This connection would create a cycle.', reason };
    case 'tagSourceConflict': return { valid: false, code: 'tag-source-conflict', existingEdgeId: reason.existingEdgeId, message: 'The tag already has an upstream source.', reason };
    case 'kindMismatch': return { valid: false, code: 'kind-mismatch', message: `Expected ${reason.expected.join(' or ')} references, received ${reason.actual}.`, reason };
  }
}
