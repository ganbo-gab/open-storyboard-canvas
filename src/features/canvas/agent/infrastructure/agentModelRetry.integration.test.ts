import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent, tool } from '@openai/agents';
import { z } from 'zod';
import { createStoryboardAgentRuntime } from './sdkRuntime';
import { createAgentModelTransport } from './agentModelGateway';
import { ChannelChatTransportError } from '@/features/channels/runtime/transport';
import { parseChannelRetryAfter } from '@/features/channels/runtime/transport';
import type { ChannelProfileV2 } from '@/features/channels/domain/profile';
import type { AgentModelReference } from '../domain/agentModel';
import { consumeAgentRunStream } from '../application/agentRunStreamReader';
const channel = vi.hoisted(() => ({ resolve: vi.fn(), submit: vi.fn(), stream: vi.fn() }));
vi.mock('@/features/channels/application/channelService', () => ({ resolveNativeChannelModel: channel.resolve,
  submitChannelChat: channel.submit, streamChannelChat: channel.stream }));
const reference: AgentModelReference = { catalogId: 'chat', providerId: 'retry', modelId: 'test', label: 'test', usable: true,
  capabilities: { protocol: 'openai-chat-completions', tools: true, stream: true, vision: false, toolSearch: false, reasoningSummary: false } };
const profile: ChannelProfileV2 = { version: 2, id: 'retry', name: 'Retry', baseUrl: 'https://fixture.invalid', auth: { type: 'none' },
  models: [{ id: 'test', operations: ['chat'], params: [] }], operations: { chat: { method: 'POST', path: '/chat', body: 'json',
    template: { messages: '{{messages}}' }, response: { mode: 'sync', outputs: [] } } } };
const event = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`;
const final = event({ content: 'Finished' }, 'stop') + 'data: [DONE]\n\n';
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); channel.resolve.mockReturnValue({ profile, model: profile.models[0] }); });
afterEach(() => vi.useRealTimers());
function setup(execute = vi.fn(async () => 'Created once')) {
  const notice = vi.fn();
  const runtime = createStoryboardAgentRuntime({ resolveModel: () => reference, transport: createAgentModelTransport(), onRetry: notice });
  const agent = new Agent({ name: 'Retry fixture', model: runtime.modelProvider.getModel(), tools: [tool({ name: 'stage_command', description: 'Create stage object', parameters: z.object({}), execute })] });
  const work = async (signal?: AbortSignal) => { const result = await runtime.runner.run(agent, 'Create one object', { stream: true, signal });
    await consumeAgentRunStream(result, () => {}); return result; };
  return { work, execute, notice };
}
describe('real SDK bounded model retry', () => {
  it('honors provider Retry-After before making the next request', async () => {
    let requests = 0;
    channel.stream.mockImplementation(async function* () {
      if (++requests === 1) throw new ChannelChatTransportError('busy', 503, false, undefined, 4000);
      yield final;
    });
    const pending = setup().work();
    await vi.advanceTimersByTimeAsync(3999); expect(requests).toBe(1);
    await vi.advanceTimersByTimeAsync(1); expect((await pending).finalOutput).toBe('Finished');
    expect(parseChannelRetryAfter('4')).toBe(4000);
    expect(parseChannelRetryAfter('Thu, 01 Jan 1970 00:00:05 GMT', 1000)).toBe(4000);
    expect(parseChannelRetryAfter('-1')).toBeUndefined();
    expect(parseChannelRetryAfter('broken')).toBeUndefined();
  });
  it('retries a temporary failed model continuation without executing its preceding tool twice', async () => {
    let requests = 0;
    channel.stream.mockImplementation(async function* () {
      requests += 1;
      if (requests === 1) { yield event({ tool_calls: [{ index: 0, id: 'create-once', type: 'function', function: { name: 'stage_command', arguments: '{}' } }] }, 'tool_calls'); yield 'data: [DONE]\n\n'; }
      else if (requests === 2) throw new ChannelChatTransportError('temporarily unavailable', 503);
      else yield final;
    });
    const h = setup(); const pending = h.work();
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;
    expect(result.finalOutput).toBe('Finished'); expect(requests).toBe(3); expect(h.execute).toHaveBeenCalledOnce();
    expect(h.notice).toHaveBeenCalledWith({ attempt: 1, maxRetries: 3, status: 503 });
  });
  it('stops after three retries and never executes tools from failed model responses', async () => {
    channel.stream.mockImplementation(async function* () { throw new ChannelChatTransportError('rate limited', 429); });
    const h = setup(); const rejected = expect(h.work()).rejects.toThrow('rate limited');
    await vi.advanceTimersByTimeAsync(30_000); await rejected;
    expect(channel.stream).toHaveBeenCalledTimes(4); expect(h.execute).not.toHaveBeenCalled(); expect(h.notice).toHaveBeenCalledTimes(3);
  });
  it.each([400, 401, 402, 403])('does not retry an HTTP %s rejection', async status => {
    channel.stream.mockImplementation(async function* () { throw new ChannelChatTransportError('rejected', status); });
    const h = setup(); await expect(h.work()).rejects.toThrow('rejected'); expect(channel.stream).toHaveBeenCalledOnce();
    expect(h.notice).not.toHaveBeenCalled();
  });
  it.each(['insufficient_quota', 'organization_spend_limit_exceeded', '余额不足'])('does not retry billing failures: %s', async message => {
    channel.stream.mockImplementation(async function* () { throw new ChannelChatTransportError(message, 429); });
    await expect(setup().work()).rejects.toThrow(message); expect(channel.stream).toHaveBeenCalledOnce();
  });
  it('does not replay a partial reply or an ambiguous network failure', async () => {
    channel.stream.mockImplementation(async function* () { yield event({ content: 'Partial' }); throw new ChannelChatTransportError('closed', 503, true); });
    await expect(setup().work()).rejects.toThrow('closed'); expect(channel.stream).toHaveBeenCalledOnce();
    channel.stream.mockClear().mockImplementation(async function* () { throw new Error('unknown acceptance'); });
    await expect(setup().work()).rejects.toThrow('unknown acceptance'); expect(channel.stream).toHaveBeenCalledOnce();
  });
  it('honors user cancellation during backoff without sending another request', async () => {
    channel.stream.mockImplementation(async function* () { throw new ChannelChatTransportError('busy', 503); });
    const h = setup(), controller = new AbortController(); const pending = h.work(controller.signal);
    await vi.advanceTimersByTimeAsync(0); controller.abort();
    expect((await pending).cancelled).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000); expect(channel.stream).toHaveBeenCalledOnce();
  });
});
