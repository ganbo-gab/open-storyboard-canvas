import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentModelTurnRequest, AgentModelTurnResponse } from '../domain/agentModel';
import type { StoryboardModelProviderOptions } from '../infrastructure/sdkRuntime';

const transport = vi.hoisted(() => ({ response: vi.fn() }));
vi.mock('./agentRuntimeLoader', () => ({ loadCanvasAgentSdkRuntime: async () => {
  const sdk = await import('../infrastructure/sdkRuntime');
  return { ...sdk, createStoryboardAgentRuntime: (options: StoryboardModelProviderOptions) => sdk.createStoryboardAgentRuntime({ ...options,
    transport: { getResponse: transport.response, async *getStreamedResponse() { throw new Error('Not streamed'); } } }) };
} }));
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it.each(['run-state', 'approval-ledger'] as const)('restores the original selected model and manual run mode from %s after a later session mode change', async (recoverySource) => {
  const values = new Map<string, string>();
  const storage = { getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => { values.set(name, value); }, removeItem: (name: string) => values.delete(name) };
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', { localStorage: storage });
  const channels = await import('@/features/channels/store/channelStore');
  await channels.ensureChannelStoresHydrated();
  channels.saveChannelRecord({ version: 2, id: 'restart-chat', name: 'Restart chat', baseUrl: 'https://fixture.test', auth: { type: 'none' },
    operations: { chat: { method: 'POST', path: '/chat/completions', body: 'json', template: { messages: '{{messages}}', tools: '{{tools}}' },
      response: { mode: 'sync', outputs: [] } } }, models: [{ id: 'deepseek-flash', operations: ['chat'], params: [], capabilities: { supportsMultimodal: false } }] });
  const { getChannelCatalogProviders } = await import('@/features/channels/application/channelCatalog');
  const { buildChatModelCatalog } = await import('@/features/canvas/application/chatModelCatalog');
  const model = buildChatModelCatalog(getChannelCatalogProviders()).find((entry) => entry.modelId === 'deepseek-flash');
  if (!model) throw new Error('Missing test text model');
  const requests: AgentModelTurnRequest[] = [];
  transport.response.mockReset().mockImplementation(async (request: AgentModelTurnRequest): Promise<AgentModelTurnResponse> => {
    requests.push(request);
    return { responseId: `response-${requests.length}`, toolCalls: requests.length <= 2 ? [{ callId: `rename-${requests.length}`, name: 'canvas_command',
      arguments: JSON.stringify({ type: 'node.rename', input: { nodeId: 'note', displayName: `Name ${requests.length}` } }) }] : [],
      text: requests.length <= 2 ? undefined : 'Done', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } };
  });
  const prepareGraph = async () => {
    const { useCanvasStore } = await import('@/stores/canvasStore');
    const { useProjectStore } = await import('@/stores/projectStore');
    useCanvasStore.setState({ nodes: [{ id: 'note', type: 'textAnnotationNode', position: { x: 0, y: 0 }, data: { content: 'Note' } }],
      edges: [], revision: 0, history: { past: [], future: [] }, dragHistorySnapshot: null });
    useProjectStore.setState({ currentProjectId: 'restart-project', saveCurrentProject: vi.fn(), waitForProjectPersistence: vi.fn(async () => {}) });
  };
  await prepareGraph();
  const firstController = await import('./canvasAgentController');
  const preferences = { image: { modelId: 'custom:selected-image:gpt-image-2.6', supportedResolutions: ['1024x1536'] } };
  const first = await firstController.runCanvasAgentTurn({ projectId: 'restart-project', model, executionMode: 'manual',
    generationPreferences: preferences, message: 'Rename canvas node' });
  expect(first.status).toBe('awaiting-approval');
  const { AgentSessionRepository } = await import('../infrastructure/agentSessionRepository');
  new AgentSessionRepository().updateSessionMetadata(first.sessionId, { executionMode: 'full' });
  if (recoverySource === 'approval-ledger') {
    const { createAgentCompressedStorage } = await import('../infrastructure/agentCompressedStorage');
    createAgentCompressedStorage(storage).removeItem('storyboard-copilot:canvas-agent:run-states:v1');
  }
  vi.resetModules();
  await prepareGraph();
  const resumedController = await import('./canvasAgentController');
  try {
    const resumed = await resumedController.resolveCanvasAgentApproval({ runId: first.runId, approvalId: 'rename-1', approve: true, model });
    // The explicit approval applies only the first edit. The later session's
    // full mode cannot silently approve the next operation of this older run.
    expect(resumed.status).toBe('awaiting-approval');
    expect(resumed.approvals[0]?.id).toBe('rename-2');
    expect(requests).toHaveLength(2);
    expect(requests[1].systemInstructions).toContain(`modelId=${preferences.image.modelId}`);
    expect(requests[1].systemInstructions).toContain('当前是手动模式');
    const { useCanvasStore } = await import('@/stores/canvasStore');
    expect(useCanvasStore.getState().nodes[0].data.displayName).toBe('Name 1');
  } finally {
    resumedController.cancelCanvasAgentRun(first.runId);
    firstController.cancelCanvasAgentRun(first.runId);
  }
});
