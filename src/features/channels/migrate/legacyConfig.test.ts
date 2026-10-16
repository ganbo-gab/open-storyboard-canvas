import { describe, expect, it } from 'vitest';
import { CUSTOM_PROVIDER_PRESETS, type CustomProviderConfig } from '@/stores/customProvidersStore';
import { customImageProviderConfigToDraft, customImageProviderDraftToConfig } from '@/features/canvas/application/customImageProviderConfig';
import { validateProfile } from '../domain/profile';
import { renderRequest } from '../domain/template';
import type { ChannelProfileV2 } from '../domain/profile';
import type { JobInput, JobRef } from '../runtime/types';
import { migrateLegacyConfig } from './legacyConfig';

function provider(patch: Partial<CustomProviderConfig> = {}): CustomProviderConfig {
  return { id: 'legacy', label: 'Legacy relay', baseUrl: 'https://relay.example/v1',
    endpointPath: '/images/generations', httpMethod: 'POST', apiKey: 'private-credential',
    apiStyle: 'openai-compatible', models: ['image-model'], supportsWebSearch: false,
    responseFormat: 'openai-images', ...patch };
}
function preset(key: string): CustomProviderConfig {
  const value = CUSTOM_PROVIDER_PRESETS.find((entry) => entry.key === key);
  if (!value) throw new Error(`Missing real legacy preset: ${key}`);
  return { ...value.template, id: key, apiKey: 'private-credential' };
}
function job(profile: ChannelProfileV2, patch: Partial<JobInput> = {}): JobInput {
  return { jobId: 'migration-job', channelId: profile.id, modelId: profile.models[0]?.id ?? '',
    operation: 'image.generate', prompt: 'a castle', params: {}, refs: [], count: 1, ...patch };
}
const refs: JobRef[] = [1, 2].map((index) => ({ kind: 'image', assetId: `asset-${index}`,
  path: `/assets/${index}.png`, mime: 'image/png', width: 1024, height: 1024 }));
const resolveRef = async (ref: JobRef, encoding: 'url' | 'data-url' | 'base64'): Promise<string> =>
  encoding === 'url' ? `https://images.example/${ref.assetId}.png` : encoding === 'base64'
    ? `base64-${ref.assetId}` : `data:image/png;base64,${ref.assetId}`;
async function wire(config: CustomProviderConfig, patch: Partial<JobInput> = {}) {
  const result = migrateLegacyConfig(config);
  expect(validateProfile(result.profile)).toEqual([]);
  return { ...result, ...await renderRequest(result.profile, job(result.profile, patch), config.apiKey, resolveRef) };
}

describe('migrateLegacyConfig', () => {
  it.each(CUSTOM_PROVIDER_PRESETS.map((entry) => [entry.key]))('converts the actual %s store fixture into a strict profile', (key) => {
    const input = preset(key);
    const before = JSON.stringify(input);
    const migrated = migrateLegacyConfig(input);
    expect(validateProfile(migrated.profile)).toEqual([]);
    expect(JSON.stringify(migrated.profile)).not.toContain(input.apiKey);
    expect(JSON.stringify(input)).toBe(before);
    expect(new Set(migrated.unmigrated.map((entry) => entry.key)).size).toBe(migrated.unmigrated.length);
    for (const entry of migrated.unmigrated) expect(entry.reason.length).toBeGreaterThan(0);
    if (!input.baseUrl) {
      expect(migrated.profile.baseUrl).toBe('https://invalid.invalid');
      expect(migrated.profile.operations).toEqual({});
      expect(migrated.profile.notes?.join('')).toContain('禁用');
      expect(migrated.unmigrated).toContainEqual(expect.objectContaining({ key: 'baseUrl', value: '' }));
    }
  });

  it('renders real OpenAI preset defaults, model, endpoint and static query/header values without extra config leakage', async () => {
    const result = await wire({ ...preset('openai_images'), extraHeaders: { 'X-Title': 'Storyboard' },
      queryParams: { 'api-version': '2025-01-01' }, extraParams: { defaultRequestParams: { quality: 'high', seed: 17 } } },
    { params: { size: '1536x1024' } });
    expect(result.request.url).toBe('https://api.openai.com/v1/images/generations?api-version=2025-01-01');
    expect(result.request.headers).toEqual({ 'X-Title': 'Storyboard', Authorization: 'Bearer private-credential', 'Content-Type': 'application/json' });
    expect(result.request.body).toEqual({ mode: 'json', json: { model: 'gpt-image-1.5', prompt: 'a castle', size: '1536x1024', n: 1, quality: 'high', seed: 17 } });
    expect(result.preview.headers.Authorization).toBe('Bearer ***');
    expect(result.unmigrated).toEqual([]);
  });

  it.each(['fal', 'replicate', 'generic-json', 'volcengine', 'unknown-style'])('preserves the legacy %s generic request rather than substituting a new preset', async (apiStyle) => {
    const config = provider({ apiStyle, endpointPath: '/create', extraParams: {
      requestBodyMode: 'json', requestBodyHints: { modelField: 'input.model', promptField: 'input.prompt', sizeField: '', ratioField: 'input.ratio', referenceImageField: 'input.image' },
      responseImagePath: 'result.url',
    } });
    const result = await wire(config, { params: { aspectRatio: '16:9' } });
    expect(result.request.url).toBe('https://relay.example/v1/create');
    expect(result.request.body).toEqual({ mode: 'json', json: { input: { model: 'image-model', prompt: 'a castle', ratio: '16:9' } } });
    expect(result.unmigrated).toEqual([]);
  });

  it('renders the actual Stability store fixture as multipart without model or size fields', async () => {
    const result = await wire(preset('stability'), { params: { aspectRatio: '16:9' } });
    expect(result.request.url).toBe('https://api.stability.ai/v2beta/stable-image/generate/core');
    expect(result.request.headers.Accept).toBe('application/json');
    expect(result.request.body).toEqual({ mode: 'multipart', fields: [
      { name: 'output_format', value: 'png' }, { name: 'prompt', value: 'a castle' }, { name: 'aspect_ratio', value: '16:9' },
    ], files: [] });
    expect(result.unmigrated).toEqual([]);
  });

  it('does not duplicate a full endpoint already stored in baseUrl and defaults a /v1 base correctly', async () => {
    const full = await wire(provider({ baseUrl: 'https://relay.example/v1/images/generations/', endpointPath: '/images/generations' }));
    expect(full.request.url).toBe('https://relay.example/v1/images/generations');
    const root = await wire(provider({ endpointPath: undefined }));
    expect(root.request.url).toBe('https://relay.example/v1/images/generations');
  });

  it('binds known extra parameters with typed defaults and reports exactly the non-parameter extensions', async () => {
    const metadata = { 'image-model': { contextWindow: 128000 } };
    const vendorExtension = { keep: true };
    const result = await wire(provider({ modelMetadata: metadata, extraParams: {
      quality: 'high', seed: 7, defaultRequestParams: { safety: { level: 2 }, enabled: false, tags: ['a', 'b'] },
      vendorExtension, unrecognized: 42,
    } }));
    expect(result.request.body).toEqual({ mode: 'json', json: {
      model: 'image-model', prompt: 'a castle', n: 1, quality: 'high', seed: 7,
      safety: { level: 2 }, enabled: false, tags: ['a', 'b'],
    } });
    expect(result.profile.models[0].params).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'seed', type: 'number', default: 7 }),
      expect.objectContaining({ key: 'enabled', type: 'boolean', default: false }),
      expect.objectContaining({ key: 'safety', type: 'enum', default: { level: 2 } }),
    ]));
    expect(result.unmigrated.map(({ key, value }) => ({ key, value })).sort((a, b) => a.key.localeCompare(b.key))).toEqual([
      { key: 'extraParams.unrecognized', value: 42 }, { key: 'extraParams.vendorExtension', value: vendorExtension },
      { key: 'modelMetadata', value: metadata },
    ]);
  });

  it('migrates V1 JSON tokens and correlated ratio/size/arbitrary fields into one enum selection', async () => {
    const config = provider({ extraParams: { imageRequestContract: { version: 1,
      textToImage: { endpointPath: '/custom/generate', method: 'POST', bodyMode: 'json',
        bodyTemplate: { model_name: '{{model}}', input: { text: '{{prompt}}' }, strength: '{{extra.strength}}' },
        responseImagePaths: ['payload.assets[0].url'] },
      ratioMappings: { '16:9': { ratio: 'landscape', size: '3840x2160', fields: {
        'input.aspectRatio': '{{aspectRatio}}', 'input.output.size': '{{size}}',
      } } },
    } } });
    const migrated = migrateLegacyConfig(config);
    const ratio = migrated.profile.models[0].params.find((param) => param.key === 'aspectRatio')!.options![0].value;
    const result = await wire(config, { params: { aspectRatio: ratio, strength: 0.75 } });
    expect(result.request.url).toBe('https://relay.example/v1/custom/generate');
    expect(result.request.body).toEqual({ mode: 'json', json: {
      model_name: 'image-model', input: { text: 'a castle', aspectRatio: 'landscape', output: { size: '3840x2160' } }, strength: 0.75,
    } });
    expect(result.profile.operations['image.generate']?.response).toEqual({ mode: 'sync', outputs: [{ path: 'payload.assets[0].url', as: 'url' }] });
    expect(result.unmigrated.some((entry) => entry.key.includes('ratioMappings'))).toBe(false);
  });

  it.each(['single', 'array', 'repeat'] as const)('preserves actual V1 multipart %s file field names and text fields', async (mode) => {
    const result = await wire(provider({ extraParams: { imageRequestContract: { version: 1, imageToImage: {
      endpointPath: '/custom/edit', bodyMode: 'multipart', bodyTemplate: { prompt: '{{prompt}}', model: '{{model}}' },
      imageFields: [{ name: 'upload', mode, encoding: 'base64' }], responseImagePaths: ['data[0].url'],
    } } } }), { operation: 'image.edit', refs: mode === 'single' ? refs.slice(0, 1) : refs });
    expect(result.request.url).toBe('https://relay.example/v1/custom/edit');
    expect(result.request.body).toEqual({ mode: 'multipart', fields: [{ name: 'prompt', value: 'a castle' }, { name: 'model', value: 'image-model' }],
      files: (mode === 'single' ? refs.slice(0, 1) : refs).map((ref) => ({ name: mode === 'array' ? 'upload[]' : 'upload', path: ref.path, mime: ref.mime, filename: ref.path.split('/').pop() })) });
  });

  it('preserves JSON image field arrays and explicit URL encoding', async () => {
    const result = await wire(provider({ extraParams: { imageRequestContract: { version: 1, imageToImage: {
      bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}' },
      imageFields: [{ name: 'input.images', mode: 'array', encoding: 'url' }], responseImagePaths: ['data[0].url'],
    } } } }), { operation: 'image.edit', refs });
    expect(result.request.body).toEqual({ mode: 'json', json: { model: 'image-model', prompt: 'a castle', input: {
      images: ['https://images.example/asset-1.png', 'https://images.example/asset-2.png'],
    } } });
  });

  it('converts a saved legacy-fallback contract using the real draft conversion', async () => {
    const input = provider({ apiStyle: 'generic-json', extraParams: {
      requestBodyMode: 'multipart', multipart: { enabled: true, fileField: 'upload[]' },
      requestBodyHints: { modelField: 'model_name', promptField: 'text', sizeField: '', referenceImageField: 'upload[]' },
      defaultRequestParams: { quality: 'hd' }, responseImagePath: 'payload.url',
    } });
    const saved = customImageProviderDraftToConfig(customImageProviderConfigToDraft(input), input.id).value!;
    const result = await wire(saved, { operation: 'image.edit', refs });
    expect(result.request.body).toMatchObject({ mode: 'multipart', fields: expect.arrayContaining([
      { name: 'model_name', value: 'image-model' }, { name: 'text', value: 'a castle' }, { name: 'quality', value: 'hd' },
    ]), files: refs.map((ref) => expect.objectContaining({ name: 'upload[]', path: ref.path })) });
  });

  it('preserves async submit ID, POST polling body, status, output and timing from the real Draw preset', async () => {
    const result = await wire(preset('grsai_draw_async'), { params: { aspectRatio: '16:9' } });
    expect(result.request.body).toEqual({ mode: 'json', json: { model: 'gpt-image-2', prompt: 'a castle', aspectRatio: '16:9', webHook: '-1', shutProgress: false } });
    const response = result.profile.operations['image.generate']!.response;
    expect(response).toEqual({ mode: 'async', taskIdPath: 'data.id', poll: {
      method: 'POST', path: '/v1/draw/result', template: { id: '{{taskId}}' }, intervalSec: 1, timeoutMin: 3,
      statusPath: 'status', success: ['succeeded', 'success', 'completed', 'done'], failure: ['failed', 'error'], outputs: [{ path: 'results[0].url', as: 'url' }],
    } });
    const poll = await renderRequest(result.profile, job(result.profile), 'private-credential', resolveRef, 'task/1');
    expect(poll.request.url).toBe('https://grsai.dakka.com.cn/v1/draw/result');
    expect(poll.request.body).toEqual({ mode: 'json', json: { id: 'task/1' } });
    expect(result.unmigrated).toEqual([]);
  });

  it('retains OpenAI Videos multipart seconds, polling and authenticated raw-content output URL', async () => {
    const result = await wire(preset('openai_videos'), { operation: 'video.generate', params: { size: '1280x720' }, refs: refs.slice(0, 1) });
    expect(result.request.url).toBe('https://api.openai.com/v1/videos');
    expect(result.request.body).toMatchObject({ mode: 'multipart', fields: expect.arrayContaining([
      { name: 'model', value: 'sora-2' }, { name: 'prompt', value: 'a castle' }, { name: 'size', value: '1280x720' }, { name: 'seconds', value: '8' },
    ]), files: [expect.objectContaining({ name: 'input_reference' })] });
    expect(result.profile.operations['video.generate']!.response).toMatchObject({ mode: 'async', poll: {
      path: '/v1/videos/{{taskId}}', outputs: [{ url: '/v1/videos/{{taskId}}/content', kind: 'video', auth: true }],
    } });
    expect(result.unmigrated.some((entry) => entry.key === 'extraParams.videoContentEndpointPath')).toBe(false);
  });

  it.each(['openai-images', 'url-array', 'data-url', 'generic'] as const)('preserves declared %s response extraction and explicitly reports only heuristic scanning', (responseFormat) => {
    const result = migrateLegacyConfig(provider({ responseFormat }));
    expect(validateProfile(result.profile)).toEqual([]);
    const response = result.profile.operations['image.generate']!.response;
    expect(response.mode).toBe('sync');
    if (response.mode !== 'sync') throw new Error('Expected synchronous response');
    const expected = responseFormat === 'openai-images' ? [{ path: 'data[*].url', as: 'url' }, { path: 'data[*].b64_json', as: 'base64' }]
      : responseFormat === 'url-array' ? [{ path: '[*]', as: 'url' }, { path: 'images[*]', as: 'url' }]
        : responseFormat === 'data-url' ? [{ path: '$', as: 'data-url' }, { path: 'image', as: 'data-url' }, { path: 'data', as: 'data-url' }] : undefined;
    if (expected) expect(response.outputs).toEqual(expected);
    expect(result.unmigrated.map((entry) => entry.key)).toEqual(responseFormat === 'generic' ? ['responseFormat'] : []);
  });

  it('renders GET query values with their actual special characters and omits optional missing query pairs', async () => {
    const result = await wire(provider({ extraParams: { imageRequestContract: { version: 1, textToImage: {
      endpointPath: '/render', method: 'GET', query: { optional: '{{extra.optional}}' },
      bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}', channel: '{{extra.channel}}' }, responseImagePaths: ['result.url'],
    } } } }), { prompt: 'castle & sky #1', params: { channel: 'a&b=c' } });
    const url = new URL(result.request.url);
    expect(url.pathname).toBe('/v1/render');
    expect(Object.fromEntries(url.searchParams)).toEqual({ model: 'image-model', prompt: 'castle & sky #1', channel: 'a&b=c' });
    expect(result.request.body).toEqual({ mode: 'none' });
  });

  it('preserves non-secret auth descriptions but never persists keys copied into defaults or notes', async () => {
    const result = await wire(provider({ note: 'Do not copy private-credential', extraHeaders: {
      Authorization: 'Bearer private-credential', 'X-Title': 'Storyboard',
    }, extraParams: { auth: { mode: 'header', name: 'X-API-Key', prefix: 'Token' }, defaultRequestParams: { credential: 'private-credential', quality: 'high' } } }));
    expect(result.profile.auth).toEqual({ type: 'header', name: 'X-API-Key', prefix: 'Token ' });
    expect(result.request.headers['X-API-Key']).toBe('Token private-credential');
    expect(JSON.stringify(result.profile)).not.toContain('private-credential');
    expect(result.unmigrated.map((entry) => entry.key).sort()).toEqual(['extraHeaders.Authorization', 'extraParams.defaultRequestParams.credential', 'note']);
  });

  it('blocks a V1 template containing a copied secret rather than persisting or rendering it', () => {
    const result = migrateLegacyConfig(provider({ extraParams: { imageRequestContract: { version: 1, textToImage: {
      bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}', audit: 'private-credential' },
    } } } }));
    expect(validateProfile(result.profile)).toEqual([]);
    expect(result.profile.operations).toEqual({});
    expect(JSON.stringify(result.profile)).not.toContain('private-credential');
    expect(result.unmigrated).toContainEqual(expect.objectContaining({ key: 'extraParams.imageRequestContract.textToImage.bodyTemplate' }));
  });

  it('retains literal null, empty strings, false, and zero in fixed defaults', async () => {
    const result = await wire(provider({ extraParams: { defaultRequestParams: { optional: null, suffix: '', enabled: false, seed: 0 } } }));
    expect(result.request.body).toEqual({ mode: 'json', json: {
      optional: null, suffix: '', enabled: false, seed: 0, model: 'image-model', prompt: 'a castle', n: 1,
    } });
  });

  it('preserves chat messages, Anthropic headers, typed token defaults, and native Gemini imageConfig casing', async () => {
    const chat = await wire(provider({ mediaType: 'chat', apiStyle: 'anthropic', endpointPath: '/messages',
      extraParams: { providerKind: 'anthropic-messages', defaultRequestParams: { max_tokens: 256 } } }), { operation: 'chat', messages: [{ role: 'user', content: 'hello' }] });
    expect(chat.request.headers['x-api-key']).toBe('private-credential');
    expect(chat.request.body).toEqual({ mode: 'json', json: { model: 'image-model', max_tokens: 256, messages: [{ role: 'user', content: 'hello' }] } });
    const gemini = await wire(provider({ endpointPath: '/models/{model}:generateContent', supportedResolutions: ['1K', '2K'], extraParams: {
      providerConfigVersion: 'new-v1', providerKind: 'google-gemini', supportedRatios: ['16:9', '1:1'],
    } }), { params: { size: '2K', aspectRatio: '16:9' } });
    expect(gemini.request.body).toEqual({ mode: 'json', json: {
      contents: [{ role: 'user', parts: [{ text: 'a castle' }] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '16:9', imageSize: '2K' } },
    } });
  });

  it.each(['comfyui', 'dreamina-cli', 'minimax-h3', 'local-audio'])('does not invent an HTTP implementation for %s', (apiStyle) => {
    const result = migrateLegacyConfig(provider({ apiStyle }));
    expect(validateProfile(result.profile)).toEqual([]);
    expect(result.profile.operations).toEqual({});
    expect(result.unmigrated).toContainEqual(expect.objectContaining({ key: 'apiStyle', value: apiStyle }));
  });

  it('does not substitute JSON for form-urlencoded, signing, invalid V1 contracts, or multiple multipart file fields', () => {
    const inputs = [
      provider({ extraParams: { requestBodyMode: 'form-urlencoded' } }),
      provider({ extraParams: { transport: 'signed', signedAuth: { required: true } } }),
      provider({ extraParams: { imageRequestContract: { version: 1, textToImage: { method: 'DELETE' } } } }),
      provider({ extraParams: { imageRequestContract: { version: 1, imageToImage: { bodyMode: 'multipart', imageFields: [{ name: 'image', mode: 'repeat' }, { name: 'mask', mode: 'single' }] } } } }),
    ];
    for (const input of inputs) {
      const result = migrateLegacyConfig(input);
      expect(validateProfile(result.profile)).toEqual([]);
      expect(result.profile.operations).toEqual({});
      expect(result.unmigrated.length).toBeGreaterThan(0);
    }
  });
});
