import 'fake-indexeddb/auto';
import { Agent, tool, type AgentInputItem } from '@openai/agents';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createStoryboardAgentRuntime } from './sdkRuntime';
import { buildAgentProviderBody } from '../application/agentProviderRequestCodec';
import { parseAgentProviderResponse } from '../application/agentProviderCodec';
import { consumeAgentRunStream } from '../application/agentRunStreamReader';
import type { AgentModelProtocol, AgentModelReference, AgentModelTurnRequest } from '../domain/agentModel';

const names = ['stage_query', 'create_object', 'stage_command'];
const callIds = ['read-real-scene', 'unknown-name', 'unexposed-edit'];
const cases = (['openai-chat-completions', 'openai-responses', 'anthropic-messages', 'google-gemini'] as const)
  .flatMap(protocol => [false, true].map(streaming => ({ protocol, streaming })));

function wirePairs(request: AgentModelTurnRequest): { calls: string[]; results: string[] } {
  const body = buildAgentProviderBody(request, false);
  const protocol = request.model.capabilities.protocol;
  if (protocol === 'openai-chat-completions') {
    const messages = z.array(z.object({ role: z.string(), tool_call_id: z.string().optional(), tool_calls: z.array(z.object({ id: z.string() })).optional() })).parse(body.messages);
    const pending = new Set<string>();
    const calls: string[] = [], results: string[] = [];
    for (const message of messages) {
      if (message.role === 'tool') {
        const id = message.tool_call_id ?? '';
        expect(pending.delete(id)).toBe(true); results.push(id);
      } else {
        expect([...pending]).toEqual([]);
        for (const call of message.tool_calls ?? []) { pending.add(call.id); calls.push(call.id); }
      }
    }
    expect([...pending]).toEqual([]);
    return { calls, results };
  }
  if (protocol === 'google-gemini') {
    const contents = z.array(z.object({ parts: z.array(z.object({ functionCall: z.object({ id: z.string() }).optional(), functionResponse: z.object({ id: z.string() }).optional() })) })).parse(body.contents);
    return {
      calls: contents.flatMap(content => content.parts.flatMap(part => part.functionCall ? [part.functionCall.id] : [])),
      results: contents.flatMap(content => content.parts.flatMap(part => part.functionResponse ? [part.functionResponse.id] : [])),
    };
  }
  if (protocol === 'anthropic-messages') {
    const messages = z.array(z.object({ content: z.array(z.object({ type: z.string(), id: z.string().optional(), tool_use_id: z.string().optional() })) })).parse(body.messages);
    return {
      calls: messages.flatMap(message => message.content.flatMap(part => part.type === 'tool_use' && part.id ? [part.id] : [])),
      results: messages.flatMap(message => message.content.flatMap(part => part.type === 'tool_result' && part.tool_use_id ? [part.tool_use_id] : [])),
    };
  }
  const input = z.array(z.object({ type: z.string(), call_id: z.string().optional() })).parse(body.input);
  return {
    calls: input.flatMap(item => item.type === 'function_call' && item.call_id ? [item.call_id] : []),
    results: input.flatMap(item => item.type === 'function_call_output' && item.call_id ? [item.call_id] : []),
  };
}

function providerToolResponse(request: AgentModelTurnRequest) {
  const calls = names.map((name, index) => ({ name, id: callIds[index] }));
  const protocol = request.model.capabilities.protocol;
  const payload = protocol === 'openai-chat-completions'
    ? { choices: [{ message: { content: 'Inspecting the scene.', reasoning_content: 'PRIVATE_FIXTURE_REASONING', tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: '{}' } })) }, finish_reason: 'tool_calls' }] }
    : protocol === 'openai-responses'
      ? { output: [{ type: 'reasoning', encrypted_content: 'PRIVATE_FIXTURE_REASONING', summary: [] }, ...calls.map(call => ({ type: 'function_call', name: call.name, call_id: call.id, arguments: '{}' }))] }
      : protocol === 'anthropic-messages'
        ? { content: [{ type: 'thinking', thinking: 'PRIVATE_FIXTURE_REASONING', signature: 'signed-fixture' }, ...calls.map(call => ({ type: 'tool_use', name: call.name, id: call.id, input: {} }))] }
        : { candidates: [{ content: { role: 'model', parts: calls.map(call => ({ functionCall: { name: call.name, id: call.id, args: {} }, thoughtSignature: 'PRIVATE_FIXTURE_REASONING' })) } }] };
  return parseAgentProviderResponse(request, payload);
}

function modelReference(protocol: AgentModelProtocol, streaming: boolean): AgentModelReference {
  return { catalogId: 'unknown-tool-local', providerId: 'fixture', modelId: 'local', label: 'Local tool fixture', usable: true,
    capabilities: { protocol, tools: true, stream: streaming, vision: false, reasoningSummary: false, toolSearch: false } };
}

describe('provider continuation after unavailable tool requests', () => {
  it.each(cases)('returns errors for every unavailable call without breaking $protocol continuation (stream=$streaming)', async ({ protocol, streaming }) => {
    const inspect = vi.fn(async () => 'Actual scene contains one object.');
    const calls: AgentModelTurnRequest[] = [];
    const respond = async (request: AgentModelTurnRequest) => {
      calls.push(request);
      expect(request.tools.map(tool => tool.name)).toEqual(['stage_query']);
      if (calls.length === 1) return providerToolResponse(request);
      const pairs = wirePairs(request);
      expect(pairs.calls).toEqual(callIds);
      expect(pairs.results.slice().sort()).toEqual(callIds.slice().sort());
      const results = request.input.filter(item => item.type === 'function_call_result');
      expect(results).toHaveLength(3);
      expect(results.find(item => item.callId === 'read-real-scene')?.output).toContain('Actual scene');
      for (const id of ['unknown-name', 'unexposed-edit']) {
        expect(JSON.parse(results.find(item => item.callId === id)?.output ?? 'null')).toMatchObject({ ok: false, code: 'tool-not-allowed' });
      }
      return { responseId: `done-${calls.length}`, text: 'Unavailable tools were rejected; the real scene was inspected.', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    };
    const runtime = createStoryboardAgentRuntime({ resolveModel: () => modelReference(protocol, streaming), transport: {
      getResponse: respond,
      getStreamedResponse: async function* (request) { yield { type: 'completed', response: await respond(request) }; },
    } });
    const agent = new Agent({ name: 'Unknown tool fixture', model: runtime.modelProvider.getModel(),
      tools: [tool({ name: 'stage_query', description: 'Inspect actual fixture', parameters: z.object({}), execute: inspect })],
    });
    const run = async (input: string | AgentInputItem[]) => {
      if (!streaming) return runtime.runner.run(agent, input);
      const result = await runtime.runner.run(agent, input, { stream: true });
      await consumeAgentRunStream(result, () => undefined);
      return result;
    };
    const completed = await run('Inspect the local fixture.');
    expect(completed.finalOutput).toContain('Unavailable tools were rejected');
    expect(inspect).toHaveBeenCalledOnce();
    expect(JSON.stringify(completed.history)).not.toContain('PRIVATE_FIXTURE_REASONING');
    expect(completed.history.filter(item => item.type === 'function_call_result')).toHaveLength(3);
    await run([...completed.history, { role: 'user', content: 'Continue from those explicit errors.' }]);
    expect(calls).toHaveLength(3);
    expect(inspect).toHaveBeenCalledOnce();
  });
});
