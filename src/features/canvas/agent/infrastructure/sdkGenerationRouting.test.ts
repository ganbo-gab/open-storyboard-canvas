import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { z } from 'zod';
import type { CanvasCommand, CanvasCommandExecutionSuccess } from '@/features/canvas/domain/canvasCommands';
import { buildAgentProviderBody } from '../application/agentProviderRequestCodec';
import {
  canvasAgentApprovalExecution, canvasAgentApprovalStore, createAgentRequestFingerprint,
  createApprovalId, createApprovalRecord,
} from '../application/agentApproval';
import type { AgentModelReference, AgentModelTransport, AgentModelTurnRequest } from '../domain/agentModel';
import { createCanvasAgent, createStoryboardAgentRuntime, type CanvasAgentContext } from './sdkRuntime';

const reference: AgentModelReference = {
  catalogId: 'custom:deepseek-channel:deepseek-flash', providerId: 'deepseek-channel', modelId: 'deepseek-flash', label: 'DeepSeek Flash', usable: true,
  capabilities: { protocol: 'openai-chat-completions', tools: true, stream: false, vision: false, reasoningSummary: false, toolSearch: false },
};
const target = 'custom:channel-image-fixture-image:gpt-image-2.6';
const callInputSchema = z.object({ type: z.enum(['node.create', 'generation.submit']), input: z.record(z.string(), z.unknown()) });
const createInput = { type: 'node.create', input: { nodeType: 'imageNode', position: { x: 0, y: 0 }, configuration: {
  prompt: '原神神里绫华，动漫插画', modelId: target, modeId: 'generate', params: { size: '1024x1536', quality: 'high' },
} } };
const submitInput = { type: 'generation.submit', input: { nodeIds: ['created-image-node'] } };

it.each(['生成吧', '你直接帮我提交生成呀'])('keeps DeepSeek canvas tools and completes the approved image chain after “%s”', async (message) => {
  const runId = crypto.randomUUID();
  const requests: AgentModelTurnRequest[] = [];
  const commands: CanvasCommand[] = [];
  let revision = 1;
  const transport: AgentModelTransport = {
    async getResponse(request) {
      requests.push(request);
      // A provider sees real function schemas on Chat Completions, never a
      // Responses-only deferred namespace that it cannot discover.
      const body = buildAgentProviderBody(request, false);
      expect(body).toMatchObject({ model: 'deepseek-flash', tools: expect.arrayContaining([
        { type: 'function', function: expect.objectContaining({ name: 'canvas_command' }) },
      ]) });
      expect(JSON.stringify(body)).not.toContain('defer_loading');
      expect(JSON.stringify(body)).not.toContain('tool_search');
      expect(request.systemInstructions).toContain(`modelId=${target}`);
      expect(request.systemInstructions).toContain('1024x1536');
      const call = requests.length === 1 ? createInput : requests.length === 2 ? submitInput : undefined;
      return { responseId: `response-${requests.length}`, text: call ? undefined : '生成完成。',
        toolCalls: call ? [{ callId: `call-${requests.length}`, name: 'canvas_command', arguments: JSON.stringify(call) }] : [],
        usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 } };
    },
    async *getStreamedResponse() { throw new Error('This fixture uses the non-streaming transport'); },
  };
  const context: CanvasAgentContext = {
    projectId: 'generation-routing-fixture', runId, getCanvasRevision: () => revision,
    generationFollowThrough: { maxAttempts: 3, initialDelayMs: 0, wait: async () => {} },
    executeCanvasCommand: async (command) => {
      commands.push(command);
      const before = revision;
      if (command.type === 'node.create') revision += 1;
      const result: CanvasCommandExecutionSuccess = {
        ok: true, commandType: command.type, revisionBefore: before, revisionAfter: revision,
        impact: { effect: command.type === 'node.create' ? 'graph' : command.type === 'generation.submit' ? 'generation' : 'read',
          summary: command.type, affectedNodeIds: ['created-image-node'], affectedEdgeIds: [],
          creates: { nodes: command.type === 'node.create' ? 1 : 0, edges: 0, groups: 0 },
          deletes: { nodes: 0, edges: 0, groups: 0 }, requiresExternalSideEffect: command.type === 'generation.submit' },
        output: command.type === 'node.create' ? { references: { nodeId: 'created-image-node' } }
          : command.type === 'generation.submit' ? { references: { nodeIds: ['created-image-node'] }, value: { status: 'accepted' } }
            : commands.filter((entry) => entry.type === 'generation.status').length === 1
              ? { references: { nodeId: 'created-image-node' }, value: { status: 'running' } }
              : { references: { nodeId: 'created-image-node', nodeIds: ['created-image-node', 'generated-result-node'] },
                value: { status: 'succeeded', resultNodeIds: ['generated-result-node'] } },
      };
      return result;
    },
  };
  const runtime = createStoryboardAgentRuntime({ resolveModel: () => reference, transport });
  const agent = createCanvasAgent({ runtime, context, modelName: reference.catalogId, protocol: reference.capabilities.protocol,
    supportsToolSearch: false, executionMode: 'manual',
    skillContext: { text: message, recentUserText: '帮我生成一张图片，内容是原神神里绫华' },
    generationPreferences: { image: { modelId: target, supportedRatios: ['2:3'], supportedResolutions: ['1024x1536'],
      modes: [{ id: 'generate', label: '文生图', operation: 'image.generate', slots: [], params: [
        { key: 'size', label: '尺寸', type: 'enum', values: ['1024x1536'], default: '1024x1536' },
        { key: 'quality', label: '质量', type: 'enum', values: ['high'], default: 'high' },
      ] }] } },
  });
  try {
    let result = await runtime.runner.run(agent, message, { context });
    for (let stage = 1; stage <= 2; stage += 1) {
      expect(result.interruptions).toHaveLength(1);
      const interruption = result.state.getInterruptions()[0];
      const callId = `call-${stage}`;
      if (interruption.rawItem.type !== 'function_call') throw new Error('Expected a structured function approval');
      const input = callInputSchema.parse(JSON.parse(interruption.rawItem.arguments));
      const approvalId = createApprovalId(runId, 'canvas_command', callId);
      canvasAgentApprovalStore.put(createApprovalRecord({ id: approvalId, runId, projectId: context.projectId,
        interruptionId: callId, requestFingerprint: await createAgentRequestFingerprint('canvas_command', input),
        impact: { effect: stage === 1 ? 'canvas-write' : 'external-submit', title: 'Fixture approval', summary: 'Explicitly approved test',
          affectedNodeCount: 1, affectedEdgeCount: 0, externalSideEffect: stage === 2 }, baseRevision: revision }));
      canvasAgentApprovalExecution.decide(approvalId, true);
      result.state.approve(interruption);
      result = await runtime.runner.run(agent, result.state, { context });
    }
    expect(result.finalOutput).toBe('生成完成。');
    expect(result.interruptions).toEqual([]);
    expect(commands.map((entry) => entry.type)).toEqual(['node.create', 'generation.submit', 'generation.status', 'generation.status']);
    expect(commands[0]).toMatchObject({ input: { configuration: { modelId: target } } });
    expect(commands[1]).toMatchObject({ input: { nodeIds: ['created-image-node'] } });
    expect(requests).toHaveLength(3);
    expect(requests.every((request) => request.toolPolicy?.mode === 'local-pruned')).toBe(true);
  } finally { canvasAgentApprovalStore.deleteRun(runId); }
});
