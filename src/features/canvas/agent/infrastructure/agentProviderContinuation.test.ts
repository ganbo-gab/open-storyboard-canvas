import 'fake-indexeddb/auto';
import { Agent, Runner, tool, type AgentInputItem } from '@openai/agents';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { StoryboardAgentModel } from './sdkRuntime';
import { AgentProviderStreamAccumulator, parseAgentProviderResponse } from '../application/agentProviderCodec';
import { buildAgentProviderBody } from '../application/agentProviderRequestCodec';
import type { AgentModelReference, AgentModelTurnRequest } from '../domain/agentModel';
import { readProviderContinuation, saveProviderContinuation } from '../application/agentProviderContinuation';
const model: AgentModelReference = { catalogId: 'deepseek-test', providerId: 'test', modelId: 'deepseek-flash', label: 'DeepSeek', usable: true,
  capabilities: { protocol: 'openai-chat-completions', tools: true, stream: true, vision: true, reasoningSummary: false, toolSearch: false } };
const request = (): AgentModelTurnRequest => ({model,input:[],tools:[]});
describe('provider continuation through real SDK tool turns', () => {
  it('replays exact hidden reasoning and groups parallel calls with their assistant message', async () => {
    const bodies: unknown[] = []; let step = 0;
    const adapter = new StoryboardAgentModel(model, { getStreamedResponse: async function* () {}, getResponse: async request => {
      bodies.push(buildAgentProviderBody(request, false));step++;
      return parseAgentProviderResponse(request,{id:`response-${step}`,choices:[{message:step===1
        ? {content:'Checking.',reasoning_content:'opaque provider continuation',tool_calls:[{id:'a',type:'function',function:{name:'inspect_scene',arguments:'{}'}},{id:'b',type:'function',function:{name:'inspect_scene',arguments:'{}'}}]}
        : {content:'Done.',reasoning_content:'second private continuation'},finish_reason:step===1?'tool_calls':'stop'}],usage:{prompt_tokens:100,prompt_cache_hit_tokens:80,completion_tokens:10}});
    }});
    const inspect=vi.fn(async()=> 'scene has 2 objects');
    const agent=new Agent({name:'Test',model:adapter,tools:[tool({name:'inspect_scene',description:'Inspect scene',parameters:z.object({}),execute:inspect})]});
    const runner=new Runner({tracingDisabled:true});
    const result=await runner.run(agent,'Inspect twice then finish.');
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(bodies[1]).toMatchObject({messages:[{role:'user'}, {role:'assistant',content:'Checking.',reasoning_content:'opaque provider continuation',tool_calls:[{id:'a'},{id:'b'}]},{role:'tool',tool_call_id:'a'},{role:'tool',tool_call_id:'b'}]});
    expect(JSON.stringify(result.history)).not.toContain('opaque provider continuation');
    expect(JSON.stringify(result.history)).not.toContain('second private continuation');
    await runner.run(agent,[...result.history,{role:'user',content:'Continue.'}] as AgentInputItem[]);
    expect(bodies[2]).toMatchObject({messages:expect.arrayContaining([{role:'assistant',content:'Done.',reasoning_content:'second private continuation'}])});
  });
  it('delivers ten real SDK tool results, including image assets, as complete Chat batches across later turns', async () => {
    const wireMessage = z.object({ role: z.string(), content: z.unknown().optional(), tool_call_id: z.string().optional(),
      tool_calls: z.array(z.object({ id: z.string() })).optional(), reasoning_content: z.string().optional() }).passthrough();
    const bodies: ReturnType<typeof wireMessage.parse>[][] = [];
    const receive = (request: AgentModelTurnRequest) => {
      const wire = z.array(wireMessage).parse(buildAgentProviderBody(request, false).messages);
      const pending = new Set<string>();
      for (const message of wire) {
        if (message.role === 'tool') {
          if (!message.tool_call_id || !pending.delete(message.tool_call_id)) throw new Error('Consumer received an unpaired result');
        } else {
          if (pending.size) throw new Error('Consumer received ordinary content before all tool results');
          for (const call of message.tool_calls ?? []) {
            if (pending.has(call.id)) throw new Error('Duplicate call id');
            pending.add(call.id);
          }
        }
      }
      if (pending.size) throw new Error('Consumer did not receive all results');
      bodies.push(wire);
    };
    let step = 0;
    const adapter = new StoryboardAgentModel(model, { getStreamedResponse: async function* () {}, getResponse: async request => {
      receive(request); step++;
      return parseAgentProviderResponse(request, { id: `batch-${step}`, choices: [{ message: step === 1
        ? { content: 'Inspecting ten tools.', reasoning_content: 'exact-batch-continuation', tool_calls: Array.from({ length: 10 }, (_, index) => ({ id: `stage-call-${index}`, type: 'function',
          function: { name: index === 0 || index === 4 ? 'asset_view' : 'stage_query', arguments: JSON.stringify({ index }) } })) }
        : { content: step === 2 ? 'All ten inspected.' : 'Continued after ten tools.' }, finish_reason: step === 1 ? 'tool_calls' : 'stop' }] });
    } });
    const view = vi.fn(async ({ index }: { index: number }) => [
      { type: 'text' as const, text: `Asset ${index}` },
      { type: 'image' as const, image: `https://fixture.test/asset-${index}-a.png`, detail: 'high' as const },
      { type: 'image' as const, image: `https://fixture.test/asset-${index}-b.png`, detail: 'low' as const },
    ]);
    const query = vi.fn(async ({ index }: { index: number }) => ({ ok: true, index, objects: 3 }));
    const agent = new Agent({ name: 'Local stage batch', model: adapter, tools: [
      tool({ name: 'asset_view', description: 'View local fixture asset', parameters: z.object({ index: z.number() }), execute: view }),
      tool({ name: 'stage_query', description: 'Read local fixture stage', parameters: z.object({ index: z.number() }), execute: query }),
    ] });
    const runner = new Runner({ tracingDisabled: true });
    const completed = await runner.run(agent, 'Inspect the ten local tool results.');
    expect(completed.finalOutput).toBe('All ten inspected.');
    expect(view).toHaveBeenCalledTimes(2); expect(query).toHaveBeenCalledTimes(8);
    const next = bodies[1], assistant = next.find(message => message.tool_calls?.length === 10);
    expect(assistant?.reasoning_content).toBe('exact-batch-continuation');
    expect(next.filter(message => message.role === 'tool').map(message => message.tool_call_id)).toEqual(Array.from({ length: 10 }, (_, index) => `stage-call-${index}`));
    const imageMessages = next.filter(message => message.role === 'user' && Array.isArray(message.content));
    const images = imageMessages.flatMap(message => z.array(z.object({ type: z.literal('image_url'), image_url: z.object({ url: z.string(), detail: z.string() }) })).parse(message.content));
    expect(images.map(image => image.image_url)).toEqual([0, 4].flatMap(index => [
      { url: `https://fixture.test/asset-${index}-a.png`, detail: 'high' }, { url: `https://fixture.test/asset-${index}-b.png`, detail: 'low' },
    ]));
    await runner.run(agent, [...completed.history, { role: 'user', content: 'Continue the same local stage task.' }] as AgentInputItem[]);
    expect(bodies).toHaveLength(3);
    expect(view).toHaveBeenCalledTimes(2); expect(query).toHaveBeenCalledTimes(8);
  });
  it('preserves whitespace streaming deltas, keeps reasoning off visible events and reads DeepSeek cache counts', () => {
    const acc=new AgentProviderStreamAccumulator(request());
    const visible=[];
    for(const text of ['one',' ','two'])visible.push(...acc.consume({choices:[{delta:{content:text,reasoning_content:text}}]}));
    acc.consume({choices:[],usage:{prompt_tokens:100,prompt_cache_hit_tokens:64,completion_tokens:20}});
    const result=acc.complete();
    expect(result.text).toBe('one two');expect(result.continuation).toEqual({kind:'chat-reasoning',reasoningContent:'one two'});
    expect(visible.every(x=>x.type==='text_delta')).toBe(true);expect(result.usage.cachedInputTokens).toBe(64);
  });
  it('does not replay provider-private state into another channel and refuses missing required state locally',async()=>{
    const id=await saveProviderContinuation('original',{kind:'chat-reasoning',reasoningContent:'opaque'});
    expect(await readProviderContinuation({storyboardContinuationRef:id},'different')).toEqual({});
    await expect(readProviderContinuation({storyboardContinuationRef:crypto.randomUUID()},'original')).rejects.toThrow('续聊数据');
  });
  it.each(['anthropic-messages', 'google-gemini', 'openai-responses'] as const)('preserves %s native continuation fields without showing them in text', async protocol => {
    const req = { ...request(), model: { ...model, capabilities: { ...model.capabilities, protocol } } };
    const payload = protocol === 'anthropic-messages'
      ? { id: 'a', content: [{ type: 'thinking', thinking: 'private', signature: 'signature-value' }, { type: 'tool_use', id: 'tool1', name: 'inspect_scene', input: {} }] }
      : protocol === 'google-gemini'
        ? { responseId: 'g', candidates: [{ content: { role: 'model', parts: [{ text: 'private', thought: true }, { functionCall: { id: 'tool1', name: 'inspect_scene', args: {} }, thoughtSignature: 'signature-value' }] } }] }
        : { id: 'r', output: [{ id: 'reason1', type: 'reasoning', summary: [], encrypted_content: 'opaque-encrypted' }, { type: 'function_call', call_id: 'tool1', name: 'inspect_scene', arguments: '{}' }] };
    const parsed = parseAgentProviderResponse(req, payload);
    expect(parsed.text ?? '').not.toContain('private');
    const body = buildAgentProviderBody({ ...req, input: [{ type: 'function_call', callId: 'tool1', name: 'inspect_scene', arguments: '{}', responseGroup: 'one', continuation: parsed.continuation }, { type: 'function_call_result', callId: 'tool1', name: 'inspect_scene', output: '{}' }] }, false);
    expect(JSON.stringify(body)).toContain(protocol === 'openai-responses' ? 'opaque-encrypted' : 'signature-value');
  });
  it('rehydrates a continuation from local storage after module reload', async () => {
    const id = await saveProviderContinuation('persisted', { kind: 'chat-reasoning', reasoningContent: 'exact private state' });
    vi.resetModules();
    const reopened = await import('../application/agentProviderContinuation');
    expect(await reopened.readProviderContinuation({ storyboardContinuationRef: id, storyboardResponseGroup: 'g' }, 'persisted')).toMatchObject({ responseGroup: 'g', continuation: { reasoningContent: 'exact private state' } });
  });

  it('does not expose Responses private reasoning content in assistant text', () => {
    const req = { ...request(), model: { ...model, capabilities: { ...model.capabilities, protocol: 'openai-responses' as const } } };
    const response=parseAgentProviderResponse(req,{output:[{type:'reasoning',content:[{type:'reasoning_text',text:'SYNTHETIC_PRIVATE'}],summary:[]},{type:'message',content:[{type:'output_text',text:'public'}]}]});
    expect(response.text).toBe('public');
  });
  it('keeps whitespace-only tool argument fragments byte-for-byte',()=>{
    const acc=new AgentProviderStreamAccumulator(request());
    for(const fragment of ['{"text":"one',' ','two"}'])acc.consume({choices:[{delta:{tool_calls:[{index:0,id:'tool',function:{name:'',arguments:fragment}}]}}]});
    acc.consume({choices:[{delta:{tool_calls:[{index:0,function:{name:'inspect_scene'}}]},finish_reason:'tool_calls'}]});
    expect(acc.complete().toolCalls[0].arguments).toBe('{"text":"one two"}');
  });

});
