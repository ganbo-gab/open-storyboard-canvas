import { describe, expect, it, vi } from 'vitest';
import { channelProfileSchema, validateProfile, type ChannelProfileV2, type OperationKind } from '../domain/profile';
import { renderRequest } from '../domain/template';
import type { JobInput, JobRef, JsonValue, RequestPreview } from '../runtime/types';
import {
  anthropicProfile, builtInPresets, falProfile, geminiNativeProfile, genericAsyncProfile,
  grsaiProfile, openAICompatibleProfile, openAIStandardProfile, ppioProfile,
} from './index';

const image: JobRef = {
  kind: 'image', assetId: 'image-asset', path: '/fixtures/reference.png',
  mime: 'image/png', width: 1024, height: 1024,
};
const prompt = 'A lighthouse at sunrise';
const summary = '<image 1: 1024×1024 png>';

function job(profile: ChannelProfileV2, modelId: string, operation: OperationKind,
  params: Record<string, JsonValue> = {}, refs: JobRef[] = []): JobInput {
  return { jobId: 'preview-job', channelId: profile.id, modelId, operation, prompt, params, refs, count: 1 };
}

interface PreviewCase {
  name: string;
  profile: ChannelProfileV2;
  job: JobInput;
  expected: RequestPreview;
}

// Fixed wire expectations, deliberately independent of the preset templates/defaults.
const cases: PreviewCase[] = [
  {
    name: 'OpenAI standard image generation', profile: openAIStandardProfile,
    job: job(openAIStandardProfile, 'gpt-image-1', 'image.generate'),
    expected: {
      method: 'POST', url: 'https://api.openai.com/v1/images/generations',
      headers: { Authorization: 'Bearer ***', 'Content-Type': 'application/json' },
      body: { mode: 'json', json: { model: 'gpt-image-1', prompt, n: 1, size: '1024x1024' } },
    },
  },
  {
    name: 'OpenAI chat', profile: openAIStandardProfile,
    job: job(openAIStandardProfile, 'gpt-4o-mini', 'chat', { temperature: 0.3, max_tokens: 500 }),
    expected: {
      method: 'POST', url: 'https://api.openai.com/v1/chat/completions',
      headers: { Authorization: 'Bearer ***', 'Content-Type': 'application/json' },
      body: { mode: 'json', json: {
        model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: 500,
      } },
    },
  },
  {
    name: 'OpenAI multipart image[] edits', profile: openAIStandardProfile,
    job: job(openAIStandardProfile, 'gpt-image-1', 'image.edit', { n: 2, size: '1536x1024' }, [image]),
    expected: {
      method: 'POST', url: 'https://api.openai.com/v1/images/edits',
      headers: { Authorization: 'Bearer ***' },
      body: { mode: 'multipart', fields: [
        { name: 'model', value: 'gpt-image-1' }, { name: 'prompt', value: prompt },
        { name: 'n', value: '2' }, { name: 'size', value: '1536x1024' },
        { name: 'image[]', value: summary },
      ] },
    },
  },
  {
    name: 'OpenAI models list', profile: openAIStandardProfile,
    job: job(openAIStandardProfile, '', 'models.list'),
    expected: {
      method: 'GET', url: 'https://api.openai.com/v1/models',
      headers: { Authorization: 'Bearer ***' }, body: { mode: 'none' },
    },
  },
  {
    name: 'OpenAI compatible relay async video', profile: openAICompatibleProfile,
    job: job(openAICompatibleProfile, 'sora-2', 'video.generate'),
    expected: {
      method: 'POST', url: 'https://relay.example.invalid/v1/videos',
      headers: { Authorization: 'Bearer ***', 'Content-Type': 'application/json' },
      body: { mode: 'json', json: { model: 'sora-2', prompt, seconds: '4', size: '1280x720' } },
    },
  },
  {
    name: 'Gemini native imageConfig and verbatim 2K', profile: geminiNativeProfile,
    job: job(geminiNativeProfile, 'gemini-3.1-flash-image', 'image.generate', { aspectRatio: '16:9', imageSize: '2K' }),
    expected: {
      method: 'POST', url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent',
      headers: { 'x-goog-api-key': '***', 'Content-Type': 'application/json' },
      body: { mode: 'json', json: {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '16:9', imageSize: '2K' } },
      } },
    },
  },
  {
    name: 'Gemini native single-turn chat', profile: geminiNativeProfile,
    job: job(geminiNativeProfile, 'gemini-2.5-flash', 'chat'),
    expected: {
      method: 'POST', url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
      headers: { 'x-goog-api-key': '***', 'Content-Type': 'application/json' },
      body: { mode: 'json', json: { contents: [{ role: 'user', parts: [{ text: prompt }] }] } },
    },
  },
  {
    name: 'Anthropic messages', profile: anthropicProfile,
    job: job(anthropicProfile, 'claude-sonnet-4-5', 'chat'),
    expected: {
      method: 'POST', url: 'https://api.anthropic.com/v1/messages',
      headers: { 'anthropic-version': '2023-06-01', 'x-api-key': '***', 'Content-Type': 'application/json' },
      body: { mode: 'json', json: {
        model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: prompt }], max_tokens: 4096,
      } },
    },
  },
  {
    name: 'Generic async skeleton', profile: genericAsyncProfile,
    job: job(genericAsyncProfile, 'replace-with-upstream-model', 'video.generate'),
    expected: {
      method: 'POST', url: 'https://api.example.invalid/tasks',
      headers: { Authorization: 'Bearer ***', 'Content-Type': 'application/json' },
      body: { mode: 'json', json: { model: 'replace-with-upstream-model', prompt } },
    },
  },
  {
    name: 'PPIO generation', profile: ppioProfile,
    job: job(ppioProfile, 'gemini-3.1-flash', 'image.generate'),
    expected: {
      method: 'POST', url: 'https://api.ppio.com/v3/gemini-3.1-flash-image-text-to-image',
      headers: { Authorization: 'Bearer ***', 'Content-Type': 'application/json' },
      body: { mode: 'json', json: { prompt, size: '2K', aspect_ratio: '1:1', output_format: 'image/png' } },
    },
  },
  {
    name: 'PPIO base64 edit', profile: ppioProfile,
    job: job(ppioProfile, 'gemini-3.1-flash', 'image.edit', {}, [image]),
    expected: {
      method: 'POST', url: 'https://api.ppio.com/v3/gemini-3.1-flash-image-edit',
      headers: { Authorization: 'Bearer ***', 'Content-Type': 'application/json' },
      body: { mode: 'json', json: {
        prompt, size: '2K', aspect_ratio: '1:1', image_base64s: [summary], output_format: 'image/png',
      } },
    },
  },
  {
    name: 'GRSAI generation', profile: grsaiProfile,
    job: job(grsaiProfile, 'nano-banana-2', 'image.generate'),
    expected: {
      method: 'POST', url: 'https://grsai.dakka.com.cn/v1/draw/nano-banana',
      headers: { Authorization: 'Bearer ***', 'Content-Type': 'application/json' },
      body: { mode: 'json', json: {
        model: 'nano-banana-2', prompt, aspectRatio: '1:1', imageSize: '1K', webHook: '-1', shutProgress: true,
      } },
    },
  },
  {
    name: 'GRSAI edit', profile: grsaiProfile,
    job: job(grsaiProfile, 'nano-banana-pro-4k-vip', 'image.edit', {}, [image]),
    expected: {
      method: 'POST', url: 'https://grsai.dakka.com.cn/v1/draw/nano-banana',
      headers: { Authorization: 'Bearer ***', 'Content-Type': 'application/json' },
      body: { mode: 'json', json: {
        model: 'nano-banana-pro-4k-vip', prompt, aspectRatio: '1:1', imageSize: '4K',
        urls: [summary], webHook: '-1', shutProgress: true,
      } },
    },
  },
  {
    name: 'Fal generation', profile: falProfile,
    job: job(falProfile, 'fal-ai/nano-banana-2', 'image.generate'),
    expected: {
      method: 'POST', url: 'https://queue.fal.run/fal-ai/nano-banana-2',
      headers: { 'X-Fal-No-Retry': '1', Authorization: 'Key ***', 'Content-Type': 'application/json' },
      body: { mode: 'json', json: {
        prompt, num_images: 1, aspect_ratio: '1:1', output_format: 'png', safety_tolerance: 6,
        resolution: '1K', limit_generations: true, enable_web_search: false,
      } },
    },
  },
  {
    name: 'Fal edit with thinking and web search', profile: falProfile,
    job: job(falProfile, 'fal-ai/nano-banana-pro', 'image.edit', { thinking_level: 'high', enable_web_search: true }, [image]),
    expected: {
      method: 'POST', url: 'https://queue.fal.run/fal-ai/nano-banana-pro/edit',
      headers: { 'X-Fal-No-Retry': '1', Authorization: 'Key ***', 'Content-Type': 'application/json' },
      body: { mode: 'json', json: {
        prompt, num_images: 1, aspect_ratio: '1:1', output_format: 'png', safety_tolerance: 6,
        resolution: '1K', limit_generations: true, enable_web_search: true,
        thinking_level: 'high', image_urls: [summary],
      } },
    },
  },
];

describe('built-in channel profiles', () => {
  it.each(builtInPresets)('$id satisfies the strict complete profile schema', (profile) => {
    expect(validateProfile(profile)).toEqual([]);
    expect(channelProfileSchema.safeParse(profile).success).toBe(true);
  });

  it('exports unique profiles and only the explicitly supported built-ins', () => {
    expect(builtInPresets.map((profile) => profile.id)).toEqual([
      'openai-standard', 'openai-compatible', 'gemini-native', 'anthropic-messages',
      'generic-async', 'ppio', 'grsai', 'fal',
    ]);
  });

  it.each(cases)('$name has a fixed async-rendered preview', async ({ profile, job: input, expected }) => {
    const resolveRef = vi.fn(async (_ref: JobRef, encoding: 'url' | 'data-url' | 'base64') =>
      encoding === 'base64' ? 'cG5n' : encoding === 'url' ? 'https://assets.example/reference.png' : 'data:image/png;base64,cG5n');
    const { preview } = await renderRequest(profile, input, 'test-secret', resolveRef);
    expect(preview).toEqual(expected);
    expect(JSON.stringify(preview)).not.toContain('test-secret');
    expect(JSON.stringify(preview)).not.toContain('cG5n');
  });

  it.each([openAIStandardProfile, anthropicProfile])('$id preserves supplied user/assistant messages', async (profile) => {
    const input = job(profile, profile.models[0].id, 'chat');
    input.messages = [{ role: 'user', content: 'First' }, { role: 'assistant', content: 'Second' }, { role: 'user', content: 'Third' }];
    const { request } = await renderRequest(profile, input, 'test-secret', async () => 'unused');
    expect(request.body).toEqual({ mode: 'json', json: {
      model: profile.models[0].id, messages: input.messages,
      ...(profile.id === 'anthropic-messages' ? { max_tokens: 4096 } : {}),
    } });
  });

  it('sends raw PPIO and GRSAI base64, not data URLs or image summaries', async () => {
    for (const profile of [ppioProfile, grsaiProfile]) {
      const resolveRef = vi.fn(async () => 'cG5n');
      const { request } = await renderRequest(profile,
        job(profile, profile.models[0].id, 'image.edit', {}, [image]), 'test-secret', resolveRef);
      expect(resolveRef).toHaveBeenCalledWith(image, 'base64');
      expect(request.body.mode).toBe('json');
      if (request.body.mode === 'json') {
        expect(request.body.json).toMatchObject(profile.id === 'ppio' ? { image_base64s: ['cG5n'] } : { urls: ['cG5n'] });
      }
    }
  });

  it('uses genuine Fal Key authentication and the separate result endpoint', async () => {
    const { request } = await renderRequest(falProfile,
      job(falProfile, 'fal-ai/nano-banana-2', 'image.generate'), 'fal-secret', async () => 'unused');
    expect(request.headers.Authorization).toBe('Key fal-secret');
    expect(falProfile.operations['image.generate']!.response).toEqual({
      mode: 'async', taskIdPath: 'request_id', poll: {
        method: 'GET', path: '{{submit.status_url}}', intervalSec: 2, timeoutMin: 20,
        statusPath: 'status', success: ['COMPLETED'], failure: ['FAILED', 'ERROR', 'CANCELLED'],
        resultRequest: { method: 'GET', path: '{{submit.response_url}}' },
        outputs: [
          { path: 'images[*].url', as: 'url', kind: 'image' },
          { path: 'images[*].image.url', as: 'url', kind: 'image' },
          { path: 'response.images[*].url', as: 'url', kind: 'image' },
          { path: 'response.images[*].image.url', as: 'url', kind: 'image' },
        ],
      },
    });
  });

  it('does not invent successful GRSAI statuses or encoded KIE output paths', () => {
    const response = grsaiProfile.operations['image.generate']!.response;
    expect(response).toEqual({ mode: 'async', taskIdPath: 'data.id', poll: {
      method: 'POST', path: '/v1/draw/result', template: { id: '{{taskId}}' },
      intervalSec: 2, timeoutMin: 20, statusPath: 'data.status', success: [], failure: ['failed'],
      outputs: [{ path: 'data.results[*].url', as: 'url', kind: 'image' }],
    } });
    expect(builtInPresets.some((profile) => profile.id === 'kie')).toBe(false);
  });
});
