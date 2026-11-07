import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as sdk from '../infrastructure/sdkRuntime';
import type { StoryboardModelProviderOptions } from '../infrastructure/sdkRuntime';
import { AgentModelGatewayError } from '../infrastructure/agentModelGateway';
import type { AgentModelTurnRequest, AgentModelTurnResponse } from '../domain/agentModel';
import type { ChatCatalogEntry } from '@/features/canvas/application/chatModelCatalog';
import { stageCommands } from '@/features/stage/application/stageCommands';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { cancelCanvasAgentRun, resolveCanvasAgentApproval, runCanvasAgentTurn } from './canvasAgentController';

const gateway = vi.hoisted(() => ({ response: vi.fn<(request: AgentModelTurnRequest) => Promise<AgentModelTurnResponse>>() }));
vi.mock('./agentRuntimeLoader', () => ({ loadCanvasAgentSdkRuntime: async () => ({ ...sdk,
  createStoryboardAgentRuntime: (options: StoryboardModelProviderOptions) => sdk.createStoryboardAgentRuntime({ ...options,
    transport: { getResponse: gateway.response, async *getStreamedResponse(request) { yield { type: 'completed', response: await gateway.response(request) }; } },
  }),
}) }));
const model: ChatCatalogEntry = { id: 'custom:feedback:fixture', providerId: 'fixture', providerLabel: 'Fixture', modelId: 'fixture', modelLabel: 'Fixture',
  supportsMultimodal: false, supportsTools: true, supportsStreaming: true, supportsReasoningSummary: false,
  supportsToolSearch: false, agentProtocol: 'openai-chat-completions', usable: true };
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const done: AgentModelTurnResponse = { responseId: 'done', text: 'Done', toolCalls: [], usage };
const runs = new Set<string>();
let stageId: string;
beforeEach(() => {
  gateway.response.mockReset();
  useCanvasStore.setState({ nodes: [], edges: [], revision: 0, history: { past: [], future: [] }, dragHistorySnapshot: null });
  useProjectStore.setState({ currentProjectId: 'feedback', saveCurrentProject: vi.fn(), waitForProjectPersistence: vi.fn(async () => {}) });
  stageId = stageCommands.create({ name: 'Feedback fixture' }).nodeId;
});
afterEach(() => { runs.forEach(cancelCanvasAgentRun); runs.clear(); vi.restoreAllMocks(); });
const initial = (onToolEvent = vi.fn(), onRetry = vi.fn()) => runCanvasAgentTurn({ projectId: 'feedback', scope: 'stage', model,
  message: 'Please prepare this stage operation.', executionMode: 'manual', signal: new AbortController().signal,
  onToolEvent, onRetry, onRunStarted: ({ runId }) => runs.add(runId) });

describe('approval continuation uses the current operation feedback', () => {
  it('delivers tool events and model retries to the new approval callback', async () => {
    gateway.response.mockResolvedValueOnce({ responseId: 'call', usage, toolCalls: [{ callId: 'add', name: 'stage_command',
      arguments: JSON.stringify({ nodeId: stageId, command: { type: 'object.add', item: { id: 'once', label: 'once', x: 0, y: 0, color: '#888888', category: 'object' } } }) }] });
    const oldEvents = vi.fn(), oldRetry = vi.fn();
    const waiting = await initial(oldEvents, oldRetry);
    const events = vi.fn(), retry = vi.fn();
    gateway.response.mockRejectedValueOnce(new AgentModelGatewayError('temporary busy', 503, true, false))
      .mockResolvedValueOnce(done);
    const result = await resolveCanvasAgentApproval({ runId: waiting.runId, approvalId: 'add', approve: true, model,
      signal: new AbortController().signal, onToolEvent: events, onRetry: retry });
    expect(result.status).toBe('completed');
    expect(events.mock.calls.map(([event]) => event.status)).toEqual(['executing', 'succeeded']);
    expect(retry).toHaveBeenCalledWith({ attempt: 1, maxRetries: 3, status: 503 });
    expect(oldEvents).not.toHaveBeenCalled(); expect(oldRetry).not.toHaveBeenCalled();
    expect(stageCommands.query(stageId).data.items.map(item => item.id)).toEqual(['once']);
  });
  it('cancels a running scoped tool using the approval operation signal', async () => {
    gateway.response.mockResolvedValueOnce({ responseId: 'capture', usage, toolCalls: [{ callId: 'capture', name: 'stage_capture', arguments: JSON.stringify({ nodeId: stageId }) }] });
    const started = Promise.withResolvers<AbortSignal>();
    vi.spyOn(stageCommands, 'capture').mockImplementation(async (_id, _time, signal) => {
      if (!signal) throw new Error('Capture must receive an abort signal');
      started.resolve(signal);
      return new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const waiting = await initial();
    const controller = new AbortController();
    const pending = resolveCanvasAgentApproval({ runId: waiting.runId, approvalId: 'capture', approve: true, model, signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const signal = await started.promise;
    controller.abort();
    expect(signal.aborted).toBe(true);
    await rejected;
    expect(gateway.response).toHaveBeenCalledOnce();
  });
});
