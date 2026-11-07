import { beforeEach, describe, expect, it, vi } from 'vitest';
const bridge = vi.hoisted(() => ({ native: false, http: vi.fn(), stream: vi.fn(), fetch: vi.fn() }));
vi.mock('@tauri-apps/api/core', async (original) => ({ ...await original<typeof import('@tauri-apps/api/core')>(), isTauri: () => bridge.native }));
vi.mock('@/commands/ai', async (original) => ({ ...await original<typeof import('@/commands/ai')>(), customHttpRequest: bridge.http, customHttpStreamRequest: bridge.stream }));
import { channelChatInput, resolveNativeChannelModel, submitChannelChat } from '../application/channelService';
import { channelProviderId, setChannelCredential, useChannelStore } from '../store/channelStore';
import { openAIStandardProfile } from '../presets/openai';
import { buildCustomChatCompletionRequestDebugPreview, streamCustomChatCompletion, submitCustomChatCompletion } from './channelChat';
import { adaptChannelChatPayload } from './channelChatPayload';
import { renderRequest } from '../domain/template';
import type { ChannelProfileV2 } from '../domain/profile';
import { useMemorySecretVault } from '@/features/secrets/testSupport';
import { credentialFailureOf } from '@/features/secrets/credentialFailure';

useMemorySecretVault();

const id = `custom:${channelProviderId('chat-channel', 'chat')}:chat-model`;
function profile(): ChannelProfileV2 {
  return { ...openAIStandardProfile, id: 'chat-channel', baseUrl: 'https://relay.test',
    models: [{ ...openAIStandardProfile.models.find((model) => model.operations.includes('chat'))!, id: 'chat-model' }] };
}
async function install(value = profile()) {
  useChannelStore.setState({ channels: [{ profile: value, origin: 'native', migrationIssues: [], createdAt: 1, updatedAt: 1 }] });
  await setChannelCredential(value.id, 'private-channel-key');
}
beforeEach(async () => {
  vi.clearAllMocks(); bridge.http.mockReset(); bridge.stream.mockReset(); bridge.fetch.mockReset();
  bridge.native = false; vi.stubGlobal('fetch', bridge.fetch); await install();
});
describe('v2 rendered chat runtime', () => {
  it('preserves native streaming vault denials as credential failures without starting a replacement request', async () => {
    bridge.native = true;
    bridge.stream.mockRejectedValueOnce('{"state":"locked","code":"storage_locked"}');
    const error = await streamCustomChatCompletion(id, { messages: [{ role: 'user', content: 'Go' }] }).catch((cause: unknown) => cause);
    expect(credentialFailureOf(error)).toEqual({ state: 'locked', code: 'storage_locked' });
    expect(bridge.stream).toHaveBeenCalledOnce(); expect(bridge.http).not.toHaveBeenCalled(); expect(bridge.fetch).not.toHaveBeenCalled();
  });
  it('retains and redacts verbatim SSE failure payloads instead of discarding provider reasons', async () => {
    const raw = '{"error":{"message":"provider moderation reason private-channel-key"}}';
    bridge.fetch.mockResolvedValue(new Response(`data: ${raw}\n\n`, { status: 200 }));
    await expect(streamCustomChatCompletion(id, { messages: [{ role: 'user', content: 'Go' }] })).rejects.toMatchObject({
      status: 200, upstreamMessage: raw.replace('private-channel-key', '[redacted]'),
      message: expect.stringContaining('provider moderation reason [redacted]'),
      rawStreamTail: expect.not.stringContaining('private-channel-key'),
    });
    expect(bridge.fetch).toHaveBeenCalledOnce();
  });
  it('uses a selected mode-only chat endpoint and protocol without leaking the mode selector into its body', async () => {
    const config = profile(); const original = config.operations.chat!;
    config.operations = {}; config.models[0].operations = [];
    config.models[0].modes = [{ id: 'first', label: 'First', operation: 'chat', endpoint: { ...original, path: '/first' } },
      { id: 'selected', label: 'Selected', operation: 'chat', endpoint: { ...original, path: '/selected' } }];
    await install(config); bridge.fetch.mockResolvedValue(new Response('{"choices":[{"message":{"content":"selected mode"}}]}', { status: 200 }));
    expect(await submitCustomChatCompletion(id, { channel_mode_id: 'selected', messages: [{ role: 'user', content: 'Hello' }] })).toMatchObject({ text: 'selected mode' });
    expect(bridge.fetch.mock.calls[0][0]).toBe('https://relay.test/selected');
    expect(JSON.parse(bridge.fetch.mock.calls[0][1].body)).not.toHaveProperty('channel_mode_id');
  });
  it('resolves projections and old model IDs directly from channel state', () => {
    expect(resolveNativeChannelModel(id)?.model.id).toBe('chat-model');
    expect(resolveNativeChannelModel('custom:chat-channel:chat-model')?.profile.id).toBe('chat-channel');
    expect(resolveNativeChannelModel('custom:missing:chat-model')).toBeNull();
  });
  it('uses the same template for preview and actual one-shot send and retains tool-only raw replies', async () => {
    const payload = { messages: [{ role: 'user', content: 'Plan it' }], temperature: 0 };
    const raw = { choices: [{ message: { content: null, tool_calls: [{ id: 'call', type: 'function', function: { name: 'inspect', arguments: '{}' } }] } }] };
    bridge.fetch.mockResolvedValue(new Response(JSON.stringify(raw), { status: 200 }));
    const preview = buildCustomChatCompletionRequestDebugPreview(id, payload);
    const response = await submitCustomChatCompletion(id, payload);
    expect(response.raw).toEqual(raw); expect(response.text).toBe(''); expect(bridge.fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(bridge.fetch.mock.calls[0][1].body)).toEqual(preview.body);
    expect(preview.headers.Authorization).not.toContain('private-channel-key');
    expect(bridge.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer private-channel-key');
  });
  it('delivers real incremental browser chunks before completion without a second submit', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    bridge.fetch.mockResolvedValue(new Response(body, { status: 200 }));
    const deltas: string[] = []; let first!: () => void;
    const received = new Promise<void>((resolve) => { first = resolve; });
    const pending = streamCustomChatCompletion(id, { messages: [{ role: 'user', content: 'Hello' }] }, {
      onTextDelta(delta) { deltas.push(delta); first(); },
    });
    controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n'));
    await received;
    expect(deltas).toEqual(['Hel']);
    controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}],"usage":{"total_tokens":5}}\n\ndata: [DONE]\n\n'));
    controller.close();
    const result = await pending;
    expect(result).toMatchObject({ text: 'Hello', finishReason: 'stop', usage: { total_tokens: 5 } });
    expect(deltas).toEqual(['Hel', 'lo']); expect(bridge.fetch).toHaveBeenCalledOnce();
    const preview = buildCustomChatCompletionRequestDebugPreview(id, { messages: [{ role: 'user', content: 'Hello' }] }, true);
    expect(JSON.parse(bridge.fetch.mock.calls[0][1].body)).toEqual(preview.body);
  });
  it('uses the native streaming bridge with the rendered request and callback deltas', async () => {
    bridge.native = true;
    bridge.stream.mockImplementation(async (_request, handlers) => {
      handlers.onStatus(200); handlers.onChunk('data: {"choices":[{"delta":{"content":"Native"}}]}\n\n', 200);
      return { status: 200, text: 'data: [DONE]\n', byteLength: 1, chunkCount: 1 };
    });
    const delta = vi.fn(); const result = await streamCustomChatCompletion(id, { messages: [{ role: 'user', content: 'Go' }] }, { onTextDelta: delta });
    expect(result.text).toBe('Native'); expect(delta).toHaveBeenCalledWith('Native', 'Native');
    expect(bridge.stream).toHaveBeenCalledOnce(); expect(bridge.http).not.toHaveBeenCalled();
    expect(bridge.stream.mock.calls[0][0].body.stream).toBe(true);
  });
  it('does not retry ambiguous stream failures or silently drop undeclared request fields', async () => {
    bridge.fetch.mockRejectedValue(new Error('network disconnected'));
    await expect(streamCustomChatCompletion(id, { messages: [{ role: 'user', content: 'Go' }] })).rejects.toThrow(/network disconnected/);
    expect(bridge.fetch).toHaveBeenCalledOnce(); expect(bridge.http).not.toHaveBeenCalled();
    expect(() => channelChatInput(profile(), 'chat-model', { messages: [{ role: 'user', content: 'Go' }], invented: true })).toThrow(/invented/);
    expect(bridge.fetch).toHaveBeenCalledOnce();
  });
  it.each<{ name: string; template: Record<string, string>; raw: unknown; payload: unknown }>([
    { name: 'anthropic', template: { system: '{{chatPayload.system}}', messages: '{{messages}}', tools: '{{chatPayload.tools}}' }, raw: { content: [{ type: 'tool_use', id: 'call', name: 'inspect', input: {} }] }, payload: { messages: [{ role: 'user', content: 'Hi' }] } },
    { name: 'responses', template: { input: '{{chatPayload.input}}', tools: '{{chatPayload.tools}}' }, raw: { output: [{ type: 'function_call', call_id: 'call', name: 'inspect', arguments: '{}' }] }, payload: { input: [{ role: 'user', content: 'Hi' }] } },
    { name: 'gemini', template: { contents: '{{chatPayload.contents}}', tools: '{{chatPayload.tools}}' }, raw: { candidates: [{ content: { parts: [{ functionCall: { name: 'inspect', args: {} } }] } }] }, payload: { contents: [{ role: 'user', parts: [{ text: 'Hi' }] }] } },
  ])('retains native $name tool-only raw responses through the template adapter', async ({ template, raw, payload }) => {
    const channel = profile(); channel.operations = { chat: { method: 'POST', path: '/chat', body: 'json', template, response: { mode: 'sync', outputs: [] } } };
    bridge.fetch.mockResolvedValue(new Response(JSON.stringify(raw), { status: 200 }));
    const response = await submitChannelChat(channel, 'chat-model', payload);
    expect(response.raw).toEqual(raw); expect(response.text).toBe('');
  });
  it('preserves structured messages and every native payload field selected by templates', async () => {
    const value = profile();
    value.operations.chat!.template = { model: '{{model}}', messages: '{{messages}}', system: '{{chatPayload.system}}', stream: '{{param.stream}}' };
    const payload = { messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'inspect', input: {} }] }], system: [{ type: 'text', text: 'System' }] };
    const rendered = await renderRequest(value, channelChatInput(value, 'chat-model', payload), 'secret', async (ref) => ref.path);
    expect(rendered.request.body).toMatchObject({ mode: 'json', json: payload });
  });
  it('explicit protocol adapters retain system, image, history and caller settings rather than flattening', () => {
    const value = { ...profile(), operations: { chat: { ...profile().operations.chat!, template: { contents: '{{chatPayload.contents}}' } } } };
    const payload = adaptChannelChatPayload(value, { messages: [
      { role: 'system', content: 'Rules' }, { role: 'user', content: [{ type: 'text', text: 'Look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1n' } }] },
      { role: 'assistant', content: 'Earlier' }, { role: 'user', content: 'Continue' },
    ], temperature: 0, max_tokens: 123 });
    expect(payload).toMatchObject({ systemInstruction: { parts: [{ text: 'Rules' }] }, generationConfig: { temperature: 0, maxOutputTokens: 123 },
      contents: [{ role: 'user', parts: [{ text: 'Look' }, { inlineData: { mimeType: 'image/png', data: 'aW1n' } }] }, { role: 'model', parts: [{ text: 'Earlier' }] }, { role: 'user', parts: [{ text: 'Continue' }] }] });
    expect(() => adaptChannelChatPayload(value, { messages: [{ role: 'user', name: 'must-not-drop', content: 'Hi' }] })).toThrow(/name/);
  });
  it('renders Gemini streaming action and alt in both preview and send without an invented stream body field', async () => {
    const value = profile(); value.operations.chat = { method: 'POST', path: '/models/{{model}}:{{chatPayload.action}}?alt={{chatPayload.alt}}', body: 'json',
      template: { contents: '{{chatPayload.contents}}' }, response: { mode: 'sync', outputs: [] } };
    await install(value);
    bridge.fetch.mockResolvedValue(new Response('data: {"candidates":[{"content":{"parts":[{"text":"Gemini"}]}}]}\n\n', { status: 200 }));
    const payload = { messages: [{ role: 'user', content: 'Hi' }] };
    const preview = buildCustomChatCompletionRequestDebugPreview(id, payload, true);
    const response = await streamCustomChatCompletion(id, payload);
    expect(response.text).toBe('Gemini'); expect(preview.url).toContain(':streamGenerateContent?alt=sse');
    expect(bridge.fetch.mock.calls[0][0]).toBe(preview.url);
    expect(JSON.parse(bridge.fetch.mock.calls[0][1].body)).toEqual(preview.body);
    expect(preview.body).not.toHaveProperty('stream');
  });
});
