import { describe, expect, it, vi } from 'vitest';
import { channelProfileSchema, validateProfile, type ChannelProfileV2, type ModeSpec, type ModelSpec, type OperationKind } from '../domain/profile';
import { renderPreview, renderRequest, resolveJobOperation } from '../domain/template';
import type { JobInput, JobRef, JsonValue, RequestPreview } from '../runtime/types';
import {
  anthropicProfile, builtInPresets, falProfile, geminiNativeProfile, genericAsyncProfile,
  grsaiProfile, openAICompatibleProfile, openAIStandardProfile, ppioProfile,
  bytePlusSeedanceProfile, miniMaxChinaVideoProfile, miniMaxVideoProfile, officialVideoPresets,
  viduVideoProfile, volcengineSeedanceProfile, wanVideoProfile,
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
        model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: 500, stream: false,
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
    job: { ...job(geminiNativeProfile, 'gemini-2.5-flash', 'chat'), chatPayload: {
      contents: [{ role: 'user', parts: [{ text: prompt }] }], action: 'generateContent', alt: 'json',
    } },
    expected: {
      method: 'POST', url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?alt=json',
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
        model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: prompt }], max_tokens: 4096, stream: false,
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
      'generic-async', 'generic-audio-json', 'ppio', 'grsai', 'fal',
      'volcengine-seedance', 'byteplus-seedance', 'minimax-video', 'minimax-china-video', 'alibaba-wan-video', 'vidu-video',
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
      model: profile.models[0].id, messages: input.messages, stream: false,
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

  it('downloads completed relay video content using channel authentication', () => {
    expect(openAICompatibleProfile.operations['video.generate']!.response).toEqual({
      mode: 'async', taskIdPath: 'id', poll: {
        method: 'GET', path: '/v1/videos/{{taskId}}', intervalSec: 5, timeoutMin: 20,
        statusPath: 'status', success: ['completed'], failure: ['failed', 'cancelled'],
        progressPath: 'progress', outputs: [{ url: '/v1/videos/{{taskId}}/content', kind: 'video', auth: true }],
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

interface VideoModeCase {
  name: string;
  profile: ChannelProfileV2;
  model: ModelSpec;
  mode: ModeSpec;
  input: JobInput;
}
const videoModes: VideoModeCase[] = officialVideoPresets.flatMap((profile) => profile.models.flatMap((model) =>
  (model.modes ?? []).map((mode) => {
    // Include optional media to exercise all typed inputs, and reverse frames to prove slot identity.
    const refs: JobRef[] = (mode.slots ?? []).map((slot, index) => ({
      kind: slot.kind, slot: slot.key, assetId: `${slot.key}-${index}`, path: `/fixtures/${slot.key}`,
      mime: slot.kind === 'image' ? 'image/png' : slot.kind === 'video' ? 'video/mp4' : 'audio/mp3',
      ...(slot.kind === 'image' ? { width: 1024, height: 1024 } : {}),
    })).reverse();
    return { name: `${profile.id} / ${model.id} / ${mode.id}`, profile, model, mode,
      input: { ...job(profile, model.id, 'video.generate', {}, refs), modeId: mode.id } };
  })));

function expectedVideoBody({ profile, model, mode, input }: VideoModeCase): Record<string, JsonValue> {
  const refs = input.refs.map((ref, index) => ({
    ref, value: `<${ref.kind} ${index + 1}: ${ref.kind === 'image' ? '1024×1024 png' : ref.kind === 'video' ? 'mp4' : 'mp3'}>`,
  }));
  if (profile.id.includes('seedance') || model.id.startsWith('MiniMax-H3')) {
    const content = [...refs.map(({ ref, value }) => ({
      type: `${ref.kind}_url`, [`${ref.kind}_url`]: { url: value }, role: ref.slot ?? '',
    })), { type: 'text', text: prompt }];
    if (model.id.startsWith('MiniMax-H3')) return {
      model: model.id, content, resolution: '768P', duration: 5,
      ratio: mode.id === 'text-to-video' ? '16:9' : 'adaptive',
      ...(model.id === 'MiniMax-H3-Max' ? { extra: { prompt_expansion_mode: 'balanced' } } : {}),
      ...(profile.id === 'minimax-china-video' ? { aigc_watermark: false } : {}),
    };
    const is25 = model.id.includes('-2-5-');
    return {
      model: model.id, content, resolution: '720p', duration: is25 ? -1 : 5, ratio: 'adaptive',
      generate_audio: true, watermark: false, return_last_frame: false,
      ...(is25 ? { output_format: 'mp4' } : {}),
      ...(is25 && mode.id.startsWith('reference-') ? { omni_reference_task_type: 'reference' } : {}),
      ...(mode.id === 'video-edit' ? { omni_reference_task_type: 'edit' } : {}),
      ...(mode.id === 'video-extend' ? { omni_reference_task_type: 'extend' } : {}),
    };
  }
  if (model.id.startsWith('MiniMax-Hailuo')) return {
    model: model.id, prompt, duration: 6, resolution: '768P', prompt_optimizer: true,
    ...(mode.id !== 'first-last-frame' ? { fast_pretreatment: false } : {}),
    ...(mode.id !== 'text-to-video' ? { first_frame_image: refs.find(({ ref }) => ref.slot === 'first_frame')!.value } : {}),
    ...(mode.id === 'first-last-frame' ? { last_frame_image: refs.find(({ ref }) => ref.slot === 'last_frame')!.value } : {}),
  };
  if (profile.id === 'alibaba-wan-video') return {
    model: model.id, input: { prompt,
      ...(refs.length ? { media: refs.map(({ ref, value }) => ({ type: ref.slot ?? '', url: value })) } : {}) },
    parameters: { resolution: '1080P', ratio: 'adaptive', duration: mode.id === 'video-edit' ? -1 : 5,
      audio: true, prompt_extend: true, watermark: false },
  };
  return {
    model: model.id, prompt, duration: 5, resolution: '720p', audio: true,
    ...(mode.id === 'text-to-video' || mode.id === 'reference-images' ? { aspect_ratio: '16:9' } : {}),
    ...(mode.id === 'first-frame' ? { images: [refs[0].value], is_rec: false } : {}),
    ...(mode.id === 'first-last-frame' ? { images: [
      refs.find(({ ref }) => ref.slot === 'first_frame')!.value, refs.find(({ ref }) => ref.slot === 'last_frame')!.value,
    ] } : {}),
    ...(mode.id === 'reference-images' ? { images: refs.map(({ value }) => value) } : {}),
  };
}

describe('official video presets (offline contracts)', () => {
  it.each(videoModes)('$name renders the documented body with renderPreview', (entry) => {
    const preview = renderPreview(entry.profile, entry.input, 'video-secret');
    const endpoint = entry.profile.id.includes('seedance') ? '/api/v3/contents/generations/tasks'
      : entry.model.id.startsWith('MiniMax-H3') ? '/v2/video_generation'
      : entry.model.id.startsWith('MiniMax-Hailuo') ? '/v1/video_generation'
      : entry.profile.id === 'alibaba-wan-video' ? '/api/v1/services/aigc/video-generation/video-synthesis'
      : `/ent/v2/${{ 'text-to-video': 'text2video', 'first-frame': 'img2video',
        'first-last-frame': 'start-end2video', 'reference-images': 'reference2video' }[entry.mode.id]}`;
    expect(preview).toEqual({
      method: 'POST', url: `${entry.profile.baseUrl}${endpoint}`,
      headers: { Authorization: entry.profile.id === 'vidu-video' ? 'Token ***' : 'Bearer ***',
        'Content-Type': 'application/json', ...(entry.profile.id === 'alibaba-wan-video' ? { 'X-DashScope-Async': 'enable' } : {}) },
      body: { mode: 'json', json: expectedVideoBody(entry) },
    });
    expect(JSON.stringify(preview)).not.toContain('video-secret');
  });

  it.each(videoModes)('$name shares real-send and preview rendering without network', async (entry) => {
    const resolveRef = vi.fn(async (ref: JobRef) => `https://assets.example/${ref.assetId}`);
    const rendered = await renderRequest(entry.profile, entry.input, 'video-secret', resolveRef);
    expect(rendered.preview).toEqual(renderPreview(entry.profile, entry.input, 'video-secret'));
    expect(rendered.request.body.mode).toBe('json');
    expect(resolveRef).toHaveBeenCalledTimes(entry.input.refs.length);
    expect(JSON.stringify(rendered.request.body)).not.toContain('<image ');
    expect(JSON.stringify(rendered.request.body)).not.toContain('<video ');
    expect(JSON.stringify(rendered.request.body)).not.toContain('<audio ');
  });

  it('declares only current official IDs and exposes no retired Sora or Veo preset', () => {
    expect(volcengineSeedanceProfile.models.map((model) => model.id)).toEqual([
      'doubao-seedance-2-5-260628', 'doubao-seedance-2-0-260128',
      'doubao-seedance-2-0-fast-260128', 'doubao-seedance-2-0-mini-260615',
    ]);
    expect(bytePlusSeedanceProfile.models[0].id).toBe('dreamina-seedance-2-5-260628');
    expect(miniMaxVideoProfile.models.map((model) => model.id)).toEqual([
      'MiniMax-H3', 'MiniMax-H3-Max', 'MiniMax-Hailuo-2.3', 'MiniMax-Hailuo-2.3-Fast', 'MiniMax-Hailuo-02',
    ]);
    expect(wanVideoProfile.models.map((model) => model.id)).toEqual(['wan3.0-video', 'wan3.0-video-prime']);
    expect(officialVideoPresets.flatMap((profile) => profile.models).some((model) => /sora|veo|Hailuo-03|viduq4/.test(model.id))).toBe(false);
  });

  it('uses the exact documented poll paths, statuses, and output fields per protocol', () => {
    const representatives = [volcengineSeedanceProfile, bytePlusSeedanceProfile, miniMaxVideoProfile,
      miniMaxChinaVideoProfile, wanVideoProfile, viduVideoProfile];
    const expected = [
      ['id', '/api/v3/contents/generations/tasks/{{taskId}}', 'status', ['succeeded'], ['failed', 'cancelled', 'expired'], 'content.video_url'],
      ['id', '/api/v3/contents/generations/tasks/{{taskId}}', 'status', ['succeeded'], ['failed', 'cancelled', 'expired'], 'content.video_url'],
      ['task_id', '/v2/query/video_generation/{{taskId}}', 'task.status', ['succeeded'], ['failed', 'cancelled'], 'task.content.url'],
      ['task_id', '/v2/query/video_generation/{{taskId}}', 'task.status', ['succeeded'], ['failed', 'cancelled'], 'task.content.url'],
      ['output.task_id', '/api/v1/tasks/{{taskId}}', 'output.task_status', ['SUCCEEDED'], ['FAILED', 'CANCELED', 'UNKNOWN'], 'output.video_url'],
      ['task_id', '/ent/v2/tasks/{{taskId}}/creations', 'state', ['success'], ['failed'], 'creations[*].url'],
    ];
    representatives.forEach((profile, index) => {
      const response = profile.operations['video.generate']!.response;
      expect(response.mode).toBe('async');
      if (response.mode !== 'async') throw new Error('Expected async video protocol');
      expect([response.taskIdPath, response.poll.path, response.poll.statusPath, response.poll.success,
        response.poll.failure, 'path' in response.poll.outputs[0] ? response.poll.outputs[0].path : '']).toEqual(expected[index]);
    });
  });

  it('retrieves Hailuo V1 downloads using the final poll file_id, not the task_id', async () => {
    const input = job(miniMaxVideoProfile, 'MiniMax-Hailuo-2.3', 'video.generate');
    input.modeId = 'text-to-video';
    const op = resolveJobOperation(miniMaxVideoProfile, input);
    expect(op.response).toMatchObject({ mode: 'async', taskIdPath: 'task_id', poll: {
      path: '/v1/query/video_generation?task_id={{taskId}}', statusPath: 'status',
      success: ['Success'], failure: ['Fail'], outputs: [{ path: 'file.download_url', as: 'url', kind: 'video' }],
    } });
    const resolveRef = vi.fn(async () => 'unused');
    const result = await renderRequest(miniMaxVideoProfile, input, 'key', resolveRef, 'task-123',
      { task_id: 'task-123' }, true, { status: 'Success', file_id: 'file-456' });
    expect(result.request.url).toBe('https://api.minimax.io/v1/files/retrieve?file_id=file-456');
    expect(result.request.method).toBe('GET');
    expect(result.request.body).toEqual({ mode: 'none' });
    expect(resolveRef).not.toHaveBeenCalled();
  });

  it('prevents invalid mode-specific parameter combinations and missing required references', () => {
    expect(() => renderPreview(miniMaxVideoProfile, { ...job(miniMaxVideoProfile, 'MiniMax-H3-Max', 'video.generate',
      { resolution: '2K' }), modeId: 'text-to-video' })).toThrow();
    expect(() => renderPreview(miniMaxVideoProfile, { ...job(miniMaxVideoProfile, 'MiniMax-Hailuo-2.3', 'video.generate',
      { output: { duration: 10, resolution: '1080P' } }), modeId: 'text-to-video' })).toThrow();
    expect(() => renderPreview(volcengineSeedanceProfile, { ...job(volcengineSeedanceProfile,
      'doubao-seedance-2-5-260628', 'video.generate'), modeId: 'first-last-frame' })).toThrow();
    expect(() => renderPreview(volcengineSeedanceProfile, { ...job(volcengineSeedanceProfile,
      'doubao-seedance-2-0-260128', 'video.generate', {}, [
        { kind: 'audio', slot: 'reference_audio', assetId: 'audio', path: '/audio.mp3', mime: 'audio/mp3' },
      ]), modeId: 'reference-images' })).toThrow();
    expect(() => renderPreview(wanVideoProfile, { ...job(wanVideoProfile, 'wan3.0-video', 'video.generate', {}, [
      { ...image, slot: 'first_frame' },
      { kind: 'audio', slot: 'reference_audio', assetId: 'audio', path: '/audio.mp3', mime: 'audio/mp3' },
    ]), modeId: 'first-frame' })).toThrow();
  });

  it('never sends undocumented legacy or caller-injected fields', () => {
    const input = { ...job(wanVideoProfile, 'wan3.0-video', 'video.generate', {
      size: '1920*1080', generate_audio: false, negative_prompt: 'bad', shot_type: 'multi', unknown: true,
    }), modeId: 'text-to-video' };
    expect(renderPreview(wanVideoProfile, input).body).toEqual({ mode: 'json', json: {
      model: 'wan3.0-video', input: { prompt }, parameters: {
        resolution: '1080P', ratio: 'adaptive', duration: 5, audio: true, prompt_extend: true, watermark: false,
      },
    } });
    const seedance = renderPreview(volcengineSeedanceProfile, { ...job(volcengineSeedanceProfile,
      'doubao-seedance-2-5-260628', 'video.generate', { seed: 42, camera_fixed: true, frames: 100 }), modeId: 'text-to-video' });
    expect(JSON.stringify(seedance.body)).not.toMatch(/\"seed\"|camera_fixed|\"frames\"/);
  });
});
