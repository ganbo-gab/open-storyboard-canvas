import 'fake-indexeddb/auto';
import { Agent, Runner, tool, type AgentInputItem } from '@openai/agents';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AgentSessionRepository } from '../infrastructure/agentSessionRepository';
import { StoryboardAgentModel } from '../infrastructure/sdkRuntime';
import { AgentModelGatewayError } from '../infrastructure/agentModelGateway';
import { parseAgentProviderResponse } from './agentProviderCodec';
import { buildAgentProviderBody } from './agentProviderRequestCodec';
import { recoverInterruptedAgentHistory, recoverInterruptedAgentRequestHistory } from './agentInterruptedHistory';
import { consumeAgentRunStream } from './agentRunStreamReader';
import type { AgentExecutionReceipt } from './agentApproval';
import type { AgentModelProtocol, AgentModelReference, AgentModelTurnRequest } from '../domain/agentModel';

const reference: AgentModelReference = {
  catalogId: 'interrupted-local', providerId: 'local', modelId: 'local-fixture', label: 'Local fixture', usable: true,
  capabilities: { protocol: 'openai-chat-completions', tools: true, stream: false, vision: true, reasoningSummary: false, toolSearch: false },
};
const ids = ['read-scene', 'recorded-edit', 'unexecuted-edit'];
const receipt: AgentExecutionReceipt = {
  id: 'existing-receipt', executionId: 'existing-execution', approvalId: 'existing-approval', idempotencyKey: 'existing-once',
  status: 'succeeded', createdAt: 1, updatedAt: 2, output: { objectId: 'already-created' },
};

function firstResponse(request: AgentModelTurnRequest) {
  const calls = ids.map((id, index) => ({ id, name: index ? 'stage_command' : 'stage_query', args: { index } }));
  const protocol = request.model.capabilities.protocol;
  const payload = protocol === 'openai-chat-completions'
    ? { choices: [{ message: { content: 'Inspecting the real scene.', reasoning_content: 'PRIVATE_PROVIDER_FIXTURE', tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) }, finish_reason: 'tool_calls' }] }
    : protocol === 'google-gemini'
      ? { candidates: [{ content: { role: 'model', parts: calls.map(call => ({ functionCall: call, thoughtSignature: 'PRIVATE_PROVIDER_FIXTURE' })) } }] }
      : protocol === 'anthropic-messages'
        ? { content: [{ type: 'thinking', thinking: 'PRIVATE_PROVIDER_FIXTURE', signature: 'signed-fixture' }, ...calls.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.args }))] }
        : { output: [{ type: 'reasoning', encrypted_content: 'PRIVATE_PROVIDER_FIXTURE', summary: [] }, ...calls.map(call => ({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.args) }))] };
  return parseAgentProviderResponse(request, payload);
}

function expectCompleteWire(request: AgentModelTurnRequest): void {
  const body = buildAgentProviderBody(request, false);
  const protocol = request.model.capabilities.protocol;
  if (protocol === 'openai-chat-completions') {
    const messages = z.array(z.object({ role: z.string(), tool_call_id: z.string().optional(), tool_calls: z.array(z.object({ id: z.string() })).optional() })).parse(body.messages);
    const pending = new Set<string>();
    for (const message of messages) {
      if (message.role === 'tool') {
        expect(pending.delete(message.tool_call_id ?? '')).toBe(true);
      } else {
        expect([...pending]).toEqual([]);
        for (const call of message.tool_calls ?? []) pending.add(call.id);
      }
    }
    expect([...pending]).toEqual([]);
  } else if (protocol === 'google-gemini') {
    const contents = z.array(z.object({ parts: z.array(z.object({ functionCall: z.object({ id: z.string() }).optional(), functionResponse: z.object({ id: z.string() }).optional() })) })).parse(body.contents);
    expect(contents.flatMap(content => content.parts.flatMap(part => part.functionCall ? [part.functionCall.id] : []))).toEqual(ids);
    expect(contents.flatMap(content => content.parts.flatMap(part => part.functionResponse ? [part.functionResponse.id] : [])).sort()).toEqual(ids.slice().sort());
  } else if (protocol === 'anthropic-messages') {
    const messages = z.array(z.object({ content: z.array(z.object({ type: z.string(), id: z.string().optional(), tool_use_id: z.string().optional() })) })).parse(body.messages);
    expect(messages.flatMap(message => message.content.filter(part => part.type === 'tool_use').map(part => part.id))).toEqual(ids);
    expect(messages.flatMap(message => message.content.filter(part => part.type === 'tool_result').map(part => part.tool_use_id)).sort()).toEqual(ids.slice().sort());
  } else {
    const input = z.array(z.object({ type: z.string(), call_id: z.string().optional() })).parse(body.input);
    expect(input.filter(item => item.type === 'function_call').map(item => item.call_id)).toEqual(ids);
    expect(input.filter(item => item.type === 'function_call_output').map(item => item.call_id).sort()).toEqual(ids.slice().sort());
  }
}

async function interruptedFixture(protocol: AgentModelProtocol = 'openai-chat-completions') {
  const repository = new AgentSessionRepository(null);
  const session = repository.createSession({ projectId: 'local', scope: 'stage', modelRef: reference.catalogId });
  const model = { ...reference, capabilities: { ...reference.capabilities, protocol } };
  const query = vi.fn(async () => ({ objects: ['existing-object'] }));
  const command = vi.fn(async () => ({ objectId: 'should-not-execute' }));
  let step = 0;
  const adapter = new StoryboardAgentModel(model, {
    getStreamedResponse: async function* () {},
    getResponse: async request => {
      if (++step === 1) return firstResponse(request);
      expectCompleteWire(request);
      return { responseId: `continue-${step}`, text: 'Continued without repeating work.', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    },
  });
  const agent = new Agent({ name: 'Interrupted scene fixture', model: adapter, tools: [
    tool({ name: 'stage_query', description: 'Read fixture scene', parameters: z.object({ index: z.number() }), execute: query }),
    tool({ name: 'stage_command', description: 'Edit fixture scene', parameters: z.object({ index: z.number() }), needsApproval: true, execute: command }),
  ] });
  const runner = new Runner({ tracingDisabled: true });
  const result = await runner.run(agent, 'Inspect and edit the local scene.', {
    session: repository.createSdkSession(session.id),
    context: { rawProviderFixture: 'CONTEXT_MUST_NOT_BE_COPIED', mediaFixture: 'data:image/png;base64,AAAA' },
  });
  expect(result.interruptions).toHaveLength(2);
  return { repository, session, agent, runner, result, query, command };
}

describe('abandoned real SDK runs', () => {
  it.each<AgentModelProtocol>(['openai-chat-completions', 'google-gemini', 'anthropic-messages', 'openai-responses'])(
    'retains the complete %s tool batch and continues without re-executing abandoned tools', async protocol => {
      const fixture = await interruptedFixture(protocol);
      const { repository, session, result, query, command, runner, agent } = fixture;
      expect(result.state.history.filter(item => item.type === 'function_call').map(item => item.callId)).toEqual(['read-scene']);
      const saved = repository.getSession(session.id)!.items;
      const recovered = recoverInterruptedAgentHistory(saved, result.state, call => call.callId === 'recorded-edit' ? receipt : undefined);
      expect(recovered).toBeDefined();
      if (!recovered) throw new Error('Expected recovery of the same run');
      expect(recovered.filter(item => item.type === 'function_call').map(item => item.callId)).toEqual(ids);
      const outputs = recovered.filter(item => item.type === 'function_call_result');
      expect(outputs.find(item => item.callId === 'read-scene')).toEqual(saved.find(item => item.type === 'function_call_result' && item.callId === 'read-scene'));
      expect(outputs.find(item => item.callId === 'recorded-edit')?.output).toContain('already-created');
      expect(outputs.find(item => item.callId === 'unexecuted-edit')?.output).toContain('interrupted_without_result');
      expect(outputs.find(item => item.callId === 'unexecuted-edit')?.output).toContain('unconfirmed');
      const portable = JSON.stringify(recovered);
      expect(portable).not.toContain('PRIVATE_PROVIDER_FIXTURE');
      expect(portable).not.toContain('CONTEXT_MUST_NOT_BE_COPIED');
      expect(portable).not.toContain('data:image');
      repository.replaceItems(session.id, recovered);
      const continued = await runner.run(agent, 'Continue using the retained results.', { session: repository.createSdkSession(session.id) });
      expect(continued.finalOutput).toBe('Continued without repeating work.');
      expect(query).toHaveBeenCalledTimes(1);
      expect(command).not.toHaveBeenCalled();
    },
  );

  it('recovers unsaved SDK items and preserves saved outputs absent from an older snapshot', async () => {
    const { result, repository, session } = await interruptedFixture();
    const generatedOnly = recoverInterruptedAgentHistory([], result.state);
    expect(generatedOnly?.filter(item => item.type === 'function_call').map(item => item.callId)).toEqual(ids);
    expect(generatedOnly?.filter(item => item.type === 'function_call_result')).toHaveLength(3);
    const extra: AgentInputItem = { type: 'function_call_result', callId: 'recorded-edit', name: 'stage_command', status: 'completed', output: 'REAL_ALREADY_SAVED_RESULT' };
    await repository.createSdkSession(session.id).addItems([extra]);
    const saved = repository.getSession(session.id)!.items;
    const recovered = recoverInterruptedAgentHistory(saved, result.state, () => receipt);
    expect(recovered?.find(item => item.type === 'function_call_result' && item.callId === extra.callId)).toEqual(extra);
    expect(saved).toEqual(repository.getSession(session.id)!.items);
  });

  it('refuses to replace history with a different turn appended after the snapshot', async () => {
    const { result, repository, session } = await interruptedFixture();
    await repository.createSdkSession(session.id).addItems([{ role: 'user', content: 'A different turn owns the session now.' }]);
    const saved = repository.getSession(session.id)!.items;
    expect(recoverInterruptedAgentHistory(saved, result.state)).toBeUndefined();
    expect(repository.getSession(session.id)!.items).toEqual(saved);
  });

  it('retains real tool output when a subsequent model request fails', async () => {
    const repository = new AgentSessionRepository(null);
    const session = repository.createSession({ projectId: 'local', modelRef: reference.catalogId });
    let step = 0;
    const query = vi.fn(async () => ({ objects: ['real-before-failure'] }));
    const adapter = new StoryboardAgentModel(reference, {
      getStreamedResponse: async function* (request) {
        if (++step > 1) throw new AgentModelGatewayError('Local continuation failure');
        yield { type: 'completed', response: parseAgentProviderResponse(request, { choices: [{ message: { tool_calls: [{ id: 'query-before-failure', type: 'function', function: { name: 'stage_query', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }) };
      },
      getResponse: async () => { throw new Error('Unexpected nonstream transport'); },
    });
    const agent = new Agent({ name: 'Failure fixture', model: adapter, tools: [tool({ name: 'stage_query', description: 'Read scene', parameters: z.object({}), execute: query })] });
    const streamed = await new Runner({ tracingDisabled: true }).run(agent, 'Read then finish.', { stream: true, session: repository.createSdkSession(session.id) });
    await expect(consumeAgentRunStream(streamed, () => undefined)).rejects.toThrow('Local continuation failure');
    const recovered = recoverInterruptedAgentHistory(repository.getSession(session.id)!.items, streamed.state);
    expect(JSON.stringify(recovered?.find(item => item.type === 'function_call_result')?.output)).toContain('real-before-failure');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('recovers a nonstreaming model failure from the latest real SDK input without fabricating a RunState', async () => {
    const repository = new AgentSessionRepository(null);
    const session = repository.createSession({ projectId: 'local', modelRef: reference.catalogId });
    let step = 0;
    let latestInput: AgentInputItem[] | undefined;
    const query = vi.fn(async () => ({ objectId: 'nonstream-existing-object' }));
    const adapter = new StoryboardAgentModel(reference, {
      getStreamedResponse: async function* () {},
      getResponse: async request => {
        if (++step > 1) throw new AgentModelGatewayError('Local nonstream continuation failure');
        return parseAgentProviderResponse(request, { choices: [{ message: { tool_calls: [{ id: 'nonstream-query', type: 'function', function: { name: 'stage_query', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] });
      },
    }, undefined, undefined, input => { latestInput = typeof input === 'string' ? [{ role: 'user', content: input }] : input.slice(); });
    const agent = new Agent({ name: 'Nonstream failure fixture', model: adapter, tools: [tool({ name: 'stage_query', description: 'Read scene', parameters: z.object({}), execute: query })] });
    await expect(new Runner({ tracingDisabled: true }).run(agent, 'Read then finish.', { session: repository.createSdkSession(session.id) }))
      .rejects.toThrow('Local nonstream continuation failure');
    expect(latestInput).toBeDefined();
    const recovered = recoverInterruptedAgentRequestHistory(repository.getSession(session.id)!.items, latestInput ?? []);
    expect(JSON.stringify(recovered?.find(item => item.type === 'function_call_result')?.output)).toContain('nonstream-existing-object');
    expect(query).toHaveBeenCalledTimes(1);
    if (!recovered) throw new Error('Expected latest request recovery');
    repository.replaceItems(session.id, recovered);
    expect(repository.getSession(session.id)!.items).toEqual(recovered);
  });
});
