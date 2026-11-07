import { CANVAS_NODE_TYPES, type CanvasNode, type CanvasNodeType } from '../domain/canvasNodes';
import { resolveNodeDisplayName } from '../domain/nodeDisplay';

export interface CanvasNodeTreeGroup {
  kind: CanvasNodeType;
  count: number;
  items: Array<{ nodeId: string; title: string; parentId?: string }>;
}

/** Stable type order, authored node order; geometry/selection do not affect the content tree. */
export function buildCanvasNodeTree(nodes: readonly CanvasNode[]): CanvasNodeTreeGroup[] {
  const groups = new Map<CanvasNodeType, CanvasNodeTreeGroup>();
  for (const node of nodes) {
    let group = groups.get(node.type);
    if (!group) { group = { kind: node.type, count: 0, items: [] }; groups.set(node.type, group); }
    group.count += 1;
    group.items.push({ nodeId: node.id, title: resolveNodeDisplayName(node.type, node.data), ...(node.parentId ? { parentId: node.parentId } : {}) });
  }
  return Object.values(CANVAS_NODE_TYPES).flatMap((kind) => groups.get(kind) ?? []);
}
