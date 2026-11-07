import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanvasStore } from '@/stores/canvasStore';
import { CANVAS_NODE_TYPES, type CanvasNode } from '../domain/canvasNodes';
import { CANVAS_COMMAND_VERSION } from '../domain/canvasCommands';
import { CanvasGenerationFacade } from './canvasGenerationFacade';
import { canvasCommandRegistry } from './canvasCommandService';
import { executionOrder } from '@/features/library/toolbox/toolbox';
import type * as Generation from './generation';

const generation = vi.hoisted(() => ({ submit: vi.fn() }));
vi.mock('./generation', async (importOriginal) => ({ ...await importOriginal<typeof Generation>(), submitNodeGeneration: generation.submit }));

beforeEach(() => {
  generation.submit.mockReset().mockImplementation(async (nodeId: string) => ({ ok: true, nodeId, resultNodeIds: [], jobIds: [] }));
  useCanvasStore.setState({ nodes: [], edges: [], revision: 0, selectedNodeId: null, history: { past: [], future: [] }, dragHistorySnapshot: null });
});

function generator(id: string, enabled = true): CanvasNode {
  return { id, type: CANVAS_NODE_TYPES.imageEdit, position: { x: 0, y: 0 }, data: { prompt: 'Shot', enabled } };
}

describe('node enablement', () => {
  it('enables and disables ordinary generation nodes in one undoable command', async () => {
    useCanvasStore.setState({ nodes: [generator('one'), generator('two')] });
    const result = await canvasCommandRegistry.execute({ type: 'node.setEnabled', version: CANVAS_COMMAND_VERSION,
      input: { nodeIds: ['one', 'two'], enabled: false } }, 'agent');
    expect(result.ok).toBe(true);
    expect(useCanvasStore.getState().nodes.every((node) => node.data.enabled === false)).toBe(true);
    expect(useCanvasStore.getState().history.past).toHaveLength(1);
    useCanvasStore.getState().undo();
    expect(useCanvasStore.getState().nodes.every((node) => node.data.enabled === true)).toBe(true);
  });

  it('skips disabled members of group/selection submissions without invoking their generation boundary', async () => {
    const nodes = [generator('enabled'), generator('disabled', false),
      { id: 'group', type: CANVAS_NODE_TYPES.group, position: { x: 0, y: 0 }, data: { label: 'Group' } } satisfies CanvasNode];
    const result = await new CanvasGenerationFacade().submit(['group', 'enabled', 'disabled', 'enabled'], nodes);
    expect(result.acceptedNodeIds).toEqual(['enabled']);
    expect(generation.submit).toHaveBeenCalledTimes(1);
    expect(generation.submit).toHaveBeenCalledWith('enabled', { historySurface: 'canvas' });
  });

  it('keeps disabled dependencies in topology but omits them from toolbox execution order', () => {
    const nodes = [generator('first'), generator('disabled', false), generator('last')];
    const edges = [{ id: 'one', source: 'first', target: 'disabled' }, { id: 'two', source: 'disabled', target: 'last' }];
    expect(executionOrder({ nodes, edges })).toEqual(['first', 'last']);
  });
});
