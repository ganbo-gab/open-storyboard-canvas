import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent, Runner, tool } from '@openai/agents';
import { z } from 'zod';
import type { AgentModelProtocol, AgentModelReference, AgentModelStreamEvent, AgentModelTurnRequest } from '../domain/agentModel';
import type { ChannelProfileV2 } from '@/features/channels/domain/profile';
import { buildAgentProviderBody } from '../application/agentProviderRequestCodec';
import { AgentModelGatewayError, createAgentModelTransport } from './agentModelGateway';
import { StoryboardAgentModel } from './sdkRuntime';

const channel = vi.hoisted(() => ({ resolve: vi.fn(), submit: vi.fn(), stream: vi.fn() }));
vi.mock('@/features/channels/application/channelService', () => ({ resolveNativeChannelModel: channel.resolve,
  submitChannelChat: channel.submit, streamChannelChat: channel.stream }));
function model(protocol: AgentModelProtocol, overrides: Partial<AgentModelReference['capabilities']> = {}): AgentModelReference {
  return { catalogId: `custom:provider:${protocol}`, providerId: 'provider', modelId: `fixture-${protocol}`,
    label: `Fixture ${protocol}`, usable: true,
    capabilities: { protocol, tools: true, stream: true, vision: true, reasoningSummary: true, toolSearch: false, ...overrides } };
}
function request(reference: AgentModelReference): AgentModelTurnRequest {
  return { model: reference, systemInstructions: 'Use tools when needed.',
    input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'Create a node.' }] }],
    tools: [{ name: 'create_node', namespace: 'canvas', description: 'Create one canvas node.',
      parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false }, strict: true }],
    toolChoice: 'auto' };
}
function resolve(protocol: AgentModelProtocol) {
  const mappings: Record<AgentModelProtocol, Record<string, string>> = {
    'openai-chat-completions': { messages: '{{messages}}' },
    'openai-responses': { input: '{{chatPayload.input}}' },
    'anthropic-messages': { messages: '{{messages}}', system: '{{chatPayload.system}}' },
    'google-gemini': { contents: '{{chatPayload.contents}}' },
  };
  const profile: ChannelProfileV2 = { version: 2, id: 'provider', name: 'Channel', baseUrl: 'https://provider.test', auth: { type: 'none' },
    operations: { chat: { method: 'POST', path: '/chat', body: 'json', template: mappings[protocol], response: { mode: 'sync', outputs: [] } } },
    models: [{ id: `fixture-${protocol}`, operations: ['chat'], params: [] }] };
  channel.resolve.mockReturnValue({ profile, model: profile.models[0] });
  return profile;
}
async function collect(iterable: AsyncIterable<AgentModelStreamEvent>): Promise<AgentModelStreamEvent[]> {
  const events: AgentModelStreamEvent[] = []; for await (const event of iterable) events.push(event); return events;
}
function streamedToolFixture(protocol: AgentModelProtocol, terminal: 'missing' | 'success' | 'limited'): unknown[] {
  const complete = terminal === 'success';
  if (protocol === 'openai-responses') {
    const item = { type: 'function_call', id: 'item-1', call_id: 'call-1', name: 'canvas__create_node', arguments: '{"title":"Shot"}' };
    return [{ type: 'response.output_item.done', item }, ...(terminal === 'missing' ? [] : [{
      type: complete ? 'response.completed' : 'response.incomplete',
      response: { id: 'response', status: complete ? 'completed' : 'incomplete', output: [item] },
    }])];
  }
  if (protocol === 'anthropic-messages') return [
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call-1', name: 'canvas__create_node', input: { title: 'Shot' } } },
    { type: 'message_delta', delta: { stop_reason: terminal === 'limited' ? 'max_tokens' : 'tool_use' } },
    ...(terminal === 'missing' ? [] : [{ type: 'message_stop' }]),
  ];
  if (protocol === 'google-gemini') return [{ candidates: [{
    content: { parts: [{ functionCall: { id: 'call-1', name: 'canvas__create_node', args: { title: 'Shot' } }, thoughtSignature: 'complete-signature' }] },
    ...(terminal === 'missing' ? {} : { finishReason: complete ? 'STOP' : 'MAX_TOKENS' }),
  }] }];
  return [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'canvas__create_node', arguments: '{"title":"Shot"}' } }] },
    ...(terminal === 'missing' ? {} : { finish_reason: complete ? 'tool_calls' : 'length' }),
  }] }];
}
beforeEach(() => { vi.resetAllMocks(); resolve('openai-chat-completions'); });
afterEach(() => vi.unstubAllGlobals());
describe('channel-only agent model gateway', () => {
  it.each(['read', 'write'] as const)('preserves a successful model request when optional context storage %s throws', async (phase) => {
    vi.resetModules();
    const getItem = vi.fn(() => { if (phase === 'read') throw new Error('Unknown statistics read failure'); return null; });
    const setItem = vi.fn(() => { throw new Error('Unknown statistics write failure'); });
    vi.stubGlobal('localStorage', { getItem, setItem, removeItem: () => {} });
    const { createAgentModelTransport: createIsolatedTransport } = await import('./agentModelGateway');
    const selected = { ...model('openai-chat-completions'), contextSessionId: 'context-storage-error' };
    channel.submit.mockResolvedValue({ raw: { choices: [{ message: { content: 'Still successful' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } } });
    await expect(createIsolatedTransport().getResponse(request(selected))).resolves.toMatchObject({ text: 'Still successful', usage: { inputTokens: 100 } });
    expect(channel.submit).toHaveBeenCalledOnce();
    expect(phase === 'read' ? getItem : setItem).toHaveBeenCalled();
  });
  it.each<AgentModelProtocol>(['openai-chat-completions', 'openai-responses', 'anthropic-messages', 'google-gemini'])(
    'requires successful protocol completion before exposing executable %s tools', async (protocol) => {
      resolve(protocol);
      for (const terminal of ['missing', 'limited', 'success'] as const) {
        channel.stream.mockImplementation(async function* () {
          for (const payload of streamedToolFixture(protocol, terminal)) yield `data: ${JSON.stringify(payload)}\n\n`;
          yield 'data: [DONE]\n\n';
        });
        const events: AgentModelStreamEvent[] = [];
        const reading = (async () => { for await (const event of createAgentModelTransport().getStreamedResponse(request(model(protocol)))) events.push(event); })();
        if (terminal === 'success') {
          await reading;
          expect(events.at(-1)).toMatchObject({ type: 'completed', response: { toolCalls: [{ name: 'create_node', arguments: '{"title":"Shot"}' }] } });
        } else {
          await expect(reading).rejects.toThrow(/未完整结束.*工具未执行/);
          expect(events.some(event => event.type === 'completed')).toBe(false);
        }
      }
      expect(channel.stream).toHaveBeenCalledTimes(3);
      expect(channel.submit).not.toHaveBeenCalled();
    });
  it('does not let the real SDK execute a complete-looking tool call from a truncated stream', async () => {
    channel.stream.mockImplementation(async function* () {
      for (const payload of streamedToolFixture('openai-chat-completions', 'missing')) yield `data: ${JSON.stringify(payload)}\n\n`;
    });
    const execute = vi.fn(async () => 'Created');
    const agent = new Agent({ name: 'Stream safety', model: new StoryboardAgentModel(model('openai-chat-completions'), createAgentModelTransport()),
      tools: [tool({ name: 'canvas__create_node', description: 'Create a node', parameters: z.object({ title: z.string() }), execute })] });
    const result = await new Runner({ tracingDisabled: true }).run(agent, 'Create a node', { stream: true });
    await expect(result.completed).rejects.toThrow(/工具未执行/);
    expect(execute).not.toHaveBeenCalled();
    expect(channel.stream).toHaveBeenCalledOnce();
    expect(channel.submit).not.toHaveBeenCalled();
  });
  it.each<AgentModelProtocol>(['openai-chat-completions', 'openai-responses', 'anthropic-messages', 'google-gemini'])(
    'sends the full native %s request through channelService and parses raw tool responses', async (protocol) => {
      const profile = resolve(protocol); const input = request(model(protocol));
      const fixtures: Record<AgentModelProtocol, unknown> = {
        'openai-chat-completions': { id: 'chat', choices: [{ finish_reason: 'tool_calls', message: { content: null,
          tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'canvas__create_node', arguments: '{"title":"Shot"}' } }] } }] },
        'openai-responses': { id: 'response', output: [{ type: 'function_call', call_id: 'call-1', name: 'canvas__create_node', arguments: '{"title":"Shot"}' }] },
        'anthropic-messages': { id: 'message', content: [{ type: 'tool_use', id: 'call-1', name: 'canvas__create_node', input: { title: 'Shot' } }], stop_reason: 'tool_use' },
        'google-gemini': { candidates: [{ content: { parts: [{ functionCall: { id: 'call-1', name: 'canvas__create_node', args: { title: 'Shot' } } }] }, finishReason: 'STOP' }] },
      };
      channel.submit.mockResolvedValue({ text: '', raw: fixtures[protocol], status: 200 });
      const response = await createAgentModelTransport().getResponse(input);
      expect(channel.submit).toHaveBeenCalledOnce();
      expect(channel.submit).toHaveBeenCalledWith(profile, profile.models[0].id, buildAgentProviderBody(input, false), undefined);
      expect(response.toolCalls).toMatchObject([{ name: 'create_node', namespace: 'canvas', arguments: '{"title":"Shot"}' }]);
    });
  it('accepts a mode-only chat model with an explicit chat endpoint', async () => {
    const profile = resolve('openai-chat-completions'); const selected = profile.models[0];
    selected.operations = []; selected.modes = [{ id: 'chat-mode', label: 'Chat', operation: 'chat', endpoint: profile.operations.chat! }];
    profile.operations = {};
    channel.submit.mockResolvedValue({ text: 'Mode chat works', raw: { choices: [{ message: { content: 'Mode chat works' } }] } });
    expect(await createAgentModelTransport().getResponse(request(model('openai-chat-completions')))).toMatchObject({ text: 'Mode chat works' });
    expect(channel.submit).toHaveBeenCalledWith(profile, selected.id, expect.any(Object), undefined);
  });
  it('validates the selected model chat mode rather than an unrelated model protocol', async () => {
    const profile = resolve('anthropic-messages'); const selected = profile.models[0];
    selected.modes = [{ id: 'image-mode', label: 'Image', operation: 'image.generate', endpoint: {
      method: 'POST', path: '/images', body: 'json', template: { prompt: '{{prompt}}' }, response: { mode: 'sync', outputs: [] } } },
      { id: 'selected-chat', label: 'Chat', operation: 'chat', endpoint: profile.operations.chat! }];
    profile.models.unshift({ id: 'unrelated-openai', operations: ['chat'], params: [], modes: [
      { id: 'unrelated-chat', label: 'Other chat', operation: 'chat', endpoint: { method: 'POST', path: '/other-chat', body: 'json',
        template: { messages: '{{messages}}' }, response: { mode: 'sync', outputs: [] } } },
    ] });
    channel.submit.mockResolvedValue({ text: 'Selected Anthropic', raw: { content: [{ type: 'text', text: 'Selected Anthropic' }] } });
    expect(await createAgentModelTransport().getResponse(request(model('anthropic-messages')))).toMatchObject({ text: 'Selected Anthropic' });
    expect(channel.submit).toHaveBeenCalledWith(profile, selected.id, expect.any(Object), undefined);
  });
  it('rejects stale protocol metadata that only matches an unrelated model chat mode', async () => {
    const profile = resolve('anthropic-messages'); const selected = profile.models[0];
    selected.modes = [{ id: 'selected-chat', label: 'Chat', operation: 'chat', endpoint: profile.operations.chat! }];
    profile.models.unshift({ id: 'unrelated-openai', operations: ['chat'], params: [], modes: [
      { id: 'other-chat', label: 'Other chat', operation: 'chat', endpoint: { method: 'POST', path: '/other-chat', body: 'json',
        template: { messages: '{{messages}}' }, response: { mode: 'sync', outputs: [] } } },
    ] });
    channel.submit.mockResolvedValue({ text: 'Wrong protocol', raw: { choices: [{ message: { content: 'Wrong protocol' } }] } });
    await expect(createAgentModelTransport().getResponse(request(model('openai-chat-completions')))).rejects.toBeInstanceOf(AgentModelGatewayError);
    expect(channel.submit).not.toHaveBeenCalled();
  });
  it('does not use a legacy chat operation when explicit modes expose no chat mode', async () => {
    const profile = resolve('openai-chat-completions');
    profile.models[0].modes = [{ id: 'image-only', label: 'Image', operation: 'image.generate', endpoint: {
      method: 'POST', path: '/images', body: 'json', template: { prompt: '{{prompt}}' }, response: { mode: 'sync', outputs: [] } } }];
    channel.submit.mockResolvedValue({ text: 'Wrong operation', raw: { choices: [{ message: { content: 'Wrong operation' } }] } });
    await expect(createAgentModelTransport().getResponse(request(model('openai-chat-completions')))).rejects.toBeInstanceOf(AgentModelGatewayError);
    expect(channel.submit).not.toHaveBeenCalled();
  });
  it('streams split provider events and tool argument fragments through the real channel stream port', async () => {
    channel.stream.mockImplementation(async function* () {
      yield 'data: {"id":"chat-stream","choices":[{"delta":{"content":"Work';
      yield 'ing","tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"canvas__create_node","arguments":"{\\\"title\\\":"}}]}}]}\n\n';
      yield 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\\"Shot\\\"}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n';
    });
    const events = await collect(createAgentModelTransport().getStreamedResponse(request(model('openai-chat-completions'))));
    expect(events).toContainEqual({ type: 'text_delta', delta: 'Working' });
    expect(events.at(-1)).toMatchObject({ type: 'completed', response: { text: 'Working', toolCalls: [{ name: 'create_node', arguments: '{"title":"Shot"}' }] } });
    expect(channel.stream).toHaveBeenCalledOnce(); expect(channel.submit).not.toHaveBeenCalled();
  });
  it('never submits a second request after a stream failure before any visible output', async () => {
    channel.stream.mockImplementation(async function* () { throw new Error('unknown upstream acceptance'); });
    await expect(collect(createAgentModelTransport().getStreamedResponse(request(model('openai-chat-completions'))))).rejects.toMatchObject({
      name: 'AgentModelGatewayError', retryable: false, responseStarted: false,
    });
    expect(channel.stream).toHaveBeenCalledOnce(); expect(channel.submit).not.toHaveBeenCalled();
  });
  it('assembles Anthropic tool input deltas independently and preserves whitespace inside JSON strings', async () => {
    resolve('anthropic-messages');
    const payloads = [
      { type: 'message_start', message: { id: 'anthropic-stream', usage: { input_tokens: 12 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call-1', name: 'canvas__create_node', input: {} } },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call-2', name: 'canvas__create_node', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"title":"First' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"title":"Second"}' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: ' ' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'shot"}' } },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } },
      { type: 'message_stop' },
    ];
    channel.stream.mockImplementation(async function* () {
      for (const payload of payloads) {
        const line = `data: ${JSON.stringify(payload)}\n\n`;
        yield line.slice(0, 17);
        yield line.slice(17);
      }
    });
    const events = await collect(createAgentModelTransport().getStreamedResponse(request(model('anthropic-messages'))));
    expect(events.at(-1)).toMatchObject({ type: 'completed', response: {
      toolCalls: [
        { callId: 'call-1', name: 'create_node', namespace: 'canvas', arguments: '{"title":"First shot"}' },
        { callId: 'call-2', name: 'create_node', namespace: 'canvas', arguments: '{"title":"Second"}' },
      ], usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
    } });
    expect(channel.stream).toHaveBeenCalledOnce();
    expect(channel.submit).not.toHaveBeenCalled();
  });
  it.each([{}, { title: 'Complete input' }])('preserves complete Anthropic input without deltas: %j', async (input) => {
    resolve('anthropic-messages');
    channel.stream.mockImplementation(async function* () {
      yield `data: ${JSON.stringify({ type: 'content_block_start', index: 0,
        content_block: { type: 'tool_use', id: 'call-1', name: 'canvas__create_node', input } })}\n\n`;
      yield `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' } })}\n\n`;
      yield `data: ${JSON.stringify({ type: 'message_stop' })}\n\n`;
    });
    const events = await collect(createAgentModelTransport().getStreamedResponse(request(model('anthropic-messages'))));
    expect(events.at(-1)).toMatchObject({ type: 'completed', response: {
      toolCalls: [{ arguments: JSON.stringify(input) }],
    } });
  });
  it.each(['null', '[]', '{"title":', '{"title":"cut'])('rejects malformed or non-object streamed Anthropic input %s without resubmission', async (partialJson) => {
    resolve('anthropic-messages');
    channel.stream.mockImplementation(async function* () {
      yield `data: ${JSON.stringify({ type: 'content_block_start', index: 0,
        content_block: { type: 'tool_use', id: 'call-1', name: 'canvas__create_node', input: {} } })}\n\n`;
      yield `data: ${JSON.stringify({ type: 'content_block_delta', index: 0,
        delta: { type: 'input_json_delta', partial_json: partialJson } })}\n\n`;
    });
    await expect(collect(createAgentModelTransport().getStreamedResponse(request(model('anthropic-messages')))))
      .rejects.toThrow(/create_node.*JSON.*未执行/);
    expect(channel.stream).toHaveBeenCalledOnce();
    expect(channel.submit).not.toHaveBeenCalled();
  });
  it.each([null, [], 'not an object'])('rejects non-object complete Anthropic input: %j', async (input) => {
    resolve('anthropic-messages');
    channel.submit.mockResolvedValue({ raw: { content: [{ type: 'tool_use', id: 'call-1', name: 'canvas__create_node', input }] }, text: '' });
    await expect(createAgentModelTransport().getResponse(request(model('anthropic-messages'))))
      .rejects.toThrow(/create_node.*JSON.*未执行/);
    expect(channel.submit).toHaveBeenCalledOnce();
  });
  it('never submits a second request for an empty or malformed stream', async () => {
    channel.stream.mockImplementation(async function* () { yield 'data: [DONE]\n'; });
    await expect(collect(createAgentModelTransport().getStreamedResponse(request(model('openai-chat-completions'))))).rejects.toThrow(/not resubmitted/);
    channel.stream.mockImplementation(async function* () { yield 'data: {broken}\n'; });
    await expect(collect(createAgentModelTransport().getStreamedResponse(request(model('openai-chat-completions'))))).rejects.toThrow(/malformed/);
    expect(channel.submit).not.toHaveBeenCalled();
  });
  it('uses one non-stream request when streaming is explicitly unsupported', async () => {
    channel.submit.mockResolvedValue({ raw: { choices: [{ message: { content: 'Ready' } }] }, text: 'Ready' });
    const events = await collect(createAgentModelTransport().getStreamedResponse(request(model('openai-chat-completions', { stream: false }))));
    expect(events[0]).toEqual({ type: 'text_delta', delta: 'Ready' }); expect(channel.submit).toHaveBeenCalledOnce(); expect(channel.stream).not.toHaveBeenCalled();
  });
  it('rejects stale protocol metadata, unavailable channels and unsupported tools before sending', async () => {
    const transport = createAgentModelTransport();
    await expect(transport.getResponse(request(model('anthropic-messages')))).rejects.toThrow(/协议/);
    channel.resolve.mockReturnValue(null);
    await expect(transport.getResponse(request(model('openai-chat-completions')))).rejects.toThrow(/v2/);
    await expect(transport.getResponse(request(model('openai-chat-completions', { tools: false })))).rejects.toBeInstanceOf(AgentModelGatewayError);
    expect(channel.submit).not.toHaveBeenCalled(); expect(channel.stream).not.toHaveBeenCalled();
  });
  it('does not submit pre-cancelled requests and passes cancellation to channelService', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(createAgentModelTransport().getResponse(request(model('openai-chat-completions')), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(channel.submit).not.toHaveBeenCalled();
    const active = new AbortController();
    channel.submit.mockImplementation(async () => { active.abort(); return { raw: {}, text: '' }; });
    await expect(createAgentModelTransport().getResponse(request(model('openai-chat-completions')), active.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(channel.submit.mock.lastCall?.[3]).toBe(active.signal);
  });
});
