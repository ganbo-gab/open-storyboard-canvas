import { isTagGroupNode, type CanvasEdge, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { layoutLayered, type LayoutNode } from './autoLayout';

function sizeOf(node: CanvasNode): { width: number; height: number } {
  const style = node.style ?? {};
  return {
    width: node.measured?.width ?? node.width ?? (typeof style.width === 'number' ? style.width : 320),
    height: node.measured?.height ?? node.height ?? (typeof style.height === 'number' ? style.height : 220),
  };
}

/**
 * Plan "整理画布": top-level nodes are laid out left→right by data flow. A tag group and its
 * members move as one rigid block so frames never detach from what they label; grouped
 * children move with their group because their positions are parent-relative.
 */
export function planOrganizeCanvas(nodes: CanvasNode[], edges: CanvasEdge[]): Array<{ nodeId: string; position: { x: number; y: number } }> {
  const blockOf = new Map<string, string>();
  for (const node of nodes) {
    if (!isTagGroupNode(node)) continue;
    for (const memberId of node.data.memberNodeIds) blockOf.set(memberId, node.id);
  }

  // Top-level only: group children are parent-relative and travel with their group.
  const layoutNodes: LayoutNode[] = nodes
    .filter((node) => !node.parentId && !blockOf.has(node.id))
    .map((node) => ({ id: node.id, x: node.position.x, y: node.position.y, ...sizeOf(node) }));
  if (layoutNodes.length < 2) return [];

  const layoutEdges = edges.map((edge) => ({
    source: blockOf.get(edge.source) ?? edge.source,
    target: blockOf.get(edge.target) ?? edge.target,
  }));
  const placed = layoutLayered(layoutNodes, layoutEdges);

  const moves: Array<{ nodeId: string; position: { x: number; y: number } }> = [];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  for (const [id, position] of placed) {
    const node = nodeById.get(id);
    if (!node) continue;
    const dx = position.x - node.position.x;
    const dy = position.y - node.position.y;
    if (dx === 0 && dy === 0) continue;
    moves.push({ nodeId: id, position });
    if (!isTagGroupNode(node)) continue;
    for (const memberId of node.data.memberNodeIds) {
      const member = nodeById.get(memberId);
      if (member && !member.parentId) {
        moves.push({ nodeId: memberId, position: { x: member.position.x + dx, y: member.position.y + dy } });
      }
    }
  }
  return moves;
}
