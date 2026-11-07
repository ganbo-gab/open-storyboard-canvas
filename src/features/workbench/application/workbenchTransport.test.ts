import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ chat: vi.fn(), portable: vi.fn(), image: vi.fn(), video: vi.fn() }));
vi.mock('@/features/channels/runtime/channelChat', () => ({ submitCustomChatCompletion: mocks.chat }));
vi.mock('@/features/assets/application/assetMediaStorage', () => ({ getAssetPortableSource: mocks.portable }));
vi.mock('@/features/canvas/infrastructure/tauriAiGateway', () => ({ tauriAiGateway: { submitGenerateImageJob: mocks.image, submitGenerateVideoJob: mocks.video } }));
vi.mock('@/features/canvas/infrastructure/providerGateway', () => ({ recoverCustomProviderJob: vi.fn() }));
import { workbenchTransport } from './workbenchTransport';
import { useChannelStore } from '@/features/channels/store/channelStore';
import { miniMaxVideoProfile } from '@/features/channels/presets/videoModels';
import type { ChannelProfileV2 } from '@/features/channels/domain/profile';
import type * as ChannelExecution from '@/features/channels/runtime/channelExecution';

vi.mock('@/features/channels/runtime/channelExecution', async (importOriginal) => ({
  ...await importOriginal<typeof ChannelExecution>(),
  submitChannelJob: vi.fn(async () => 'custom-local-channel-job-audio'),
}));
import { submitChannelJob } from '@/features/channels/runtime/channelExecution';

beforeEach(() => {
  vi.resetAllMocks(); mocks.portable.mockImplementation(async (source: string) => source);
  useChannelStore.setState({ channels: [] });
  mocks.chat.mockResolvedValue({ text: 'Channel answer', raw: {} });
});
it.each(['image', 'video'] as const)('forwards %s mode selection and ordered portable slot sources', async (kind) => {
  mocks.portable.mockImplementation(async (source: string) => source === 'asset-media:image' ? 'data:image/png;base64,FRAME' : source);
  const submit = kind === 'image' ? mocks.image : mocks.video;
  submit.mockResolvedValue('job');
  expect(await workbenchTransport.submit({ kind, model: 'custom:channel:model', prompt: 'Frames',
    channelModeId: 'frames', referenceSlots: { first_frame: ['asset-media:image'], last_frame: ['/last.png'] },
    config: { extraParams: { strength: 0.5 } } }, [])).toEqual({ jobId: 'job' });
  expect(submit).toHaveBeenCalledOnce();
  expect(submit).toHaveBeenCalledWith(expect.objectContaining({ channelModeId: 'frames',
    referenceSlots: { first_frame: ['data:image/png;base64,FRAME'], last_frame: ['/last.png'] }, extraParams: { strength: 0.5 } }));
});
it('sends the selected native mode defaults without legacy video size or ratio hints', async () => {
  useChannelStore.setState({ channels: [{ origin: 'native', profile: miniMaxVideoProfile, migrationIssues: [], createdAt: 1, updatedAt: 1 }] });
  mocks.video.mockResolvedValue('job');
  await workbenchTransport.submit({ kind: 'video', model: 'custom:minimax-video:MiniMax-H3', prompt: 'A crane',
    channelModeId: 'text-to-video', config: {} }, []);
  expect(mocks.video).toHaveBeenCalledWith(expect.objectContaining({
    size: '', aspectRatio: '', extraParams: expect.objectContaining({ resolution: '768P', duration: 5, ratio: '16:9' }),
  }));
});
it('routes a v2 audio mode and typed defaults through the shared channel executor', async () => {
  const profile: ChannelProfileV2 = { version: 2, id: 'voice', name: 'Voice', baseUrl: 'https://voice.test', auth: { type: 'none' },
    operations: { 'audio.generate': { method: 'POST', path: '/audio', body: 'json', template: { text: '{{prompt}}', voice: '{{param.voice}}' },
      response: { mode: 'sync', outputs: [{ path: 'url', as: 'url', kind: 'audio' }] } } },
    models: [{ id: 'speaker', operations: [], params: [{ key: 'voice', label: 'Voice', type: 'text', default: 'calm' }],
      modes: [{ id: 'speech', label: 'Speech', operation: 'audio.generate', slots: [] }] }] };
  useChannelStore.setState({ channels: [{ origin: 'native', profile, migrationIssues: [], createdAt: 1, updatedAt: 1 }] });
  expect(await workbenchTransport.submit({ kind: 'audio', model: 'custom:voice:speaker', prompt: 'Hello', channelModeId: 'speech' }, []))
    .toEqual({ jobId: 'custom-local-channel-job-audio' });
  expect(submitChannelJob).toHaveBeenCalledWith(profile, expect.objectContaining({ operation: 'audio.generate', modeId: 'speech', params: { voice: 'calm' } }));
});
it('forwards the selected native chat mode with its own defaults', async () => {
  const profile: ChannelProfileV2 = { version: 2, id: 'chat-modes', name: 'Chat', baseUrl: 'https://chat.test', auth: { type: 'none' },
    operations: { chat: { method: 'POST', path: '/chat', body: 'json', template: { messages: '{{chatPayload.messages}}', temperature: '{{param.temperature}}' },
      response: { mode: 'sync', outputs: [] } } },
    models: [{ id: 'assistant', operations: [], params: [], modes: [
      { id: 'precise', label: 'Precise', operation: 'chat', params: [{ key: 'temperature', label: 'Temperature', type: 'number', default: 0 }] },
      { id: 'creative', label: 'Creative', operation: 'chat', params: [{ key: 'temperature', label: 'Temperature', type: 'number', default: 1 }] },
    ] }] };
  useChannelStore.setState({ channels: [{ origin: 'native', profile, migrationIssues: [], createdAt: 1, updatedAt: 1 }] });
  await workbenchTransport.submit({ kind: 'chat', model: 'custom:chat-modes:assistant', prompt: 'Hello', channelModeId: 'creative' }, []);
  expect(mocks.chat).toHaveBeenCalledWith('custom:chat-modes:assistant', expect.objectContaining({ channel_mode_id: 'creative', temperature: 1 }));
});
describe('workbench channel chat transport', () => {
  it('sends full history, portable image refs, text refs and configured fields through channel chat', async () => {
    mocks.portable.mockImplementation(async (source: string) => source === 'asset-media:image' ? 'data:image/png;base64,aW1n' : source);
    const result = await workbenchTransport.submit({ kind: 'chat', model: 'custom:channel-chat:model', prompt: 'Continue',
      config: { extraParams: { temperature: 0, max_tokens: 456 } },
      references: [{ id: 'image', kind: 'image', source: 'asset-media:image' }, { id: 'notes', kind: 'text', source: 'Reference notes' }] },
    [{ id: 'old', conversationId: 'conversation', role: 'assistant', text: 'Previous answer', taskId: 'old-task', createdAt: 1 }]);
    expect(mocks.chat).toHaveBeenCalledOnce();
    expect(mocks.chat).toHaveBeenCalledWith('custom:channel-chat:model', { temperature: 0, max_tokens: 456, model: 'custom:channel-chat:model', messages: [
      { role: 'assistant', content: 'Previous answer' }, { role: 'user', content: [{ type: 'text', text: 'Continue' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1n' } }, { type: 'text', text: 'Reference notes' }] },
    ] });
    expect(result).toEqual({ results: [{ kind: 'text', source: 'Channel answer' }] });
  });
  it('propagates unknown submission failures without retrying', async () => {
    mocks.chat.mockRejectedValue(new Error('upstream acceptance unknown'));
    await expect(workbenchTransport.submit({ kind: 'chat', model: 'custom:channel-chat:model', prompt: 'Go' }, [])).rejects.toThrow(/unknown/);
    expect(mocks.chat).toHaveBeenCalledOnce();
  });
  it('rejects unsupported media without sending a partial request', async () => {
    await expect(workbenchTransport.submit({ kind: 'chat', model: 'custom:channel-chat:model', prompt: 'Go',
      references: [{ id: 'video', kind: 'video', source: 'https://media.test/video.mp4' }] }, [])).rejects.toThrow(/视频或音频/);
    expect(mocks.chat).not.toHaveBeenCalled();
  });
});

it.each(['local-doubao-tts', 'voxcpm-online'])('refuses the retired audio model %s without contacting a substitute', async (model) => {
  await expect(workbenchTransport.submit({ kind: 'audio', prompt: 'Preserve old input', model }, [])).rejects.toThrow();
  expect(submitChannelJob).not.toHaveBeenCalled();
  expect(mocks.image).not.toHaveBeenCalled(); expect(mocks.video).not.toHaveBeenCalled();
});
