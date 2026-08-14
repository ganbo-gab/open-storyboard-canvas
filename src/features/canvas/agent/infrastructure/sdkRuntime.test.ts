import { describe, expect, it } from 'vitest';
import type { ModelRequest } from '@openai/agents';
import { useCanvasStore } from '@/stores/canvasStore';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';

import {
  loadCanvasAgentSdkRuntime,
  resetCanvasAgentSdkRuntimeForTests,
} from '../application/agentRuntimeLoader';
import type {
  AgentModelReference,
  AgentModelTransport,
  AgentModelTurnRequest,
  AgentModelTurnResponse,
} from '../domain/agentModel';
import { AgentModelGatewayError } from './agentModelGateway';
import { buildAgentProviderBody } from '../application/agentProviderRequestCodec';
import {
  StoryboardAgentModel,
  StoryboardModelProvider,
  conservativeModelRetryPolicy,
  createCanvasAgent,
  normalizeStoryboardAgentToolCalls,
  createStoryboardAgentRuntime,
  restoreStoryboardRunState,
  serializeStoryboardRunState,
  type CanvasAgentContext,
} from './sdkRuntime';
import {
  canvasAgentApprovalExecution,
  canvasAgentApprovalStore,
  createAgentRequestFingerprint,
  createApprovalId,
  createApprovalRecord,
  createIdempotencyKey,
} from '../application/agentApproval';
import { revokeAgentMediaRun } from '../application/agentMediaResolver';

const reference: AgentModelReference = {
  catalogId: 'custom:provider:model',
  providerId: 'provider',
  modelId: 'model',
  label: 'Provider / Model',
  usable: true,
  capabilities: {
    protocol: 'openai-chat-completions',
    tools: true,
    stream: true,
    vision: true,
    reasoningSummary: true,
    toolSearch: false,
  },
};

describe('Storyboard Agent top-level tool normalization', () => {
  it('wraps CanvasCommand names in canvas_command and drops truly unknown top-level tools', () => {
    const calls = normalizeStoryboardAgentToolCalls([
      { callId: 'status', name: 'generation.status', arguments: '{"nodeId":"node-1"}' },
      { callId: 'asset', name: 'asset.list', arguments: '{}' },
      { callId: 'unknown', name: 'generation.magic', arguments: '{}' },
    ]);
    expect(calls).toEqual([
      { callId: 'status', name: 'canvas_command', arguments: JSON.stringify({ type: 'generation.status', input: { nodeId: 'node-1' } }) },
      { callId: 'asset', name: 'canvas_command', arguments: JSON.stringify({ type: 'asset.list', input: {} }) },
    ]);
  });

  it('canonicalizes unambiguous image-node aliases without inventing ids or models', () => {
    const [call] = normalizeStoryboardAgentToolCalls([{
      callId: 'create-image',
      name: 'canvas_command',
      arguments: JSON.stringify({
        type: 'node.create',
        input: {
          nodeType: 'imageEditNode',
          position: { x: 0, y: 0 },
          configuration: {
            prompt: '美丽的少女',
            modelId: 'agnes:image:image-2.1-flash',
            ratio: '16:9',
            size: '2k',
          },
        },
      }),
    }]);
    expect(JSON.parse(call.arguments)).toEqual({
      type: 'node.create',
      input: {
        nodeType: 'imageNode',
        position: { x: 0, y: 0 },
        configuration: {
          prompt: '美丽的少女',
          modelId: 'agnes:image:image-2.1-flash',
          aspectRatio: '16:9',
          resolution: '2K',
        },
      },
    });
    expect(JSON.parse(call.arguments).input).not.toHaveProperty('nodeId');
  });

  it('adds only the safe default position when node.create omits its layout hint', () => {
    const [call] = normalizeStoryboardAgentToolCalls([{
      callId: 'create-without-position',
      name: 'canvas_command',
      arguments: JSON.stringify({
        type: 'node.create',
        input: {
          nodeType: 'imageNode',
          configuration: {
            prompt: '神里绫华站在樱花庭院中',
            modelId: 'agnes:image:image-2.1-flash',
            aspectRatio: '16:9',
            resolution: '2K',
          },
        },
      }),
    }]);

    expect(JSON.parse(call.arguments)).toEqual({
      type: 'node.create',
      input: {
        nodeType: 'imageNode',
        position: { x: 0, y: 0 },
        configuration: {
          prompt: '神里绫华站在樱花庭院中',
          modelId: 'agnes:image:image-2.1-flash',
          aspectRatio: '16:9',
          resolution: '2K',
        },
      },
    });
    expect(JSON.parse(call.arguments).input).not.toHaveProperty('nodeId');
  });

  it('preserves an explicitly invalid position so registry validation still fails closed', () => {
    const [call] = normalizeStoryboardAgentToolCalls([{
      callId: 'create-invalid-position',
      name: 'canvas_command',
      arguments: JSON.stringify({
        type: 'node.create',
        input: { nodeType: 'imageNode', position: { x: 'left', y: 0 }, configuration: {} },
      }),
    }]);

    expect(JSON.parse(call.arguments).input.position).toEqual({ x: 'left', y: 0 });
  });
});

function modelRequest(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    systemInstructions: 'Operate the canvas.',
    input: [{
      role: 'user',
      content: [
        { type: 'input_text', text: 'Inspect this shot.' },
        { type: 'input_image', image: 'https://assets.test/shot.png', detail: 'high' },
      ],
    }],
    modelSettings: { toolChoice: 'auto', maxTokens: 512 },
    tools: [{
      type: 'function',
      name: 'query_canvas',
      namespace: 'canvas',
      description: 'Read the canvas projection.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      strict: true,
    }],
    toolsExplicitlyProvided: true,
    outputType: 'text',
    handoffs: [],
    tracing: false,
    ...overrides,
  };
}

function response(): AgentModelTurnResponse {
  return {
    responseId: 'response-1',
    text: 'The canvas has one shot.',
    reasoningSummary: 'Inspected the projected node list.',
    toolCalls: [{
      callId: 'call-1',
      name: 'query_canvas',
      namespace: 'canvas',
      arguments: '{}',
    }],
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      reasoningTokens: 2,
      cachedInputTokens: 3,
    },
    providerSummary: { protocol: 'openai-chat-completions' },
  };
}

describe('OpenAI Agents SDK runtime adapter', () => {
  it('maps SDK requests and responses through application-owned DTOs', async () => {
    let captured: AgentModelTurnRequest | null = null;
    const transport: AgentModelTransport = {
      async getResponse(requestValue) {
        captured = requestValue;
        return response();
      },
      async *getStreamedResponse() {
        yield { type: 'completed', response: response() };
      },
    };
    const model = new StoryboardAgentModel(reference, transport);
    const result = await model.getResponse(modelRequest());

    expect(captured).toMatchObject({
      model: { catalogId: 'custom:provider:model' },
      systemInstructions: 'Operate the canvas.',
      input: [{
        type: 'message',
        role: 'user',
        content: [
          { type: 'text', text: 'Inspect this shot.' },
          { type: 'image', imageUrl: 'https://assets.test/shot.png', detail: 'high' },
        ],
      }],
      tools: [{ name: 'query_canvas', namespace: 'canvas' }],
    });
    expect(result).toMatchObject({
      responseId: 'response-1',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      output: [
        {
          type: 'reasoning',
          content: [{ type: 'input_text', text: 'Inspected the projected node list.' }],
        },
        { type: 'message', content: [{ type: 'output_text', text: 'The canvas has one shot.' }] },
        { type: 'function_call', callId: 'call-1', name: 'query_canvas', namespace: 'canvas' },
      ],
      providerData: { protocol: 'openai-chat-completions' },
    });
    expect(result.output[0]).not.toHaveProperty('rawContent');
  });

  it('never sends image parts to text-only models and marks missing stable references', async () => {
    const captured: AgentModelTurnRequest[] = [];
    const transport: AgentModelTransport = {
      async getResponse(requestValue) {
        captured.push(requestValue);
        return response();
      },
      async *getStreamedResponse() { throw new Error('unused'); },
    };
    const textModel = new StoryboardAgentModel({
      ...reference,
      capabilities: { ...reference.capabilities, vision: false },
    }, transport);
    await textModel.getResponse(modelRequest());
    expect(captured[0].input[0]).toMatchObject({
      type: 'message',
      content: expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: expect.stringContaining('文本模型') }),
      ]),
    });
    expect(JSON.stringify(captured[0].input)).not.toContain('"type":"image"');

    const visionModel = new StoryboardAgentModel(reference, transport);
    await visionModel.getResponse(modelRequest({
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: 'Inspect the old reference.' },
          { type: 'input_image', image: { id: 'old-run:missing-asset' }, detail: 'auto' },
        ],
      }],
    }));
    expect(captured[1].input[0]).toMatchObject({
      type: 'message',
      content: expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: expect.stringContaining('图片引用已缺失') }),
      ]),
    });
    expect(JSON.stringify(captured[1].input)).not.toContain('"type":"image"');
  });

  it('emits standard SDK stream events and preserves a final tool response', async () => {
    const transport: AgentModelTransport = {
      async getResponse() {
        return response();
      },
      async *getStreamedResponse() {
        yield { type: 'text_delta', delta: 'The canvas ' };
        yield { type: 'reasoning_summary_delta', delta: 'Inspected nodes.' };
        yield { type: 'completed', response: response() };
      },
    };
    const events = [];
    for await (const event of new StoryboardAgentModel(reference, transport)
      .getStreamedResponse(modelRequest())) {
      events.push(event);
    }
    expect(events).toMatchObject([
      { type: 'response_started' },
      { type: 'output_text_delta', delta: 'The canvas ' },
      { type: 'model', event: { type: 'reasoning_summary_delta', delta: 'Inspected nodes.' } },
      {
        type: 'response_done',
        response: {
          id: 'response-1',
          output: [
            { type: 'reasoning' },
            { type: 'message' },
            { type: 'function_call', callId: 'call-1' },
          ],
        },
      },
    ]);
  });

  it('only retries an explicitly replay-safe model failure before stream output', async () => {
    const model = new StoryboardAgentModel(reference, {
      async getResponse() { return response(); },
      async *getStreamedResponse() { yield { type: 'completed', response: response() }; },
    });
    expect(model.getRetryAdvice({
      request: modelRequest(),
      error: new AgentModelGatewayError('busy', 503, true, false),
      stream: true,
      attempt: 1,
    })).toMatchObject({ suggested: true, replaySafety: 'safe' });
    expect(model.getRetryAdvice({
      request: modelRequest(),
      error: new AgentModelGatewayError('HTTP 429 Too Many Requests', 429, true, false),
      stream: true,
      attempt: 1,
    })).toMatchObject({ suggested: true, replaySafety: 'safe' });
    expect(model.getRetryAdvice({
      request: modelRequest(),
      error: new AgentModelGatewayError('interrupted', 503, true, true),
      stream: true,
      attempt: 1,
    })).toMatchObject({ suggested: false, replaySafety: 'unsafe' });
    expect(model.getRetryAdvice({
      request: modelRequest(),
      error: new AgentModelGatewayError('The quota has been exceeded.', 429, true, false),
      stream: true,
      attempt: 1,
    })).toMatchObject({
      suggested: false,
      replaySafety: 'unsafe',
      reason: expect.stringContaining('exhausted quota'),
    });
    expect(conservativeModelRetryPolicy({
      attempt: 1,
      maxRetries: 1,
      normalized: { isAbort: false },
      providerAdvice: { suggested: true, replaySafety: 'safe' },
    })).toBe(true);
    expect(conservativeModelRetryPolicy({
      attempt: 1,
      maxRetries: 1,
      normalized: { isAbort: false },
      providerAdvice: { suggested: true, replaySafety: 'unsafe' },
    })).toBe(false);
  });

  it('fails closed for incompatible models and creates a privacy-disabled runner', () => {
    const transport: AgentModelTransport = {
      async getResponse() { return response(); },
      async *getStreamedResponse() { yield { type: 'completed', response: response() }; },
    };
    const blocked = { ...reference, usable: false, notReadyReason: 'missing tool support' };
    expect(() => new StoryboardModelProvider({
      resolveModel: () => blocked,
      transport,
    }).getModel()).toThrow('missing tool support');

    const runtime = createStoryboardAgentRuntime({ resolveModel: () => reference, transport });
    expect(runtime.runner.config).toMatchObject({
      tracingDisabled: true,
      traceIncludeSensitiveData: false,
      modelSettings: { retry: { maxRetries: 1 } },
    });
  });

  it('keeps a greeting turn provider payload observable and bounded', async () => {
    let captured: AgentModelTurnRequest | null = null;
    const transport: AgentModelTransport = {
      async getResponse(request) {
        captured = request;
        return {
          responseId: 'greeting-response',
          text: '你好！',
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      },
      async *getStreamedResponse() { throw new Error('unused'); },
    };
    const runtime = createStoryboardAgentRuntime({ resolveModel: () => reference, transport });
    const context: CanvasAgentContext = { projectId: 'project-1', runId: 'greeting-payload-run' };
    const agent = createCanvasAgent({
      runtime,
      context,
      protocol: reference.capabilities.protocol,
      supportsVision: reference.capabilities.vision,
      skillContext: { text: '你好' },
    });

    await runtime.runner.run(agent, '你好', { context });

    expect(captured).not.toBeNull();
    const body = buildAgentProviderBody(captured!, false);
    const serialized = JSON.stringify(body);
    expect(captured!.tools).toEqual([]);
    expect(serialized.length).toBeLessThan(8_000);
  });

  it('keeps structured canvas tools loaded across a short multi-turn continuation', async () => {
    let captured: AgentModelTurnRequest | null = null;
    const transport: AgentModelTransport = {
      async getResponse(requestValue) {
        captured = requestValue;
        return {
          responseId: 'continued-image-task',
          text: '需要调用画布工具。',
          toolCalls: [],
          usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
        };
      },
      async *getStreamedResponse() { throw new Error('unused'); },
    };
    const runtime = createStoryboardAgentRuntime({ resolveModel: () => reference, transport });
    const context: CanvasAgentContext = { projectId: 'project-1', runId: 'continued-image-run' };
    const agent = createCanvasAgent({
      runtime,
      context,
      executionMode: 'auto',
      skillContext: {
        text: '继续',
        recentUserText: '帮我生成图片吧\n16比9，2k，神里绫华\n默认',
      },
    });

    await runtime.runner.run(agent, '继续', { context });

    const request = captured as AgentModelTurnRequest | null;
    expect(request?.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['canvas_command']));
    expect(request?.systemInstructions).toContain('当前是自动模式');
    expect(request?.systemInstructions).toContain('不要先要求用户回复“继续”');
  });

  it('loads the SDK runtime once through the dynamic boundary', async () => {
    resetCanvasAgentSdkRuntimeForTests();
    const first = loadCanvasAgentSdkRuntime();
    const second = loadCanvasAgentSdkRuntime();
    expect(first).toBe(second);
    await expect(first).resolves.toHaveProperty('StoryboardModelProvider');
  });

  it('restores a real SDK approval interruption and executes its canvas command once', async () => {
    const runId = 'sdk-approval-run';
    const callId = 'sdk-canvas-call';
    canvasAgentApprovalStore.deleteRun(runId);
    let modelCalls = 0;
    let commandCalls = 0;
    let persistedCheckpoints = 0;
    const transport: AgentModelTransport = {
      async getResponse(request) {
        modelCalls += 1;
        const hasToolResult = request.input.some((item) => item.type === 'function_call_result');
        return hasToolResult ? {
          responseId: 'response-final',
          text: 'Renamed the node.',
          toolCalls: [],
          usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
        } : {
          responseId: 'response-tool',
          toolCalls: [{
            callId,
            name: 'canvas_command',
            arguments: JSON.stringify({ type: 'node.rename', input: { nodeId: 'node-1', displayName: 'Opening shot' } }),
          }],
          usage: { inputTokens: 10, outputTokens: 6, totalTokens: 16 },
        };
      },
      async *getStreamedResponse() {
        throw new Error('streaming is not used by this test');
      },
    };
    const runtime = createStoryboardAgentRuntime({ resolveModel: () => reference, transport });
    const context: CanvasAgentContext = {
      projectId: 'project-1',
      runId,
      getCanvasRevision: () => 3,
      persistCanvasCheckpoint: async () => { persistedCheckpoints += 1; },
      executeCanvasCommand: async (_command, _expectedRevision) => {
        commandCalls += 1;
        return {
          ok: true as const,
          commandType: 'node.rename' as const,
          revisionBefore: 3,
          revisionAfter: 4,
          impact: { effect: 'graph' as const, summary: 'rename', affectedNodeIds: ['node-1'], affectedEdgeIds: [], creates: { nodes: 0, edges: 0, groups: 0 }, deletes: { nodes: 0, edges: 0, groups: 0 }, requiresExternalSideEffect: false },
          output: { references: { nodeId: 'node-1' } },
        };
      },
    };
    const agent = createCanvasAgent({ runtime, context, skillContext: { text: 'Rename node one' } });
    const interrupted = await runtime.runner.run(agent, 'Rename node one', { context });
    expect(commandCalls).toBe(0);
    expect(interrupted.interruptions).toHaveLength(1);

    const approvalId = createApprovalId(runId, 'canvas_command', callId);
    const requestFingerprint = await createAgentRequestFingerprint('canvas_command', {
      type: 'node.rename',
      input: { nodeId: 'node-1', displayName: 'Opening shot' },
    });
    canvasAgentApprovalStore.put({
      ...createApprovalRecord({
        id: approvalId,
        runId,
        projectId: context.projectId,
        interruptionId: callId,
        requestFingerprint,
        impact: { effect: 'canvas-write', title: 'Rename', summary: 'Rename one node', affectedNodeCount: 1, affectedEdgeCount: 0, externalSideEffect: false },
        baseRevision: 3,
      }),
    });
    const serialized = serializeStoryboardRunState(interrupted.state);
    const restored = await restoreStoryboardRunState(agent, serialized, context);
    const approval = restored.getInterruptions()[0];
    canvasAgentApprovalExecution.decide(approvalId, true);
    restored.approve(approval);
    const completed = await runtime.runner.run(agent, restored, { context });
    expect(completed.finalOutput).toBe('Renamed the node.');
    expect(commandCalls).toBe(1);
    expect(persistedCheckpoints).toBe(1);
    expect(modelCalls).toBe(2);
    expect(canvasAgentApprovalStore.getReceipt(createIdempotencyKey(runId, 'canvas_command', callId))).toMatchObject({ status: 'succeeded' });
    canvasAgentApprovalStore.deleteRun(runId);
  });

  it('enforces bounded generation follow-through and returns both locate targets', async () => {
    const runId = 'sdk-generation-poll-run';
    const submitCallId = 'sdk-generation-submit';
    canvasAgentApprovalStore.deleteRun(runId);
    let modelCalls = 0;
    const commandTypes: string[] = [];
    const toolOutputs: unknown[] = [];
    const transport: AgentModelTransport = {
      async getResponse() {
        modelCalls += 1;
        if (modelCalls === 1) {
          return {
            responseId: 'response-submit',
            toolCalls: [{
              callId: submitCallId,
              name: 'canvas_command',
              arguments: JSON.stringify({ type: 'generation.submit', input: { nodeIds: ['node-1'] } }),
            }],
            usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
          };
        }
        return {
          responseId: 'response-final',
          text: 'Generation completed.',
          toolCalls: [],
          usage: { inputTokens: 14, outputTokens: 4, totalTokens: 18 },
        };
      },
      async *getStreamedResponse() {
        throw new Error('streaming is not used by this test');
      },
    };
    const runtime = createStoryboardAgentRuntime({ resolveModel: () => reference, transport });
    const context: CanvasAgentContext = {
      projectId: 'project-1',
      runId,
      getCanvasRevision: () => 3,
      generationFollowThrough: { maxAttempts: 3, initialDelayMs: 0, wait: async () => {} },
      onToolEvent: (event) => { if (event.output) toolOutputs.push(event.output); },
      executeCanvasCommand: async (command) => {
        commandTypes.push(command.type);
        if (command.type === 'generation.submit') {
          return {
            ok: true as const,
            commandType: 'generation.submit' as const,
            revisionBefore: 3,
            revisionAfter: 3,
            impact: { effect: 'generation' as const, summary: 'submit', affectedNodeIds: ['node-1'], affectedEdgeIds: [], creates: { nodes: 0, edges: 0, groups: 0 }, deletes: { nodes: 0, edges: 0, groups: 0 }, requiresExternalSideEffect: true },
            output: { references: { nodeIds: ['node-1'] }, value: { status: 'accepted' } },
          };
        }
        const statusCalls = commandTypes.filter((type) => type === 'generation.status').length;
        return {
          ok: true as const,
          commandType: 'generation.status' as const,
          revisionBefore: 3,
          revisionAfter: 3,
          impact: { effect: 'read' as const, summary: 'status', affectedNodeIds: ['node-1'], affectedEdgeIds: [], creates: { nodes: 0, edges: 0, groups: 0 }, deletes: { nodes: 0, edges: 0, groups: 0 }, requiresExternalSideEffect: false },
          output: statusCalls <= 1
            ? { references: { nodeId: 'node-1' }, value: { status: 'running' } }
            : { references: { nodeId: 'node-1', nodeIds: ['node-1', 'result-1'] }, value: { status: 'succeeded', resultNodeId: 'result-1', resultNodeIds: ['result-1'] } },
        };
      },
    };
    const agent = createCanvasAgent({ runtime, context, skillContext: { text: 'Generate and monitor node one' } });
    const interrupted = await runtime.runner.run(agent, 'Generate and monitor node one', { context });
    expect(interrupted.interruptions).toHaveLength(1);

    const approvalId = createApprovalId(runId, 'canvas_command', submitCallId);
    const requestFingerprint = await createAgentRequestFingerprint('canvas_command', {
      type: 'generation.submit',
      input: { nodeIds: ['node-1'] },
    });
    canvasAgentApprovalStore.put(createApprovalRecord({
      id: approvalId,
      runId,
      projectId: context.projectId,
      interruptionId: submitCallId,
      requestFingerprint,
      impact: { effect: 'external-submit', title: 'Generate', summary: 'Submit one generation', affectedNodeCount: 1, affectedEdgeCount: 0, externalSideEffect: true },
      baseRevision: 3,
    }));
    canvasAgentApprovalExecution.decide(approvalId, true);
    const approval = interrupted.state.getInterruptions()[0];
    interrupted.state.approve(approval);
    const completed = await runtime.runner.run(agent, interrupted.state, { context });

    expect(completed.interruptions).toHaveLength(0);
    expect(completed.finalOutput).toBe('Generation completed.');
    expect(commandTypes).toEqual(['generation.submit', 'generation.status', 'generation.status']);
    expect(modelCalls).toBe(2);
    expect(toolOutputs.some((output) => JSON.stringify(output).includes('"resultNodeIds":["result-1"]'))).toBe(true);
    expect(canvasAgentApprovalStore.listByRun(runId)).toHaveLength(1);
    expect(canvasAgentApprovalStore.getReceipt(
      createIdempotencyKey(runId, 'canvas_command', submitCallId),
    )).toMatchObject({ status: 'succeeded' });
    canvasAgentApprovalStore.deleteRun(runId);
  });

  it('recovers an ambiguous generation submit with status polling and no second submit', async () => {
    const runId = 'sdk-generation-unknown-recovery-run';
    const submitCallId = 'sdk-generation-unknown-submit';
    canvasAgentApprovalStore.deleteRun(runId);
    let modelCalls = 0;
    let submitCalls = 0;
    const commandTypes: string[] = [];
    const toolStatuses: string[] = [];
    const transport: AgentModelTransport = {
      async getResponse() {
        modelCalls += 1;
        if (modelCalls === 1) {
          return {
            responseId: 'response-submit',
            toolCalls: [{
              callId: submitCallId,
              name: 'canvas_command',
              arguments: JSON.stringify({ type: 'generation.submit', input: { nodeIds: ['node-1'] } }),
            }],
            usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
          };
        }
        if (modelCalls === 2) {
          return {
            responseId: 'response-status',
            toolCalls: [{
              callId: 'sdk-generation-unknown-status',
              name: 'canvas_command',
              arguments: JSON.stringify({ type: 'generation.status', input: { nodeId: 'node-1' } }),
            }],
            usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
          };
        }
        return {
          responseId: 'response-final',
          text: 'The first submit may have been accepted and status polling is running.',
          toolCalls: [],
          usage: { inputTokens: 14, outputTokens: 4, totalTokens: 18 },
        };
      },
      async *getStreamedResponse() {
        throw new Error('streaming is not used by this test');
      },
    };
    const runtime = createStoryboardAgentRuntime({ resolveModel: () => reference, transport });
    const context: CanvasAgentContext = {
      projectId: 'project-1',
      runId,
      getCanvasRevision: () => 3,
      onToolEvent: (event) => { toolStatuses.push(event.status); },
      executeCanvasCommand: async (command) => {
        commandTypes.push(command.type);
        if (command.type === 'generation.submit') {
          submitCalls += 1;
          return {
            ok: false as const,
            commandType: 'generation.submit' as const,
            revisionBefore: 3,
            revisionAfter: 3,
            error: { code: 'execution_failed' as const, message: 'network closed after request send' },
          };
        }
        return {
          ok: true as const,
          commandType: 'generation.status' as const,
          revisionBefore: 3,
          revisionAfter: 3,
          impact: { effect: 'read' as const, summary: 'status', affectedNodeIds: ['node-1'], affectedEdgeIds: [], creates: { nodes: 0, edges: 0, groups: 0 }, deletes: { nodes: 0, edges: 0, groups: 0 }, requiresExternalSideEffect: false },
          output: { references: { nodeId: 'node-1', jobId: 'job-1', jobIds: ['job-1'] }, value: { status: 'running' } },
        };
      },
    };
    const agent = createCanvasAgent({ runtime, context, skillContext: { text: 'Generate image once and recover safely if the outcome is unknown' } });
    const interrupted = await runtime.runner.run(agent, 'Generate image once and recover safely if the outcome is unknown', { context });
    expect(interrupted.interruptions).toHaveLength(1);

    const approvalId = createApprovalId(runId, 'canvas_command', submitCallId);
    const requestFingerprint = await createAgentRequestFingerprint('canvas_command', {
      type: 'generation.submit',
      input: { nodeIds: ['node-1'] },
    });
    canvasAgentApprovalStore.put(createApprovalRecord({
      id: approvalId,
      runId,
      projectId: context.projectId,
      interruptionId: submitCallId,
      requestFingerprint,
      impact: { effect: 'external-submit', title: 'Generate', summary: 'Submit one generation', affectedNodeCount: 1, affectedEdgeCount: 0, externalSideEffect: true },
      baseRevision: 3,
    }));
    canvasAgentApprovalExecution.decide(approvalId, true);
    interrupted.state.approve(interrupted.state.getInterruptions()[0]);
    const completed = await runtime.runner.run(agent, interrupted.state, { context });

    expect(completed.interruptions).toHaveLength(0);
    expect(commandTypes).toEqual(['generation.submit', 'generation.status']);
    expect(submitCalls).toBe(1);
    expect(toolStatuses).toContain('unknown');
    expect(canvasAgentApprovalStore.getReceipt(
      createIdempotencyKey(runId, 'canvas_command', submitCallId),
    )).toMatchObject({
      status: 'accepted',
      safeRecovery: { kind: 'generation-status', nodeIds: ['node-1'], jobIds: ['job-1'] },
    });
    canvasAgentApprovalStore.deleteRun(runId);
  });

  it('stops bounded follow-through at a recoverable unknown boundary without replaying submit', async () => {
    const runId = 'sdk-generation-recoverable-boundary-run';
    const submitCallId = 'sdk-generation-recoverable-submit';
    canvasAgentApprovalStore.deleteRun(runId);
    let modelCalls = 0;
    let submitCalls = 0;
    const toolEvents: Array<{ status: string; error?: string }> = [];
    const transport: AgentModelTransport = {
      async getResponse() {
        modelCalls += 1;
        return modelCalls === 1 ? {
          responseId: 'recoverable-submit-response',
          toolCalls: [{
            callId: submitCallId,
            name: 'canvas_command',
            arguments: JSON.stringify({ type: 'generation.submit', input: { nodeIds: ['node-1'] } }),
          }],
          usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
        } : {
          responseId: 'recoverable-final-response',
          text: 'The existing task can be safely queried again.',
          toolCalls: [],
          usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
        };
      },
      async *getStreamedResponse() { throw new Error('unused'); },
    };
    const runtime = createStoryboardAgentRuntime({ resolveModel: () => reference, transport });
    const context: CanvasAgentContext = {
      projectId: 'project-1',
      runId,
      getCanvasRevision: () => 3,
      generationFollowThrough: { maxAttempts: 3, initialDelayMs: 0, wait: async () => {} },
      onToolEvent: (event) => { toolEvents.push({ status: event.status, error: event.error }); },
      executeCanvasCommand: async (command) => {
        if (command.type === 'generation.submit') {
          submitCalls += 1;
          return {
            ok: true as const,
            commandType: 'generation.submit' as const,
            revisionBefore: 3,
            revisionAfter: 3,
            impact: { effect: 'generation' as const, summary: 'submit', affectedNodeIds: ['node-1'], affectedEdgeIds: [], creates: { nodes: 0, edges: 0, groups: 0 }, deletes: { nodes: 0, edges: 0, groups: 0 }, requiresExternalSideEffect: true },
            output: { references: { nodeIds: ['node-1'] }, value: { status: 'accepted' } },
          };
        }
        return {
          ok: true as const,
          commandType: 'generation.status' as const,
          revisionBefore: 3,
          revisionAfter: 3,
          impact: { effect: 'read' as const, summary: 'status', affectedNodeIds: ['node-1'], affectedEdgeIds: [], creates: { nodes: 0, edges: 0, groups: 0 }, deletes: { nodes: 0, edges: 0, groups: 0 }, requiresExternalSideEffect: false },
          output: { references: { nodeId: 'node-1', jobId: 'job-1' }, value: { status: 'recoverable_wait', error: 'result lookup delayed' } },
        };
      },
    };
    const agent = createCanvasAgent({ runtime, context, skillContext: { text: 'Generate image once and follow through safely' } });
    const interrupted = await runtime.runner.run(agent, 'Generate image once and follow through safely', { context });
    const approvalId = createApprovalId(runId, 'canvas_command', submitCallId);
    canvasAgentApprovalStore.put(createApprovalRecord({
      id: approvalId,
      runId,
      projectId: context.projectId,
      interruptionId: submitCallId,
      requestFingerprint: await createAgentRequestFingerprint('canvas_command', {
        type: 'generation.submit', input: { nodeIds: ['node-1'] },
      }),
      impact: { effect: 'external-submit', title: 'Generate', summary: 'Submit one generation', affectedNodeCount: 1, affectedEdgeCount: 0, externalSideEffect: true },
      baseRevision: 3,
    }));
    canvasAgentApprovalExecution.decide(approvalId, true);
    interrupted.state.approve(interrupted.state.getInterruptions()[0]);
    await runtime.runner.run(agent, interrupted.state, { context });

    expect(submitCalls).toBe(1);
    expect(toolEvents[toolEvents.length - 1]).toMatchObject({
      status: 'unknown',
      error: expect.stringContaining('没有重复提交生成请求'),
    });
    expect(canvasAgentApprovalStore.getReceipt(createIdempotencyKey(runId, 'canvas_command', submitCallId)))
      .toMatchObject({ status: 'accepted' });
    canvasAgentApprovalStore.deleteRun(runId);
  });

  it('only exposes approved asset reads to vision models and keeps persisted state opaque', async () => {
    useCanvasStore.setState({
      nodes: [],
      edges: [],
      revision: 0,
      selectedNodeId: null,
      activeDirectorStudioNodeId: null,
      activeToolDialog: null,
      history: { past: [], future: [] },
      dragHistorySnapshot: null,
      currentViewport: { x: 0, y: 0, zoom: 1 },
      canvasViewportSize: { width: 1280, height: 720 },
    });
    const source = 'data:image/png;base64,aGVsbG8=';
    const nodeId = useCanvasStore.getState().addNode(CANVAS_NODE_TYPES.upload, { x: 0, y: 0 }, {
      displayName: 'Approved shot',
      imageUrl: source,
      aspectRatio: '16:9',
    });
    const assetId = `${nodeId}:image`;
    const runId = 'sdk-asset-read-run';
    const callId = 'sdk-asset-read-call';
    canvasAgentApprovalStore.deleteRun(runId);
    let modelCalls = 0;
    let requestAfterRead: AgentModelTurnRequest | undefined;
    const transport: AgentModelTransport = {
      async getResponse(requestValue) {
        modelCalls += 1;
        if (modelCalls === 1) {
          expect(requestValue.tools.map((candidate) => candidate.name)).toContain('asset_read');
          return {
            responseId: 'response-asset-call',
            toolCalls: [{
              callId,
              name: 'asset_read',
              arguments: JSON.stringify({ assetId }),
            }],
            usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
          };
        }
        requestAfterRead = requestValue;
        return {
          responseId: 'response-asset-final',
          text: 'The approved image is a 16:9 shot.',
          toolCalls: [],
          usage: { inputTokens: 20, outputTokens: 6, totalTokens: 26 },
        };
      },
      async *getStreamedResponse() {
        throw new Error('streaming is not used by this test');
      },
    };
    const runtime = createStoryboardAgentRuntime({ resolveModel: () => reference, transport });
    const context: CanvasAgentContext = {
      projectId: 'project-1',
      runId,
      getCanvasRevision: () => useCanvasStore.getState().revision,
      getActiveProjectId: () => 'project-1',
    };
    const agent = createCanvasAgent({
      runtime,
      context,
      supportsVision: true,
      skillContext: { text: 'Inspect the approved shot.' },
    });
    const interrupted = await runtime.runner.run(agent, 'Inspect the approved shot.', { context });
    expect(interrupted.interruptions).toHaveLength(1);

    const approvalId = createApprovalId(runId, 'asset_read', callId);
    const requestFingerprint = await createAgentRequestFingerprint('asset_read', { assetId });
    canvasAgentApprovalStore.put(createApprovalRecord({
      id: approvalId,
      runId,
      projectId: context.projectId,
      interruptionId: callId,
      requestFingerprint,
      impact: {
        effect: 'read',
        title: 'asset_read',
        summary: 'Read one approved image.',
        affectedNodeCount: 1,
        affectedEdgeCount: 0,
        externalSideEffect: false,
      },
      baseRevision: useCanvasStore.getState().revision,
    }));
    canvasAgentApprovalExecution.decide(approvalId, true);
    interrupted.state.approve(interrupted.state.getInterruptions()[0]);
    const completed = await runtime.runner.run(agent, interrupted.state, { context });

    expect(completed.finalOutput).toBe('The approved image is a 16:9 shot.');
    expect(modelCalls).toBe(2);
    expect(requestAfterRead?.input).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'function_call_result',
        content: expect.arrayContaining([
          expect.objectContaining({ type: 'image', imageUrl: source }),
        ]),
      }),
    ]));
    const serialized = serializeStoryboardRunState(completed.state);
    const receipt = canvasAgentApprovalStore.getReceipt(createIdempotencyKey(runId, 'asset_read', callId));
    expect(serialized).toContain('agent-media-ref:');
    expect(JSON.stringify(receipt)).toContain('agent-media-ref:');
    expect(serialized).not.toContain(source);
    expect(JSON.stringify(receipt)).not.toContain(source);

    const textRequests: AgentModelTurnRequest[] = [];
    const textRuntime = createStoryboardAgentRuntime({
      resolveModel: () => ({ ...reference, capabilities: { ...reference.capabilities, vision: false } }),
      transport: {
        async getResponse(requestValue) {
          textRequests.push(requestValue);
          return {
            responseId: 'response-text-only',
            text: 'I can inspect metadata only.',
            toolCalls: [],
            usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
          };
        },
        async *getStreamedResponse() { throw new Error('unused'); },
      },
    });
    const textAgent = createCanvasAgent({
      runtime: textRuntime,
      context: { ...context, runId: 'sdk-text-only-run' },
      supportsVision: false,
      skillContext: { text: 'Inspect metadata.' },
    });
    await textRuntime.runner.run(textAgent, 'Inspect metadata.', { context: { ...context, runId: 'sdk-text-only-run' } });
    expect(textRequests[0].tools.map((candidate) => candidate.name)).not.toContain('asset_read');

    canvasAgentApprovalStore.deleteRun(runId);
    revokeAgentMediaRun(runId);
    useCanvasStore.setState({ nodes: [], edges: [], revision: 0, history: { past: [], future: [] } });
  });

  it('registers only tools allowed by the routed skills', async () => {
    const requests: AgentModelTurnRequest[] = [];
    const transport: AgentModelTransport = {
      async getResponse(requestValue) {
        requests.push(requestValue);
        return {
          responseId: `response-${requests.length}`,
          text: 'Done.',
          toolCalls: [],
          usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
        };
      },
      async *getStreamedResponse() { throw new Error('unused'); },
    };
    const runtime = createStoryboardAgentRuntime({ resolveModel: () => reference, transport });
    const diagnosticContext: CanvasAgentContext = { projectId: 'project-1', runId: 'skills-diagnostic-run' };
    const diagnosticAgent = createCanvasAgent({
      runtime,
      context: diagnosticContext,
      supportsVision: true,
      supportsToolSearch: true,
      skillContext: { text: '帮我诊断 429 错误' },
    });
    await runtime.runner.run(diagnosticAgent, '帮我诊断 429 错误', { context: diagnosticContext });
    expect(requests[0].tools.map((candidate) => candidate.name)).toEqual(['diagnostics']);

    const minimalContext: CanvasAgentContext = { projectId: 'project-1', runId: 'skills-minimal-run' };
    const minimalAgent = createCanvasAgent({
      runtime,
      context: minimalContext,
      supportsVision: true,
      supportsToolSearch: true,
      skillContext: { text: '你好' },
    });
    await runtime.runner.run(minimalAgent, '你好', { context: minimalContext });
    expect(requests[1].tools.map((candidate) => candidate.name)).toEqual([]);
  });

  it('marks deferred namespaced tools only for a compatible Responses model', async () => {
    const requests: AgentModelTurnRequest[] = [];
    const compatibleReference: AgentModelReference = {
      ...reference,
      capabilities: {
        ...reference.capabilities,
        protocol: 'openai-responses',
        toolSearch: true,
      },
    };
    const transport: AgentModelTransport = {
      async getResponse(requestValue) {
        requests.push(requestValue);
        return {
          responseId: `response-${requests.length}`,
          text: 'Done.',
          toolCalls: [],
          usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
        };
      },
      async *getStreamedResponse() { throw new Error('unused'); },
    };
    const responsesRuntime = createStoryboardAgentRuntime({
      resolveModel: () => compatibleReference,
      transport,
    });
    const responsesContext: CanvasAgentContext = { projectId: 'project-1', runId: 'responses-tool-search-run' };
    const responsesAgent = createCanvasAgent({
      runtime: responsesRuntime,
      context: responsesContext,
      supportsVision: false,
      supportsToolSearch: true,
      protocol: 'openai-responses',
      skillContext: { text: '帮我诊断 429 错误' },
    });
    await responsesRuntime.runner.run(responsesAgent, '帮我诊断 429 错误', { context: responsesContext });
    expect(requests[0]).toMatchObject({
      tools: [{
        name: 'diagnostics',
        namespace: 'storyboard_canvas',
        deferLoading: true,
      }],
      toolPolicy: {
        mode: 'responses-tool-search',
        deferredToolNames: ['storyboard_canvas.diagnostics'],
        deferredNamespaces: ['storyboard_canvas'],
      },
    });

    const chatRuntime = createStoryboardAgentRuntime({
      resolveModel: () => ({
        ...reference,
        capabilities: { ...reference.capabilities, toolSearch: true },
      }),
      transport,
    });
    const chatContext: CanvasAgentContext = { projectId: 'project-1', runId: 'chat-local-pruning-run' };
    const chatAgent = createCanvasAgent({
      runtime: chatRuntime,
      context: chatContext,
      supportsVision: false,
      supportsToolSearch: true,
      protocol: 'openai-chat-completions',
      skillContext: { text: '帮我诊断 429 错误' },
    });
    await chatRuntime.runner.run(chatAgent, '帮我诊断 429 错误', { context: chatContext });
    expect(requests[1]).toMatchObject({
      tools: [{ name: 'diagnostics', deferLoading: false }],
      toolPolicy: {
        mode: 'local-pruned',
        deferredToolNames: [],
        deferredNamespaces: [],
      },
    });
    expect(requests[1].tools[0].namespace).toBeUndefined();
  });

  it('publishes exact canvas command contracts and the selected generation target to the model', async () => {
    let captured: AgentModelTurnRequest | null = null;
    const transport: AgentModelTransport = {
      async getResponse(requestValue) {
        captured = requestValue;
        return {
          responseId: 'generation-contract-response',
          text: 'Done.',
          toolCalls: [],
          usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
        };
      },
      async *getStreamedResponse() { throw new Error('unused'); },
    };
    const runtime = createStoryboardAgentRuntime({ resolveModel: () => reference, transport });
    const context: CanvasAgentContext = { projectId: 'project-1', runId: 'generation-contract-run' };
    const agent = createCanvasAgent({
      runtime,
      context,
      supportsVision: true,
      protocol: 'openai-chat-completions',
      skillContext: { text: '生成一张 16:9 的 2K 图片' },
      generationPreferences: {
        image: {
          modelId: 'agnes:image:image-2.1-flash',
          supportedRatios: ['16:9', '1:1'],
          supportedResolutions: ['1K', '2K'],
        },
      },
    });
    await runtime.runner.run(agent, '生成一张 16:9 的 2K 图片', { context });

    const request = captured as AgentModelTurnRequest | null;
    const canvasTool = request?.tools.find((tool) => tool.name === 'canvas_command');
    expect(canvasTool?.parameters).toMatchObject({
      additionalProperties: false,
      anyOf: expect.any(Array),
      properties: {
        input: {
          description: expect.stringContaining('generation.submit { nodeIds:array }'),
        },
      },
    });
    const commandVariants = canvasTool?.parameters.anyOf as Array<Record<string, any>>;
    expect(commandVariants.find((variant) => variant.title === 'generation.submit')).toMatchObject({
      required: ['type', 'input'],
      additionalProperties: false,
      properties: {
        type: { enum: ['generation.submit'] },
        input: {
          required: ['nodeIds'],
          additionalProperties: false,
          properties: { nodeIds: { type: 'array' } },
        },
      },
    });
    expect(commandVariants.find((variant) => variant.title === 'canvas.query')).toMatchObject({
      required: ['type', 'input'],
      additionalProperties: false,
      properties: {
        type: { enum: ['canvas.query'] },
        input: {
          required: ['scope'],
          additionalProperties: false,
          properties: {
            scope: { type: 'string' },
            nodeIds: { type: 'array' },
            limit: { type: 'number' },
          },
        },
      },
    });
    const generationInput = (commandVariants.find((variant) => variant.title === 'generation.submit')?.properties as Record<string, any>).input;
    const queryInput = (commandVariants.find((variant) => variant.title === 'canvas.query')?.properties as Record<string, any>).input;
    const createInput = (commandVariants.find((variant) => variant.title === 'node.create')?.properties as Record<string, any>).input;
    expect(generationInput.properties).not.toHaveProperty('prompt');
    expect(queryInput.properties).not.toHaveProperty('filter');
    expect(queryInput.properties.scope.enum).toEqual(['graph', 'nodes', 'edges', 'selection']);
    expect(createInput.properties.nodeType.enum).toContain('imageNode');
    expect(createInput.properties.nodeType.enum).not.toContain('image');
    expect(createInput.properties.position).toMatchObject({
      required: ['x', 'y'],
      additionalProperties: false,
    });
    expect(createInput.properties.configuration).toMatchObject({
      additionalProperties: false,
      properties: {
        prompt: { type: 'string' },
        modelId: { type: 'string' },
        aspectRatio: { type: 'string' },
        resolution: { type: 'string' },
      },
    });
    expect(request?.systemInstructions).toContain('精确注册值 imageNode');
    expect(request?.systemInstructions).toContain('不要自造 nodeId');
    expect(request?.systemInstructions).toContain('不能写成 Markdown');
    expect(request?.systemInstructions).toContain('modelId=agnes:image:image-2.1-flash');
    expect(request?.systemInstructions).toContain('generation.submit 不接收 prompt');
    expect(request?.systemInstructions).toContain('禁止在正文输出 Reasoning Summary');
    expect(request?.systemInstructions).toContain('状态查询和生成结果通常用一至三段中文');

    for (const protocol of [
      'openai-responses',
      'openai-chat-completions',
      'anthropic-messages',
      'google-gemini',
    ] as const) {
      const body = buildAgentProviderBody({
        ...request!,
        model: {
          ...request!.model,
          capabilities: { ...request!.model.capabilities, protocol },
        },
      }, false);
      const serialized = JSON.stringify(body);
      expect(serialized).toContain('"anyOf"');
      expect(serialized).toContain('"generation.submit"');
      expect(serialized).toContain('"nodeIds"');
      expect(serialized).not.toContain('"filter"');
    }
  });
});
