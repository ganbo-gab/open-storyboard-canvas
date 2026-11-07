import { describe, expect, it } from 'vitest';
import type { ParamSpec } from '@/features/channels/domain/profile';
import { resolveParamValue } from '@/features/channels/domain/template';
import { commonFrameOptions, isFrameChoiceParameter, mergeParameterOptions, setParameterOptionEnabled, type ParameterOption } from './parameterOptionSelection';

const sizeParam = (options: ParameterOption[], rest: Partial<ParamSpec> = {}): ParamSpec => ({ key: 'size', label: '尺寸', type: 'enum', options, ...rest });
const choice = (value: string): ParameterOption => ({ label: value, value });

describe('channel frame option selection', () => {
  it('limits frame checkboxes to declared enum size or ratio fields', () => {
    for (const key of ['size', 'resolution', 'resolutionType', 'imageSize', 'image_size', 'aspectRatio', 'aspect_ratio', 'ratio']) {
      expect(isFrameChoiceParameter(sizeParam([], { key }))).toBe(true);
    }
    expect(isFrameChoiceParameter(sizeParam([], { key: 'quality' }))).toBe(false);
    expect(isFrameChoiceParameter(sizeParam([], { type: 'text' }))).toBe(false);
    expect(commonFrameOptions(sizeParam([], { key: 'quality' }))).toEqual([]);
  });

  it('offers familiar ratio candidates without adding them to the declaration or inventing auto', () => {
    const param = sizeParam([choice('16:9'), choice('adaptive')], { key: 'ratio', default: 'adaptive' });
    const before = structuredClone(param);
    const candidates = commonFrameOptions(param);
    expect(candidates.map(entry => entry.value)).toEqual(['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16', '21:9', '9:21', '2:1', '1:2', '4:5', '5:4']);
    expect(param).toEqual(before);
    expect(param.options).toHaveLength(2);
    expect(candidates.some(entry => entry.value === 'auto' || entry.value === 'adaptive')).toBe(false);
  });

  it.each(['x', 'X', '*', '×', ' × '])('keeps the declared pixel separator %j for explicit examples', separator => {
    const param = sizeParam([choice(`1010${separator}777`), choice('auto')]);
    const candidates = commonFrameOptions(param).map(entry => entry.value);
    expect(candidates).toContain(`1024${separator}1024`);
    expect(candidates).toContain(`1536${separator}1024`);
    expect(candidates).toContain(`1920${separator}1080`);
    expect(candidates).not.toContain(`1010${separator}1010`);
    expect(param.options?.map(entry => entry.value)).toEqual([`1010${separator}777`, 'auto']);
  });

  it.each(['K', 'k', 'P', 'p'])('keeps symbolic tier family and casing %s', suffix => {
    const param = sizeParam([choice(suffix.toLowerCase() === 'k' ? `2${suffix}` : `720${suffix}`)]);
    const candidates = commonFrameOptions(param).map(entry => entry.value);
    expect(candidates).toContain(suffix.toLowerCase() === 'k' ? `4${suffix}` : `1080${suffix}`);
    expect(candidates.every(value => typeof value === 'string' && value.endsWith(suffix))).toBe(true);
    expect(candidates.some(value => typeof value === 'string' && /[x*×:]/.test(value))).toBe(false);
  });

  it('does not guess a dialect for unknown, automatic or object values', () => {
    for (const options of [[choice('auto')], [choice('provider-square')], [{ label: 'Output', value: { width: 1024, height: 1536 } }]]) {
      expect(commonFrameOptions(sizeParam(options))).toEqual([]);
    }
    expect(commonFrameOptions(sizeParam([]))).toEqual([]);
    expect(commonFrameOptions(sizeParam([], { default: '2k' })).map(entry => entry.value)).toContain('4k');
  });

  it('merges by exact JSON semantics while preserving the first label and custom metadata', () => {
    const original: ParameterOption = { label: 'Provider landscape', value: { width: 1536, height: 1024 }, size: { ratio: '3:2', resolution: 'HD' } };
    const equivalent: ParameterOption = { label: 'Candidate', value: { height: 1024, width: 1536 } };
    const first = [original, choice('auto')];
    const result = mergeParameterOptions(first, [equivalent, choice('1024x1024')], [choice('auto')]);
    expect(result).toHaveLength(3);
    expect(result[0]).toBe(original);
    expect(result[0].size).toEqual({ ratio: '3:2', resolution: 'HD' });
    expect(first).toEqual([original, choice('auto')]);
    expect(mergeParameterOptions([{ label: 'Numeric', value: 1 }], [choice('1')])).toHaveLength(2);
  });

  it('enables only the selected candidate and keeps existing metadata and the default', () => {
    const original: ParameterOption = { label: 'Portrait', value: '1024x1536', size: { ratio: '2:3', resolution: '1536px' } };
    const param = sizeParam([original, choice('auto')], { default: 'auto', sizeDisplay: 'ratio-resolution' });
    const candidate = commonFrameOptions(param).find(entry => entry.value === '1024x1024')!;
    const enabled = setParameterOptionEnabled(param, candidate, true);
    expect(enabled.options?.map(entry => entry.value)).toEqual(['1024x1536', 'auto', '1024x1024']);
    expect(enabled.options?.[0]).toBe(original);
    expect(enabled.default).toBe('auto');
    expect(enabled.sizeDisplay).toBe('ratio-resolution');
    expect(setParameterOptionEnabled(enabled, { label: 'Renamed', value: original.value }, true).options?.[0]).toBe(original);
    expect(param.options).toEqual([original, choice('auto')]);
  });

  it('moves a removed default to the first remaining supported value so request validation still succeeds', () => {
    const param = sizeParam([choice('auto'), choice('1024x1536'), choice('1024x1024')], { default: 'auto', required: true });
    const next = setParameterOptionEnabled(param, choice('auto'), false);
    expect(next.default).toBe('1024x1536');
    expect(next.options?.map(entry => entry.value)).toEqual(['1024x1536', '1024x1024']);
    expect(resolveParamValue(next, undefined)).toBe('1024x1536');
    expect(() => resolveParamValue(next, 'auto')).toThrow(/不符合声明/);
    expect(param.default).toBe('auto');
  });

  it('clears the default after removing its last option instead of retaining an invalid wire value', () => {
    const next = setParameterOptionEnabled(sizeParam([choice('auto')], { default: 'auto' }), choice('auto'), false);
    expect(next.options).toEqual([]);
    expect(next.default).toBeUndefined();
    expect(resolveParamValue(next, undefined)).toBeUndefined();
    expect(() => resolveParamValue({ ...next, required: true }, undefined)).toThrow(/缺少必填参数/);
  });

  it('preserves special auto and unset defaults when unrelated choices change', () => {
    const param = sizeParam([choice('auto'), choice('1024x1024')], { default: 'auto' });
    expect(setParameterOptionEnabled(param, choice('1024x1024'), false).default).toBe('auto');
    const unset = sizeParam([choice('1024x1024')]);
    expect(setParameterOptionEnabled(unset, choice('2048x2048'), true).default).toBeUndefined();
    const text: ParamSpec = { key: 'size', label: '尺寸', type: 'text', default: 'custom' };
    expect(setParameterOptionEnabled(text, choice('1024x1024'), true)).toBe(text);
  });
});
