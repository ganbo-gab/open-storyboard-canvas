import { describe, expect, it, vi } from 'vitest';
import { renderPreview, renderRequest } from './template';
import type { ChannelProfileV2 } from './profile';
import type { JobInput } from '../runtime/types';
import { createChannelHttpStreamTransport, resolveChannelRef } from '../runtime/transport';
import { channelJobFromRequest } from '../runtime/channelExecution';

const profile = (): ChannelProfileV2 => ({ version: 2, id: 'safety', name: 'Safety', baseUrl: 'https://relay.example', auth: { type: 'none' },
  operations: { 'video.generate': { method: 'POST', path: '/videos', body: 'json', imageEncoding: 'url', template: { content: '{{seedanceContent}}' }, response: { mode: 'sync', outputs: [] } } },
  models: [{ id: 'video', label: 'Video', operations: ['video.generate'], params: [], mention: 'en-at', refs: { image: 1, video: 1, audio: 1 } }] });
const job = (): JobInput => ({ jobId: 'job', channelId: 'safety', modelId: 'video', operation: 'video.generate', prompt: 'move', params: {}, refs: [], count: 1 });

describe('shared channel execution safety', () => {
  it('preserves HTTP status and verbatim redacted error text for streaming chat', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('provider says: invalid key private-stream-key', { status: 403 })));
    try {
      const stream = createChannelHttpStreamTransport()({ method: 'POST', url: 'https://relay.example/chat', headers: { 'x-custom-key': 'private-stream-key' }, body: { mode: 'json', json: {} } });
      await expect(stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({ status: 403, upstreamMessage: 'provider says: invalid key [redacted]',
        message: expect.stringContaining('provider says: invalid key [redacted]') });
    } finally { vi.unstubAllGlobals(); }
  });
  it.each(['', '   \n'])('rejects empty content-array prompt before reference resolution or submit (%j)', async (prompt) => {
    const resolve = vi.fn().mockResolvedValue('https://cdn.example/image.png');
    const input = { ...job(), prompt, refs: [{ kind: 'image' as const, assetId: 'image', path: '/local.png', mime: 'image/png' }] };
    await expect(renderRequest(profile(), input, '', resolve)).rejects.toMatchObject({ path: 'prompt' });
    expect(resolve).not.toHaveBeenCalled();
  });
  it.each([
    ['zh-at', '@图1 @视频1 @音频1'],
    ['en-at', '@image1 @video1 @audio1'],
    ['zh-bare', '图1 视频1 音频1'],
  ] as const)('compiles all content projections with %s mention dialect without changing prose', (mention, tokens) => {
    const config = profile(); config.models[0].mention = mention;
    const preview = renderPreview(config, { ...job(), prompt: 'Use @图1 视频1 @audio1; email a@image2.com stays.' });
    expect(preview.body).toEqual({ mode: 'json', json: { content: [{ type: 'text', text: `Use ${tokens}; email a@image2.com stays.` }] } });
  });
  it('keeps natural mention prompts unmodified', () => {
    const config = profile(); config.models[0].mention = 'natural';
    expect(renderPreview(config, { ...job(), prompt: '@图1 follows 视频1' }).body).toEqual({ mode: 'json', json: { content: [{ type: 'text', text: '@图1 follows 视频1' }] } });
  });
  it('raises a typed public URL preflight error carrying the slot before submit', async () => {
    await expect(resolveChannelRef({ kind: 'image', slot: 'first_frame', assetId: 'image', path: 'data:image/png;base64,AA==', mime: 'image/png' }, 'url'))
      .rejects.toMatchObject({ name: 'ReferenceNeedsPublicUrlError', code: 'reference.needsPublicUrl', slotKey: 'first_frame' });
  });
  it('maps requested native count exactly once instead of retaining a conflicting default', () => {
    const config = profile(); config.models[0].params = [{ key: 'n', label: 'Count', type: 'number', min: 1, max: 10, default: 2 }];
    const input = channelJobFromRequest(config, 'video', { model: 'video', prompt: 'move', size: '', aspect_ratio: '', count: 3, extra_params: { n: 2 } }, 'video');
    expect(input).toMatchObject({ count: 3, params: { n: 3 } });
  });
});
