import type { CanvasNode } from './canvasNodes';

/**
 * Canvas selection has exactly one source of truth: `node.selected`.
 * `selectedNodeId` is derived — it names the node only when exactly one node is selected.
 */
export function deriveSelectedNodeId(nodes: readonly CanvasNode[]): string | null {
  let selectedId: string | null = null;
  for (const node of nodes) {
    if (!node.selected) continue;
    if (selectedId !== null) return null;
    selectedId = node.id;
  }
  return selectedId;
}

export function getSelectedNodeIds(nodes: readonly CanvasNode[]): string[] {
  const ids: string[] = [];
  for (const node of nodes) {
    if (node.selected) ids.push(node.id);
  }
  return ids;
}

/** Select exactly `nodeIds`; returns the input array when no flag changes. */
export function selectNodesExclusive(nodes: CanvasNode[], nodeIds: Iterable<string>): CanvasNode[] {
  const wanted = new Set(nodeIds);
  let changed = false;
  const next = nodes.map((node) => {
    const selected = wanted.has(node.id);
    if (Boolean(node.selected) === selected) return node;
    changed = true;
    return { ...node, selected };
  });
  return changed ? next : nodes;
}

/** Selection is not part of history: keep the live selection when swapping in a snapshot. */
export function carrySelection(target: CanvasNode[], current: readonly CanvasNode[]): CanvasNode[] {
  const selected = new Set(getSelectedNodeIds(current));
  return selectNodesExclusive(target, selected);
}
