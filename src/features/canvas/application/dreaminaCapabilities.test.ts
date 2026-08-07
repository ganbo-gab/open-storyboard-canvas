import { describe, expect, it } from 'vitest';

import {
  DREAMINA_IMAGE_CUSTOM_DIMENSION_LIMITS,
  DREAMINA_IMAGE_MODEL_CAPABILITIES,
  DREAMINA_MULTIFRAME_CAPABILITY,
  getDreaminaImageModelCapability,
  getDreaminaVideoModelCapability,
  listDreaminaImageModels,
  listDreaminaVideoModels,
  parseDreaminaVideoEntryId,
  parseDreaminaTransitionSegments,
  resizeDreaminaTransitionSegments,
  validateDreaminaImageRequest,
  validateDreaminaVideoRequest,
} from './dreaminaCapabilities';
import { buildImageModelCatalog } from './modelCatalog';
import { buildVideoModelCatalog, resolveVideoModelConfig } from './videoModelCatalog';

describe('Dreamina image capabilities', () => {
  it('matches the current CLI model lists per command', () => {
    expect(listDreaminaImageModels('text2image').map(({ model }) => model)).toEqual([
      '3.0', '3.1', '4.0', '4.1', '4.5', '4.6', '4.7', '5.0', '5.0Pro',
    ]);
    expect(listDreaminaImageModels('image2image').map(({ model }) => model)).toEqual([
      '4.0', '4.1', '4.5', '4.6', '4.7', '5.0', '5.0Pro',
    ]);
  });

  it('keeps 5.0Pro and legacy resolution rules distinct', () => {
    expect(getDreaminaImageModelCapability('text2image', '5.0Pro')?.resolutions).toEqual(['1k', '2k', '4k']);
    expect(getDreaminaImageModelCapability('text2image', '3.1')?.resolutions).toEqual(['1k', '2k']);
    expect(getDreaminaImageModelCapability('image2image', '3.1')).toBeUndefined();
  });

  it('locks custom dimension limits from CLI help', () => {
    expect(DREAMINA_IMAGE_CUSTOM_DIMENSION_LIMITS).toEqual({
      '1k': { minSide: 512, maxSide: 2016, maxPixels: 1_763_584 },
      '2k': { minSide: 768, maxSide: 3072, maxPixels: 4_194_304 },
      '4k': { minSide: 1536, maxSide: 6240, maxPixels: 16_777_216 },
    });
  });

  it('rejects known-invalid image combinations before submission', () => {
    expect(validateDreaminaImageRequest({
      command: 'image2image',
      model: '3.1',
      resolution: '2k',
      ratio: '16:9',
      imageCount: 1,
    })).toEqual([expect.objectContaining({ code: 'unsupported-model' })]);

    expect(validateDreaminaImageRequest({
      command: 'text2image',
      model: '5.0',
      resolution: '1k',
      ratio: '16:9',
      imageCount: 0,
    })).toContainEqual(expect.objectContaining({ code: 'unsupported-resolution' }));
  });

  it('declares every image model only once', () => {
    expect(new Set(DREAMINA_IMAGE_MODEL_CAPABILITIES.map(({ model }) => model)).size)
      .toBe(DREAMINA_IMAGE_MODEL_CAPABILITIES.length);
  });
});

describe('Dreamina video capabilities', () => {
  it('normalizes persisted transition rows and resizes them to N-1', () => {
    expect(parseDreaminaTransitionSegments([
      { prompt: 'first', duration: '3' },
      null,
    ])).toEqual([
      { prompt: 'first', duration: 3 },
      { prompt: '' },
    ]);
    expect(resizeDreaminaTransitionSegments([
      { prompt: 'first', duration: 3 },
      { prompt: 'second', duration: 4 },
      { prompt: 'stale', duration: 5 },
    ], 2)).toEqual([
      { prompt: 'first', duration: 3 },
      { prompt: 'second', duration: 4 },
    ]);
    expect(resizeDreaminaTransitionSegments([{ prompt: 'first' }], 3)).toEqual([
      { prompt: 'first' },
      { prompt: '' },
      { prompt: '' },
    ]);
  });

  it('matches current text/video command model lists', () => {
    const seedance20Family = [
      'seedance2.0',
      'seedance2.0fast',
      'seedance2.0_vip',
      'seedance2.0fast_vip',
      'seedance2.0mini',
      'seedance2.5',
    ];
    expect(listDreaminaVideoModels('text2video').map(({ model }) => model)).toEqual(seedance20Family);
    expect(listDreaminaVideoModels('multimodal2video').map(({ model }) => model)).toEqual(seedance20Family);
    expect(listDreaminaVideoModels('image2video').map(({ model }) => model)).toEqual([
      'seedance1.0fast',
      'seedance1.5pro',
      ...seedance20Family,
    ]);
    expect(listDreaminaVideoModels('frames2video').map(({ model }) => model)).toEqual([
      'seedance1.5pro',
      ...seedance20Family,
    ]);
  });

  it('keeps VIP, 2.5, mini, and legacy image-video constraints exact', () => {
    expect(getDreaminaVideoModelCapability('text2video', 'seedance2.0_vip')).toMatchObject({
      resolutions: ['720p', '1080p', '4k'],
      vipOnly: true,
    });
    expect(getDreaminaVideoModelCapability('text2video', 'seedance2.5')).toMatchObject({
      resolutions: ['480p', '720p'],
      vipOnly: true,
    });
    expect(getDreaminaVideoModelCapability('text2video', 'seedance2.5')?.durations).toHaveLength(27);
    expect(getDreaminaVideoModelCapability('text2video', 'seedance2.0mini')).toBeDefined();
    expect(getDreaminaVideoModelCapability('image2video', 'seedance1.0fast')?.durations).toEqual(['5', '6', '7', '8', '9', '10']);
    expect(getDreaminaVideoModelCapability('image2video', '3.0')).toBeUndefined();
  });

  it('supports 2.5 audio-only but rejects it for the 2.0 family', () => {
    expect(validateDreaminaVideoRequest({
      command: 'multimodal2video',
      model: 'seedance2.5',
      resolution: '720p',
      duration: 30,
      imageCount: 0,
      videoCount: 0,
      audioCount: 1,
    })).toEqual([]);
    expect(validateDreaminaVideoRequest({
      command: 'multimodal2video',
      model: 'seedance2.0',
      resolution: '720p',
      duration: 15,
      imageCount: 0,
      videoCount: 0,
      audioCount: 1,
    })).toContainEqual(expect.objectContaining({ code: 'required-media-missing' }));
  });

  it('locks 2.5 reference limits and total count', () => {
    const capability = getDreaminaVideoModelCapability('multimodal2video', 'seedance2.5');
    expect(capability?.inputSchema.images.max).toBe(30);
    expect(capability?.inputSchema.video.max).toBe(10);
    expect(capability?.inputSchema.audio.max).toBe(10);
    expect(capability?.maxReferenceTotal).toBe(50);
  });

  it('requires N-1 explicit transitions for three or more frames', () => {
    expect(DREAMINA_MULTIFRAME_CAPABILITY).toMatchObject({
      resolutions: ['720p', '1080p'],
      imageCount: { min: 2, max: 20 },
      segmentDuration: { min: 1, max: 8 },
    });
    expect(validateDreaminaVideoRequest({
      command: 'multiframe2video',
      resolution: '1080p',
      imageCount: 4,
      videoCount: 0,
      audioCount: 0,
      transitions: [{ prompt: 'a' }, { prompt: 'b' }],
    })).toContainEqual(expect.objectContaining({ code: 'transition-count-mismatch' }));
    expect(validateDreaminaVideoRequest({
      command: 'multiframe2video',
      resolution: '1080p',
      imageCount: 4,
      videoCount: 0,
      audioCount: 0,
      transitions: [
        { prompt: 'a', duration: 2 },
        { prompt: 'b', duration: 2 },
        { prompt: 'c', duration: 2 },
      ],
    })).toEqual([]);
  });

  it('parses full entry ids and diagnoses removed 3.x video models', () => {
    expect(parseDreaminaVideoEntryId('dreamina:text-video:seedance2.5')).toMatchObject({
      command: 'text2video',
      model: 'seedance2.5',
      supported: true,
    });
    expect(parseDreaminaVideoEntryId('dreamina:image-video:3.0')).toMatchObject({
      command: 'image2video',
      model: '3.0',
      supported: false,
    });
  });
});

describe('Dreamina catalogs', () => {
  it('projects every current image capability into the picker catalog', () => {
    const entries = buildImageModelCatalog({
      customProviders: [],
      dreaminaStatus: { loggedIn: true },
    }).filter((entry) => entry.providerId === 'dreamina');

    expect(entries.map(({ modelId }) => modelId)).toEqual([
      '5.0Pro', '5.0', '4.7', '4.6', '4.5', '4.1', '4.0', '3.1', '3.0', 'upscale',
    ]);
    expect(entries.find(({ modelId }) => modelId === '5.0Pro')?.supportedResolutions)
      .toEqual(['1k', '2k', '4k']);
    expect(entries.find(({ modelId }) => modelId === '5.0Pro')?.supportedRatios)
      .toEqual(['auto', '21:9', '16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16']);
  });

  it('projects exact video command capabilities and removes old 3.x rows', () => {
    const entries = buildVideoModelCatalog([], '', { loggedIn: true })
      .filter((entry) => entry.providerId === 'dreamina');

    expect(entries).toHaveLength(28);
    expect(entries.some(({ id }) => /:3(?:\.|$)/.test(id))).toBe(false);
    expect(entries.find(({ id }) => id === 'dreamina:text-video:seedance2.5')).toMatchObject({
      supportedDurations: expect.arrayContaining(['4', '30']),
      supportedResolutions: ['480p', '720p'],
    });
    expect(entries.find(({ id }) => id === 'dreamina:image-video:seedance1.0fast')).toBeDefined();
    expect(entries.find(({ id }) => id === 'dreamina:frames-video:seedance1.5pro')).toBeDefined();
    expect(entries.find(({ id }) => id === 'dreamina:multi-frame-video')).toMatchObject({
      supportedDurations: ['2', '3', '4', '5', '6', '7', '8'],
      supportedResolutions: ['720p', '1080p'],
    });
  });

  it('does not silently migrate a removed Dreamina model to a paid current model', () => {
    const catalog = buildVideoModelCatalog([], '', { loggedIn: true });
    expect(resolveVideoModelConfig(catalog, {
      entryId: 'dreamina:image-video:3.0',
      duration: '5',
      resolution: '720p',
      aspectRatio: 'auto',
    })).toBeUndefined();
  });
});
