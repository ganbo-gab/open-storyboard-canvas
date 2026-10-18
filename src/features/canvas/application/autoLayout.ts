export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutEdge {
  source: string;
  target: string;
}

const COLUMN_GAP = 120;
const ROW_GAP = 56;

/**
 * Left-to-right layered layout for "整理画布": every edge points to a later column
 * (longest-path ranking), nodes keep their relative vertical order inside a column
 * (barycenter of their inputs), and the result starts at the graph's current top-left
 * so the user does not lose their place. Cycles are broken by ignoring back edges.
 */
export function layoutLayered(nodes: LayoutNode[], edges: LayoutEdge[]): Map<string, { x: number; y: number }> {
  const result = new Map<string, { x: number; y: number }>();
  if (nodes.length === 0) return result;

  const ids = new Set(nodes.map((node) => node.id));
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const node of nodes) {
    incoming.set(node.id, []);
    outgoing.set(node.id, []);
  }
  for (const edge of edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target) || edge.source === edge.target) continue;
    outgoing.get(edge.source)!.push(edge.target);
    incoming.get(edge.target)!.push(edge.source);
  }

  // Kahn order; leftovers (cycles) are appended in original vertical order.
  const indegree = new Map(nodes.map((node) => [node.id, incoming.get(node.id)!.length]));
  const byY = [...nodes].sort((a, b) => a.y - b.y || a.x - b.x);
  const queue = byY.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  const order: string[] = [];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    order.push(id);
    for (const next of outgoing.get(id)!) {
      const remaining = indegree.get(next)! - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }
  for (const node of byY) {
    if (!visited.has(node.id)) order.push(node.id);
  }

  const position = new Map(order.map((id, index) => [id, index]));
  const rank = new Map<string, number>();
  for (const id of order) {
    let value = 0;
    for (const source of incoming.get(id)!) {
      if (position.get(source)! < position.get(id)!) value = Math.max(value, (rank.get(source) ?? 0) + 1);
    }
    rank.set(id, value);
  }

  const columns: string[][] = [];
  for (const id of order) {
    const column = rank.get(id)!;
    (columns[column] ??= []).push(id);
  }

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const originX = Math.min(...nodes.map((node) => node.x));
  const originY = Math.min(...nodes.map((node) => node.y));
  const rowIndex = new Map<string, number>();
  let x = originX;
  for (const column of columns) {
    if (!column) continue;
    column.sort((a, b) => barycenter(a) - barycenter(b));
    let y = originY;
    let width = 0;
    column.forEach((id, index) => {
      const node = nodeById.get(id)!;
      result.set(id, { x, y });
      rowIndex.set(id, index);
      y += node.height + ROW_GAP;
      width = Math.max(width, node.width);
    });
    x += width + COLUMN_GAP;
  }
  return result;

  function barycenter(id: string): number {
    const sources = incoming.get(id)!.filter((source) => rowIndex.has(source));
    if (sources.length === 0) return nodeById.get(id)!.y;
    const mean = sources.reduce((sum, source) => sum + result.get(source)!.y, 0) / sources.length;
    return mean;
  }
}
