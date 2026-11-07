import { describe, expect, it } from 'vitest';
import { numericParameterOptions, parameterSummary, sameParameterValue } from './parameterPresentation';
import type { ParamSpec } from '../domain/profile';

describe('channel parameter presentation', () => {
  it('uses the declared label for object-valued dimensions', () => {
    const params: ParamSpec[] = [{ key: 'size', label: '尺寸', type: 'enum', default: { width: 1280, height: 720 }, options: [{ label: '1280 × 720', value: { width: 1280, height: 720 } }] }];
    expect(parameterSummary(params, {})).toEqual(['1280 × 720']);
  });
  it('keeps sparse durations on their declared stops and excludes nonnumeric options', () => {
    const options = [1, 2, 4, 8, 12, 18].map((value) => ({ label: `${value}s`, value }));
    const param: ParamSpec = { key: 'duration', label: '时长', type: 'enum', options };
    expect(numericParameterOptions(param)).toEqual([1, 2, 4, 8, 12, 18]);
    expect(numericParameterOptions({ ...param, options: [...options, { label: '自动', value: 'auto' }] })).toBeNull();
  });
  it('treats restored JSON object order as irrelevant without coercing wire scalar types or array order', () => {
    expect(sameParameterValue({ output: { width: 1280, height: 720 }, formats: ['png', 'webp'] }, { formats: ['png', 'webp'], output: { height: 720, width: 1280 } })).toBe(true);
    expect(sameParameterValue({ seconds: 18 }, { seconds: '18' })).toBe(false);
    expect(sameParameterValue({ output: [1, 2] }, { output: [2, 1] })).toBe(false);
    expect(sameParameterValue({ width: 1280 }, { width: 1280, height: 720 })).toBe(false);
  });
});
