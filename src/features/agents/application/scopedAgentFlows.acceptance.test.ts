import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import * as sdk from '@/features/canvas/agent/infrastructure/sdkRuntime';
import type { StoryboardModelProviderOptions } from '@/features/canvas/agent/infrastructure/sdkRuntime';
import type { AgentModelToolCall, AgentModelTurnRequest, AgentModelTurnResponse } from '@/features/canvas/agent/domain/agentModel';
import type { ChatCatalogEntry } from '@/features/canvas/application/chatModelCatalog';
import { canvasCommandRegistry } from '@/features/canvas/application/canvasCommandService';
import { canvasAiGateway } from '@/features/canvas/application/canvasServices';
import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { sampleDirectorMotion } from '@/features/canvas/application/directorMotion';
import { publishGenerationJobResults } from '@/features/canvas/application/generation/publishJobResults';
import { useGenerationHistoryStore } from '@/features/library/history/historyStore';
import { canvasAgentApprovalStore } from '@/features/canvas/agent/application/agentApproval';
import { rollbackAgentTurn } from '@/features/canvas/agent/application/agentCanvasRollback';
import { listCanvasAgentSessions } from '@/features/canvas/agent/application/canvasAgentController';
import { channelProviderId, useChannelStore } from '@/features/channels/store/channelStore';
import { openAIStandardProfile } from '@/features/channels/presets/openai';
import { persistAssetBlob, readWorkspaceRecord } from '@/features/assets/application/assetMediaStorage';
import { resolveAsset, saveAsset } from '@/features/assets/application/assetCatalog';
import { registerStageViewport, stageCommands } from '@/features/stage/application/stageCommands';
import type { StoryPlan } from '@/features/stage/application/storyPlan';
import { useCanvasStore } from '@/stores/canvasStore';
import { withCanvasHistoryAgentTurn, withCanvasHistoryGroup } from '@/stores/canvasHistory';
import { useProjectStore } from '@/stores/projectStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { getProjectRecord } from '@/commands/projectState';
import { createScopedAgentSession, type ScopedAgentSession } from './scopedAgentSession';
import { openAgentProject, type AgentCanvasPlan } from './agentCanvasPlan';

// Substitute model transport and the generation polling clock/delivery boundary.
// The SDK runner, session/controller, registry, approvals, persistence and undo stay real.
const scriptedModel = vi.hoisted(() => ({
  response: vi.fn<(request: AgentModelTurnRequest) => Promise<AgentModelTurnResponse>>(),
  pollWait: vi.fn<() => Promise<void>>(),
}));
vi.mock('@/features/canvas/agent/application/agentRuntimeLoader', () => ({
  loadCanvasAgentSdkRuntime: async () => ({
    ...sdk,
    createStoryboardAgentRuntime: (options: StoryboardModelProviderOptions) => sdk.createStoryboardAgentRuntime({
      ...options,
      transport: {
        getResponse: scriptedModel.response,
        async *getStreamedResponse() { throw new Error('The deterministic fixture does not stream'); },
      },
    }),
    createCanvasAgent: (options: Parameters<typeof sdk.createCanvasAgent>[0]) => sdk.createCanvasAgent({
      ...options, context: { ...options.context, generationFollowThrough: { wait: scriptedModel.pollWait } },
    }),
  }),
}));

const model: ChatCatalogEntry = {
  id: 'custom:acceptance:scripted-chat', providerId: 'acceptance', providerLabel: 'Local fixture',
  modelId: 'scripted-chat', modelLabel: 'Scripted chat', usable: true,
  supportsTools: true, supportsMultimodal: false, supportsStreaming: false,
  supportsReasoningSummary: false, supportsToolSearch: false, agentProtocol: 'openai-chat-completions',
};
const imageModel = `custom:${channelProviderId('acceptance-local', 'image')}:gpt-image-1`;
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const done: AgentModelTurnResponse = { responseId: 'done', text: '本地工具流程已完成。', toolCalls: [], usage };
const sessions: ScopedAgentSession[] = [];
const generationCompletions: Array<{ nodeId: string; jobId: string; source: string }> = [];
let captureCleanup: (() => void) | undefined;
let imageSource: string;

function call(callId: string, name: string, args: unknown): AgentModelToolCall {
  return { callId, name, arguments: JSON.stringify(args) };
}
function response(...toolCalls: AgentModelToolCall[]): AgentModelTurnResponse {
  return { responseId: toolCalls.map((item) => item.callId).join('+'), toolCalls, usage };
}
function command(callId: string, type: string, input: unknown): AgentModelToolCall {
  return call(callId, 'canvas_command', { type, input });
}
function toolOutput<T>(request: AgentModelTurnRequest, callId: string, schema: z.ZodType<T>): T {
  const item = request.input.find((entry) => entry.type === 'function_call_result' && entry.callId === callId);
  if (!item || item.type !== 'function_call_result') throw new Error(`Missing actual tool result for ${callId}`);
  const parsed = schema.safeParse(JSON.parse(item.output) as unknown);
  if (!parsed.success) throw new Error(`Unexpected actual ${callId} output: ${item.output}`);
  return parsed.data;
}
function session(scope: 'home' | 'canvas' | 'stage', projectId?: string): ScopedAgentSession {
  const service = createScopedAgentSession({ scope, projectId });
  sessions.push(service);
  return service;
}
function graph() {
  return structuredClone({ nodes: useCanvasStore.getState().nodes, edges: useCanvasStore.getState().edges });
}
async function project(name: string): Promise<string> {
  const id = useProjectStore.getState().createProject(name);
  await useProjectStore.getState().waitForProjectPersistence(id);
  return id;
}
function pendingType(service: ScopedAgentSession): string[] {
  return service.getSnapshot().approvals.map((approval) => z.object({ type: z.string() }).parse(approval.arguments).type);
}

beforeEach(async () => {
  scriptedModel.response.mockReset().mockRejectedValue(new Error('Unscripted model request'));
  generationCompletions.splice(0);
  scriptedModel.pollWait.mockReset().mockImplementation(async () => {
    for (const completion of generationCompletions.splice(0)) {
      publishGenerationJobResults(completion.nodeId, { job_id: completion.jobId, status: 'succeeded',
        results: [{ kind: 'image', source: completion.source }] });
    }
  });
  useCanvasStore.setState({
    nodes: [], edges: [], revision: 0, selectedNodeId: null,
    activeDirectorStudioNodeId: null, activeToolDialog: null,
    history: { past: [], future: [] }, dragHistorySnapshot: null,
    currentViewport: { x: 0, y: 0, zoom: 1 }, canvasViewportSize: { width: 1280, height: 720 },
  });
  useProjectStore.setState({ projects: [], currentProjectId: null, currentProject: null, isHydrated: true, isOpeningProject: false });
  useSettingsStore.setState({ appendParameterConstraintsToPrompt: false });
  useChannelStore.setState({ channels: [{
    profile: { ...openAIStandardProfile, id: 'acceptance-local', name: 'Local deterministic fixture',
      baseUrl: 'http://127.0.0.1:1', auth: { type: 'none' } },
    origin: 'native', migrationIssues: [], createdAt: 1, updatedAt: 1,
  }] });
  // Actual durable media storage, containing fixture bytes rather than a rendered image.
  imageSource = await persistAssetBlob(new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Network is forbidden in Agent acceptance tests'); }));
  vi.spyOn(canvasAiGateway, 'submitGenerateImageJob').mockImplementation(async (payload) => {
    // The local gateway fixture finishes its already-created result placeholder;
    // it neither changes prompts nor constructs source/result nodes itself.
    const result = useCanvasStore.getState().nodes.slice().reverse().find((node) => node.type === CANVAS_NODE_TYPES.exportImage
      && node.data.sourcePrompt === payload.prompt && node.data.isGenerating === true);
    if (!result) throw new Error('The real generation service did not create a result placeholder');
    // The polling wait is an explicit deterministic provider-delivery handshake,
    // after the real submitter has associated its returned job id.
    generationCompletions.push({ nodeId: result.id, jobId: `local-job:${result.id}`, source: imageSource });
    return `local-job:${result.id}`;
  });
});

afterEach(async () => {
  captureCleanup?.(); captureCleanup = undefined;
  for (const service of sessions.splice(0)) {
    if (service.getSnapshot().status === 'running' || service.getSnapshot().status === 'awaiting-approval') service.stop();
  }
  vi.useRealTimers();
  const currentProjectId = useProjectStore.getState().currentProjectId;
  if (currentProjectId) await useProjectStore.getState().waitForProjectPersistence(currentProjectId);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Agent specification §8 — real runtime acceptance', () => {
  it.each(['manual', 'auto'] as const)('Home materializes the exact six-shot plan in %s mode without submitting generation', async (executionMode) => {
    const script = `猫咪走出小巷，寻找回家的路。${'街角的灯光映在它的眼睛里。'.repeat(480)}最终回到窗边。`;
    const plan: AgentCanvasPlan = { title: '猫咪回家', script, shots: Array.from({ length: 6 }, (_, index) => ({
      title: `镜头 ${index + 1}`, prompt: `第${index + 1}镜：${'猫咪穿过暖色街道，保持同一只橘猫的外貌。'.repeat(310)}结尾标记${index}`,
      modelId: imageModel, aspectRatio: '16:9', resolution: '2K',
    })) };
    let planId = '';
    scriptedModel.response
      .mockResolvedValueOnce(response(call('prepare', 'canvas_prepare_plan', plan)))
      .mockImplementationOnce(async (request) => {
        const prepared = toolOutput(request, 'prepare', z.object({ result: z.object({ planId: z.string(), paidGeneration: z.literal(false), nodeCount: z.literal(7) }) }));
        planId = prepared.result.planId;
        expect(useCanvasStore.getState().nodes).toHaveLength(0);
        expect(useProjectStore.getState().currentProjectId).toBeNull();
        return response(call('open', 'canvas_open_plan', { projectId: null, planId }));
      })
      .mockResolvedValueOnce(done);
    const service = session('home');
    const first = await service.send({ message: '做一个 6 镜头的猫咪短片分镜', model, executionMode });
    expect(first).toBeDefined();
    if (!first) throw new Error('Missing Home turn');
    if (executionMode === 'manual') {
      expect(service.getSnapshot().status).toBe('awaiting-approval');
      expect(service.getSnapshot().approvals.map((approval) => approval.toolName)).toEqual(['canvas_open_plan']);
      expect(useCanvasStore.getState().nodes).toHaveLength(0);
      expect(useProjectStore.getState().currentProjectId).toBeNull();
      await service.resolveApproval({ approvalId: service.getSnapshot().approvals[0].id, approve: true, model });
    }
    expect(service.getSnapshot().status).toBe('completed');
    const state = useCanvasStore.getState();
    const textNodes = state.nodes.filter((node) => node.type === CANVAS_NODE_TYPES.textAnnotation);
    const shots = state.nodes.filter((node) => node.type === CANVAS_NODE_TYPES.imageEdit);
    expect(textNodes).toHaveLength(1);
    expect(textNodes[0].data.content).toBe(script);
    expect(shots.map((node) => node.data.prompt)).toEqual(plan.shots.map((shot) => shot.prompt));
    expect(state.nodes).toHaveLength(7);
    expect(state.edges).toHaveLength(6);
    expect(state.edges.every((edge) => edge.source === textNodes[0].id && shots.some((shot) => shot.id === edge.target))).toBe(true);
    expect(new Set(state.edges.map((edge) => edge.target)).size).toBe(6);
    expect(canvasAiGateway.submitGenerateImageJob).not.toHaveBeenCalled();
    const actualProjectId = useProjectStore.getState().currentProjectId;
    expect(actualProjectId).toBeTruthy();
    const savedProject = await getProjectRecord(actualProjectId!);
    expect(JSON.parse(savedProject!.nodesJson)).toHaveLength(7);
    const storedPlan = await readWorkspaceRecord<{ data: Array<{ id: string; plan: AgentCanvasPlan }> }>('documents', 'storyboard-copilot:agent-canvas-plans:v1');
    expect(storedPlan?.data.find((entry) => entry.id === planId)?.plan).toEqual(plan);
    const preparedAudit = service.getSnapshot().toolEvents.find((entry) => entry.callId === 'prepare');
    expect(preparedAudit?.input).toMatchObject({ script: expect.stringMatching(/^\[redacted-long-value:/) });
    expect(JSON.stringify(preparedAudit)).not.toContain(script);
    expect(listCanvasAgentSessions('home', 'home').some((entry) => entry.id === first.sessionId)).toBe(true);
    expect(state.history.past).toHaveLength(1);
    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(useCanvasStore.getState().nodes).toHaveLength(0);
  }, 15_000);

  it.each(['manual', 'auto'] as const)('Canvas keeps paid generation gated in %s mode and withdraws the entire turn once', async (executionMode) => {
    const projectId = await project('Cyberpunk group');
    const transaction = canvasCommandRegistry.executeTransaction({ id: 'fixture-group', origin: 'ui', expectedRevision: 0, commands: [
      ...['left', 'right'].map((id, index) => ({ type: 'node.create' as const, version: 1 as const, input: {
        nodeId: id, nodeType: CANVAS_NODE_TYPES.imageEdit, position: { x: index * 500, y: 0 },
        configuration: { prompt: `${id} 原始提示词`, modelId: imageModel, aspectRatio: '16:9', resolution: '2K' },
      } })),
      { type: 'group.create', version: 1, input: { groupId: 'selected-group', nodeIds: ['left', 'right'] } },
    ] });
    expect(transaction.ok).toBe(true);
    expect(useCanvasStore.getState().nodes.find((node) => node.id === 'selected-group')?.selected).toBe(true);
    const before = graph();
    const previousHistory = useCanvasStore.getState().history.past.length;
    const updatedPrompts = { left: '赛博朋克霓虹雨夜中的左侧猫咪', right: '赛博朋克全息广告下的右侧猫咪' };
    scriptedModel.response
      .mockImplementationOnce(async (request) => {
        expect(request.systemInstructions).toContain('selected-group');
        return response(command('read-group', 'canvas.query', { scope: 'graph', limit: 20 }));
      })
      .mockImplementationOnce(async (request) => {
        const actual = toolOutput(request, 'read-group', z.object({ ok: z.literal(true), output: z.object({ value: z.object({ nodes: z.array(z.object({ id: z.string() })) }) }) }));
        expect(actual.output.value.nodes.map((node) => node.id)).toEqual(expect.arrayContaining(['left', 'right', 'selected-group']));
        return response(command('edit-left', 'node.setPrompt', { nodeId: 'left', prompt: updatedPrompts.left }),
          command('edit-right', 'node.setPrompt', { nodeId: 'right', prompt: updatedPrompts.right }));
      })
      .mockResolvedValueOnce(response(command('submit', 'generation.submit', { nodeIds: ['left', 'right'] })))
      .mockImplementationOnce(async (request) => {
        const generated = toolOutput(request, 'submit', z.object({ ok: z.literal(true), output: z.object({ references: z.object({ nodeIds: z.array(z.string()) }) }), followThrough: z.object({ outcome: z.literal('succeeded') }) }));
        expect(generated.output.references.nodeIds).toEqual(['left', 'right']);
        return done;
      });
    const service = session('canvas', projectId);
    const first = await service.send({ message: '把提示词都改成赛博朋克风格并生成', model, executionMode });
    if (!first) throw new Error('Missing Canvas turn');
    if (executionMode === 'manual') {
      // Runtime exposes two simultaneous underlying approvals, not a merged card.
      // UI may project this pair as one card, but each stable approval is real.
      expect(pendingType(service)).toEqual(['node.setPrompt', 'node.setPrompt']);
      expect(graph()).toEqual(before);
      const ids = service.getSnapshot().approvals.map((approval) => approval.id);
      await service.resolveApproval({ approvalId: ids[0], approve: true, model });
      expect(pendingType(service)).toEqual(['node.setPrompt']);
      expect(canvasAiGateway.submitGenerateImageJob).not.toHaveBeenCalled();
      await service.resolveApproval({ approvalId: ids[1], approve: true, model });
    }
    expect(pendingType(service)).toEqual(['generation.submit']);
    expect(canvasAiGateway.submitGenerateImageJob).not.toHaveBeenCalled();
    expect(useCanvasStore.getState().nodes.filter((node) => node.id === 'left' || node.id === 'right').map((node) => node.data.prompt)).toEqual(Object.values(updatedPrompts));
    await service.resolveApproval({ approvalId: service.getSnapshot().approvals[0].id, approve: true, model });
    expect(service.getSnapshot().status).toBe('completed');
    expect(canvasAiGateway.submitGenerateImageJob).toHaveBeenCalledTimes(2);
    expect(vi.mocked(canvasAiGateway.submitGenerateImageJob).mock.calls.map(([payload]) => payload.prompt)).toEqual(Object.values(updatedPrompts));
    const resultNodes = useCanvasStore.getState().nodes.filter((node) => node.type === CANVAS_NODE_TYPES.exportImage);
    expect(resultNodes).toHaveLength(2);
    expect(resultNodes.every((node) => String(node.data.imageUrl).startsWith('asset-media:'))).toBe(true);
    // Ordinary undo remains granular across the asynchronous generation boundary.
    expect(useCanvasStore.getState().history.past.length).toBeGreaterThan(previousHistory + 1);
    const withdrawn = rollbackAgentTurn({ projectId, runId: first.runId });
    expect(withdrawn).toMatchObject({ ok: true, undone: expect.any(Number) });
    expect(graph()).toEqual(before);
    expect(useCanvasStore.getState().history.past).toHaveLength(previousHistory);
    expect(canvasAiGateway.submitGenerateImageJob).toHaveBeenCalledTimes(2);
    expect(publishGenerationJobResults(resultNodes[0].id, { job_id: `local-job:${resultNodes[0].id}`, status: 'succeeded',
      results: [{ kind: 'image', source: imageSource }] })).toEqual([]);
    expect(graph()).toEqual(before);
    await vi.waitFor(() => expect(useGenerationHistoryStore.getState().records.filter((entry) => entry.projectId === projectId)).toHaveLength(2));
    expect(useGenerationHistoryStore.getState().records.filter((entry) => entry.projectId === projectId)
      .every((entry) => entry.jobIds?.length === 1 && entry.surface === 'agent')).toBe(true);
    expect(rollbackAgentTurn({ projectId, runId: first.runId })).toEqual({ ok: false, reason: 'no-changes' });
  }, 15_000);

  it('Stage queries real catalogs, previews, directs at the returned revision, and checks both capture boundaries', async () => {
    const projectId = await project('Street meeting');
    const stage = stageCommands.create({ name: 'Street stage' });
    const before = graph();
    const historyDepth = useCanvasStore.getState().history.past.length;
    let previewRevision = -1;
    let captureTime = -1;
    const story: StoryPlan = {
      version: 1, duration: 8,
      cast: [
        { kind: 'new', itemId: 'alice', presetId: 'woman', label: 'Alice', heightM: 1.7, position: { x: -3, y: 0, z: 0 } },
        { kind: 'new', itemId: 'bob', presetId: 'man', label: 'Bob', heightM: 1.8, position: { x: 3, y: 0, z: 0 } },
      ],
      setObjects: [{ itemId: 'street', presetId: 'scene-street-corner', label: 'Street', position: { x: 0, y: 0, z: -4 } }],
      beats: [{ start: 0, duration: 4, blocking: [
        { itemId: 'alice', to: { x: -0.7, y: 0, z: 0 }, actionId: 'walk', facing: { actorId: 'bob' }, lookAt: { actorId: 'bob' } },
        { itemId: 'bob', to: { x: 0.7, y: 0, z: 0 }, actionId: 'walk', facing: { actorId: 'alice' }, lookAt: { actorId: 'alice' } },
      ] }],
      shots: [{ start: 0, duration: 8, size: 'wide', angle: 'eye', movement: 'track', subjectItemIds: ['alice'], transition: 'cut', fov: 45 }],
    };
    scriptedModel.response
      .mockResolvedValueOnce(response(call('query', 'stage_query', { nodeId: null })))
      .mockImplementationOnce(async (request) => {
        const queried = toolOutput(request, 'query', z.object({ result: z.object({ nodeId: z.string(), revision: z.number(), catalogs: z.object({ scene: z.array(z.object({ presetId: z.string() })), actions: z.array(z.object({ id: z.string() })) }) }) }));
        expect(queried.result.nodeId).toBe(stage.nodeId);
        expect(queried.result.catalogs.scene.map((entry) => entry.presetId)).toEqual(expect.arrayContaining(['woman', 'man', 'scene-street-corner']));
        expect(queried.result.catalogs.actions.map((entry) => entry.id)).toContain('walk');
        return response(call('preview', 'stage_direct', { nodeId: queried.result.nodeId, plan: story, dryRun: true }));
      })
      .mockImplementationOnce(async (request) => {
        const preview = toolOutput(request, 'preview', z.object({ result: z.object({ revision: z.number(), dryRun: z.literal(true), captureTimes: z.array(z.number()).min(1), commands: z.array(z.unknown()).min(1) }) }));
        previewRevision = preview.result.revision; captureTime = preview.result.captureTimes[0];
        expect(graph()).toEqual(before);
        expect(useCanvasStore.getState().history.past).toHaveLength(historyDepth);
        return response(call('execute', 'stage_direct', { nodeId: stage.nodeId, plan: story, dryRun: false, expectedRevision: previewRevision }));
      })
      .mockImplementationOnce(async (request) => {
        const executed = toolOutput(request, 'execute', z.object({ result: z.object({ dryRun: z.literal(false), revision: z.number(), objects: z.array(z.unknown()) }) }));
        expect(executed.result.revision).toBe(previewRevision + 1);
        expect(executed.result.objects).toHaveLength(3);
        return response(call('capture-unmounted', 'stage_capture', { nodeId: stage.nodeId, timeSeconds: captureTime }));
      })
      .mockImplementationOnce(async (request) => {
        const failed = toolOutput(request, 'capture-unmounted', z.object({ ok: z.literal(false), error: z.string() }));
        expect(failed.error).toMatch(/viewport|视口/i);
        captureCleanup = registerStageViewport(stage.nodeId, {
          capture: async () => { throw new Error('Exact-time capture must not fall back to the current frame'); },
          captureAt: async (timeSeconds) => {
            expect(timeSeconds).toBe(captureTime);
            const asset = await saveAsset({ id: `fixture-capture:${stage.nodeId}`, kind: 'image', source: imageSource,
              name: 'Deterministic fake viewport capture', origin: 'canvas', metadata: { timeSeconds } });
            return { assetId: asset.id };
          },
        });
        return response(call('capture-mounted', 'stage_capture', { nodeId: stage.nodeId, timeSeconds: captureTime }));
      })
      .mockImplementationOnce(async (request) => {
        const captured = toolOutput(request, 'capture-mounted', z.object({ result: z.object({ assetId: z.string(), timeSeconds: z.number() }) }));
        expect(captured.result.timeSeconds).toBe(captureTime);
        expect((await resolveAsset(captured.result.assetId))?.source).toBe(imageSource);
        return done;
      });
    const service = session('stage', projectId);
    await service.send({ message: '两个人在路口相遇，机位跟拍左边的人', model, executionMode: 'auto' });
    expect(service.getSnapshot().status).toBe('awaiting-approval');
    expect(service.getSnapshot().approvals.map((approval) => approval.toolName)).toEqual(['stage_direct']);
    expect(graph()).toEqual(before);
    await service.resolveApproval({ approvalId: service.getSnapshot().approvals[0].id, approve: true, model });
    expect(service.getSnapshot().status).toBe('completed');
    expect(service.getSnapshot().toolEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ callId: 'capture-unmounted', status: 'failed', error: expect.stringMatching(/viewport|视口/i) }),
      expect.objectContaining({ callId: 'capture-mounted', status: 'succeeded' }),
    ]));
    const data = stageCommands.query(stage.nodeId).data;
    expect(data.items.filter((item) => item.category === 'person')).toHaveLength(2);
    expect(data.motionProject?.objectTracks.alice.length).toBeGreaterThan(1);
    expect(data.motionProject?.objectTracks.bob.length).toBeGreaterThan(1);
    expect(data.motionProject?.cameraTrack.length).toBeGreaterThan(1);
    if (!data.motionProject) throw new Error('The real director did not create a motion timeline');
    const start = sampleDirectorMotion(data.motionProject, 0, data.items);
    const middle = sampleDirectorMotion(data.motionProject, 2, data.items);
    expect(middle).not.toEqual(start);
    expect(useCanvasStore.getState().history.past).toHaveLength(historyDepth + 1);
    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(graph()).toEqual(before);
    expect(canvasAiGateway.submitGenerateImageJob).not.toHaveBeenCalled();
  }, 15_000);

  it('stops before a 97th real tool can execute, retaining the 96 successful reads and explanation', async () => {
    const projectId = await project('Tool budget');
    let count = 0;
    scriptedModel.response.mockImplementation(async () => response(command(`read-${++count}`, 'canvas.query', { scope: 'graph', limit: 1 })));
    const service = session('canvas', projectId);
    await expect(service.send({ message: '读取画布，检查分镜节点与提示词', model, executionMode: 'auto' })).rejects.toMatchObject({ name: 'AgentTurnLimitError' });
    expect(service.getSnapshot().status).toBe('error');
    expect(service.getSnapshot().error).toMatch(/96/);
    expect(service.getSnapshot().approvals).toHaveLength(0);
    expect(service.getSnapshot().toolEvents.filter((event) => event.status === 'succeeded')).toHaveLength(96);
    expect(scriptedModel.response).toHaveBeenCalledTimes(97);
    expect(useCanvasStore.getState().history.past).toHaveLength(0);
    expect(canvasAiGateway.submitGenerateImageJob).not.toHaveBeenCalled();
  }, 45_000);

  it('expires a real manual approval after thirty minutes without modifying the canvas or calling a provider', async () => {
    const projectId = await project('Turn deadline');
    const node: CanvasNode = { id: 'deadline-node', type: CANVAS_NODE_TYPES.imageEdit, position: { x: 0, y: 0 }, data: { prompt: 'Original prompt' } };
    useCanvasStore.setState({ nodes: [node] });
    const before = graph();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    scriptedModel.response.mockResolvedValueOnce(response(command('edit', 'node.setPrompt', { nodeId: node.id, prompt: 'Expired edit' })));
    const service = session('canvas', projectId);
    const result = await service.send({ message: '修改选中分镜提示词', model, executionMode: 'manual' });
    if (!result) throw new Error('Missing deadline turn');
    expect(service.getSnapshot().status).toBe('awaiting-approval');
    await vi.advanceTimersByTimeAsync(30 * 60_000 - 1);
    expect(service.getSnapshot().status).toBe('awaiting-approval');
    await vi.advanceTimersByTimeAsync(1);
    expect(service.getSnapshot().status).toBe('error');
    expect(service.getSnapshot().error).toMatch(/30.*分钟/);
    expect(service.getSnapshot().approvals).toHaveLength(0);
    expect(canvasAgentApprovalStore.listByRun(result.runId).every((approval) => approval.status !== 'awaiting-approval')).toBe(true);
    expect(graph()).toEqual(before);
    expect(canvasAiGateway.submitGenerateImageJob).not.toHaveBeenCalled();
  });

  it.each(['after', 'between'] as const)('refuses turn withdrawal when a manual edit occurs %s Agent mutations', async (placement) => {
    const projectId = await project('Protected manual edits');
    const runId = `manual-safety-${placement}`;
    const turnId = JSON.stringify([projectId, runId]);
    const nodeId = useCanvasStore.getState().addNode(CANVAS_NODE_TYPES.imageEdit, { x: 0, y: 0 }, { prompt: 'Original' });
    withCanvasHistoryGroup(turnId, () => useCanvasStore.getState().updateNodeData(nodeId, { prompt: 'Agent first' }));
    useCanvasStore.getState().updateNodeData(nodeId, { displayName: 'Manual edit must survive' });
    if (placement === 'between') withCanvasHistoryAgentTurn(turnId, () => useCanvasStore.getState().updateNodeData(nodeId, { prompt: 'Agent second' }));
    const before = graph();
    const history = useCanvasStore.getState().history;
    expect(rollbackAgentTurn({ projectId: 'another-project', runId })).toEqual({ ok: false, reason: 'project-changed' });
    expect(rollbackAgentTurn({ projectId, runId })).toEqual({ ok: false, reason: 'not-latest' });
    expect(graph()).toEqual(before);
    expect(useCanvasStore.getState().history).toBe(history);
  });

  it('preserves turn ownership through real project save/reopen and withdraws all retained turn entries', async () => {
    const projectId = await project('Persistent whole-turn undo');
    const runId = 'persisted-turn';
    const turnId = JSON.stringify([projectId, runId]);
    const nodeId = useCanvasStore.getState().addNode(CANVAS_NODE_TYPES.imageEdit, { x: 0, y: 0 }, { prompt: 'Original prompt' });
    withCanvasHistoryGroup(turnId, () => useCanvasStore.getState().updateNodeData(nodeId, { prompt: 'Agent prompt' }));
    const resultId = withCanvasHistoryAgentTurn(turnId, () => useCanvasStore.getState().addNode(CANVAS_NODE_TYPES.exportImage, { x: 500, y: 0 }, { generationJobId: 'persisted-job' }));
    withCanvasHistoryAgentTurn(turnId, () => useCanvasStore.getState().addEdge(nodeId, resultId, { provenance: 'generationResult' }));
    useProjectStore.getState().closeProject();
    await useProjectStore.getState().waitForProjectPersistence(projectId);
    useCanvasStore.getState().setCanvasData([], []);
    await openAgentProject(projectId);
    expect(useCanvasStore.getState().nodes).toHaveLength(2);
    expect(rollbackAgentTurn({ projectId, runId })).toEqual({ ok: true, undone: 3 });
    expect(useCanvasStore.getState().nodes.map((node) => ({ id: node.id, prompt: node.data.prompt }))).toEqual([{ id: nodeId, prompt: 'Original prompt' }]);
    expect(useCanvasStore.getState().edges).toHaveLength(0);
    await useProjectStore.getState().waitForProjectPersistence(projectId);
    expect(JSON.parse((await getProjectRecord(projectId))!.nodesJson)).toHaveLength(1);
  });
});
