import { beforeEach, describe, expect, it } from 'vitest';
import { useCanvasStore } from '@/stores/canvasStore';
import { CANVAS_COMMAND_VERSION } from '../domain/canvasCommands';
import { CANVAS_NODE_TYPES } from '../domain/canvasNodes';
import type { CanvasNode, CanvasEdge } from '../domain/canvasNodes';
import { canvasCommandRegistry } from './canvasCommandService';
import { selectBatchStack } from './stacks';
import { duplicateCanvasGraph } from '../clipboard/canvasDuplication';
import { collectDownloadableMedia } from './selectionAssets';

function seedBatch(): void {
  const store = useCanvasStore.getState();
  const source = store.addNode(CANVAS_NODE_TYPES.imageEdit, { x: 0, y: 0 });
  for (let index = 0; index < 3; index += 1) {
    const id = store.addNode(CANVAS_NODE_TYPES.exportImage, { x: 400 + index * 450, y: 0 }, {
      batchId: 'batch', batchIndex: index, batchTotal: 3, imageUrl: `/durable/result-${index}.png`,
    });
    store.addEdge(source, id, { provenance: 'generationResult' });
  }
  useCanvasStore.setState({ history: { past: [], future: [] }, selectedNodeId: null });
}

beforeEach(() => {
  useCanvasStore.setState({ nodes: [], edges: [], revision: 0, selectedNodeId: null,
    history: { past: [], future: [] }, dragHistorySnapshot: null });
  seedBatch();
});

describe('durable multi-result stacks', () => {
  it('collapses, changes primary and expands atomically, preserving every node and edge through undo/redo', async () => {
    const initial = useCanvasStore.getState();
    const members = selectBatchStack(initial.nodes, 'batch').memberIds;
    const edges = initial.edges;
    const collapse = await canvasCommandRegistry.execute({ type: 'batch.setCollapsed', version: CANVAS_COMMAND_VERSION,
      input: { batchId: 'batch', collapsed: true } }, 'agent');
    expect(collapse).toMatchObject({ ok: true, impact: { effect: 'graph', requiresExternalSideEffect: false } });
    expect(useCanvasStore.getState().history.past).toHaveLength(1);
    expect(useCanvasStore.getState().nodes.filter((node) => node.hidden).map((node) => node.id)).toEqual(members.slice(1));
    expect(useCanvasStore.getState().edges).toEqual(edges);
    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(useCanvasStore.getState().nodes.some((node) => node.hidden)).toBe(false);
    expect(useCanvasStore.getState().redo()).toBe(true);
    expect(selectBatchStack(useCanvasStore.getState().nodes, 'batch').collapsed).toBe(true);

    const primary = await canvasCommandRegistry.execute({ type: 'batch.setPrimary', version: CANVAS_COMMAND_VERSION,
      input: { batchId: 'batch', nodeId: members[1] } }, 'agent');
    expect(primary.ok).toBe(true);
    expect(selectBatchStack(useCanvasStore.getState().nodes, 'batch').primaryId).toBe(members[1]);
    expect(useCanvasStore.getState().nodes.find((node) => node.id === members[1])?.hidden).toBe(false);
    expect(useCanvasStore.getState().history.past).toHaveLength(2);
    useCanvasStore.getState().undo();
    expect(selectBatchStack(useCanvasStore.getState().nodes, 'batch').primaryId).toBe(members[0]);
    useCanvasStore.getState().redo();
    useCanvasStore.getState().setBatchCollapsed('batch', false);
    expect(useCanvasStore.getState().history.past).toHaveLength(3);
    expect(useCanvasStore.getState().nodes.every((node) => !node.hidden)).toBe(true);
    useCanvasStore.getState().undo();
    expect(selectBatchStack(useCanvasStore.getState().nodes, 'batch').collapsed).toBe(true);
  });

  it('persists stack metadata and history, re-deriving visibility even if serialized hidden is stale', () => {
    const members = selectBatchStack(useCanvasStore.getState().nodes, 'batch').memberIds;
    useCanvasStore.getState().setBatchPrimary('batch', members[2]);
    useCanvasStore.getState().setBatchCollapsed('batch', true);
    const persisted = JSON.parse(JSON.stringify({ nodes: useCanvasStore.getState().nodes,
      edges: useCanvasStore.getState().edges, history: useCanvasStore.getState().history })) as {
        nodes: CanvasNode[]; edges: CanvasEdge[]; history: unknown;
      };
    persisted.nodes.forEach((node) => { node.hidden = false; });
    useCanvasStore.getState().setCanvasData(persisted.nodes, persisted.edges, persisted.history);
    expect(selectBatchStack(useCanvasStore.getState().nodes, 'batch')).toEqual({ primaryId: members[2], memberIds: members, collapsed: true });
    expect(useCanvasStore.getState().nodes.filter((node) => node.hidden)).toHaveLength(2);
    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(selectBatchStack(useCanvasStore.getState().nodes, 'batch').collapsed).toBe(false);
    expect(useCanvasStore.getState().redo()).toBe(true);
    expect(useCanvasStore.getState().nodes.filter((node) => node.hidden)).toHaveLength(2);
  });

  it('promotes the next ordered member when deleting primary, restores primary on undo and cleans up an empty batch', async () => {
    const members = selectBatchStack(useCanvasStore.getState().nodes, 'batch').memberIds;
    useCanvasStore.getState().setBatchPrimary('batch', members[1]);
    useCanvasStore.getState().setBatchCollapsed('batch', true);
    const deletion = await canvasCommandRegistry.execute({ type: 'node.delete', version: CANVAS_COMMAND_VERSION,
      input: { nodeIds: [members[1]] } }, 'agent');
    expect(deletion.ok).toBe(true);
    expect(selectBatchStack(useCanvasStore.getState().nodes, 'batch').primaryId).toBe(members[2]);
    useCanvasStore.getState().undo();
    expect(selectBatchStack(useCanvasStore.getState().nodes, 'batch').primaryId).toBe(members[1]);
    useCanvasStore.getState().deleteNodes(members);
    expect(selectBatchStack(useCanvasStore.getState().nodes, 'batch')).toEqual({ primaryId: null, memberIds: [], collapsed: false });
    expect(useCanvasStore.getState().edges).toEqual([]);
  });

  it('keeps hidden members readable while selection, layout and batch download operate on visible members', async () => {
    const members = selectBatchStack(useCanvasStore.getState().nodes, 'batch').memberIds;
    useCanvasStore.getState().setBatchCollapsed('batch', true);
    useCanvasStore.getState().onNodesChange([{ id: members[2], type: 'select', selected: true }]);
    expect(useCanvasStore.getState().nodes.filter((node) => node.selected).map((node) => node.id)).toEqual([members[0]]);
    const before = useCanvasStore.getState().nodes.find((node) => node.id === members[2])?.position;
    await canvasCommandRegistry.execute({ type: 'node.layout', version: CANVAS_COMMAND_VERSION,
      input: { nodeIds: members, direction: 'vertical', origin: { x: 100, y: 100 } } }, 'ui');
    expect(useCanvasStore.getState().nodes.find((node) => node.id === members[2])?.position).toEqual(before);
    expect(collectDownloadableMedia(members).map((item) => item.nodeId)).toEqual([members[0]]);
    const query = await canvasCommandRegistry.execute({ type: 'canvas.query', version: CANVAS_COMMAND_VERSION,
      input: { scope: 'nodes', nodeIds: members } }, 'agent');
    expect(query).toMatchObject({ ok: true, output: { value: [
      { id: members[0], hidden: false, visibility: 'visible' },
      { id: members[1], hidden: true, visibility: 'collapsed-stack-member' },
      { id: members[2], hidden: true, visibility: 'collapsed-stack-member' },
    ] } });
  });

  it('duplicates full stacks into independent batches and pastes a hidden single member as visible', () => {
    useCanvasStore.getState().setBatchCollapsed('batch', true);
    const state = useCanvasStore.getState();
    const members = state.nodes.filter((node) => node.data.batchId === 'batch');
    const full = duplicateCanvasGraph({ sourceNodes: members, sourceEdges: state.edges, existingNodes: state.nodes,
      existingEdges: state.edges, copies: members.map((node, index) => ({ sourceNodeId: node.id, nodeId: `copy-${index}` })) });
    expect(full.nodes.every((node) => node.data.batchId !== 'batch')).toBe(true);
    expect(selectBatchStack(full.nodes, String(full.nodes[0].data.batchId))).toMatchObject({ primaryId: 'copy-0', collapsed: true });
    const single = duplicateCanvasGraph({ sourceNodes: [members[2]], sourceEdges: [], existingNodes: [], existingEdges: [],
      copies: [{ sourceNodeId: members[2].id, nodeId: 'pasted' }] });
    expect(single.nodes[0]).toMatchObject({ hidden: false, data: { batchPrimary: true, batchCollapsed: false } });
  });

  it('splits a collapsed stack into the same independent nodes with one reversible graph edit', async () => {
    const members = selectBatchStack(useCanvasStore.getState().nodes, 'batch').memberIds;
    useCanvasStore.getState().setBatchCollapsed('batch', true);
    useCanvasStore.getState().setBatchPrimary('batch', members[1]);
    useCanvasStore.setState({ history: { past: [], future: [] } });
    const before = useCanvasStore.getState();
    const result = await canvasCommandRegistry.execute({
      type: 'batch.split', version: CANVAS_COMMAND_VERSION, input: { batchId: 'batch' },
    }, 'agent');
    expect(result).toMatchObject({ ok: true, impact: { affectedNodeIds: members,
      creates: { nodes: 0, edges: 0, groups: 0 }, deletes: { nodes: 0, edges: 0, groups: 0 },
      requiresExternalSideEffect: false } });
    const after = useCanvasStore.getState();
    expect(after.nodes.map((node) => node.id)).toEqual(before.nodes.map((node) => node.id));
    for (const node of after.nodes.filter((candidate) => members.includes(candidate.id))) {
      expect(node.hidden).toBe(false);
      for (const field of ['batchId', 'batchIndex', 'batchTotal', 'batchPrimary', 'batchCollapsed']) {
        expect(Object.hasOwn(node.data, field)).toBe(false);
      }
      const original = before.nodes.find((candidate) => candidate.id === node.id);
      expect(node.position).toEqual(original?.position);
      expect(node.parentId).toBe(original?.parentId);
      expect(node.data.imageUrl).toBe(original?.data.imageUrl);
    }
    expect(after.edges).toEqual(before.edges);
    expect(after.history.past).toHaveLength(1);
    expect(after.undo()).toBe(true);
    expect(useCanvasStore.getState().nodes).toEqual(before.nodes);
    expect(useCanvasStore.getState().redo()).toBe(true);
    expect(useCanvasStore.getState().nodes).toEqual(after.nodes);
  });

  it('leaves a stack untouched for stale revisions, missing batches and a failed later sub-operation', async () => {
    useCanvasStore.getState().setBatchCollapsed('batch', true);
    useCanvasStore.setState({ history: { past: [], future: [] } });
    const before = useCanvasStore.getState();
    expect(await canvasCommandRegistry.executeApproved({
      type: 'batch.split', version: CANVAS_COMMAND_VERSION, input: { batchId: 'batch' },
    }, 0, 'agent')).toMatchObject({ ok: false, error: { code: 'revision_conflict' } });
    expect(await canvasCommandRegistry.execute({
      type: 'batch.split', version: CANVAS_COMMAND_VERSION, input: { batchId: 'missing' },
    }, 'agent')).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(canvasCommandRegistry.executeTransaction({
      id: 'split-then-reject', origin: 'agent', expectedRevision: before.revision,
      commands: [
        { type: 'batch.split', version: CANVAS_COMMAND_VERSION, input: { batchId: 'batch' } },
        { type: 'node.rename', version: CANVAS_COMMAND_VERSION, input: { nodeId: 'missing', displayName: 'Invalid' } },
      ],
    })).toMatchObject({ ok: false, error: { commandIndex: 1, code: 'not_found' } });
    expect(useCanvasStore.getState().nodes).toBe(before.nodes);
    expect(useCanvasStore.getState().edges).toBe(before.edges);
    expect(useCanvasStore.getState().history.past).toEqual([]);
  });
});
