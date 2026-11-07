import { createCanvasHistoryEntry, type CanvasGraph } from '@/stores/canvasHistory';

export interface AgentGraphApprovalTargets {
  approvalId: string;
  nodeIds: readonly string[];
  edgeIds: readonly string[];
}

/** A successful sibling may advance the revision only across its own declared graph resources. */
export function independentSiblingApprovalIds(
  executed: AgentGraphApprovalTargets,
  siblings: readonly AgentGraphApprovalTargets[],
  before: CanvasGraph,
  after: CanvasGraph,
): string[] {
  if (!siblings.length || (!executed.nodeIds.length && !executed.edgeIds.length)) return [];
  const nodes = new Set(executed.nodeIds);
  const edges = new Set(executed.edgeIds);
  const unchangedBefore = { nodes: before.nodes.filter((node) => !nodes.has(node.id)), edges: before.edges.filter((edge) => !edges.has(edge.id)) };
  const unchangedAfter = { nodes: after.nodes.filter((node) => !nodes.has(node.id)), edges: after.edges.filter((edge) => !edges.has(edge.id)) };
  // Uses the same semantic graph comparison as undo: selection-only changes are not graph edits.
  if (createCanvasHistoryEntry(unchangedBefore, unchangedAfter)) return [];
  return siblings.filter((sibling) => (sibling.nodeIds.length > 0 || sibling.edgeIds.length > 0)
    && sibling.nodeIds.every((id) => !nodes.has(id))
    && sibling.edgeIds.every((id) => !edges.has(id)))
    .map((sibling) => sibling.approvalId);
}
