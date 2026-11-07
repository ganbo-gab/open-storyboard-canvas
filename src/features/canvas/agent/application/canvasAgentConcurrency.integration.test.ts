import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentModelTurnRequest, AgentModelTurnResponse, AgentScope } from '../domain/agentModel';
import type { ChatCatalogEntry } from '@/features/canvas/application/chatModelCatalog';
import * as sdk from '../infrastructure/sdkRuntime';
import type { StoryboardModelProviderOptions } from '../infrastructure/sdkRuntime';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { stageCommands } from '@/features/stage/application/stageCommands';
import {
  cancelCanvasAgentRun, getCanvasAgentSession, listPendingCanvasAgentApprovals,
  resolveCanvasAgentApproval, runCanvasAgentTurn,
} from './canvasAgentController';

// Keep controller, SDK, approvals, session persistence and tool execution real.
// The only request boundary is a local transport with explicitly held responses.
const gateway = vi.hoisted(() => ({ response: vi.fn<(request: AgentModelTurnRequest) => Promise<AgentModelTurnResponse>>() }));
vi.mock('./agentRuntimeLoader', () => ({ loadCanvasAgentSdkRuntime: async () => ({ ...sdk,
  createStoryboardAgentRuntime: (options: StoryboardModelProviderOptions) => sdk.createStoryboardAgentRuntime({ ...options,
    transport: { getResponse: gateway.response, async *getStreamedResponse(request, signal) {
      signal?.throwIfAborted(); yield { type: 'completed', response: await gateway.response(request) };
    } },
  }),
}) }));

const model: ChatCatalogEntry = {
  id: 'custom:concurrency:fixture', providerId: 'fixture', providerLabel: 'Fixture', modelId: 'local', modelLabel: 'Local fixture',
  supportsMultimodal: false, supportsTools: true, supportsStreaming: true, supportsReasoningSummary: false,
  supportsToolSearch: false, agentProtocol: 'openai-chat-completions', usable: true,
};
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const done: AgentModelTurnResponse = { responseId: 'done', text: 'Finished once.', toolCalls: [], usage };
let projectId: string;
let stageId: string;
let sequence = 0;
const runIds = new Set<string>();
function identity({ runId }: { sessionId: string; runId: string }): void { runIds.add(runId); }
function addObjects(...ids: string[]): AgentModelTurnResponse {
  return { responseId: 'requested-edits', usage, toolCalls: ids.map(id => ({ callId: `add-${id}`, name: 'stage_command',
    arguments: JSON.stringify({ nodeId: stageId, command: { type: 'object.add', item: { id, label: id, x: 0, y: 0, color: '#778899', category: 'object' } } }),
  })) };
}
function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('Deferred response was not initialized'); };
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}
beforeEach(() => {
  gateway.response.mockReset();
  projectId = `concurrency-fixture-${++sequence}`;
  useCanvasStore.setState({ nodes: [], edges: [], revision: 0, history: { past: [], future: [] }, dragHistorySnapshot: null, activeDirectorStudioNodeId: null });
  useProjectStore.setState({ currentProjectId: projectId, saveCurrentProject: vi.fn(), waitForProjectPersistence: vi.fn(async () => {}) });
  stageId = stageCommands.create({ name: 'Concurrency fixture' }).nodeId;
});
afterEach(() => {
  for (const runId of runIds) cancelCanvasAgentRun(runId);
  runIds.clear();
  vi.restoreAllMocks();
});

describe('one advancing SDK runner per session and approval run', () => {
  it.each<AgentScope>(['home', 'canvas', 'stage'])('rejects a second turn while the same %s session is running', async scope => {
    gateway.response.mockResolvedValueOnce(done);
    const first = await runCanvasAgentTurn({ projectId, scope, model, message: 'Create the conversation.', onRunStarted: identity });
    const entered = deferred<void>();
    const response = deferred<AgentModelTurnResponse>();
    gateway.response.mockImplementationOnce(async () => { entered.resolve(); return response.promise; });
    const running = runCanvasAgentTurn({ projectId, scope, sessionId: first.sessionId, model, message: 'Hold this turn.', onRunStarted: identity });
    await entered.promise;
    const historyBefore = getCanvasAgentSession(first.sessionId)!.items;
    await expect(runCanvasAgentTurn({ projectId, scope, sessionId: first.sessionId, model, message: 'Must not enter the model.' }))
      .rejects.toThrow(/正在运行|等待确认/);
    expect(gateway.response).toHaveBeenCalledTimes(2);
    expect(getCanvasAgentSession(first.sessionId)!.items).toEqual(historyBefore);
    response.resolve(done);
    expect((await running).sessionId).toBe(first.sessionId);
    gateway.response.mockResolvedValueOnce(done);
    expect((await runCanvasAgentTurn({ projectId, scope, sessionId: first.sessionId, model, message: 'Now the next turn can start.', onRunStarted: identity })).status).toBe('completed');
    expect(gateway.response).toHaveBeenCalledTimes(3);
  });

  it('preserves waiting approvals and refuses to close their history as an abandoned run', async () => {
    gateway.response.mockResolvedValueOnce(addObjects('pending-object'));
    const pending = await runCanvasAgentTurn({ projectId, scope: 'stage', model, message: 'Review adding an object.', executionMode: 'manual', onRunStarted: identity });
    expect(pending.status).toBe('awaiting-approval');
    const before = getCanvasAgentSession(pending.sessionId)!.items;
    await expect(runCanvasAgentTurn({ projectId, scope: 'stage', sessionId: pending.sessionId, model, message: 'Do not overwrite this pending run.' }))
      .rejects.toThrow(/正在运行|等待确认/);
    expect(getCanvasAgentSession(pending.sessionId)!.items).toEqual(before);
    expect(listPendingCanvasAgentApprovals(projectId, pending.sessionId, 'stage').map(approval => approval.id)).toEqual(['add-pending-object']);
    expect(stageCommands.query(stageId).data.items).toEqual([]);
    expect(gateway.response).toHaveBeenCalledOnce();
    gateway.response.mockResolvedValueOnce(done);
    expect((await resolveCanvasAgentApproval({ runId: pending.runId, approvalId: pending.approvals[0].id, approve: true, model })).status).toBe('completed');
    expect(stageCommands.query(stageId).data.items.map(item => item.id)).toEqual(['pending-object']);
  });

  it('refuses simultaneous decisions for different approvals in the same run, then accepts the remaining decision', async () => {
    gateway.response.mockResolvedValueOnce(addObjects('first-object', 'second-object'));
    const pending = await runCanvasAgentTurn({ projectId, scope: 'stage', model, message: 'Review two independent edits.', executionMode: 'manual', onRunStarted: identity });
    expect(pending.approvals).toHaveLength(2);
    const first = resolveCanvasAgentApproval({ runId: pending.runId, approvalId: 'add-first-object', approve: true, model });
    await expect(resolveCanvasAgentApproval({ runId: pending.runId, approvalId: 'add-second-object', approve: false, model }))
      .rejects.toThrow(/另一个操作|等待完成/);
    const remaining = await first;
    expect(remaining.status).toBe('awaiting-approval');
    expect(remaining.approvals.map(approval => approval.id)).toEqual(['add-second-object']);
    expect(stageCommands.query(stageId).data.items.map(item => item.id)).toEqual(['first-object']);
    expect(gateway.response).toHaveBeenCalledOnce();
    gateway.response.mockImplementationOnce(async request => {
      expect(request.input.filter(item => item.type === 'function_call_result').map(item => item.callId)).toEqual(['add-first-object', 'add-second-object']);
      return done;
    });
    const completed = await resolveCanvasAgentApproval({ runId: pending.runId, approvalId: 'add-second-object', approve: false, model });
    expect(completed.status).toBe('completed');
    expect(stageCommands.query(stageId).data.items.map(item => item.id)).toEqual(['first-object']);
    expect(listPendingCanvasAgentApprovals(projectId, pending.sessionId, 'stage')).toEqual([]);
  });

  it.each([false, true])('releases turn and resolution locks after a model failure without losing executed work (stream=%s)', async streaming => {
    const selected = { ...model, supportsStreaming: streaming };
    gateway.response.mockResolvedValueOnce(addObjects('existing-object')).mockRejectedValueOnce(new Error('Local continuation failed'));
    const pending = await runCanvasAgentTurn({ projectId, scope: 'stage', model: selected, message: 'Approve this edit.', executionMode: 'manual', onRunStarted: identity });
    await expect(resolveCanvasAgentApproval({ runId: pending.runId, approvalId: 'add-existing-object', approve: true, model: selected }))
      .rejects.toThrow('Local continuation failed');
    expect(stageCommands.query(stageId).data.items.map(item => item.id)).toEqual(['existing-object']);
    expect(listPendingCanvasAgentApprovals(projectId, pending.sessionId, 'stage')).toEqual([]);
    gateway.response.mockImplementationOnce(async request => {
      expect(request.input.some(item => item.type === 'function_call_result' && item.callId === 'add-existing-object' && item.output.includes('existing-object'))).toBe(true);
      return done;
    });
    const continued = await runCanvasAgentTurn({ projectId, scope: 'stage', sessionId: pending.sessionId, model: selected, message: 'Continue using the completed edit.', onRunStarted: identity });
    expect(continued.status).toBe('completed');
    expect(continued.sessionId).toBe(pending.sessionId);
    expect(stageCommands.query(stageId).data.items.map(item => item.id)).toEqual(['existing-object']);
    expect(gateway.response).toHaveBeenCalledTimes(3);
  });
});
