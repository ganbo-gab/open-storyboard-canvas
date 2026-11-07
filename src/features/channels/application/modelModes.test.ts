import { describe, expect, it, vi } from 'vitest';
import { channelProfileSchema, validateProfile, type ChannelProfileV2, type JsonValue } from '../domain/profile';
import { renderPreview, renderRequest } from '../domain/template';
import type { JobInput, JobRef } from '../runtime/types';
import { channelParameterValues } from './channelCatalog';
import { listModelModes, modeParamDefaults, resolveModelMode, resolveModelModeOrFirst, retainModeState } from './modelModes';

function profile(): ChannelProfileV2 {
  return { version: 2, id: 'modes', name: '多模式', baseUrl: 'https://modes.example', auth: { type: 'none' }, operations: {
    'video.generate': { method: 'POST', path: '/text/{{mode}}', body: 'json', template: { model: '{{model}}', prompt: '{{prompt}}', seconds: '{{param.seconds}}' }, response: { mode: 'sync', outputs: [] } },
  }, models: [{ id: 'video', operations: ['video.generate'], params: [
    { key: 'seconds', label: '时长', type: 'number', min: 1, max: 10, default: 5, group: 'basic' },
  ], modes: [
    { id: 'text', label: '文生视频', operation: 'video.generate', slots: [] },
    { id: 'frames', label: '首尾帧', operation: 'video.generate', description: '首帧与可选尾帧', params: [
      { key: 'seconds', label: '时长', type: 'enum', required: true, options: [{ label: '八秒', value: 8 }] },
      { key: 'seed', label: '种子', type: 'number', min: 0, max: 10, step: 2, group: 'advanced', description: '可选种子' },
    ], slots: [{ key: 'first_frame', label: '首帧', kind: 'image', min: 1, max: 1 },
      { key: 'last_frame', label: '尾帧', kind: 'image', max: 1 }, { key: 'reference_image', label: '参考图', kind: 'image', max: 3 }],
    endpoint: { method: 'POST', path: '/frames/{{mode}}', body: 'json', imageEncoding: 'url',
      template: { mode: '{{mode}}', first: '{{slotFirst.first_frame}}', last: '{{slotFirst.last_frame}}', references: '{{slot.reference_image}}', seconds: '{{param.seconds}}', seed: '{{param.seed}}' },
      response: { mode: 'sync', outputs: [] } } },
  ] }] };
}
const ref = (slot: string, assetId = slot): JobRef => ({ kind: 'image', slot, assetId, path: `/${assetId}.png`, mime: 'image/png' });
function job(): JobInput {
  return { jobId: 'job', channelId: 'modes', modelId: 'video', modeId: 'frames', operation: 'video.generate', prompt: '猫', params: { seconds: 8 }, refs: [ref('first_frame')], count: 1 };
}

describe('model modes and strict declarations', () => {
  it('resolves effective params by key, preserves metadata and keeps defaults out of wire fields', () => {
    const model = profile().models[0];
    expect(listModelModes(model).map((entry) => entry.mode.id)).toEqual(['text', 'frames']);
    const frames = resolveModelMode(model, 'frames');
    expect(frames.params.map((param) => [param.key, param.type])).toEqual([['seconds', 'enum'], ['seed', 'number']]);
    expect(frames.params[1]).toMatchObject({ group: 'advanced', description: '可选种子' });
    expect(modeParamDefaults(frames)).toEqual({});
    expect(modeParamDefaults(resolveModelMode(model))).toEqual({ seconds: 5 });
    expect(frames.operationSpec?.path).toBe('/frames/{{mode}}');
    expect(() => resolveModelMode(model, 'missing')).toThrow('未声明模式');
    expect(validateProfile(profile())).toEqual([]);
  });
  it('exposes one implicit legacy mode without changing model declarations', () => {
    const model = profile().models[0]; delete model.modes;
    expect(listModelModes(model)).toMatchObject([{ mode: { id: 'default', operation: 'video.generate' }, params: model.params, slots: [] }]);
    expect(resolveModelMode(model, 'default').operationSpec).toBeUndefined();
    model.refs = { image: 2, video: 1, audio: 0 };
    expect(resolveModelMode(model).slots).toEqual([
      { key: 'image', label: '参考图', kind: 'image', max: 2 }, { key: 'video', label: '参考视频', kind: 'video', max: 1 },
    ]);
  });
  it.each([
    ['mode', '模式 ID 重复'], ['slot', '槽位名重复'], ['bounds', '槽位上限不能小于下限'], ['param', '参数名重复'],
  ])('rejects %s collisions or invalid bounds in Chinese', (kind, message) => {
    const p = profile(); const modes = p.models[0].modes!;
    if (kind === 'mode') modes.push({ ...modes[0] });
    if (kind === 'slot') modes[1].slots!.push({ ...modes[1].slots![0] });
    if (kind === 'bounds') modes[1].slots![0].min = 2;
    if (kind === 'param') modes[1].params!.push({ ...modes[1].params![0] });
    expect(validateProfile(p)).toContainEqual(expect.objectContaining({ message }));
  });
  it('rejects unknown fields in modes, slots and endpoint overrides', () => {
    for (const kind of ['mode', 'slot', 'endpoint']) {
      const p = profile(); const mode = p.models[0].modes![1];
      Object.assign(kind === 'mode' ? mode : kind === 'slot' ? mode.slots![0] : mode.endpoint!, { invented: true });
      expect(validateProfile(p)).toContainEqual(expect.objectContaining({ message: '不允许未知字段：invented' }));
    }
  });
  it('validates shared templates against only the modes which use them and override templates against their own declarations', () => {
    const p = profile();
    p.operations['video.generate']!.template = { missing: '{{slot.first_frame}}' };
    expect(validateProfile(p)).toContainEqual(expect.objectContaining({ message: '模型 video 模式 text 未声明槽位 first_frame' }));
    p.operations['video.generate']!.template = { seconds: '{{param.seconds}}' };
    p.models[0].modes![1].endpoint!.template = { absent: '{{param.unknown}}', bad: '{{slot.unknown}}', unknown: '{{unknown}}' };
    expect(validateProfile(p).map((error) => error.message)).toEqual(expect.arrayContaining([
      '模型 video 模式 frames 未声明参数 unknown', '模型 video 模式 frames 未声明槽位 unknown', '未声明的模板变量 unknown',
    ]));
  });
  it('allows a mode to supply the entire operation without a channel-level operation', () => {
    const p = profile(); p.models[0].modes = [p.models[0].modes![1]]; delete p.operations['video.generate'];
    expect(channelProfileSchema.safeParse(p).success).toBe(true);
    expect(renderPreview(p, job()).url).toBe('https://modes.example/frames/frames');
  });
  it('falls back to the first mode for a stale persisted mode id in the UI only', () => {
    const model = profile().models[0];
    expect(resolveModelModeOrFirst(model, 'removed').mode.id).toBe('text');
    expect(resolveModelModeOrFirst(model, 'frames').mode.id).toBe('frames');
    expect(() => resolveModelMode(model, 'removed')).toThrow(/未声明模式/);
  });
  it('carries only declared params and slots across a mode switch, trimmed to each slot maximum', () => {
    const [text, frames] = listModelModes(profile().models[0]);
    const params = { seconds: 8, seed: 4, legacyFlag: true };
    const slots = { first_frame: ['a', 'b'], reference_image: ['r1', 'r2', 'r3', 'r4'], video_ref: ['v'] };
    expect(retainModeState(frames, params, slots)).toEqual({
      params: { seconds: 8, seed: 4 },
      slots: { first_frame: ['a'], reference_image: ['r1', 'r2', 'r3'] },
    });
    expect(retainModeState(text, params, slots)).toEqual({ params: { seconds: 8 }, slots: {} });
  });
  it('lists picker values from every mode with the declared default first', () => {
    const model = profile().models[0];
    expect(channelParameterValues(model, ['seconds'])).toEqual(['5', '8']);
    expect(channelParameterValues(model, ['size'])).toEqual([]);
  });
});

describe('mode-aware shared request rendering', () => {
  it('renders typed slot arrays/first values, omits optional slots and masks only preview bytes', async () => {
    const p = profile(); const input = job(); input.refs.push(ref('reference_image', 'r1'), ref('reference_image', 'r2'));
    const resolve = vi.fn(async (reference: JobRef, _encoding: string) => `https://assets.example/${reference.assetId}`);
    const rendered = await renderRequest(p, input, '', resolve);
    expect(rendered.request.body).toEqual({ mode: 'json', json: { mode: 'frames', first: 'https://assets.example/first_frame', references: ['https://assets.example/r1', 'https://assets.example/r2'], seconds: 8 } });
    expect(rendered.preview).toEqual(renderPreview(p, input));
    expect(JSON.stringify(rendered.preview)).not.toContain('https://assets.example');
    expect(resolve.mock.calls.every(([, encoding]) => encoding === 'url')).toBe(true);
  });
  it('resolves only referenced slots and only the first ref for slotFirst, including query templates', async () => {
    const p = profile(); p.models[0].modes![1].endpoint!.template = { first: '{{slotFirst.reference_image}}' };
    p.models[0].modes![1].endpoint!.path = '/frames?first={{slotFirst.first_frame}}';
    const input = job(); input.refs.push(ref('last_frame'), ref('reference_image', 'r1'), ref('reference_image', 'r2'));
    const resolve = vi.fn(async (reference: JobRef) => reference.assetId);
    const rendered = await renderRequest(p, input, '', resolve);
    expect(resolve.mock.calls.map(([reference]) => reference.assetId)).toEqual(['first_frame', 'r1']);
    expect(rendered.request.body).toEqual({ mode: 'json', json: { first: 'r1' } });
  });
  it.each<Record<string, JsonValue>>([
    { seconds: 5 }, { seconds: '八秒' }, { seconds: 8, seed: 11 }, { seconds: 8, seed: -1 }, { seconds: 8, seed: 3 }, {},
  ])('blocks invalid or absent effective params %j', (params) => {
    expect(() => renderPreview(profile(), { ...job(), params })).toThrow(/参数/);
  });
  it('rejects unassigned, wrong-kind and missing required slot refs and mismatched operation', () => {
    for (const refs of [[], [{ ...ref('first_frame'), slot: undefined }], [{ ...ref('first_frame'), kind: 'video' as const }], [ref('first_frame'), ref('first_frame', 'duplicate')]]) {
      expect(() => renderPreview(profile(), { ...job(), refs })).toThrow(/槽位/);
    }
    expect(() => renderPreview(profile(), { ...job(), operation: 'image.generate' })).toThrow('不一致');
  });
  it('renders Seedance roles explicitly from slots across image, video and audio', async () => {
    const p = profile(); const mode = p.models[0].modes![1]; mode.endpoint!.template = { content: '{{seedanceContent}}' };
    mode.slots!.push({ key: 'reference_video', label: '视频', kind: 'video', max: 1 }, { key: 'reference_audio', label: '音频', kind: 'audio', max: 1 });
    const input = job(); input.refs.push({ ...ref('reference_video'), kind: 'video' }, { ...ref('reference_audio'), kind: 'audio' });
    const rendered = await renderRequest(p, input, '', async (reference) => reference.assetId);
    expect(rendered.request.body).toEqual({ mode: 'json', json: { content: [
      { type: 'image_url', image_url: { url: 'first_frame' }, role: 'first_frame' },
      { type: 'video_url', video_url: { url: 'reference_video' }, role: 'reference_video' },
      { type: 'audio_url', audio_url: { url: 'reference_audio' }, role: 'reference_audio' }, { type: 'text', text: '猫' },
    ] } });
  });
  it('renders Wan typed media with explicit slot roles and omits media for text-only modes', async () => {
    const p = profile(); const mode = p.models[0].modes![1]; mode.endpoint!.template = { media: '{{wanMedia}}' };
    mode.slots!.push({ key: 'reference_video', label: '视频', kind: 'video', max: 1 });
    const input = job(); input.refs.push({ ...ref('reference_video'), kind: 'video' });
    const resolve = vi.fn(async (reference: JobRef) => reference.assetId);
    const rendered = await renderRequest(p, input, '', resolve);
    expect(rendered.request.body).toEqual({ mode: 'json', json: { media: [
      { type: 'first_frame', url: 'first_frame' }, { type: 'reference_video', url: 'reference_video' },
    ] } });
    expect(resolve).toHaveBeenCalledTimes(2);
    p.operations['video.generate']!.template = { media: '{{wanMedia}}' };
    expect(renderPreview(p, { ...job(), modeId: 'text', refs: [], params: {} }).body).toEqual({ mode: 'json', json: {} });
  });
});
