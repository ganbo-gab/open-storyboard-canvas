import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildAgentProviderBody } from './agentProviderRequestCodec';
import type { AgentModelContentPart, AgentModelInputItem, AgentModelReference } from '../domain/agentModel';

const model: AgentModelReference = { catalogId: 'codec-batch-test', providerId: 'local', modelId: 'deepseek-flash', label: 'Local codec fixture', usable: true,
  capabilities: { protocol: 'openai-chat-completions', tools: true, stream: false, vision: true, reasoningSummary: false, toolSearch: false } };
const wireMessageSchema = z.object({ role: z.enum(['system', 'user', 'assistant', 'tool']), content: z.unknown().optional(),
  tool_calls: z.array(z.object({ id: z.string(), type: z.literal('function'), function: z.object({ name: z.string(), arguments: z.string() }) })).optional(),
  tool_call_id: z.string().optional(), reasoning_content: z.string().optional(),
}).passthrough();
function messages(input: AgentModelInputItem[]) {
  return z.array(wireMessageSchema).parse(buildAgentProviderBody({ model, input, tools: [] }, false).messages);
}
/** A strict Chat consumer refuses every ordinary message before the pending batch is complete. */
function consumeChat(batch: ReturnType<typeof messages>): { calls: string[]; results: string[]; images: string[] } {
  const pending = new Set<string>(), calls: string[] = [], results: string[] = [], images: string[] = [];
  for (const message of batch) {
    if (message.role === 'tool') {
      if (!message.tool_call_id || !pending.delete(message.tool_call_id)) throw new Error('Unexpected, duplicate, or unpaired tool result');
      results.push(message.tool_call_id);
      continue;
    }
    if (pending.size) throw new Error('Tool responses must finish before any user/assistant message');
    if (message.tool_calls) {
      if (message.role !== 'assistant') throw new Error('Only assistant may request tools');
      for (const call of message.tool_calls) {
        if (pending.has(call.id)) throw new Error('Duplicate call id');
        pending.add(call.id); calls.push(call.id);
      }
    }
    if (message.role === 'user' && Array.isArray(message.content)) {
      for (const image of z.array(z.object({ type: z.literal('image_url'), image_url: z.object({ url: z.string(), detail: z.string().optional() }) })).parse(message.content)) images.push(image.image_url.url);
    }
  }
  if (pending.size) throw new Error('Missing tool result');
  return { calls, results, images };
}
const call = (id: string, group = 'first'): Extract<AgentModelInputItem, { type: 'function_call' }> => ({ type: 'function_call', callId: id, name: id === 'a' ? 'asset_view' : 'stage_query', arguments: '{}', responseGroup: group,
  continuation: { kind: 'chat-reasoning', reasoningContent: `private-${group}` } });
const result = (id: string, imageUrls: string[] = [], output = JSON.stringify({ ok: true, id })): AgentModelInputItem => ({
  type: 'function_call_result', callId: id, name: id === 'a' ? 'asset_view' : 'stage_query', output,
  content: [{ type: 'text', text: output }, ...imageUrls.map((imageUrl): AgentModelContentPart => ({ type: 'image', imageUrl, detail: 'high' }))],
});

describe('provider tool batches with images', () => {
  it.each([
    { count: 2, reverse: false }, { count: 2, reverse: true }, { count: 10, reverse: false }, { count: 10, reverse: true },
  ])('delivers all $count results before images with reverse=$reverse', ({ count, reverse }) => {
    const ids = Array.from({ length: count }, (_, index) => `call-${index}`);
    const resultIds = reverse ? ids.slice().reverse() : ids;
    const input: AgentModelInputItem[] = [
      { type: 'message', role: 'user', content: [{ type: 'text', text: 'Inspect all results' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Checking.' }], responseGroup: 'first', continuation: { kind: 'chat-reasoning', reasoningContent: 'private-first' } },
      ...ids.map(id => call(id)),
      ...resultIds.map((id, index) => result(id, index < 2 ? [`https://images.test/${id}-one.png`, `https://images.test/${id}-two.png`] : [])),
    ];
    const wire = messages(input), consumed = consumeChat(wire);
    expect(consumed.calls).toEqual(ids);
    expect(consumed.results).toEqual(resultIds);
    expect(consumed.images).toEqual(resultIds.slice(0, 2).flatMap(id => [`https://images.test/${id}-one.png`, `https://images.test/${id}-two.png`]));
    expect(wire[1]).toMatchObject({ role: 'assistant', content: 'Checking.', reasoning_content: 'private-first', tool_calls: ids.map(id => ({ id })) });
    expect(wire.filter(message => message.role === 'tool').map(message => JSON.parse(String(message.content)) as unknown)).toEqual(resultIds.map(id => ({ ok: true, id })));
    expect(wire.findIndex(message => Array.isArray(message.content))).toBe(2 + count);
  });

  it('keeps tool images before the next assistant round, without merging rounds or dropping failed results', () => {
    const input: AgentModelInputItem[] = [call('a'), call('b'), result('a', ['https://images.test/first.png']), result('b', [], '{"ok":false,"error":"capture unavailable"}'),
      { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Repairing.' }], responseGroup: 'second', continuation: { kind: 'chat-reasoning', reasoningContent: 'private-second' } },
      call('c', 'second'), result('c', ['https://images.test/second.png']),
      { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Done.' }], responseGroup: 'final' },
    ];
    const wire = messages(input);
    expect(consumeChat(wire)).toEqual({ calls: ['a', 'b', 'c'], results: ['a', 'b', 'c'], images: ['https://images.test/first.png', 'https://images.test/second.png'] });
    expect(wire.map(message => message.role)).toEqual(['assistant', 'tool', 'tool', 'user', 'assistant', 'tool', 'user', 'assistant']);
    expect(wire[4]).toMatchObject({ content: 'Repairing.', reasoning_content: 'private-second', tool_calls: [{ id: 'c' }] });
    expect(wire[2].content).toBe('{"ok":false,"error":"capture unavailable"}');
  });

  it('does not invent a tool success when an input batch is genuinely incomplete', () => {
    const wire = messages([call('a'), call('b'), result('a', ['https://images.test/one.png'])]);
    expect(wire.filter(message => message.role === 'tool')).toHaveLength(1);
    expect(() => consumeChat(wire)).toThrow('Tool responses must finish');
  });

  it('keeps a pure text batch unchanged and retains every image detail within its original result', () => {
    const pure = messages([call('a'), call('b'), result('a'), result('b')]);
    expect(pure.map(message => message.role)).toEqual(['assistant', 'tool', 'tool']);
    expect(consumeChat(pure).images).toEqual([]);
    const wire = messages([call('a'), result('a', ['https://images.test/one.png', 'https://images.test/two.png'])]);
    expect(wire[2].content).toEqual(['one', 'two'].map(name => ({ type: 'image_url', image_url: { url: `https://images.test/${name}.png`, detail: 'high' } })));
  });

  it('puts Gemini parallel function responses in one user turn before image parts', () => {
    const nativeParts = z.array(z.json()).parse([{ functionCall: { id: 'a', name: 'asset_view', args: {} }, thoughtSignature: 'signed-first' }, { functionCall: { id: 'b', name: 'stage_query', args: {} } }]);
    const input: AgentModelInputItem[] = ['a', 'b'].map(id => ({ ...call(id), continuation: { kind: 'gemini-parts', items: nativeParts } }));
    input.push(result('b', ['data:image/png;base64,Yg==']), result('a', ['data:image/png;base64,YQ==', 'data:image/png;base64,Yw==']));
    const contents = z.array(z.object({ role: z.string(), parts: z.array(z.record(z.string(), z.unknown())) })).parse(buildAgentProviderBody({ model: { ...model, capabilities: { ...model.capabilities, protocol: 'google-gemini' } }, input, tools: [] }, false).contents);
    expect(contents).toHaveLength(2);
    expect(contents[0]).toEqual({ role: 'model', parts: nativeParts });
    expect(contents[1]).toEqual({ role: 'user', parts: [
      { functionResponse: { id: 'b', name: 'stage_query', response: { ok: true, id: 'b' } } },
      { functionResponse: { id: 'a', name: 'asset_view', response: { ok: true, id: 'a' } } },
      ...['Yg==', 'YQ==', 'Yw=='].map(data => ({ inlineData: { mimeType: 'image/png', data } })),
    ] });
  });

  it('keeps Gemini result batches separate across model rounds', () => {
    const input: AgentModelInputItem[] = [call('a'), result('a', ['data:image/png;base64,YQ==']),
      { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Next round' }] }, call('b', 'second'), result('b', ['data:image/png;base64,Yg=='])];
    const body = buildAgentProviderBody({ model: { ...model, capabilities: { ...model.capabilities, protocol: 'google-gemini' } }, input, tools: [] }, false);
    const contents = z.array(z.object({ role: z.string(), parts: z.array(z.record(z.string(), z.unknown())) })).parse(body.contents);
    expect(contents.map(content => content.role)).toEqual(['model', 'user', 'model', 'model', 'user']);
    expect(contents[1].parts).toHaveLength(2);
    expect(contents[4].parts).toHaveLength(2);
  });

  it('keeps Anthropic tool images nested in their result so no ordinary user image splits the batch', () => {
    const native = [{ type: 'tool_use', id: 'a', name: 'asset_view', input: {} }, { type: 'tool_use', id: 'b', name: 'stage_query', input: {} }];
    const input: AgentModelInputItem[] = ['a', 'b'].map(id => ({ ...call(id), continuation: { kind: 'anthropic-content', items: native } }));
    input.push(result('a', ['data:image/png;base64,YQ==']), result('b'));
    const body = buildAgentProviderBody({ model: { ...model, capabilities: { ...model.capabilities, protocol: 'anthropic-messages' } }, input, tools: [] }, false);
    const wire = z.array(z.object({ role: z.string(), content: z.array(z.record(z.string(), z.unknown())) })).parse(body.messages);
    expect(wire).toHaveLength(3);
    expect(wire[0].content).toEqual(native);
    expect(wire.slice(1).flatMap(message => message.content).map(part => part.tool_use_id)).toEqual(['a', 'b']);
    expect(wire[1].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'a', content: [
      { type: 'text', text: '{"ok":true,"id":"a"}' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YQ==' } },
    ] });
  });
});
