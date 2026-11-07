import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as sdk from '../infrastructure/sdkRuntime';
import type { CanvasAgentContext, StoryboardModelProviderOptions } from '../infrastructure/sdkRuntime';
import type { AgentModelTurnResponse } from '../domain/agentModel';
import type { ChatCatalogEntry } from '@/features/canvas/application/chatModelCatalog';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { cancelCanvasAgentRun, resolveCanvasAgentApproval, runCanvasAgentTurn } from './canvasAgentController';
import { canvasAgentApprovalExecution, canvasAgentApprovalStore, createApprovalId, createIdempotencyKey } from './agentApproval';
import { rollbackAgentCanvasReceipt } from './agentCanvasRollback';

const modelTransport = vi.hoisted(() => ({ response: vi.fn() }));
vi.mock('./agentRuntimeLoader', () => ({ loadCanvasAgentSdkRuntime: async () => ({
  ...sdk,
  createStoryboardAgentRuntime: (options: StoryboardModelProviderOptions) => sdk.createStoryboardAgentRuntime({ ...options,
    transport: { getResponse: modelTransport.response, async *getStreamedResponse() { throw new Error('Not streamed'); } },
  }),
}) }));

const projectId = 'history-controller-project';
const model: ChatCatalogEntry = {
  id: 'custom:fixture:history', providerId: 'fixture', providerLabel: 'Fixture', modelId: 'history', modelLabel: 'History',
  supportsMultimodal: false, supportsTools: true, supportsStreaming: false, supportsReasoningSummary: false,
  supportsToolSearch: false, agentProtocol: 'openai-chat-completions', usable: true,
};
const finalResponse: AgentModelTurnResponse = { responseId: 'done', text: 'Done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
let runId: string | undefined;
const graph = () => structuredClone({ nodes: useCanvasStore.getState().nodes, edges: useCanvasStore.getState().edges });

function rename(callId: string, nodeId: string, displayName: string): AgentModelTurnResponse {
  return { responseId: callId, toolCalls: [{ callId, name: 'canvas_command', arguments: JSON.stringify({ type: 'node.rename', input: { nodeId, displayName } }) }],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
}

beforeEach(() => {
  modelTransport.response.mockReset()
    .mockResolvedValueOnce(rename('first', 'one', 'First title'))
    .mockResolvedValueOnce(rename('second', 'two', 'Second title'))
    .mockResolvedValue(finalResponse);
  useCanvasStore.setState({
    nodes: ['one', 'two'].map((id) => ({ id, type: CANVAS_NODE_TYPES.textAnnotation, position: { x: 0, y: 0 }, data: { content: id } })),
    edges: [], revision: 0, selectedNodeId: null, history: { past: [], future: [] }, dragHistorySnapshot: null,
  });
  useProjectStore.setState({ currentProjectId: projectId, saveCurrentProject: vi.fn(), waitForProjectPersistence: vi.fn(async () => {}) });
});
afterEach(() => {
  if (runId) cancelCanvasAgentRun(runId);
  runId = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function begin() {
  const result = await runCanvasAgentTurn({ projectId, model, message: 'Rename both canvas nodes, one then two.' });
  runId = result.runId;
  expect(result.status).toBe('awaiting-approval');
  return result;
}

async function approveFirst() {
  const first = await begin();
  const next = await resolveCanvasAgentApproval({ runId: first.runId, approvalId: first.approvals[0].id, approve: true, model });
  expect(next.status).toBe('awaiting-approval');
  expect(useCanvasStore.getState().nodes[0].data.displayName).toBe('First title');
  return next;
}

describe('Agent turn undo integration', () => {
  it('groups two separately approved mutations and safely rolls back only that turn', async () => {
    useCanvasStore.getState().updateNodeData('one', { content: 'Earlier user work' });
    const before = graph();
    const next = await approveFirst();
    const completed = await resolveCanvasAgentApproval({ runId: next.runId, approvalId: next.approvals[0].id, approve: true, model });
    expect(completed.status).toBe('completed');
    const after = graph();
    expect(useCanvasStore.getState().history.past).toHaveLength(2);
    const receipt = canvasAgentApprovalStore.getReceipt(createIdempotencyKey(next.runId, 'canvas_command', 'second'))!;
    await expect(rollbackAgentCanvasReceipt(receipt.id, projectId)).resolves.toMatchObject({ ok: true });
    expect(graph()).toEqual(before);
    expect(useCanvasStore.getState().history.past).toHaveLength(1);
    expect(useCanvasStore.getState().redo()).toBe(true);
    expect(graph()).toEqual(after);
    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(graph()).toEqual(before);
  });

  it('keeps interleaved manual edits outside the Agent undo segment', async () => {
    modelTransport.response.mockReset()
      .mockResolvedValueOnce(rename('first', 'one', 'First title'))
      .mockImplementationOnce(async () => {
        useCanvasStore.getState().updateNodeData('one', { content: 'Typed while the model continued' });
        return rename('second', 'two', 'Second title');
      })
      .mockResolvedValue(finalResponse);
    const next = await approveFirst();
    const beforeSecond = graph();
    await resolveCanvasAgentApproval({ runId: next.runId, approvalId: next.approvals[0].id, approve: true, model });
    expect(useCanvasStore.getState().history.past).toHaveLength(3);
    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(graph()).toEqual(beforeSecond);
    expect(useCanvasStore.getState().nodes[0].data.content).toBe('Typed while the model continued');
  });

  it('continues a serialized semantic approval in a fresh SDK runtime with the same undo group', async () => {
    const before = graph();
    const next = await approveFirst();
    const recovery = canvasAgentApprovalStore.getRunRecovery(next.runId)!;
    const runtime = sdk.createStoryboardAgentRuntime({ resolveModel: () => ({
      catalogId: model.id, providerId: model.providerId, modelId: model.modelId, label: model.modelLabel, usable: true,
      capabilities: { protocol: 'openai-chat-completions', tools: true, stream: false, vision: false, reasoningSummary: false, toolSearch: false },
    }), transport: { getResponse: modelTransport.response, async *getStreamedResponse() { throw new Error('Not streamed'); } } });
    const context: CanvasAgentContext = { projectId, runId: next.runId, getCanvasRevision: () => useCanvasStore.getState().revision, getActiveProjectId: () => projectId };
    const agent = sdk.createCanvasAgent({ runtime, context, skillContext: { text: 'Rename both canvas nodes.' } });
    const restored = await sdk.restoreStoryboardRunState(agent, recovery.serializedState, context);
    const approval = restored.getInterruptions()[0];
    canvasAgentApprovalExecution.decide(createApprovalId(next.runId, 'canvas_command', 'second'), true);
    restored.approve(approval);
    const completed = await runtime.runner.run(agent, restored, { context });
    expect(completed.interruptions).toHaveLength(0);
    expect(useCanvasStore.getState().nodes[1].data.displayName).toBe('Second title');
    expect(useCanvasStore.getState().history.past).toHaveLength(1);
    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(graph()).toEqual(before);
  });

  it.each(['rejected', 'cancelled', 'stopped'] as const)('retains applied mutations when the remaining approval is %s', async (outcome) => {
    if (outcome === 'stopped') vi.useFakeTimers();
    const before = graph();
    const next = await approveFirst();
    const applied = graph();
    if (outcome === 'rejected') {
      await resolveCanvasAgentApproval({ runId: next.runId, approvalId: next.approvals[0].id, approve: false, model });
    } else if (outcome === 'cancelled') {
      cancelCanvasAgentRun(next.runId);
    } else {
      await vi.advanceTimersByTimeAsync(30 * 60_000);
    }
    expect(graph()).toEqual(applied);
    expect(useCanvasStore.getState().history.past).toHaveLength(1);
    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(graph()).toEqual(before);
    expect(useCanvasStore.getState().redo()).toBe(true);
    expect(graph()).toEqual(applied);
  });

  it('retains the immediate graph mutation if the model continuation fails', async () => {
    modelTransport.response.mockReset().mockResolvedValueOnce(rename('first', 'one', 'First title')).mockRejectedValue(new Error('Local continuation failed'));
    const before = graph();
    const first = await begin();
    await expect(resolveCanvasAgentApproval({ runId: first.runId, approvalId: first.approvals[0].id, approve: true, model })).rejects.toThrow(/Local continuation failed/);
    expect(useCanvasStore.getState().nodes[0].data.displayName).toBe('First title');
    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(graph()).toEqual(before);
  });
});
