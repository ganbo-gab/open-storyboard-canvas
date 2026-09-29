import { describe, expect, it } from 'vitest';
import type { GenerateRequest } from '@/commands/ai';
import { composeMinimaxH3Request, MINIMAX_H3_PRESET, MinimaxH3ValidationError } from './minimaxH3';
import { buildVideoModelCatalog, resolveVideoModelConfig } from './videoModelCatalog';
import { normalizeVideoInputSchema, resolveVideoInputSchemaFromExtraParams } from './videoInputSchema';

const base: GenerateRequest = { prompt: 'A camera follows a cyclist', model: 'MiniMax-H3', size: '768P', aspect_ratio: '16:9' };
const image = 'https://media.example/image.png';
const video = 'https://media.example/video.mp4';
const audio = 'https://media.example/audio.mp3';
const compose = (patch: Partial<GenerateRequest> = {}) => composeMinimaxH3Request('MiniMax-H3', { ...base, ...patch });

function expectInvalid(patch: Partial<GenerateRequest>, code: string) {
  try { compose(patch); throw new Error('Expected validation failure'); }
  catch (error) { expect(error).toBeInstanceOf(MinimaxH3ValidationError); expect(error).toHaveProperty('code', code); }
}

describe('MiniMax H3 composer', () => {
  it('composes a minimal text request with the documented defaults and no unrelated fields', () => {
    expect(compose({ extra_params: { watermark: false, model: 'other', content: [], api_key: 'secret' } })).toEqual({
      model: 'MiniMax-H3', content: [{ type: 'text', text: base.prompt }], duration: 5, resolution: '768P', ratio: '16:9',
    });
  });
  it.each([4, 5, 15, '12'])('accepts duration %s and sends an integer', (seconds) => {
    expect(compose({ extra_params: { seconds }, size: '2K' })).toMatchObject({ duration: Number(seconds), resolution: '2K' });
  });
  it.each([3, 16, 4.5, '4.5', '', true, NaN])('rejects invalid duration %s', (duration) => {
    expectInvalid({ extra_params: { duration } }, 'duration');
  });
  it.each(['480P', '1080P', '768p', '1280x720'])('rejects unsupported resolution %s', (size) => {
    expectInvalid({ size }, 'resolution');
  });
  it('rejects blank prompt, unsupported models, invalid ratios and adaptive text-only requests', () => {
    expectInvalid({ prompt: ' ' }, 'prompt');
    expectInvalid({ prompt: '字'.repeat(7001) }, 'prompt');
    expect(compose({ prompt: '字'.repeat(7000) }).content).toHaveLength(1);
    expect(() => composeMinimaxH3Request('MiniMax-H3-Max', base)).toThrow('minimaxH3.errors.model');
    expectInvalid({ aspect_ratio: '2:1' }, 'ratio');
    expectInvalid({ aspect_ratio: 'adaptive' }, 'textRatio');
  });
  it.each([
    ['firstFrame', [image], ['first_frame']],
    ['lastFrame', [image], ['last_frame']],
    ['frames', [image, `${image}?last`], ['first_frame', 'last_frame']],
  ] as const)('maps %s to explicit frame roles and forces adaptive ratio', (imageMode, sources, roles) => {
    const body = compose({ reference_images: [...sources], extra_params: { imageMode } });
    expect(body.ratio).toBe('adaptive');
    expect(body.content).toEqual([
      { type: 'text', text: base.prompt },
      ...sources.map((url, index) => ({ type: 'image_url', image_url: { url }, role: roles[index] })),
    ]);
  });
  it('maps multimodal references without flattening URL objects', () => {
    expect(compose({ reference_images: [image], reference_videos: [video], reference_audios: [audio] }).content).toEqual([
      { type: 'text', text: base.prompt },
      { type: 'image_url', image_url: { url: image }, role: 'reference_image' },
      { type: 'video_url', video_url: { url: video }, role: 'reference_video' },
      { type: 'audio_url', audio_url: { url: audio }, role: 'reference_audio' },
    ]);
  });
  it('rejects ambiguous frame counts or mixing frame and reference inputs', () => {
    expectInvalid({ extra_params: { imageMode: 'frames' }, reference_images: [image] }, 'frames');
    expectInvalid({ extra_params: { imageMode: 'firstFrame' }, reference_images: [image, image] }, 'frames');
    expectInvalid({ extra_params: { imageMode: 'lastFrame' }, reference_images: [image], reference_audios: [audio] }, 'mixed');
    expectInvalid({ extra_params: { imageMode: 'frames' }, reference_images: [image, image], reference_videos: [video] }, 'mixed');
    expectInvalid({ extra_params: { imageMode: 'keyframe' } }, 'mode');
  });
  it('enforces individual and combined media limits without silently dropping inputs', () => {
    expectInvalid({ reference_images: Array(10).fill(image) }, 'limits');
    expectInvalid({ reference_videos: Array(4).fill(video) }, 'limits');
    expectInvalid({ reference_audios: Array(4).fill(audio) }, 'limits');
    expectInvalid({ reference_images: Array(9).fill(image), reference_videos: Array(3).fill(video), reference_audios: [audio] }, 'limits');
    expect(compose({ reference_images: Array(9).fill(image), reference_videos: Array(3).fill(video) }).content).toHaveLength(13);
  });
  it('accepts matching data URLs but rejects local, blob, and mismatched data media', () => {
    expect(compose({ reference_images: ['data:image/png;base64,AAAA'] }).content).toHaveLength(2);
    for (const source of ['/tmp/ref.png', 'blob:https://app/id', 'data:audio/mp3;base64,AAAA', 'https://user:secret@media.example/a.png']) {
      expectInvalid({ reference_images: [source] }, 'media');
    }
  });
  it('uses configured defaults without leaking configuration metadata into the body', () => {
    expect(composeMinimaxH3Request('MiniMax-H3', { ...base, reference_images: [image] }, { duration: 10, imageMode: 'lastFrame' })).toMatchObject({
      duration: 10, ratio: 'adaptive', content: [expect.anything(), expect.objectContaining({ role: 'last_frame' })],
    });
  });
});

describe('MiniMax H3 registration', () => {
  it('derives model availability, defaults and multimodal capability from the preset', () => {
    const provider = { ...MINIMAX_H3_PRESET.template, id: 'minimax', apiKey: 'key' };
    const catalog = buildVideoModelCatalog([provider]);
    expect(catalog).toHaveLength(1);
    expect(resolveVideoModelConfig(catalog)).toMatchObject({ entryId: 'custom:minimax:MiniMax-H3', duration: '5', resolution: '768P', aspectRatio: '16:9' });
    expect(catalog[0].inputSchema).toMatchObject({ images: { max: 9 }, video: { max: 3 }, audio: { max: 3 }, imageModes: ['reference', 'firstFrame', 'lastFrame', 'frames'] });
    expect(buildVideoModelCatalog([{ ...provider, apiKey: '' }])[0].usable).toBe(false);
  });
  it('retains mode metadata through normalization and kind fallback', () => {
    const schema = resolveVideoInputSchemaFromExtraParams({ providerKind: 'minimax-h3' });
    expect(normalizeVideoInputSchema(schema)).toEqual(schema);
    expect(normalizeVideoInputSchema({ imageModes: ['reference', 'invalid'] }).imageModes).toEqual(['reference']);
  });
});
