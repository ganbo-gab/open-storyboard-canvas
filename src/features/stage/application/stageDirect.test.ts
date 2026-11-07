import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';
import { stageAgentTools } from '@/features/agents/application/stageAgentTools';
import { stageCommands } from './stageCommands';
import { stageDirectInputSchema, type StoryPlan } from './storyPlan';

const plan: StoryPlan = {
  version: 1, duration: 8,
  cast: [{ kind: 'new', itemId: 'new-actor', presetId: 'man', label: 'Actor', heightM: 1.8 }],
  setObjects: [{ itemId: 'chair', presetId: 'chair', label: 'Chair', position: { x: 2, y: 0, z: 0 } }],
  beats: [{ start: 0, duration: 4, blocking: [{ itemId: 'new-actor', to: { x: 2.7, y: 0, z: 0 }, facing: Math.PI / 2 }] }],
  shots: [{ start: 0, duration: 8, size: 'full', angle: 'eye', movement: 'track', subjectItemIds: ['new-actor'], transition: 'cut' }],
};
const context = { projectId: 'project', runId: 'run', expectedRevision: 0 };
beforeEach(() => useCanvasStore.setState({ nodes: [{ id: 'stage', type: CANVAS_NODE_TYPES.blueprint, position: { x: 0, y: 0 }, data: { mode: 'flat', aspectRatio: '16:9', items: [], referenceImages: [], backgroundImageUrl: 'keep.png' } }], edges: [], revision: 0, selectedNodeId: 'stage', activeDirectorStudioNodeId: null, activeToolDialog: null, history: { past: [], future: [] }, dragHistorySnapshot: null }));

describe('stage_direct transaction and tool boundary', () => {
  it('previews without mutation then commits the identical command batch with one undo', () => {
    const before = useCanvasStore.getState();
    const preview = stageCommands.direct('stage', plan, { dryRun: true });
    expect(preview.dryRun).toBe(true);
    expect(useCanvasStore.getState().nodes).toBe(before.nodes);
    expect(useCanvasStore.getState().history.past).toHaveLength(0);
    const result = stageCommands.direct('stage', plan, { dryRun: false, expectedRevision: preview.revision });
    expect(result.commands).toEqual(preview.commands);
    if (result.dryRun) throw new Error('Expected execution result');
    expect(result.data.items).toHaveLength(2);
    expect(result.data.backgroundImageUrl).toBe('keep.png');
    expect(useCanvasStore.getState().history.past).toHaveLength(1);
    expect(stageCommands.undo()).toBe(true);
    expect(useCanvasStore.getState().nodes).toEqual(before.nodes);
  });
  it('rolls back the complete plan when a later reference fails and rejects stale preview revisions', () => {
    const before = useCanvasStore.getState();
    expect(() => stageCommands.direct('stage', { ...plan, shots: [{ ...plan.shots[0], subjectItemIds: ['missing'] }] }, { dryRun: false })).toThrow(/subject/);
    expect(useCanvasStore.getState().nodes).toBe(before.nodes);
    expect(useCanvasStore.getState().history.past).toHaveLength(0);
    expect(() => stageCommands.direct('stage', plan, { dryRun: false, expectedRevision: 1 })).toThrow(/revision/);
    expect(useCanvasStore.getState().nodes).toBe(before.nodes);
  });
  it('does not split a story with more than 100 generated commands into multiple transactions', () => {
    const large: StoryPlan = { ...plan, shots: Array.from({ length: 16 }, (_, index) => ({ ...plan.shots[0], start: index / 2, duration: 0.5, movement: 'orbit' })) };
    const preview = stageCommands.direct('stage', large, { dryRun: true });
    expect(preview.commands.length).toBeGreaterThan(100);
    stageCommands.direct('stage', large, { dryRun: false });
    expect(useCanvasStore.getState().history.past).toHaveLength(1);
    stageCommands.undo();
    expect(stageCommands.query('stage').data.items).toHaveLength(0);
  });
  it('exports a strict JSON-compatible tool schema and derives read/edit/destructive risk from effects', async () => {
    const direct = stageAgentTools.find((tool) => tool.name === 'stage_direct')!;
    expect(z.toJSONSchema(stageDirectInputSchema).additionalProperties).toBe(false);
    expect(stageDirectInputSchema.safeParse({ nodeId: 'stage', plan, dryRun: true, extra: true }).success).toBe(false);
    expect(typeof direct.risk).toBe('function');
    if (typeof direct.risk !== 'function') throw new Error('Expected dynamic risk');
    expect(direct.risk({ nodeId: 'stage', plan, dryRun: true })).toBe('read');
    expect(direct.risk({ nodeId: 'stage', plan, dryRun: false })).toBe('destructive');
    expect(direct.risk({ nodeId: 'stage', plan: { ...plan, beats: [], shots: [] }, dryRun: false })).toBe('edit');
    await direct.execute({ nodeId: 'stage', plan, dryRun: true }, context);
    expect(useCanvasStore.getState().history.past).toHaveLength(0);
    await direct.execute({ nodeId: 'stage', plan, dryRun: false }, context);
    expect(useCanvasStore.getState().history.past).toHaveLength(1);
  });
  it('accepts real typed stage_command batches and escalates destructive members', async () => {
    const tool = stageAgentTools.find((entry) => entry.name === 'stage_command')!;
    const command = [{ type: 'object.add', item: { id: 'added', label: 'Added', x: 0, y: 0, color: '#fff', category: 'person', presetId: 'man' } }, { type: 'person.action', itemId: 'added', actionId: 'wave', start: 0, duration: 2 }];
    if (typeof tool.risk !== 'function') throw new Error('Expected dynamic risk');
    expect(tool.risk({ nodeId: 'stage', command })).toBe('destructive');
    await tool.execute({ nodeId: 'stage', command }, context);
    expect(stageCommands.query('stage').data.items[0].id).toBe('added');
    expect(useCanvasStore.getState().history.past).toHaveLength(1);
  });
});
