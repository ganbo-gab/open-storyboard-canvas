import { beforeEach, describe, expect, it } from 'vitest';
import { useCanvasStore, type CanvasNode } from './canvasStore';
import { CANVAS_NODE_TYPES, type BlueprintNodeData } from '@/features/canvas/domain/canvasNodes';
import { canvasCommandRegistry } from '@/features/canvas/application/canvasCommandService';
import { stageCommands } from '@/features/stage/application/stageCommands';
import { MAX_HISTORY_BYTES, withCanvasHistoryGroup } from './canvasHistory';
import { planOrganizeCanvas } from '@/features/canvas/application/organizeCanvas';
import type { CanvasCommand } from '@/features/canvas/domain/canvasCommands';

async function approve(command: CanvasCommand, groupId = 'project/turn') {
  const result = await canvasCommandRegistry.executeApproved(command, useCanvasStore.getState().revision, 'agent', groupId);
  expect(result.ok).toBe(true);
}

const graph = () => ({ nodes: useCanvasStore.getState().nodes, edges: useCanvasStore.getState().edges });
const note = (content = ''): CanvasNode => ({ id: 'note', type: CANVAS_NODE_TYPES.textAnnotation, position: { x: 0, y: 0 }, data: { content } });

beforeEach(() => useCanvasStore.setState({ nodes: [], edges: [], revision: 0, selectedNodeId: null, activeToolDialog: null, activeDirectorStudioNodeId: null, history: { past: [], future: [] }, dragHistorySnapshot: null }));

describe('canvas reversible patch history', () => {
  it('round-trips exactly 200 edits in both directions and evicts only the oldest step', () => {
    useCanvasStore.setState({ nodes: [note()] });
    const initial = structuredClone(graph());
    for (let index = 1; index <= 200; index += 1) useCanvasStore.getState().updateNodeData('note', { content: `Edit ${index}` });
    const edited = structuredClone(graph());
    expect(useCanvasStore.getState().history.past).toHaveLength(200);
    for (let index = 0; index < 200; index += 1) expect(useCanvasStore.getState().undo()).toBe(true);
    expect(graph()).toEqual(initial);
    expect(useCanvasStore.getState().undo()).toBe(false);
    for (let index = 0; index < 200; index += 1) expect(useCanvasStore.getState().redo()).toBe(true);
    expect(graph()).toEqual(edited);
    useCanvasStore.getState().updateNodeData('note', { content: 'Edit 201' });
    expect(useCanvasStore.getState().history.past).toHaveLength(200);
    for (let index = 0; index < 200; index += 1) useCanvasStore.getState().undo();
    expect(useCanvasStore.getState().nodes[0].data.content).toBe('Edit 1');
  });

  it('keeps 200 small edits on a media-heavy stage without copying unchanged payloads', () => {
    const imageUrl = `data:image/png;base64,${'a'.repeat(1_000_000)}`;
    const data: BlueprintNodeData = { mode: 'flat', aspectRatio: '16:9', items: [], referenceImages: [], backgroundImageUrl: imageUrl };
    useCanvasStore.setState({ nodes: [{ id: 'stage', type: CANVAS_NODE_TYPES.blueprint, position: { x: 0, y: 0 }, data }] });
    for (let index = 1; index <= 200; index += 1) useCanvasStore.getState().updateNodeData('stage', { displayName: `Stage ${index}` });
    expect(useCanvasStore.getState().history.past).toHaveLength(200);
    expect(JSON.stringify(useCanvasStore.getState().history).length).toBeLessThan(100_000);
    for (let index = 0; index < 200; index += 1) expect(useCanvasStore.getState().undo()).toBe(true);
    expect(useCanvasStore.getState().nodes[0].data.backgroundImageUrl).toBe(imageUrl);
    expect(useCanvasStore.getState().nodes[0].data).not.toHaveProperty('displayName');
  });

  it('bounds changed heavy payloads while retaining complete reversible transactions', () => {
    useCanvasStore.setState({ nodes: [note('Image 0')] });
    for (let index = 1; index <= 40; index += 1) useCanvasStore.getState().updateNodeData('note', { content: `Image ${index}:${'x'.repeat(300_000)}` });
    const state = useCanvasStore.getState();
    const retained = state.history.past.length;
    expect(retained).toBeGreaterThan(1);
    expect(retained).toBeLessThan(40);
    expect(state.history.past.reduce((size, entry) => size + entry.bytes, 0)).toBeLessThanOrEqual(MAX_HISTORY_BYTES);
    for (let index = 0; index < retained; index += 1) expect(useCanvasStore.getState().undo()).toBe(true);
    expect(String(useCanvasStore.getState().nodes[0].data.content).startsWith(`Image ${40 - retained}:`)).toBe(true);
    expect(useCanvasStore.getState().undo()).toBe(false);
    for (let index = 0; index < retained; index += 1) expect(useCanvasStore.getState().redo()).toBe(true);
    expect(useCanvasStore.getState().nodes).toEqual(state.nodes);
  });

  it('does not retain a disconnected undo chain when a single edit exceeds the payload bound', () => {
    useCanvasStore.setState({ nodes: [note()] });
    useCanvasStore.getState().updateNodeData('note', { content: 'Before the large edit' });
    const content = 'x'.repeat(MAX_HISTORY_BYTES / 2 + 1);
    useCanvasStore.getState().updateNodeData('note', { content });
    expect(useCanvasStore.getState().nodes[0].data.content).toBe(content);
    expect(useCanvasStore.getState().undo()).toBe(false);
    expect(useCanvasStore.getState().redo()).toBe(false);
  });

  it('recomputes composed payload retention and drops the whole chain for an over-cap group edit', () => {
    useCanvasStore.setState({ nodes: [note('Before')] });
    useCanvasStore.getState().updateNodeData('note', { content: 'Earlier user work' });
    for (let index = 1; index <= 40; index += 1) {
      withCanvasHistoryGroup('heavy-turn', () => useCanvasStore.getState().updateNodeData('note', { content: `${index}:${'x'.repeat(300_000)}` }));
    }
    expect(useCanvasStore.getState().history.past).toHaveLength(2);
    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(useCanvasStore.getState().nodes[0].data.content).toBe('Earlier user work');
    expect(useCanvasStore.getState().redo()).toBe(true);
    const content = 'x'.repeat(MAX_HISTORY_BYTES / 2 + 1);
    withCanvasHistoryGroup('heavy-turn', () => useCanvasStore.getState().updateNodeData('note', { content }));
    expect(useCanvasStore.getState().nodes[0].data.content).toBe(content);
    expect(useCanvasStore.getState().undo()).toBe(false);
    expect(useCanvasStore.getState().redo()).toBe(false);
  });

  it('undoes and redoes an agent graph transaction as one step', () => {
    const before = structuredClone(graph());
    const result = canvasCommandRegistry.executeTransaction({ id: 'history-agent', origin: 'agent', expectedRevision: 0, commands: [
      { type: 'node.create', version: 1, input: { nodeId: 'one', nodeType: CANVAS_NODE_TYPES.imageEdit, position: { x: 0, y: 0 } } },
      { type: 'node.create', version: 1, input: { nodeId: 'two', nodeType: CANVAS_NODE_TYPES.imageEdit, position: { x: 600, y: 0 } } },
      { type: 'edge.connect', version: 1, input: { sourceNodeId: 'one', targetNodeId: 'two', edgeId: 'one-two' } },
    ] });
    expect(result.ok).toBe(true);
    const after = structuredClone(graph());
    expect(useCanvasStore.getState().history.past).toHaveLength(1);
    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(graph()).toEqual(before);
    expect(useCanvasStore.getState().redo()).toBe(true);
    expect(graph()).toEqual(after);
  });

  it('undoes and redoes a multi-command stage transaction as one step', () => {
    useCanvasStore.setState({ nodes: [{ id: 'stage', type: CANVAS_NODE_TYPES.blueprint, position: { x: 0, y: 0 }, data: { mode: 'flat', aspectRatio: '16:9', items: [], referenceImages: [] } }] });
    const before = structuredClone(graph());
    stageCommands.execute('stage', [
      { type: 'object.add', item: { id: 'box-a', category: 'object', label: 'A', x: 1, y: 2, color: '#ffffff' } },
      { type: 'object.add', item: { id: 'box-b', category: 'object', label: 'B', x: 3, y: 4, color: '#ffffff' } },
    ]);
    const after = structuredClone(graph());
    expect(useCanvasStore.getState().history.past).toHaveLength(1);
    expect(stageCommands.undo()).toBe(true);
    expect(graph()).toEqual(before);
    expect(stageCommands.redo()).toBe(true);
    expect(graph()).toEqual(after);
  });

  it('composes sequential approved commands without leaking intermediate nodes or undoing earlier work', async () => {
    useCanvasStore.setState({ nodes: [note('Before')] });
    useCanvasStore.getState().updateNodeData('note', { content: 'User edit' });
    const before = structuredClone(graph());
    await approve({ type: 'node.create', version: 1, input: { nodeId: 'temporary', nodeType: CANVAS_NODE_TYPES.imageEdit, position: { x: 600, y: 0 } } });
    await approve({ type: 'node.rename', version: 1, input: { nodeId: 'note', displayName: 'Agent title' } });
    await approve({ type: 'node.delete', version: 1, input: { nodeIds: ['temporary'] } });
    const after = structuredClone(graph());
    expect(useCanvasStore.getState().history.past).toHaveLength(2);
    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(graph()).toEqual(before);
    expect(useCanvasStore.getState().redo()).toBe(true);
    expect(graph()).toEqual(after);
    expect(useCanvasStore.getState().nodes.map((node) => node.id)).toEqual(['note']);
  });

  it('keeps manual edits between approved commands as separate undo boundaries', async () => {
    useCanvasStore.setState({ nodes: [note('Before')] });
    await approve({ type: 'node.rename', version: 1, input: { nodeId: 'note', displayName: 'First' } });
    useCanvasStore.getState().updateNodeData('note', { content: 'User edit' });
    await approve({ type: 'node.rename', version: 1, input: { nodeId: 'note', displayName: 'Second' } });
    expect(useCanvasStore.getState().history.past).toHaveLength(3);
    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(useCanvasStore.getState().nodes[0].data).toMatchObject({ displayName: 'First', content: 'User edit' });
    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(useCanvasStore.getState().nodes[0].data).toMatchObject({ displayName: 'First', content: 'Before' });
    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(useCanvasStore.getState().nodes[0].data).not.toHaveProperty('displayName');
    for (let index = 0; index < 3; index += 1) expect(useCanvasStore.getState().redo()).toBe(true);
    expect(useCanvasStore.getState().nodes[0].data).toMatchObject({ displayName: 'Second', content: 'User edit' });
  });

  it('keeps live multi-selection by id while replaying reordered and deleted nodes', () => {
    const nodes = [note('First'), { ...note('Second'), id: 'second' }, { ...note('Third'), id: 'third' }];
    useCanvasStore.setState({ nodes });
    useCanvasStore.getState().commitGraphTransaction({ expectedRevision: 0, nodes: [nodes[2], nodes[0]], edges: [], selectedNodeId: null });
    useCanvasStore.getState().setSelectedNodeIds(['note', 'third']);
    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(useCanvasStore.getState().nodes.map((node) => node.id)).toEqual(['note', 'second', 'third']);
    expect(useCanvasStore.getState().nodes.filter((node) => node.selected).map((node) => node.id)).toEqual(['note', 'third']);
    expect(useCanvasStore.getState().selectedNodeId).toBeNull();
    expect(useCanvasStore.getState().redo()).toBe(true);
    expect(useCanvasStore.getState().nodes.filter((node) => node.selected).map((node) => node.id)).toEqual(['third', 'note']);
    useCanvasStore.getState().setSelectedNode('note');
    useCanvasStore.getState().deleteNode('note');
    expect(useCanvasStore.getState().selectedNodeId).toBeNull();
    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(useCanvasStore.getState().nodes.some((node) => node.selected)).toBe(false);
  });

  it('converts legacy snapshot past and future stacks on load', () => {
    useCanvasStore.getState().setCanvasData([note('middle')], [], { past: [{ nodes: [note('before')], edges: [] }], future: [{ nodes: [note('after')], edges: [] }] });
    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(useCanvasStore.getState().nodes[0].data.content).toBe('before');
    expect(useCanvasStore.getState().redo()).toBe(true);
    expect(useCanvasStore.getState().nodes[0].data.content).toBe('middle');
    expect(useCanvasStore.getState().redo()).toBe(true);
    expect(useCanvasStore.getState().nodes[0].data.content).toBe('after');
  });

  it('drops malformed legacy links without changing the loaded graph', () => {
    useCanvasStore.getState().setCanvasData([note('Loaded')], [], { past: [{ nodes: 'corrupt', edges: [] }], future: [] });
    expect(useCanvasStore.getState().nodes[0].data.content).toBe('Loaded');
    expect(useCanvasStore.getState().undo()).toBe(false);
  });

  it('commits drag and resize only on release', () => {
    useCanvasStore.setState({ nodes: [note(), { ...note('second'), id: 'second' }] });
    const before = structuredClone(graph());
    useCanvasStore.getState().onNodesChange([{ id: 'note', type: 'position', position: { x: 20, y: 30 }, dragging: true }]);
    useCanvasStore.getState().onNodesChange([{ id: 'note', type: 'position', position: { x: 40, y: 50 }, dragging: true }]);
    expect(useCanvasStore.getState().history.past).toHaveLength(0);
    useCanvasStore.getState().onNodesChange([{ id: 'note', type: 'position', position: { x: 60, y: 70 }, dragging: false }]);
    expect(useCanvasStore.getState().history.past).toHaveLength(1);
    useCanvasStore.getState().undo();
    expect(graph()).toEqual(before);
    useCanvasStore.getState().onNodesChange([{ id: 'note', type: 'dimensions', dimensions: { width: 400, height: 300 }, resizing: true }]);
    expect(useCanvasStore.getState().history.past).toHaveLength(0);
    useCanvasStore.getState().onNodesChange([{ id: 'note', type: 'dimensions', dimensions: { width: 500, height: 400 }, resizing: false }]);
    expect(useCanvasStore.getState().history.past).toHaveLength(1);
    useCanvasStore.getState().undo();
    expect(graph()).toEqual(before);
  });

  it('restores node order, nested array edits, deleted fields, and edges exactly', () => {
    const first: CanvasNode = { ...note('First'), data: { content: 'First', removable: true, nested: [{ id: 'a', values: [1, 2] }, { id: 'b', values: [3] }] } };
    const second: CanvasNode = { ...note('Second'), id: 'second' };
    useCanvasStore.setState({ nodes: [first, second], edges: [{ id: 'edge', source: 'note', target: 'second' }] });
    const before = structuredClone(graph());
    const changed: CanvasNode = { ...first, data: { content: 'Changed', nested: [{ id: 'b', values: [3, 4] }] } };
    useCanvasStore.getState().commitGraphTransaction({ expectedRevision: 0, nodes: [second, changed], edges: [], selectedNodeId: null });
    const after = structuredClone(graph());
    useCanvasStore.getState().undo();
    expect(graph()).toEqual(before);
    useCanvasStore.getState().redo();
    expect(graph()).toEqual(after);
  });

  it('undoes and redoes canvas organization in one step', async () => {
    useCanvasStore.setState({ nodes: [{ ...note('First'), position: { x: 900, y: 700 } }, { ...note('Second'), id: 'second', position: { x: -600, y: 100 } }] });
    const before = structuredClone(graph());
    const positions = planOrganizeCanvas(before.nodes, before.edges);
    expect(positions.length).toBeGreaterThan(0);
    const result = await canvasCommandRegistry.execute({ type: 'node.move', version: 1, input: { positions } }, 'ui');
    expect(result.ok).toBe(true);
    const after = structuredClone(graph());
    expect(after).not.toEqual(before);
    expect(useCanvasStore.getState().history.past).toHaveLength(1);
    useCanvasStore.getState().undo();
    expect(graph()).toEqual(before);
    useCanvasStore.getState().redo();
    expect(graph()).toEqual(after);
  });
});
