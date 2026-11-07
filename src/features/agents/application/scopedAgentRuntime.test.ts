import { describe, expect, it } from 'vitest';
import { createCanvasAgent, createStoryboardAgentRuntime, normalizeStoryboardAgentToolCalls } from '@/features/canvas/agent/infrastructure/sdkRuntime';
import type { AgentModelReference, AgentModelTransport, AgentModelTurnRequest, AgentScope } from '@/features/canvas/agent/domain/agentModel';

const reference: AgentModelReference = { catalogId: 'custom:p:m', providerId: 'p', modelId: 'm', label: 'M', usable: true,
  capabilities: { protocol: 'openai-chat-completions', tools: true, stream: false, vision: true, reasoningSummary: false, toolSearch: false },
};

describe('SDK scoped tool exposure', () => {
  it.each(['home', 'stage', 'canvas'] as const)('retains SDK execution while exposing only %s tools', async (scope: AgentScope) => {
    let captured: AgentModelTurnRequest | undefined;
    const transport: AgentModelTransport = {
      async getResponse(request) {
        captured = request;
        return { responseId: `${scope}-response`, text: 'ready', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
      },
      async *getStreamedResponse() { throw new Error('No streaming in this fixture'); },
    };
    const runtime = createStoryboardAgentRuntime({ resolveModel: () => reference, transport });
    const agent = createCanvasAgent({ runtime, scope, modelName: reference.catalogId, supportsVision: true,
      skillContext: { text: scope === 'canvas' ? '帮我创建图片节点并查询知识库笔记' : 'hello' },
      context: { projectId: 'p', runId: `run-${scope}` },
    });
    const result = await runtime.runner.run(agent, 'hello');
    expect(result.finalOutput).toBe('ready');
    const names = captured?.tools.map((tool) => tool.name) ?? [];
    for (const name of ['kb_search', 'kb_read', 'kb_write', 'kb_organize']) expect(names).toContain(name);
    if (scope === 'home') {
      expect(names).toContain('project_list');
      expect(names).toContain('canvas_open_plan');
      expect(names).toContain('channel_preview');
      expect(names).toContain('channel_create');
      expect(names).not.toContain('stage_command');
      expect(names).not.toContain('canvas_command');
    } else if (scope === 'stage') {
      expect(names).toContain('stage_command');
      expect(names).toContain('stage_capture');
      expect(names).not.toContain('project_create');
      expect(names).not.toContain('canvas_command');
    } else {
      expect(names).not.toContain('project_list');
      expect(names).not.toContain('stage_command');
    }
    if (scope !== 'canvas') for (const tool of captured?.tools ?? []) {
      expect(tool.strict).toBe(true);
      expect(tool.parameters.additionalProperties).toBe(false);
    }
  });

  it('preserves all unexposed calls for explicit SDK rejection without dropping their ids', () => {
    const calls = [
      { callId: 'home', name: 'project_list', arguments: '{}' },
      { callId: 'wrong', name: 'canvas_command', arguments: '{"type":"node.delete","input":{"nodeIds":["n"]}}' },
      { callId: 'forged', name: 'stage_command', namespace: 'storyboard_canvas', arguments: '{}' },
      { callId: 'invented', name: 'invented_tool', arguments: '{}' },
    ];
    expect(normalizeStoryboardAgentToolCalls(calls)).toEqual(calls);
  });
});
