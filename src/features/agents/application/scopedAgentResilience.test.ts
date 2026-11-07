import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentModelTurnRequest, AgentModelTurnResponse } from '@/features/canvas/agent/domain/agentModel';
import type { ChatCatalogEntry } from '@/features/canvas/application/chatModelCatalog';
import * as sdk from '@/features/canvas/agent/infrastructure/sdkRuntime';
import type { StoryboardModelProviderOptions } from '@/features/canvas/agent/infrastructure/sdkRuntime';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { stageCommands } from '@/features/stage/application/stageCommands';
import { getCanvasAgentSession } from '@/features/canvas/agent/application/canvasAgentController';
import { createScopedAgentSession, type ScopedAgentSession } from './scopedAgentSession';
const gateway = vi.hoisted(() => ({ response: vi.fn<(request: AgentModelTurnRequest) => Promise<AgentModelTurnResponse>>() }));
vi.mock('@/features/canvas/agent/application/agentRuntimeLoader', () => ({ loadCanvasAgentSdkRuntime: async () => ({ ...sdk,
  createStoryboardAgentRuntime: (options: StoryboardModelProviderOptions) => sdk.createStoryboardAgentRuntime({ ...options,
    transport: { getResponse: gateway.response, async *getStreamedResponse(request, signal) { signal?.throwIfAborted(); yield { type: 'completed', response: await gateway.response(request) }; } },
  }),
}) }));
const model: ChatCatalogEntry = { id: 'custom:fixture:resilience', providerId: 'fixture', providerLabel: 'Fixture', modelId: 'resilience', modelLabel: 'Resilience',
  supportsMultimodal: false, supportsTools: true, supportsStreaming: true, supportsReasoningSummary: false,
  supportsToolSearch: false, agentProtocol: 'openai-chat-completions', usable: true };
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const done: AgentModelTurnResponse = { responseId: 'done', text: 'Scene finished', toolCalls: [], usage };
let service: ScopedAgentSession;
let stageId: string;
function add(callId: string, id: string): AgentModelTurnResponse {
  return { responseId: callId, usage, toolCalls: [{ callId, name: 'stage_command', arguments: JSON.stringify({ nodeId: stageId,
    command: { type: 'object.add', item: { id, label: id, x: 0, y: 0, color: '#778899', category: 'object' } } }) }] };
}
beforeEach(() => {
  gateway.response.mockReset();
  useCanvasStore.setState({ nodes: [], edges: [], revision: 0, history: { past: [], future: [] }, dragHistorySnapshot: null, activeDirectorStudioNodeId: null });
  useProjectStore.setState({ currentProjectId: 'resilience', saveCurrentProject: vi.fn(), waitForProjectPersistence: vi.fn(async () => {}) });
  stageId = stageCommands.create({ name: 'Resilience fixture' }).nodeId;
  service = createScopedAgentSession({ scope: 'stage', projectId: 'resilience' });
});
afterEach(() => { service.stop(); vi.restoreAllMocks(); });

describe('stage long task and failure recovery with real SDK/controller/tools', () => {
  it('finishes more than the old 24 calls and 32 auto-approval steps in one turn', async () => {
    let turn = 0;
    gateway.response.mockImplementation(async () => ++turn <= 36 ? add(`step-${turn}`, `object-${turn}`) : done);
    const history = useCanvasStore.getState().history.past.length;
    const result = await service.send({ message: '搭建舞台，创建36件道具', model, executionMode: 'full' });
    expect(result?.status).toBe('completed');
    expect(stageCommands.query(stageId).data.items).toHaveLength(36);
    expect(useCanvasStore.getState().history.past.length - history).toBe(36);
    expect(gateway.response).toHaveBeenCalledTimes(37);
    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(stageCommands.query(stageId).data.items).toHaveLength(35);
  }, 20_000);
  it.each([false, true])('keeps the same first session and executed result after a provider failure (stream=%s)', async streaming => {
    gateway.response.mockResolvedValueOnce(add('first-call', 'existing')).mockRejectedValueOnce(new Error('provider continuation refused'));
    await expect(service.send({ message: '先创建一件道具，再完成场景', model: { ...model, supportsStreaming: streaming }, executionMode: 'full' })).rejects.toThrow('provider continuation refused');
    const failed = service.getSnapshot();
    expect(failed.sessionId).toBeTruthy(); expect(failed.status).toBe('error');
    expect(stageCommands.query(stageId).data.items.map(item => item.id)).toEqual(['existing']);
    const persisted = getCanvasAgentSession(failed.sessionId!);
    expect(persisted?.items.some(item => item.type === 'function_call_result' && item.callId === 'first-call')).toBe(true);
    // A new application service simulates closing/reopening the panel after the failure.
    const reopened = createScopedAgentSession({ scope: 'stage', projectId: 'resilience' });
    reopened.loadSession(failed.sessionId!);
    gateway.response.mockImplementationOnce(async request => {
      expect(request.input.some(item => item.type === 'function_call_result' && item.callId === 'first-call' && item.output.includes('existing'))).toBe(true);
      return add('second-call', 'remaining');
    }).mockResolvedValueOnce(done);
    const resumed = await reopened.send({ message: '继续未完成的部分，先检查已有结果', model: { ...model, supportsStreaming: streaming }, executionMode: 'full' });
    expect(resumed?.sessionId).toBe(failed.sessionId);
    expect(stageCommands.query(stageId).data.items.map(item => item.id)).toEqual(['existing', 'remaining']);
    reopened.stop();
  });
});
