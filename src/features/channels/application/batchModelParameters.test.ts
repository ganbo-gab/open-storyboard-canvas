import { describe, expect, it } from 'vitest';
import type { ChannelProfileV2, ParamSpec } from '../domain/profile';
import { renderRequest } from '../domain/template';
import { applyBatchModelParameters, listBatchModelParameterContexts, previewBatchModelParameters, type BatchModelParameterSelection } from './batchModelParameters';

const image: ParamSpec = { key: 'size', label: '尺寸', type: 'enum', default: '1024x1024', options: [
  { label: 'Square', value: '1024x1024' }, { label: 'Portrait', value: '1024x1536' },
] };
const quality: ParamSpec = { key: 'quality', label: '质量', type: 'enum', default: 'standard', options: [{ label: '标准', value: 'standard' }, { label: '高清', value: 'high' }] };
function profile(): ChannelProfileV2 {
  return { version: 2, id: 'batch', name: 'Batch', baseUrl: 'https://fixture.invalid', auth: { type: 'none' }, operations: {
    'image.generate': { method: 'POST', path: '/images', body: 'json', template: { model: '{{model}}', size: '{{param.size}}' }, response: { mode: 'sync', outputs: [] } },
    'video.generate': { method: 'POST', path: '/videos', body: 'json', template: { model: '{{model}}', seconds: '{{param.seconds}}' }, response: { mode: 'sync', outputs: [] } },
  }, models: [
    { id: 'source', label: 'Source', operations: ['image.generate'], params: [image, quality] },
    { id: 'target', label: 'Target', operations: ['image.generate'], params: [{ ...image, default: '1024x1536' }, { key: 'custom', label: 'Custom', type: 'text', default: 'keep' }] },
    { id: 'modes', label: 'Modes', operations: ['image.generate'], params: [quality], modes: [
      { id: 'wide', label: 'Wide', operation: 'image.generate', params: [{ ...image, default: '1024x1536' }] },
      { id: 'video', label: 'Video', operation: 'video.generate', params: [{ key: 'seconds', label: 'Seconds', type: 'number', min: 1, max: 10, default: 5 }], endpoint: { method: 'POST', path: '/videos', body: 'json', template: { seconds: '{{param.seconds}}' }, response: { mode: 'sync', outputs: [] } } },
    ] },
  ] };
}
const sel = (overrides: Partial<BatchModelParameterSelection> = {}): BatchModelParameterSelection => ({ source: { modelId: 'source', modeId: 'default' }, targets: [{ modelId: 'target', modeId: 'default' }], selectedKeys: ['size'], ...overrides });

describe('batch model parameter reuse', () => {
  it('lists implicit and explicit effective modes only for supported image/video operations', () => {
    expect(listBatchModelParameterContexts(profile()).map(context => `${context.modelId}/${context.modeId}`)).toEqual(['source/default', 'target/default', 'modes/wide', 'modes/video']);
  });
  it('previews same-operation changes while preserving unselected target params and default', () => {
    const result = previewBatchModelParameters(profile(), sel())[0];
    expect(result.compatible).toBe(true);
    expect(result.changes[0]).toMatchObject({ key: 'size', before: { default: '1024x1536' }, after: { default: '1024x1536' } });
    expect(result.preservedExtraCount).toBe(1);
    const changed = applyBatchModelParameters(profile(), sel());
    expect(changed.models[1].params).toContainEqual(expect.objectContaining({ key: 'custom', default: 'keep' }));
    expect(changed.models[1].params.find(param => param.key === 'size')?.default).toBe('1024x1536');
  });
  it('copies defaults only when explicitly requested and does not mutate siblings or source', () => {
    const original = profile(); const changed = applyBatchModelParameters(original, sel({ copyDefaults: true }));
    expect(changed.models[1].params.find(param => param.key === 'size')?.default).toBe('1024x1024');
    expect(original.models[1].params.find(param => param.key === 'size')?.default).toBe('1024x1536');
    expect(changed.models[1].params.find(param => param.key === 'size')).not.toBe(original.models[0].params.find(param => param.key === 'size'));
  });
  it('writes explicit mode params only and keeps public params and sibling mode untouched', () => {
    const selection = sel({ source: { modelId: 'source', modeId: 'default' }, targets: [{ modelId: 'modes', modeId: 'wide' }] });
    const changed = applyBatchModelParameters(profile(), selection);
    expect(changed.models[2].params).toEqual([quality]);
    expect(changed.models[2].modes?.[0].params).toEqual([expect.objectContaining({ key: 'size' })]);
    expect(changed.models[2].modes?.[1].params).toHaveLength(1);
  });
  it('blocks writes to legacy shared params across different uses while leaving explicit modes and source reads supported', () => {
    const original = profile();
    original.models[1].operations = ['image.generate', 'video.generate'];
    const before = structuredClone(original);
    expect(previewBatchModelParameters(original, sel())[0].reasons).toContain('目标共用参数影响多个用途，请先拆成独立模式');
    expect(() => applyBatchModelParameters(original, sel())).toThrow(/目标共用参数影响多个用途/);
    expect(original).toEqual(before);
    original.models[1].operations = ['image.generate', 'models.list'];
    expect(previewBatchModelParameters(original, sel())[0].compatible).toBe(true);
    original.models[0].operations = ['image.generate', 'video.generate'];
    expect(previewBatchModelParameters(original, sel())[0].compatible).toBe(true);
    original.models[2].operations = ['image.generate', 'video.generate'];
    const modes = sel({ targets: [{ modelId: 'modes', modeId: 'wide' }] });
    expect(previewBatchModelParameters(original, modes)[0].compatible).toBe(true);
    expect(applyBatchModelParameters(original, modes).models[2].modes![1]).toEqual(original.models[2].modes![1]);
  });
  it('overrides an inherited parameter only in the chosen mode and preserves unselected effective extras', () => {
    const original = profile();
    original.models[2].modes![0].params = [{ key: 'qualityExtra', label: 'Extra', type: 'text', default: 'unchanged' }];
    original.models[2].modes!.push({ id: 'other', label: 'Other', operation: 'image.generate', params: [image] });
    original.models[0].params[1] = { ...quality, label: 'New quality name', options: [{ label: 'High only', value: 'high' }] };
    const selection = sel({ targets: [{ modelId: 'modes', modeId: 'wide' }], selectedKeys: ['quality'] });
    const preview = previewBatchModelParameters(original, selection)[0];
    expect(preview).toMatchObject({ compatible: true, preservedExtraCount: 1, changes: [{ key: 'quality', before: { default: 'standard' }, after: { default: 'high' } }] });
    const changed = applyBatchModelParameters(original, selection);
    expect(changed.models[2].params).toEqual([quality]);
    expect(changed.models[2].modes![0].params).toEqual([
      { key: 'qualityExtra', label: 'Extra', type: 'text', default: 'unchanged' },
      expect.objectContaining({ key: 'quality', label: 'New quality name', default: 'high' }),
    ]);
    expect(listBatchModelParameterContexts(changed).find(context => context.modelId === 'modes' && context.modeId === 'other')?.params.find(param => param.key === 'quality')?.default).toBe('standard');
  });
  it('blocks different operations, type mismatches, missing template declarations and pixel/symbol formats', () => {
    expect(previewBatchModelParameters(profile(), sel({ targets: [{ modelId: 'modes', modeId: 'video' }] }))[0].compatible).toBe(false);
    const different = profile(); different.models[1].params[0] = { ...different.models[1].params[0], type: 'text' };
    expect(previewBatchModelParameters(different, sel())[0].reasons).toContain('参数 size 的值类型不同');
    const absent = profile(); absent.models[1].params = []; absent.operations['image.generate']!.template = { model: '{{model}}' };
    expect(previewBatchModelParameters(absent, sel())[0].reasons).toContain('目标请求模板未引用缺失参数：size');
    const symbol = profile(); symbol.models[1].params[0] = { key: 'size', label: '尺寸', type: 'enum', default: '2K', options: [{ label: '2K', value: '2K' }] };
    expect(previewBatchModelParameters(symbol, sel())[0].reasons).toContain('参数 size 的像素尺寸与符号分辨率格式不同');
  });
  it('rejects the source itself as a batch target even when all declarations match', () => {
    const selection = sel({ targets: [{ modelId: 'source', modeId: 'default' }] });
    expect(previewBatchModelParameters(profile(), selection)[0].reasons).toContain('来源与目标不能是同一模型模式');
    expect(() => applyBatchModelParameters(profile(), selection)).toThrow(/来源与目标不能/);
  });
  it.each([
    { value: 8 }, { value: { duration: 8, resolution: '720P' } }, { value: ['720P'] },
  ])('blocks a same-enum wire shape change to $value', ({ value }) => {
    const original = profile();
    original.models[1].params[0] = { key: 'size', label: '尺寸', type: 'enum', options: [{ label: 'Target', value }] };
    expect(previewBatchModelParameters(original, sel())[0].reasons).toContain('参数 size 的枚举接口值结构不同');
  });
  it('allows optional null sentinels while rejecting incompatible nested compound enum structures', () => {
    const original = profile();
    original.models[0].params[0].options!.push({ label: 'Provider default', value: null });
    expect(previewBatchModelParameters(original, sel())[0].compatible).toBe(true);
    original.models[0].params = [{ key: 'output', label: 'Output', type: 'enum', default: { duration: 6, resolution: '720P' }, options: [{ label: 'Source', value: { duration: 6, resolution: '720P' } }] }];
    original.models[1].params = [{ key: 'output', label: 'Output', type: 'enum', default: { duration: '6', resolution: '720P' }, options: [{ label: 'Target', value: { duration: '6', resolution: '720P' } }] }];
    expect(previewBatchModelParameters(original, sel({ selectedKeys: ['output'] }))[0].reasons).toContain('参数 output 的枚举接口值结构不同');
  });
  it('adds a source parameter only when the target request template references it', () => {
    const target = profile(); target.models[1].params = []; target.operations['image.generate']!.template = { model: '{{model}}' };
    expect(previewBatchModelParameters(target, sel())[0].compatible).toBe(false);
    target.operations['image.generate']!.template = { size: '{{param.size}}' };
    expect(previewBatchModelParameters(target, sel())[0].compatible).toBe(true);
  });
  it('uses an effective endpoint override and exact nested parameter references for additions', () => {
    const original = profile();
    original.models[0].params.push({ key: 'output', label: 'Output', type: 'enum', options: [{ label: 'HD', value: { size: 'HD' } }], default: { size: 'HD' } });
    original.models[2].modes![0].endpoint = { method: 'POST', path: '/mode', body: 'json', template: { output: '{{param.output.size}}' }, response: { mode: 'sync', outputs: [] } };
    const selection = sel({ targets: [{ modelId: 'modes', modeId: 'wide' }], selectedKeys: ['output'] });
    expect(previewBatchModelParameters(original, selection)[0].compatible).toBe(true);
    original.models[2].modes![0].endpoint!.template = { output: '{{param.outputExtra}}' };
    expect(previewBatchModelParameters(original, selection)[0].compatible).toBe(false);
    original.models[2].modes![0].endpoint!.path = '/{{param.output.size}}';
    expect(previewBatchModelParameters(original, selection)[0].compatible).toBe(false);
  });
  it.each([undefined, null])('preserves an optional target default %j even when omitted from enum options', targetDefault => {
    const original = profile(); original.models[1].params[0].default = targetDefault;
    expect(previewBatchModelParameters(original, sel())[0].changes[0].after.default).toBe(targetDefault);
    expect(applyBatchModelParameters(original, sel()).models[1].params[0].default).toBe(targetDefault);
  });
  it('falls back from an invalid target enum default to the valid source default and then the first valid option', () => {
    const original = profile(); original.models[1].params[0].default = 'removed-size';
    expect(previewBatchModelParameters(original, sel())[0].changes[0].after.default).toBe('1024x1024');
    original.models[0].params[0].default = 'invalid-source-default';
    expect(previewBatchModelParameters(original, sel())[0].changes[0].after.default).toBe('1024x1024');
    expect(previewBatchModelParameters(original, sel({ copyDefaults: true }))[0].compatible).toBe(false);
  });
  it.each([
    { source: { key: 'adjust', label: 'Value', type: 'number', min: 2, max: 10, step: 2, default: 4 }, good: 8, bad: 7, fallback: 4 },
    { source: { key: 'adjust', label: 'Value', type: 'text', default: 'source' }, good: 'target', bad: 9, fallback: 'source' },
    { source: { key: 'adjust', label: 'Value', type: 'boolean', default: true }, good: false, bad: 'false', fallback: true },
  ] satisfies Array<{ source: ParamSpec; good: ParamSpec['default']; bad: ParamSpec['default']; fallback: ParamSpec['default'] }>)('validates target $source.type defaults against the copied declaration', ({ source, good, bad, fallback }) => {
    const original = profile(); original.models[0].params = [source]; original.models[1].params = [{ ...source, default: good }];
    const selection = sel({ selectedKeys: ['adjust'] });
    expect(previewBatchModelParameters(original, selection)[0].changes[0].after.default).toBe(good);
    original.models[1].params[0].default = bad;
    expect(previewBatchModelParameters(original, selection)[0].changes[0].after.default).toBe(fallback);
  });
  it('blocks invalid numeric bounds or required missing defaults without inventing values', () => {
    const original = profile(); original.models[0].params = [{ key: 'adjust', label: 'Value', type: 'number', min: 10, max: 2, default: 4 }];
    original.models[1].params = [{ key: 'adjust', label: 'Value', type: 'number', default: 4 }];
    const selection = sel({ selectedKeys: ['adjust'] });
    expect(previewBatchModelParameters(original, selection)[0].compatible).toBe(false);
    original.models[0].params = [{ key: 'adjust', label: 'Value', type: 'number', min: 1, max: 5, required: true }];
    original.models[1].params[0].default = undefined;
    expect(previewBatchModelParameters(original, selection)[0].compatible).toBe(false);
    expect(() => applyBatchModelParameters(original, selection)).toThrow(/没有符合声明的默认值/);
  });
  it('applies atomically when any target is blocked and returns a deep independent profile', () => {
    const original = profile(); const selection = sel({ targets: [{ modelId: 'target', modeId: 'default' }, { modelId: 'modes', modeId: 'video' }] });
    expect(() => applyBatchModelParameters(original, selection)).toThrow();
    expect(original.models[1].params.find(param => param.key === 'size')?.default).toBe('1024x1536');
    const changed = applyBatchModelParameters(original, sel());
    changed.models[1].params[0].label = 'Changed';
    expect(original.models[1].params[0].label).toBe('尺寸');
  });
  it('revalidates a changed target at apply time and does not share nested values between copied targets', () => {
    const original = profile(); const selection = sel({ targets: [{ modelId: 'target', modeId: 'default' }, { modelId: 'modes', modeId: 'wide' }] });
    expect(previewBatchModelParameters(original, selection).every(target => target.compatible)).toBe(true);
    original.models[1].params[0].type = 'number';
    expect(() => applyBatchModelParameters(original, selection)).toThrow(/值类型不同/);
    original.models[1].params[0].type = 'enum';
    const changed = applyBatchModelParameters(original, selection);
    changed.models[1].params[0].options![0].label = 'Target only';
    expect(changed.models[2].modes![0].params![0].options![0].label).toBe('Square');
    expect(changed.models[0].params[0].options![0].label).toBe('Square');
    expect(changed.operations).toEqual(original.operations);
    expect(changed.auth).toEqual(original.auth);
    expect(changed.models[2].modes![1]).toEqual(original.models[2].modes![1]);
  });
  it('reports missing source/target contexts, missing selected keys, and refuses an empty batch', () => {
    expect(previewBatchModelParameters(profile(), sel({ source: { modelId: 'missing', modeId: 'default' } }))[0].compatible).toBe(false);
    expect(previewBatchModelParameters(profile(), sel({ targets: [{ modelId: 'target', modeId: 'missing' }] }))[0].compatible).toBe(false);
    expect(previewBatchModelParameters(profile(), sel({ selectedKeys: ['missing'] }))[0].compatible).toBe(false);
    expect(previewBatchModelParameters(profile(), sel({ selectedKeys: [] }))[0].compatible).toBe(false);
    expect(() => applyBatchModelParameters(profile(), sel({ targets: [] }))).toThrow(/至少选择一个目标/);
  });
  it('sends copied values through the unchanged target request template', async () => {
    const changed = applyBatchModelParameters(profile(), sel());
    const rendered = await renderRequest(changed, { jobId: 'job', channelId: 'batch', modelId: 'target', operation: 'image.generate', prompt: 'p', params: { size: '1024x1536' }, refs: [], count: 1 }, '', async () => '');
    expect(rendered.request.body).toMatchObject({ mode: 'json', json: { size: '1024x1536' } });
  });
});
