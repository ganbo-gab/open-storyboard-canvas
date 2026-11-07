import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCanvasAgent, createStoryboardAgentRuntime, restoreStoryboardRunState, serializeStoryboardRunState } from './sdkRuntime';
import type { CanvasAgentContext } from './sdkRuntime';
import type { AgentModelReference, AgentModelTransport } from '../domain/agentModel';
import { AgentTurnSafety, normalizeAgentTurnSafetySnapshot } from '../application/agentTurnSafety';
import { consumeAgentRunStream } from '../application/agentRunStreamReader';

const reference: AgentModelReference = { catalogId: 'custom:fixture:tools', providerId: 'fixture', modelId: 'tools', label: 'Fixture', usable: true,
  capabilities: { protocol: 'openai-chat-completions', tools: true, stream: false, vision: false, reasoningSummary: false, toolSearch: false } };
afterEach(() => vi.useRealTimers());

describe('Agent whole-turn safety limits', () => {
  it('counts only the current run when restoring a legacy snapshot with extensive prior turns', () => {
    const call = (callId: string) => ({ type: 'function_call', callId, name: 'stage_query', arguments: '{}' });
    const saved = JSON.stringify({
      originalInput: Array.from({ length: 120 }, (_, index) => call(`old-${index}`)),
      generatedItems: [{ rawItem: call('current') }, { rawItem: call('current') }],
      modelResponses: [{ output: [call('current')] }],
    });
    expect(normalizeAgentTurnSafetySnapshot(undefined, 123, saved)).toEqual({ startedAt: 123, toolCalls: 1 });
  });

  it.each([false, true])('stops a single response containing more than 96 calls before exposing approval authority (stream=%s)', async (stream) => {
    const transport: AgentModelTransport = {
      async getResponse() { return { responseId: 'too-many', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        toolCalls: Array.from({ length: 97 }, (_, index) => ({ callId: `call-${index}`,
          name: 'canvas_command', arguments: JSON.stringify({ type: 'node.create', input: { nodeType: 'tagNode', position: { x: 0, y: 0 } } }) })) }; },
      async *getStreamedResponse(request, signal) { yield { type: 'completed', response: await this.getResponse(request, signal) }; },
    };
    const runtime = createStoryboardAgentRuntime({ resolveModel: () => reference, transport });
    const agent = createCanvasAgent({ runtime, modelName: reference.catalogId, skillContext: { text: '创建画布节点' }, context: { projectId: 'p', runId: 'cap' } });
    const run = async () => {
      if (!stream) return runtime.runner.run(agent, 'create nodes');
      const result = await runtime.runner.run(agent, 'create nodes', { stream: true });
      await consumeAgentRunStream(result, () => undefined);
      return result;
    };
    await expect(run()).rejects.toThrow(/96.*工具调用.*停止/);
  });

  it.each(['live', 'snapshot', 'legacy'])('keeps the 96-call total across approval continuations (restored=%s)', async (restored) => {
    let response = 0;
    const transport: AgentModelTransport = {
      async getResponse() {
        response += 1;
        return { responseId: `batch-${response}`, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          toolCalls: Array.from({ length: response < 3 ? 48 : 1 }, (_, index) => ({ callId: `call-${response}-${index}`, name: 'canvas_command',
            arguments: JSON.stringify({ type: 'node.create', input: { nodeType: 'tagNode', position: { x: 0, y: 0 } } }) })) };
      },
      async *getStreamedResponse() { throw new Error('Not streamed'); },
    };
    const safety = new AgentTurnSafety();
    const context: CanvasAgentContext = { projectId: 'p', runId: 'continuation-cap' };
    let runtime = createStoryboardAgentRuntime({ resolveModel: () => reference, transport, turnSafety: safety });
    let agent = createCanvasAgent({ runtime, modelName: reference.catalogId, skillContext: { text: '创建画布节点' }, context });
    const first = await runtime.runner.run(agent, 'create', { context });
    expect(first.interruptions).toHaveLength(48);
    first.interruptions.forEach((item) => first.state.reject(item));
    let state = first.state;
    if (restored !== 'live') {
      const saved = serializeStoryboardRunState(state);
      const snapshot = normalizeAgentTurnSafetySnapshot(restored === 'legacy' ? undefined : safety.snapshot(), safety.snapshot().startedAt, saved);
      safety.dispose();
      runtime = createStoryboardAgentRuntime({ resolveModel: () => reference, transport, turnSafety: new AgentTurnSafety(snapshot) });
      agent = createCanvasAgent({ runtime, modelName: reference.catalogId, skillContext: { text: '创建画布节点' }, context });
      state = await restoreStoryboardRunState(agent, saved, context);
      state.getInterruptions().forEach((item) => state.reject(item));
    }
    const second = await runtime.runner.run(agent, state, { context });
    expect(second.interruptions).toHaveLength(48);
    second.interruptions.forEach((item) => second.state.reject(item));
    await expect(runtime.runner.run(agent, second.state, { context })).rejects.toThrow(/96.*工具调用.*停止/);
  });

  it.each([false, true])('includes approval-wait time in the original thirty-minute deadline (restored=%s)', async (restored) => {
    vi.useFakeTimers();
    const transport: AgentModelTransport = {
      async getResponse() { return { responseId: 'approval', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        toolCalls: [{ callId: 'pause', name: 'canvas_command', arguments: JSON.stringify({ type: 'node.create', input: { nodeType: 'tagNode', position: { x: 0, y: 0 } } }) }] }; },
      async *getStreamedResponse() { throw new Error('Not streamed'); },
    };
    const safety = new AgentTurnSafety();
    const context: CanvasAgentContext = { projectId: 'p', runId: 'approval-deadline' };
    let runtime = createStoryboardAgentRuntime({ resolveModel: () => reference, transport, turnSafety: safety });
    let agent = createCanvasAgent({ runtime, modelName: reference.catalogId, skillContext: { text: '创建画布节点' }, context });
    const first = await runtime.runner.run(agent, 'create', { context });
    first.interruptions.forEach((item) => first.state.reject(item));
    let state = first.state;
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    if (restored) {
      const saved = serializeStoryboardRunState(state);
      safety.dispose();
      runtime = createStoryboardAgentRuntime({ resolveModel: () => reference, transport, turnSafety: new AgentTurnSafety(safety.snapshot()) });
      agent = createCanvasAgent({ runtime, modelName: reference.catalogId, skillContext: { text: '创建画布节点' }, context });
      state = await restoreStoryboardRunState(agent, saved, context);
      state.getInterruptions().forEach((item) => state.reject(item));
    }
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(runtime.runner.run(agent, state, { context })).rejects.toThrow(/30 分钟.*停止/);
  });

  it('stops a stalled model response at the thirty-minute whole-turn deadline with an explanation', async () => {
    vi.useFakeTimers();
    const transport: AgentModelTransport = {
      getResponse: () => Promise.withResolvers<never>().promise,
      async *getStreamedResponse() { throw new Error('Not streamed'); },
    };
    const runtime = createStoryboardAgentRuntime({ resolveModel: () => reference, transport });
    const agent = createCanvasAgent({ runtime, modelName: reference.catalogId, skillContext: { text: 'hello' }, context: { projectId: 'p', runId: 'deadline' } });
    const stopped = expect(runtime.runner.run(agent, 'hello')).rejects.toThrow(/30 分钟.*停止/);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    await stopped;
  });
});
