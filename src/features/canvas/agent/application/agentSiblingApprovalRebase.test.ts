import { describe, expect, it } from 'vitest';
import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import type { CanvasGraph } from '@/stores/canvasHistory';
import { independentSiblingApprovalIds } from './agentSiblingApprovalRebase';

const node = (id: string, content = id): CanvasNode => ({ id, type: CANVAS_NODE_TYPES.textAnnotation, position: { x: 0, y: 0 }, data: { content } });
const executed = { approvalId: 'executed', nodeIds: ['left'], edgeIds: [] };
const siblings = [{ approvalId: 'right-edit', nodeIds: ['right'], edgeIds: [] }];
const before: CanvasGraph = { nodes: [node('left'), node('right'), node('unrelated')], edges: [] };

describe('same-batch independent graph approval rebasing', () => {
  it('permits an independent sibling when only the approved resources changed', () => {
    const after = { ...before, nodes: [node('left', 'Approved change'), ...before.nodes.slice(1)] };
    expect(independentSiblingApprovalIds(executed, siblings, before, after)).toEqual(['right-edit']);
  });
  it('does not rebase an overlapping target even after a successful approved edit', () => {
    const after = { ...before, nodes: [node('left', 'Approved change'), ...before.nodes.slice(1)] };
    expect(independentSiblingApprovalIds(executed, [{ approvalId: 'overlap', nodeIds: ['left'], edgeIds: [] }], before, after)).toEqual([]);
  });
  it.each(['right', 'unrelated'])('rejects intervening graph changes on %s', (id) => {
    const after = { ...before, nodes: before.nodes.map((item) => item.id === 'left' ? node('left', 'Approved change') : item.id === id ? node(id, 'User edit') : item) };
    expect(independentSiblingApprovalIds(executed, siblings, before, after)).toEqual([]);
  });
  it('rejects undeclared edge edits and node insertion or deletion', () => {
    const after = { ...before, nodes: [node('left', 'Approved change'), ...before.nodes.slice(1)] };
    expect(independentSiblingApprovalIds(executed, siblings, before, { ...after, edges: [{ id: 'new-edge', source: 'left', target: 'right' }] })).toEqual([]);
    expect(independentSiblingApprovalIds(executed, siblings, before, { ...after, nodes: [...after.nodes, node('new-node')] })).toEqual([]);
    expect(independentSiblingApprovalIds(executed, siblings, before, { ...after, nodes: after.nodes.filter((item) => item.id !== 'unrelated') })).toEqual([]);
  });
  it('ignores selection-only changes without treating them as permission to rebase overlapping edits', () => {
    const after = { ...before, nodes: [node('left', 'Approved change'), { ...before.nodes[1], selected: true }, before.nodes[2]] };
    expect(independentSiblingApprovalIds(executed, siblings, before, after)).toEqual(['right-edit']);
    expect(independentSiblingApprovalIds(executed, [{ approvalId: 'overlap', nodeIds: ['left'], edgeIds: [] }], before, after)).toEqual([]);
  });
  it('requires explicit graph resources for both executed and sibling approvals', () => {
    expect(independentSiblingApprovalIds({ approvalId: 'unknown', nodeIds: [], edgeIds: [] }, siblings, before, before)).toEqual([]);
    expect(independentSiblingApprovalIds(executed, [{ approvalId: 'unknown', nodeIds: [], edgeIds: [] }], before, before)).toEqual([]);
  });
});
