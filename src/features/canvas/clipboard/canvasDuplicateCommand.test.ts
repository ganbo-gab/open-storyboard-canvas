import { beforeEach, describe, expect, it } from 'vitest';

import { useCanvasStore } from '@/stores/canvasStore';
import { canvasCommandRegistry } from '../application/canvasCommandService';
import { CANVAS_COMMAND_VERSION } from '../domain/canvasCommands';
import { CANVAS_NODE_TYPES, type CanvasNode, type CanvasNodeType } from '../domain/canvasNodes';
import { getNodeDefinition } from '../domain/nodeRegistry';

function node(id: string, type: CanvasNodeType, name: string): CanvasNode {
  return { id, type, position: { x: 100, y: 80 }, data: { ...getNodeDefinition(type).createDefaultData(), displayName: name } };
}

beforeEach(() => {
  useCanvasStore.setState({ nodes: [], edges: [], revision: 0, selectedNodeId: null, history: { past: [], future: [] }, dragHistorySnapshot: null });
});

describe('node.duplicate command', () => {
  it('duplicates normal nodes with all graph relations in one undoable command', async () => {
    const nodes = [node('upstream', CANVAS_NODE_TYPES.upload, 'Reference'), node('a', CANVAS_NODE_TYPES.imageEdit, 'Shot A'), node('b', CANVAS_NODE_TYPES.imageEdit, 'Shot B'), node('downstream', CANVAS_NODE_TYPES.imageEdit, 'Final')];
    const edges = [{ id: 'in', source: 'upstream', target: 'a' }, { id: 'internal', source: 'a', target: 'b' }, { id: 'out', source: 'b', target: 'downstream' }];
    useCanvasStore.setState({ nodes, edges });
    const result = await canvasCommandRegistry.execute({ type: 'node.duplicate', version: CANVAS_COMMAND_VERSION, input: { copies: [{ sourceNodeId: 'a', nodeId: 'a-copy' }, { sourceNodeId: 'b', nodeId: 'b-copy' }] } }, 'agent');
    expect(result.ok).toBe(true);
    const state = useCanvasStore.getState();
    expect(state.edges).toHaveLength(6);
    expect(state.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'upstream', target: 'a-copy' }),
      expect.objectContaining({ source: 'a-copy', target: 'b-copy' }),
      expect.objectContaining({ source: 'b-copy', target: 'downstream' }),
    ]));
    expect(state.nodes.find((item) => item.id === 'a-copy')?.data.displayName).toBe('Shot A-副本');
    expect(state.history.past).toHaveLength(1);
    expect(state.undo()).toBe(true);
    expect(useCanvasStore.getState().nodes).toEqual(nodes);
    expect(useCanvasStore.getState().edges).toEqual(edges);
  });

  it('inherits tag upstream and downstream edges and numbers copy names', async () => {
    const nodes = [node('upstream', CANVAS_NODE_TYPES.upload, 'Reference'), node('tag', CANVAS_NODE_TYPES.tag, 'Hero'), node('downstream', CANVAS_NODE_TYPES.imageEdit, 'Shot')];
    useCanvasStore.setState({ nodes, edges: [{ id: 'in', source: 'upstream', target: 'tag' }, { id: 'out', source: 'tag', target: 'downstream' }] });
    for (const nodeId of ['tag-copy', 'tag-copy-2']) {
      const result = await canvasCommandRegistry.execute({ type: 'node.duplicate', version: CANVAS_COMMAND_VERSION, input: { copies: [{ sourceNodeId: 'tag', nodeId }] } }, 'agent');
      expect(result.ok).toBe(true);
    }
    const state = useCanvasStore.getState();
    expect(state.nodes.find((item) => item.id === 'tag-copy')?.data.displayName).toBe('Hero-副本');
    expect(state.nodes.find((item) => item.id === 'tag-copy-2')?.data.displayName).toBe('Hero-副本2');
    expect(state.edges).toHaveLength(6);
  });
});
