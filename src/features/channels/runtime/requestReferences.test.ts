import { describe, expect, it } from 'vitest';
import type { ChannelProfileV2 } from '../domain/profile';
import { channelRequestOptions } from './requestReferences';
import { normalizeChannelGenerationFields } from '../application/generationFields';
import { channelJobFromRequest } from './channelExecution';
import { renderRequest } from '../domain/template';

const profile: ChannelProfileV2 = { version: 2, id: 'slot-test', name: 'Slots', baseUrl: 'https://example.test', auth: { type: 'none' },
  operations: { 'video.generate': { method: 'POST', path: '/video', body: 'json', template: { prompt: '{{prompt}}' }, response: { mode: 'sync', outputs: [{ path: 'url', as: 'url', kind: 'video' }] } } },
  models: [{ id: 'model', operations: ['video.generate'], params: [], modes: [{ id: 'reference', label: 'Reference', operation: 'video.generate', slots: [
    { key: 'images', label: 'Images', kind: 'image', min: 1, max: 2 },
    { key: 'video', label: 'Video', kind: 'video', max: 1 },
    { key: 'audio', label: 'Audio', kind: 'audio', max: 1 },
  ] }] }],
};
const request = { model: 'model', prompt: 'References', size: 'auto', aspect_ratio: 'auto' };

describe('slot source preflight', () => {
  it('uses declared media kinds and preserves each slot order without materializing sources', () => {
    const result = channelRequestOptions(profile, 'model', { ...request, reference_slots: {
      audio: ['data:audio/wav;base64,AUDIO'], images: ['/second.jpg', 'https://example.test/first.png'], video: ['/clip.mov'],
    } });
    expect(result.refs).toEqual([
      { slot: 'images', kind: 'image', path: '/second.jpg', mime: 'image/jpeg', assetId: 'images-0' },
      { slot: 'images', kind: 'image', path: 'https://example.test/first.png', mime: 'image/png', assetId: 'images-1' },
      { slot: 'video', kind: 'video', path: '/clip.mov', mime: 'video/quicktime', assetId: 'video-0' },
      { slot: 'audio', kind: 'audio', path: 'data:audio/wav;base64,AUDIO', mime: 'audio/wav', assetId: 'audio-0' },
    ]);
  });
  it('rejects invalid mode ids and malformed live sources rather than normalizing them away', () => {
    expect(() => channelRequestOptions(profile, 'model', { ...request, channel_mode_id: 'missing', reference_slots: {} })).toThrow('未声明模式');
    expect(() => channelRequestOptions(profile, 'model', { ...request, reference_slots: { images: [''] } })).toThrow('素材地址数组');
    expect(() => channelRequestOptions(profile, 'model', { ...request, reference_slots: { images: ['data:application/pdf;base64,PDF'] } })).toThrow('只接受');
  });
  it('leaves the legacy generic reference path selected when slots are absent', () => {
    expect(channelRequestOptions(profile, 'model', request)).toEqual({ modeId: undefined });
  });
});

describe('persisted channel generation fields', () => {
  it('drops corrupt entries and empty slots without reordering, mutating or deduplicating sources', () => {
    const original = { channelModeId: 'reference', referenceSlots: { images: ['/a.png', 1, '', '/a.png', '/b.png'], empty: [], invalid: 3 } };
    expect(normalizeChannelGenerationFields(original)).toEqual({ channelModeId: 'reference', referenceSlots: { images: ['/a.png', '/a.png', '/b.png'] } });
    expect(original.referenceSlots.images).toEqual(['/a.png', 1, '', '/a.png', '/b.png']);
  });
  it('distinguishes absent slots from explicit empty input and drops invalid mode selections', () => {
    expect(normalizeChannelGenerationFields({})).toEqual({ channelModeId: undefined, referenceSlots: undefined });
    expect(normalizeChannelGenerationFields({ channelModeId: 3, referenceSlots: { empty: [null] } })).toEqual({ channelModeId: undefined, referenceSlots: {} });
  });
});

const imageProfile: ChannelProfileV2 = { version: 2, id: 'image-slots', name: 'Image slots', baseUrl: 'https://example.test', auth: { type: 'none' },
  operations: {
    'image.generate': { method: 'POST', path: '/images', body: 'json', template: { prompt: '{{prompt}}', images: '{{images}}' }, response: { mode: 'sync', outputs: [] } },
    'image.edit': { method: 'POST', path: '/edits', body: 'json', template: { prompt: '{{prompt}}', images: '{{images}}' }, response: { mode: 'sync', outputs: [] } },
  }, models: [{ id: 'image', operations: ['image.generate', 'image.edit'], params: [], modes: [
    { id: 'text', label: 'Text', operation: 'image.generate' },
    { id: 'edit', label: 'Edit', operation: 'image.edit', slots: [{ key: 'images', label: 'Images', kind: 'image', min: 1, max: 2 }] },
  ] }],
};
const imageRequest = { model: 'image', prompt: 'Edit', size: 'auto', aspect_ratio: 'auto' };

describe('automatic image mode request preflight', () => {
  it('selects edit and assigns generic images to its only image slot when slots are absent', () => {
    const request = { ...imageRequest, reference_images: ['/one.png'] };
    expect(channelRequestOptions(imageProfile, 'image', request)).toMatchObject({ modeId: 'edit', refs: [{ slot: 'images', kind: 'image' }] });
    const job = channelJobFromRequest(imageProfile, 'image', request, 'image');
    expect(job).toMatchObject({ modeId: 'edit', operation: 'image.edit', refs: [{ slot: 'images', kind: 'image' }] });
  });
  it('keeps an explicit empty slot map empty and does not backfill generic references', () => {
    expect(channelRequestOptions(imageProfile, 'image', { ...imageRequest, reference_images: ['/one.png'], reference_slots: {} })).toEqual({ modeId: 'text', refs: [] });
  });
  it('requires explicit mode selection for ambiguous image modes and preserves invalid requested ids', () => {
    const ambiguous = structuredClone(imageProfile); ambiguous.models[0].modes!.push({ id: 'edit2', label: 'Edit 2', operation: 'image.edit', slots: [{ key: 'images', label: 'Images', kind: 'image', min: 1, max: 2 }] });
    expect(() => channelRequestOptions(ambiguous, 'image', { ...imageRequest, reference_images: ['/one.png'] })).toThrow('多个模式');
    expect(() => channelRequestOptions(imageProfile, 'image', { ...imageRequest, channel_mode_id: 'missing', reference_images: ['/one.png'] })).toThrow('未声明模式');
  });
  it('counts explicit image slots before auto selection and keeps the declared ordering', () => {
    const options = channelRequestOptions(imageProfile, 'image', { ...imageRequest, reference_slots: { images: ['/second.jpg', '/first.png'] } });
    expect(options.modeId).toBe('edit');
    expect(options.refs?.map(ref => [ref.slot, ref.path, ref.mime])).toEqual([['images', '/second.jpg', 'image/jpeg'], ['images', '/first.png', 'image/png']]);
  });
  it('respects a manually selected image mode and rejects incompatible generic refs without switching it', () => {
    expect(() => channelRequestOptions(imageProfile, 'image', { ...imageRequest, channel_mode_id: 'text', reference_images: ['/one.png'] })).toThrow('手动分配');
    expect(() => channelRequestOptions(imageProfile, 'image', { ...imageRequest, channel_mode_id: 'edit', reference_slots: {}, reference_images: ['/one.png'] })).toThrow('需要 1–2');
    expect(() => channelJobFromRequest(imageProfile, 'image', { ...imageRequest, channel_mode_id: 'missing' }, 'image')).toThrow('未声明模式');
  });
  it('rejects overflow, wrong media and ambiguous slot roles without dropping sources', () => {
    expect(() => channelRequestOptions(imageProfile, 'image', { ...imageRequest, reference_images: ['/1.png', '/2.png', '/3.png'] })).toThrow('没有可自动接入');
    expect(() => channelRequestOptions(imageProfile, 'image', { ...imageRequest, reference_videos: ['/clip.mp4'] })).toThrow('只接受图片');
    expect(() => channelRequestOptions(imageProfile, 'image', { ...imageRequest, channel_mode_id: 'edit', reference_images: ['/not-an-image.mp3'] })).toThrow('只接受 image');
    const masks = structuredClone(imageProfile);
    masks.models[0].modes![1].slots!.push({ key: 'mask', label: 'Mask', kind: 'image', max: 1 });
    expect(() => channelRequestOptions(masks, 'image', { ...imageRequest, reference_images: ['/1.png'] })).toThrow('手动选择');
    expect(channelRequestOptions(masks, 'image', { ...imageRequest, channel_mode_id: 'edit', reference_slots: { images: ['/1.png'], mask: ['/mask.png'] } }).refs).toHaveLength(2);
  });
  it('maps direct generic JobRefs and uses the actual selected mode count and parameter defaults', async () => {
    const configured = structuredClone(imageProfile);
    configured.models[0].modes![0].params = [{ key: 'textOnly', label: 'Text', type: 'text', default: 'text' }];
    configured.models[0].modes![1].params = [{ key: 'n', label: 'Count', type: 'number', min: 1, max: 4, default: 2 }, { key: 'quality', label: 'Quality', type: 'text', default: 'edit' }];
    configured.operations['image.edit']!.template = { image: '{{slotFirst.images}}', count: '{{param.n}}', quality: '{{param.quality}}' };
    const refs = [{ kind: 'image' as const, assetId: 'original', path: '/one.png', mime: 'image/png' }];
    const job = channelJobFromRequest(configured, 'image', { ...imageRequest, count: 3 }, 'image', { refs });
    expect(job).toMatchObject({ modeId: 'edit', operation: 'image.edit', count: 3, params: { n: 3 }, refs: [{ assetId: 'original', slot: 'images', path: '/one.png' }] });
    expect(refs[0]).not.toHaveProperty('slot');
    const rendered = await renderRequest(configured, job, '', async () => 'data:image/png;base64,FIXTURE');
    expect(rendered.request.body).toEqual({ mode: 'json', json: { image: 'data:image/png;base64,FIXTURE', count: 3, quality: 'edit' } });
    expect(() => channelJobFromRequest(configured, 'image', imageRequest, 'image', { modeId: 'missing', refs })).toThrow('未声明模式');
  });
  it('preserves legacy dual-operation routing and generate-with-ref endpoints without inventing edit operations', () => {
    const legacy = structuredClone(imageProfile); delete legacy.models[0].modes; legacy.models[0].refs = { image: 2 };
    expect(channelRequestOptions(legacy, 'image', { ...imageRequest, reference_images: ['/one.png'] })).toEqual({ modeId: undefined });
    expect(channelJobFromRequest(legacy, 'image', { ...imageRequest, reference_images: ['/one.png'] }, 'image').operation).toBe('image.edit');
    expect(channelJobFromRequest(legacy, 'image', imageRequest, 'image').operation).toBe('image.generate');
    legacy.models[0].operations = ['image.generate'];
    expect(channelJobFromRequest(legacy, 'image', { ...imageRequest, reference_images: ['/one.png'] }, 'image')).toMatchObject({ operation: 'image.generate', refs: [{ path: '/one.png' }] });
  });
  it('keeps mixed image/video models on manual mode resolution without treating video image input as image editing', () => {
    const mixed = structuredClone(imageProfile);
    mixed.models[0].modes!.unshift({ id: 'video', label: 'Video', operation: 'video.generate' });
    const request = { ...imageRequest, reference_images: ['/first-frame.png'] };
    expect(channelRequestOptions(mixed, 'image', request)).toEqual({ modeId: undefined });
    expect(channelJobFromRequest(mixed, 'image', request, 'video').operation).toBe('video.generate');
  });
});
