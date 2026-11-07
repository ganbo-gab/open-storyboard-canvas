import { beforeEach, describe, expect, it } from 'vitest';
import { useCanvasStore } from '@/stores/canvasStore';
import { CANVAS_COMMAND_VERSION } from '../domain/canvasCommands';
import { CANVAS_NODE_TYPES, type CanvasNode } from '../domain/canvasNodes';
import { canvasCommandRegistry } from './canvasCommandService';
import { resolveAbsoluteNodePosition } from '../clipboard/clipboardIO';

function resetCanvas(): void {
  useCanvasStore.setState({
    nodes: [], edges: [], revision: 0, selectedNodeId: null,
    history: { past: [], future: [] }, dragHistorySnapshot: null,
  });
}

function persistentNodes(nodes: readonly CanvasNode[]): Omit<CanvasNode, 'selected'>[] {
  return nodes.map(({ selected: _selected, ...node }) => node);
}

function seedNestedGroups(): void {
  const nodes: CanvasNode[] = [
    { id: 'outer', type: CANVAS_NODE_TYPES.group, position: { x: 100.25, y: 200.5 }, data: { label: 'Outer' } },
    { id: 'inner', type: CANVAS_NODE_TYPES.group, parentId: 'outer', extent: 'parent',
      position: { x: 40.5, y: 60.25 }, data: { label: 'Inner' } },
    { id: 'image', type: CANVAS_NODE_TYPES.upload, parentId: 'inner', extent: 'parent',
      position: { x: 15.25, y: 25.5 }, data: { imageUrl: 'asset-media:image:durable-image', aspectRatio: '16:9' } },
    { id: 'sibling', type: CANVAS_NODE_TYPES.imageEdit, parentId: 'outer', extent: 'parent',
      position: { x: 400, y: 80 }, data: { prompt: 'Next shot' } },
  ];
  useCanvasStore.setState({ nodes, edges: [{ id: 'external-reference', source: 'image', target: 'sibling' }],
    selectedNodeId: 'inner', revision: 1 });
}

describe('canvas selection graph commands', () => {
  beforeEach(resetCanvas);

  it('ungroups nested children into the surviving parent without changing absolute positions', async () => {
    seedNestedGroups();
    const before = useCanvasStore.getState();
    const result = await canvasCommandRegistry.execute({ type: 'group.ungroup', version: CANVAS_COMMAND_VERSION,
      input: { groupIds: ['inner'] } }, 'ui');

    expect(result.ok).toBe(true);
    expect(useCanvasStore.getState().nodes.find((node) => node.id === 'image')).toMatchObject({
      parentId: 'outer', extent: 'parent', position: { x: 55.75, y: 85.75 },
      data: { imageUrl: 'asset-media:image:durable-image' },
    });
    expect(useCanvasStore.getState().edges).toEqual(before.edges);
    expect(useCanvasStore.getState().history.past).toHaveLength(1);
    const after = useCanvasStore.getState().nodes;
    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(persistentNodes(useCanvasStore.getState().nodes)).toEqual(persistentNodes(before.nodes));
    expect(useCanvasStore.getState().edges).toEqual(before.edges);
    expect(useCanvasStore.getState().redo()).toBe(true);
    expect(persistentNodes(useCanvasStore.getState().nodes)).toEqual(persistentNodes(after));
    expect(useCanvasStore.getState().edges).toEqual(before.edges);
  });

  it('groups nested siblings without rounding their absolute positions or discarding the parent', async () => {
    seedNestedGroups();
    const before = useCanvasStore.getState();
    const beforeMap = new Map(before.nodes.map((node) => [node.id, node]));
    const result = await canvasCommandRegistry.execute({ type: 'group.create', version: CANVAS_COMMAND_VERSION,
      input: { nodeIds: ['inner', 'sibling'], groupId: 'nested-created' } }, 'ui');

    expect(result.ok).toBe(true);
    const after = useCanvasStore.getState();
    const afterMap = new Map(after.nodes.map((node) => [node.id, node]));
    expect(afterMap.get('nested-created')?.parentId).toBe('outer');
    for (const id of ['inner', 'image', 'sibling']) {
      const original = beforeMap.get(id);
      const current = afterMap.get(id);
      expect(original).toBeDefined();
      expect(current).toBeDefined();
      if (!original || !current) throw new Error('Fixture node disappeared');
      expect(resolveAbsoluteNodePosition(current, afterMap)).toEqual(resolveAbsoluteNodePosition(original, beforeMap));
    }
    expect(after.edges).toEqual(before.edges);
    expect(after.history.past).toHaveLength(1);
    expect(after.undo()).toBe(true);
    expect(persistentNodes(useCanvasStore.getState().nodes)).toEqual(persistentNodes(before.nodes));
    expect(useCanvasStore.getState().edges).toEqual(before.edges);
    expect(useCanvasStore.getState().redo()).toBe(true);
    expect(persistentNodes(useCanvasStore.getState().nodes)).toEqual(persistentNodes(after.nodes));
    expect(useCanvasStore.getState().edges).toEqual(after.edges);
  });

  it('groups an ancestor once and expands a resized parent without moving its existing content', async () => {
    seedNestedGroups();
    const nodes = useCanvasStore.getState().nodes.map((node) => node.id === 'outer'
      ? { ...node, measured: { width: 300, height: 200 }, style: { width: 300, height: 200 } }
      : node);
    useCanvasStore.setState({ nodes });
    const beforeMap = new Map(nodes.map((node) => [node.id, node]));
    const edges = useCanvasStore.getState().edges;
    const result = await canvasCommandRegistry.execute({ type: 'group.create', version: CANVAS_COMMAND_VERSION,
      input: { nodeIds: ['inner', 'image', 'sibling'], groupId: 'nested-expanded' } }, 'ui');
    expect(result.ok).toBe(true);
    const after = useCanvasStore.getState();
    expect(after.nodes.find((node) => node.id === 'image')?.parentId).toBe('inner');
    const outer = after.nodes.find((node) => node.id === 'outer');
    expect(outer?.style?.width).toBeGreaterThan(300);
    expect(outer?.style?.height).toBeGreaterThan(200);
    const afterMap = new Map(after.nodes.map((node) => [node.id, node]));
    for (const id of ['inner', 'image', 'sibling']) {
      const original = beforeMap.get(id);
      const current = afterMap.get(id);
      if (!original || !current) throw new Error('Fixture node disappeared');
      expect(resolveAbsoluteNodePosition(current, afterMap)).toEqual(resolveAbsoluteNodePosition(original, beforeMap));
    }
    expect(after.history.past).toHaveLength(1);
    expect(after.undo()).toBe(true);
    expect(persistentNodes(useCanvasStore.getState().nodes)).toEqual(persistentNodes(nodes));
    expect(useCanvasStore.getState().edges).toEqual(edges);
    expect(useCanvasStore.getState().redo()).toBe(true);
    expect(persistentNodes(useCanvasStore.getState().nodes)).toEqual(persistentNodes(after.nodes));
    expect(useCanvasStore.getState().edges).toEqual(edges);
  });

  it('rejects grouping without independent members and rolls back a later failed ungroup', async () => {
    seedNestedGroups();
    const before = useCanvasStore.getState();
    const invalid = await canvasCommandRegistry.execute({ type: 'group.create', version: CANVAS_COMMAND_VERSION,
      input: { nodeIds: ['inner', 'image'] } }, 'ui');
    expect(invalid).toMatchObject({ ok: false, error: { code: 'invalid_command' } });
    const failed = canvasCommandRegistry.executeTransaction({
      id: 'failed-nested-ungroup', origin: 'ui', expectedRevision: before.revision,
      commands: [{ type: 'group.ungroup', version: CANVAS_COMMAND_VERSION, input: { groupIds: ['inner', 'missing'] } }],
    });
    expect(failed).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(useCanvasStore.getState().nodes).toBe(before.nodes);
    expect(useCanvasStore.getState().edges).toBe(before.edges);
    expect(useCanvasStore.getState().history.past).toEqual([]);
  });
});
