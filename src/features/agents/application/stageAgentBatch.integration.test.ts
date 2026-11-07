import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as sdk from '@/features/canvas/agent/infrastructure/sdkRuntime';
import type { StoryboardModelProviderOptions } from '@/features/canvas/agent/infrastructure/sdkRuntime';
import type { AgentModelTurnRequest, AgentModelTurnResponse } from '@/features/canvas/agent/domain/agentModel';
import type { ChatCatalogEntry } from '@/features/canvas/application/chatModelCatalog';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { stageCommands } from '@/features/stage/application/stageCommands';
import { cancelCanvasAgentRun, runCanvasAgentTurn } from '@/features/canvas/agent/application/canvasAgentController';
import { inspectScopedAgentTool } from './scopedAgentTools';

const gateway = vi.hoisted(() => ({ response: vi.fn<(request: AgentModelTurnRequest) => Promise<AgentModelTurnResponse>>() }));
vi.mock('@/features/canvas/agent/application/agentRuntimeLoader', () => ({ loadCanvasAgentSdkRuntime: async () => ({ ...sdk,
  createStoryboardAgentRuntime: (options: StoryboardModelProviderOptions) => sdk.createStoryboardAgentRuntime({ ...options,
    transport: { getResponse: gateway.response, async *getStreamedResponse(request) { yield { type: 'completed', response: await gateway.response(request) }; } },
  }),
}) }));
const model: ChatCatalogEntry = { id: 'custom:batch:fixture', providerId: 'fixture', providerLabel: 'Fixture', modelId: 'local', modelLabel: 'Local fixture',
  supportsMultimodal: false, supportsTools: true, supportsStreaming: false, supportsReasoningSummary: false, supportsToolSearch: false,
  agentProtocol: 'openai-chat-completions', usable: true };
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
let stageId: string;
const runs = new Set<string>();
beforeEach(() => {
  gateway.response.mockReset();
  useCanvasStore.setState({ nodes: [], edges: [], revision: 0, history: { past: [], future: [] }, dragHistorySnapshot: null });
  useProjectStore.setState({ currentProjectId: 'batch-fixture', saveCurrentProject: vi.fn(), waitForProjectPersistence: vi.fn(async () => {}) });
  stageId = stageCommands.create({ name: 'Batch fixture' }).nodeId;
});
afterEach(() => { runs.forEach(cancelCanvasAgentRun); runs.clear(); vi.restoreAllMocks(); });

describe('strict stage command decoding through the real SDK', () => {
  it.each([false, true])('accepts optional-null command fields while keeping a batch atomic (batch=%s)', async batch => {
    const add = { type: 'object.add', item: { id: 'one', label: 'One', x: 0, y: 0, color: '#778899', category: 'object',
      hidden: null, note: null, rotation3d: null, bodyControls: null } };
    const command = batch ? [add, { type: 'object.update', itemId: 'one', patch: { label: 'Updated', pos3d: null, note: null } }] : add;
    gateway.response.mockResolvedValueOnce({ responseId: 'batch', usage, toolCalls: [{ callId: 'edit-once', name: 'stage_command', arguments: JSON.stringify({ nodeId: stageId, command }) }] })
      .mockImplementationOnce(async request => {
        const result = request.input.find(item => item.type === 'function_call_result' && item.callId === 'edit-once');
        expect(result?.type === 'function_call_result' && result.output).toContain('"receiptStatus":"succeeded"');
        return { responseId: 'done', text: 'Edited once.', toolCalls: [], usage };
      });
    const before = useCanvasStore.getState().history.past.length;
    const result = await runCanvasAgentTurn({ projectId: 'batch-fixture', scope: 'stage', model, message: 'Add the fixture scene.', executionMode: 'full', onRunStarted: ({ runId }) => runs.add(runId) });
    expect(result.status).toBe('completed');
    expect(stageCommands.query(stageId).data.items.map(item => ({ id: item.id, label: item.label }))).toEqual([{ id: 'one', label: batch ? 'Updated' : 'One' }]);
    expect(useCanvasStore.getState().history.past.length - before).toBe(1);
    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(stageCommands.query(stageId).data.items).toEqual([]);
  });

  it('rejects malformed batch members with a useful bounded path and applies nothing', () => {
    const valid = { type: 'object.remove', itemId: 'one' };
    let message = '';
    try {
      inspectScopedAgentTool('stage', 'stage_command', { nodeId: stageId, command: [valid, { type: 'object.update', itemId: 'two', patch: { x: 'left' } }] });
    } catch (error) { message = error instanceof Error ? error.message : String(error); }
    expect(message).toContain('Invalid stage_command arguments:');
    expect(message).toContain('command[1].patch.x: expected number');
    expect(message.length).toBeLessThan(1200);
    expect(message).not.toContain('"invalid_union"');
    expect(stageCommands.query(stageId).data.items).toEqual([]);
    expect(() => inspectScopedAgentTool('stage', 'stage_command', { nodeId: stageId, command: [] })).toThrow(/Invalid/);
    expect(() => inspectScopedAgentTool('stage', 'stage_command', { nodeId: stageId, command: Array.from({ length: 101 }, () => valid) })).toThrow(/Invalid/);
    expect(() => inspectScopedAgentTool('stage', 'stage_command', { nodeId: stageId, command: [{ ...valid, shell: 'unsupported' }] })).toThrow(/Invalid/);
  });

  it('preserves explicit nulls that clear camera tracking and action choices while removing only optional absence markers', async () => {
    stageCommands.execute(stageId, [
      { type: 'object.add', item: { id: 'person', label: 'Person', x: 0, y: 0, color: '#778899', category: 'person' } },
      { type: 'keyframe.add', track: { kind: 'camera' }, keyframe: { id: 'camera-frame', time: 0, easing: 'linear',
        position: { x: 0, y: 2, z: 5 }, target: { x: 0, y: 1, z: 0 }, fov: 45, trackTargetId: 'person', trackTargetBodyPart: 'head' } },
      { type: 'keyframe.add', track: { kind: 'action', itemId: 'person' }, keyframe: { id: 'action-frame', time: 0, easing: 'linear', clipId: null } },
    ]);
    const command = [
      { type: 'keyframe.update', track: { kind: 'camera' }, keyframeId: 'camera-frame', patch: { trackTargetId: null, trackTargetBodyPart: null, fov: null } },
      { type: 'keyframe.update', track: { kind: 'action', itemId: 'person' }, keyframeId: 'action-frame', patch: { poseId: null, actionId: null, clipId: null, actionOffsetSeconds: null } },
    ];
    const parsed = inspectScopedAgentTool('stage', 'stage_command', { nodeId: stageId, command });
    expect(parsed.input).toMatchObject({ command: [
      { patch: { trackTargetId: null, trackTargetBodyPart: null } },
      { patch: { poseId: null, actionId: null, clipId: null } },
    ] });
    await parsed.tool.execute(parsed.input, { projectId: 'batch-fixture', runId: 'clear-null', expectedRevision: useCanvasStore.getState().revision });
    const motion = stageCommands.query(stageId).data.motionProject;
    expect(motion?.cameraTrack.find(frame => frame.id === 'camera-frame')).toMatchObject({ trackTargetId: null, trackTargetBodyPart: null, fov: 45 });
    expect(motion?.actionTracks.person.find(frame => frame.id === 'action-frame')).toMatchObject({ poseId: null, actionId: null, clipId: null });
  });
});
