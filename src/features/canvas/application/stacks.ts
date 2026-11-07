import type { CanvasNode } from '../domain/canvasNodes';

export interface BatchStack {
  primaryId: string | null;
  memberIds: string[];
  collapsed: boolean;
}

const normalizedNodeArrays = new WeakSet<CanvasNode[]>();

/** Position/measurement-only arrays preserve metadata and selection, so need no stack scan. */
export function retainBatchStackNormalization(nodes: CanvasNode[]): CanvasNode[] {
  normalizedNodeArrays.add(nodes);
  return nodes;
}

/** Batch order is stable across persistence, deletion and graph insertion order. */
export function selectBatchStack(nodes: readonly CanvasNode[], batchId: string): BatchStack {
  const members = nodes.filter((node) => node.data.batchId === batchId).sort((left, right) => {
    const a = typeof left.data.batchIndex === 'number' ? left.data.batchIndex : Number.MAX_SAFE_INTEGER;
    const b = typeof right.data.batchIndex === 'number' ? right.data.batchIndex : Number.MAX_SAFE_INTEGER;
    return a - b || left.id.localeCompare(right.id);
  });
  return {
    primaryId: members.find((node) => node.data.batchPrimary === true)?.id ?? members[0]?.id ?? null,
    memberIds: members.map((node) => node.id),
    collapsed: members.some((node) => node.data.batchCollapsed === true),
  };
}

/** Hidden members stay in the canonical graph, including all their edges and media. */
export function normalizeBatchStacks(nodes: CanvasNode[], previousNodes?: readonly CanvasNode[]): CanvasNode[] {
  if (normalizedNodeArrays.has(nodes)) return nodes;
  const patches = new Map<string, CanvasNode>();
  const batches = new Map<string, CanvasNode[]>();
  for (const node of nodes) {
    const id = node.data.batchId;
    if (typeof id !== 'string' || !id) {
      if (node.hidden) patches.set(node.id, { ...node, hidden: false });
      continue;
    }
    const members = batches.get(id);
    if (members) members.push(node);
    else batches.set(id, [node]);
  }
  for (const [id, members] of batches) {
    const stack = selectBatchStack(members, id);
    if (previousNodes && !members.some((node) => node.data.batchPrimary === true)) {
      const previous = selectBatchStack(previousNodes, id);
      if (previous.primaryId && !stack.memberIds.includes(previous.primaryId)) {
        const index = previous.memberIds.indexOf(previous.primaryId);
        stack.primaryId = [...previous.memberIds.slice(index + 1), ...previous.memberIds.slice(0, index)]
          .find((memberId) => stack.memberIds.includes(memberId)) ?? stack.primaryId;
      }
    }
    const redirectSelection = stack.collapsed && members.some((node) => node.selected && node.id !== stack.primaryId);
    for (const node of members) {
      const primary = node.id === stack.primaryId;
      const hidden = stack.collapsed && !primary;
      const selected = hidden ? false : Boolean(node.selected || (primary && redirectSelection));
      if (node.data.batchPrimary === primary && node.data.batchCollapsed === stack.collapsed
        && Boolean(node.hidden) === hidden && Boolean(node.selected) === selected) continue;
      patches.set(node.id, { ...node, hidden, selected, data: { ...node.data, batchPrimary: primary, batchCollapsed: stack.collapsed } });
    }
  }
  const result = patches.size ? nodes.map((node) => patches.get(node.id) ?? node) : nodes;
  normalizedNodeArrays.add(result);
  return result;
}

export function updateBatchStack(
  nodes: CanvasNode[], batchId: string, patch: { primaryId?: string; collapsed?: boolean },
): CanvasNode[] {
  const stack = selectBatchStack(nodes, batchId);
  if (!stack.primaryId || (patch.primaryId !== undefined && !stack.memberIds.includes(patch.primaryId))) return nodes;
  const primaryId = patch.primaryId ?? stack.primaryId;
  const collapsed = patch.collapsed ?? stack.collapsed;
  if (primaryId === stack.primaryId && collapsed === stack.collapsed) return normalizeBatchStacks(nodes);
  return normalizeBatchStacks(nodes.map((node) => node.data.batchId === batchId
    ? { ...node, data: { ...node.data, batchPrimary: node.id === primaryId, batchCollapsed: collapsed } }
    : node));
}

/** Detach existing results rather than copying media or changing their graph identity. */
export function splitBatchStack(nodes: CanvasNode[], batchId: string): CanvasNode[] {
  if (!nodes.some((node) => node.data.batchId === batchId)) return nodes;
  return normalizeBatchStacks(nodes.map((node): CanvasNode => {
    if (node.data.batchId !== batchId) return node;
    const {
      batchId: _batchId, batchIndex: _batchIndex, batchTotal: _batchTotal,
      batchPrimary: _batchPrimary, batchCollapsed: _batchCollapsed, ...data
    } = node.data;
    return { ...node, hidden: false, data };
  }));
}
