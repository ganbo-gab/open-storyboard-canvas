import {
  CANVAS_NODE_TYPES,
  type CanvasEdge,
  type CanvasNode,
  type CanvasNodeData,
} from '@/features/canvas/domain/canvasNodes';
import { validateCanvasConnection } from './canvasConnectionRules';

export type TagMigrationDiagnosticCode =
  | 'legacy-node-type'
  | 'source-edge-created'
  | 'redundant-source-id-removed'
  | 'conflicting-source-id'
  | 'missing-source-node'
  | 'invalid-source-connection';

export interface TagMigrationDiagnostic {
  code: TagMigrationDiagnosticCode;
  tagNodeId: string;
  sourceNodeId?: string;
  edgeIds?: string[];
  message: string;
}

export interface TagGraphMigrationResult {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  diagnostics: TagMigrationDiagnostic[];
  changed: boolean;
}

function normalizeLegacyNodeType(type: unknown): CanvasNode['type'] | unknown {
  if (type === 'tag' || type === 'tag-node') return CANVAS_NODE_TYPES.tag;
  if (type === 'tagGroup' || type === 'tag-group') return CANVAS_NODE_TYPES.tagGroup;
  return type;
}

function createMigratedEdgeId(edges: CanvasEdge[], sourceNodeId: string, tagNodeId: string): string {
  const base = `e-${sourceNodeId}-${tagNodeId}`;
  if (!edges.some((edge) => edge.id === base)) return base;
  let suffix = 2;
  while (edges.some((edge) => edge.id === `${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export function migrateLegacyTagGraph(
  inputNodes: CanvasNode[],
  inputEdges: CanvasEdge[],
): TagGraphMigrationResult {
  const diagnostics: TagMigrationDiagnostic[] = [];
  let changed = false;
  const nodes = inputNodes.map((node) => {
    const normalizedType = normalizeLegacyNodeType(node?.type);
    const hasLegacyType = normalizedType !== node?.type;
    const data = node?.data && typeof node.data === 'object'
      ? { ...(node.data as Record<string, unknown>) }
      : {};

    if (hasLegacyType) {
      changed = true;
      diagnostics.push({
        code: 'legacy-node-type',
        tagNodeId: node.id,
        message: `Migrated legacy node type ${String(node.type)} to ${String(normalizedType)}.`,
      });
    }

    if (normalizedType === CANVAS_NODE_TYPES.tagGroup) {
      if (!Array.isArray(data.memberTagIds) && Array.isArray(data.tagIds)) {
        data.memberTagIds = data.tagIds;
        delete data.tagIds;
        changed = true;
      }
    }

    return {
      ...node,
      type: normalizedType as CanvasNode['type'],
      data: data as CanvasNodeData,
    };
  });

  const nodesById = new Map(nodes.map((node) => [node.id, node] as const));
  const edges = inputEdges.map((edge) => ({ ...edge }));

  nodes.forEach((node, nodeIndex) => {
    if (node.type !== CANVAS_NODE_TYPES.tag) return;
    const data = node.data as Record<string, unknown>;
    const sourceNodeId = typeof data.sourceId === 'string' ? data.sourceId.trim() : '';
    if (!Object.prototype.hasOwnProperty.call(data, 'sourceId')) return;

    const nextData = { ...data };
    delete nextData.sourceId;
    nodes[nodeIndex] = { ...node, data: nextData as CanvasNodeData };
    changed = true;

    if (!sourceNodeId) {
      diagnostics.push({
        code: 'redundant-source-id-removed',
        tagNodeId: node.id,
        message: 'Removed an empty legacy tag sourceId.',
      });
      return;
    }

    const incoming = edges.filter((edge) => edge.target === node.id);
    if (incoming.length > 0) {
      const exact = incoming.find((edge) => edge.source === sourceNodeId);
      diagnostics.push(exact && incoming.length === 1
        ? {
            code: 'redundant-source-id-removed',
            tagNodeId: node.id,
            sourceNodeId,
            edgeIds: incoming.map((edge) => edge.id),
            message: 'Removed a redundant legacy sourceId because the matching edge already exists.',
          }
        : {
            code: 'conflicting-source-id',
            tagNodeId: node.id,
            sourceNodeId,
            edgeIds: incoming.map((edge) => edge.id),
            message: 'Legacy sourceId conflicts with persisted tag edges; existing edges were preserved without guessing.',
          });
      return;
    }

    const sourceNode = nodesById.get(sourceNodeId);
    if (!sourceNode) {
      diagnostics.push({
        code: 'missing-source-node',
        tagNodeId: node.id,
        sourceNodeId,
        message: 'Legacy tag sourceId points to a missing node; no edge was created.',
      });
      return;
    }
    const connection = validateCanvasConnection(sourceNode.id, node.id, nodes, edges);
    if (!connection.valid || connection.existingEdgeId) {
      diagnostics.push({
        code: 'invalid-source-connection',
        tagNodeId: node.id,
        sourceNodeId,
        message: connection.message
          ?? 'Legacy tag sourceId cannot form a legal canvas connection; no edge was created.',
      });
      return;
    }

    const edgeId = createMigratedEdgeId(edges, sourceNode.id, node.id);
    edges.push({
      id: edgeId,
      source: sourceNode.id,
      target: node.id,
      sourceHandle: 'source',
      targetHandle: 'target',
      type: 'disconnectableEdge',
    });
    diagnostics.push({
      code: 'source-edge-created',
      tagNodeId: node.id,
      sourceNodeId,
      edgeIds: [edgeId],
      message: 'Converted legacy tag sourceId into the tag source edge.',
    });
  });

  return { nodes, edges, diagnostics, changed };
}

export function reportTagMigrationDiagnostics(
  scope: string,
  diagnostics: TagMigrationDiagnostic[],
): void {
  if (diagnostics.length === 0) return;
  console.warn(`[tag-migration:${scope}]`, diagnostics);
}
