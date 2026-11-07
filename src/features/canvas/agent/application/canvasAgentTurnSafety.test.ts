import { afterEach, describe, expect, it, vi } from 'vitest';
import * as runtime from '../infrastructure/sdkRuntime';
import type { StoryboardModelProviderOptions } from '../infrastructure/sdkRuntime';
import * as mediaResolver from './agentMediaResolver';
import type { AgentModelTurnResponse } from '../domain/agentModel';
import type { ChatCatalogEntry } from '@/features/canvas/application/chatModelCatalog';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { canvasCommandRegistry } from '@/features/canvas/application/canvasCommandService';
import { runCanvasAgentTurn, resolveCanvasAgentApproval, cancelCanvasAgentRun } from './canvasAgentController';
import { canvasAgentApprovalStore, createApprovalId } from './agentApproval';

const mocks = vi.hoisted(() => ({ response: vi.fn() }));
vi.mock('./agentRuntimeLoader', () => ({ loadCanvasAgentSdkRuntime: async () => {
  // Keep the controller's lazy-loader boundary while injecting a local model transport.
  return { ...runtime, createStoryboardAgentRuntime: (options: StoryboardModelProviderOptions) => runtime.createStoryboardAgentRuntime({ ...options,
    transport: { getResponse: mocks.response, async *getStreamedResponse() { throw new Error('Not streamed'); } } }) };
} }));
const model: ChatCatalogEntry = { id: 'custom:fixture:tools', providerId: 'fixture', providerLabel: 'Fixture', modelId: 'tools', modelLabel: 'Tools', supportsMultimodal: false,
  supportsTools: true, supportsStreaming: false, supportsReasoningSummary: false, supportsToolSearch: false, agentProtocol: 'openai-chat-completions', usable: true };
let runId: string | undefined;
afterEach(() => { if (runId) cancelCanvasAgentRun(runId); runId = undefined; vi.useRealTimers(); vi.restoreAllMocks(); });
function call(): AgentModelTurnResponse {
  return { responseId: 'create', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, toolCalls: [{ callId: 'create-call', name: 'canvas_command',
    arguments: JSON.stringify({ type: 'node.create', input: { nodeType: 'tagNode', position: { x: 0, y: 0 } } }) }] };
}

describe('Agent controller whole-turn deadline', () => {
  it('includes stalled attachment preparation in the same thirty-minute deadline', async () => {
    vi.useFakeTimers();
    useProjectStore.setState({ currentProjectId: 'deadline-project' });
    useCanvasStore.setState({ nodes: [{ id: 'fixture-image', type: 'uploadNode', position: { x: 0, y: 0 }, data: { imageUrl: 'https://assets.example/fixture.png', aspectRatio: '1:1' } }], edges: [] });
    const prepare = vi.spyOn(mediaResolver, 'prepareAgentMediaSource').mockReturnValue(Promise.withResolvers<never>().promise);
    const stopped = vi.fn();
    const pending = runCanvasAgentTurn({ projectId: 'deadline-project', model: { ...model, supportsMultimodal: true }, message: '查看图片', onTurnStopped: stopped,
      media: [{ assetId: 'fixture-image:image', nodeId: 'fixture-image', title: 'Fixture', origin: 'canvas-asset', source: 'https://assets.example/fixture.png' }] });
    const rejected = expect(pending).rejects.toThrow(/30 分钟.*停止/);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    await rejected;
    expect(prepare).toHaveBeenCalledWith('https://assets.example/fixture.png');
    expect(stopped).toHaveBeenCalledWith(expect.objectContaining({ code: 'turn-deadline' }));
  });

  it('interrupts an approved tool that never settles, revokes authority, and reports the stop reason', async () => {
    vi.useFakeTimers();
    useProjectStore.setState({ currentProjectId: 'deadline-project' });
    useCanvasStore.setState({ nodes: [], edges: [], revision: 0, history: { past: [], future: [] } });
    mocks.response.mockResolvedValue(call());
    const stopped = vi.fn();
    const first = await runCanvasAgentTurn({ projectId: 'deadline-project', model, message: '创建画布节点', onTurnStopped: stopped });
    runId = first.runId;
    expect(first.status).toBe('awaiting-approval');
    const execute = vi.spyOn(canvasCommandRegistry, 'executeApproved').mockReturnValue(Promise.withResolvers<never>().promise);
    const pending = resolveCanvasAgentApproval({ runId: first.runId, approvalId: first.approvals[0].id, approve: true, model });
    const rejected = expect(pending).rejects.toThrow(/30 分钟.*停止/);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    await rejected;
    expect(stopped).toHaveBeenCalledWith(expect.objectContaining({ code: 'turn-deadline', message: expect.stringMatching(/30 分钟.*停止/) }));
    expect(canvasAgentApprovalStore.get(createApprovalId(first.runId, 'canvas_command', 'create-call'))?.status).not.toBe('awaiting-approval');
  });

  it('revokes an unattended approval at thirty minutes and publishes its explanation without another model call', async () => {
    vi.useFakeTimers();
    useProjectStore.setState({ currentProjectId: 'deadline-project' });
    useCanvasStore.setState({ nodes: [], edges: [], revision: 0, history: { past: [], future: [] } });
    mocks.response.mockReset().mockResolvedValue(call());
    const stopped = vi.fn();
    const first = await runCanvasAgentTurn({ projectId: 'deadline-project', model, message: '创建画布节点', onTurnStopped: stopped });
    runId = first.runId;
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(stopped).toHaveBeenCalledWith(expect.objectContaining({ code: 'turn-deadline' }));
    expect(canvasAgentApprovalStore.get(createApprovalId(first.runId, 'canvas_command', 'create-call'))?.status).not.toBe('awaiting-approval');
    expect(mocks.response).toHaveBeenCalledOnce();
    await expect(resolveCanvasAgentApproval({ runId: first.runId, approvalId: first.approvals[0].id, approve: true, model })).rejects.toThrow();
    expect(useCanvasStore.getState().nodes).toEqual([]);
  });
});
