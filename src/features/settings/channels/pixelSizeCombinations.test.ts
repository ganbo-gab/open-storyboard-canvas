import { describe, expect, it } from 'vitest';
import { channelProfileSchema, type ParamSpec } from '@/features/channels/domain/profile';
import { renderRequest, resolveParamValue } from '@/features/channels/domain/template';
import { pixelSizeChoices } from '@/features/channels/ui/sizeParameterPresentation';
import type { ParameterOption } from './parameterOptionSelection';
import { applyPixelSizeCombinations, buildPixelSizeCombinations, findPixelSizeCombinationConflicts } from './pixelSizeCombinations';

const pixelParam: ParamSpec = { key: 'size', label: '尺寸', type: 'enum', default: '1024x1024', options: [
  { label: 'Square', value: '1024x1024' }, { label: 'Portrait', value: '1024x1536' }, { label: 'Automatic', value: 'auto' },
] };
function requireOption(option: ParameterOption | undefined): ParameterOption {
  if (!option) throw new Error('Expected a mapped size option');
  return option;
}

describe('independent ratio and resolution combinations', () => {
  it('preserves declared pixel and custom metadata mappings without changing their wire values', () => {
    const custom: ParameterOption = { label: 'Provider cinema', value: 'cinema-native', size: { ratio: '2:1', resolution: 'Studio' } };
    const param = { ...pixelParam, options: [...pixelParam.options!, custom] };
    const before = structuredClone(param);
    const choices = buildPixelSizeCombinations(param, ['1:1', '2:3', '2:1'], ['1K', '1536px', 'Studio']);
    expect(choices.find(choice => choice.ratio === '1:1' && choice.resolution === '1K')).toEqual({ ratio: '1:1', resolution: '1K', option: param.options[0], suggested: false });
    expect(choices.find(choice => choice.ratio === '2:3' && choice.resolution === '1536px')?.option).toBe(param.options[1]);
    expect(choices.find(choice => choice.ratio === '2:1' && choice.resolution === 'Studio')).toEqual({ ratio: '2:1', resolution: 'Studio', option: custom, suggested: false });
    expect(param).toEqual(before);
  });

  it('builds only the explicitly requested combinations and leaves them unapplied', () => {
    const before = structuredClone(pixelParam);
    const choices = buildPixelSizeCombinations(pixelParam, ['3:2', '2:3'], ['1K', '2K']);
    expect(choices.map(choice => [choice.ratio, choice.resolution, choice.option?.value, choice.suggested])).toEqual([
      ['3:2', '1K', '1024x683', true], ['3:2', '2K', '2048x1365', true],
      ['2:3', '1K', '683x1024', true], ['2:3', '2K', '1365x2048', true],
    ]);
    expect(choices[0].option?.size).toEqual({ ratio: '3:2', resolution: '1K' });
    expect(pixelSizeChoices({ ...pixelParam, options: [requireOption(choices[0].option)] })[0]).toMatchObject({ ratio: '3:2', resolution: '1K' });
    expect(pixelParam).toEqual(before);
    expect(buildPixelSizeCombinations(pixelParam, [], ['1K'])).toEqual([]);
    expect(buildPixelSizeCombinations(pixelParam, ['1:1'], [])).toEqual([]);
  });

  it.each(['x', 'X', '*', '×', ' × '])('uses the original %j pixel separator for new dimensions', separator => {
    const param: ParamSpec = { ...pixelParam, options: [{ label: 'Original', value: `1024${separator}1536` }] };
    const [choice] = buildPixelSizeCombinations(param, ['16:9'], ['4K']);
    expect(choice.option?.value).toBe(`4096${separator}2304`);
    expect(choice.option?.size).toEqual({ ratio: '16:9', resolution: '4K' });
  });

  it('supports explicit pixel long edges and fractional numeric aspect ratios', () => {
    const choices = buildPixelSizeCombinations(pixelParam, ['4:5', '1.85:1'], ['1536px']);
    expect(choices.map(choice => choice.option?.value)).toEqual(['1229x1536', '1536x830']);
    expect(choices[0].option?.size).toEqual({ ratio: '4:5', resolution: '1536px' });
    expect(buildPixelSizeCombinations(pixelParam, ['9:16'], ['2k'])[0].option?.value).toBe('1152x2048');
  });

  it.each([
    ['16:9', '720P'], ['16:9', 'HD'], ['16:9', 'unknown'], ['16:9', '0px'],
    ['auto', '1K'], ['16/9', '1K'], ['0:9', '1K'], ['-1:1', '1K'], ['1:0', '1K'], ['1:100000', '1px'],
  ])('leaves %j and %j unresolved so the user must supply the actual API size', (ratio, resolution) => {
    expect(buildPixelSizeCombinations(pixelParam, [ratio], [resolution])).toEqual([{ ratio, resolution, suggested: true }]);
  });

  it('keeps unique requested pairs in order and falls back to x only when no pixel dialect exists', () => {
    const param: ParamSpec = { key: 'size', label: '尺寸', type: 'enum', options: [{ label: 'Auto', value: 'auto' }] };
    expect(buildPixelSizeCombinations(param, ['1:1', '1:1'], ['1K', '1K']).map(choice => choice.option?.value)).toEqual(['1024x1024']);
    expect(buildPixelSizeCombinations({ ...param, type: 'text' }, ['1:1'], ['1K'])).toEqual([]);
  });

  it('applies selected frame options while preserving automatic and other special values and their default', () => {
    const automatic: ParameterOption = { label: 'Automatic', value: 'auto' };
    const nativeSpecial: ParameterOption = { label: 'Provider preset', value: { mode: 'source' } };
    const param: ParamSpec = { ...pixelParam, default: 'auto', required: true, sizeDisplay: 'ratio-resolution',
      options: [pixelParam.options![0], automatic, nativeSpecial] };
    const before = structuredClone(param);
    const [choice] = buildPixelSizeCombinations(param, ['4:3'], ['2K']);
    const applied = applyPixelSizeCombinations(param, [requireOption(choice.option)]);
    expect(applied.options?.map(option => option.value)).toEqual(['2048x1536', 'auto', { mode: 'source' }]);
    expect(applied.options?.[1]).toBe(automatic);
    expect(applied.options?.[2]).toBe(nativeSpecial);
    expect(applied.default).toBe('auto');
    expect(applied.required).toBe(true);
    expect(applied.sizeDisplay).toBe('ratio-resolution');
    expect(resolveParamValue(applied, undefined)).toBe('auto');
    expect(param).toEqual(before);
  });

  it('replaces removed defaults with a remaining value and clears them when no values remain', () => {
    const selected = requireOption(buildPixelSizeCombinations(pixelParam, ['16:9'], ['2K'])[0].option);
    const applied = applyPixelSizeCombinations(pixelParam, [selected]);
    expect(applied.default).toBe('2048x1152');
    expect(resolveParamValue(applied, undefined)).toBe('2048x1152');
    expect(() => resolveParamValue(applied, '1024x1024')).toThrow(/不符合声明/);
    const onlyPixels: ParamSpec = { ...pixelParam, options: [pixelParam.options![0]] };
    expect(applyPixelSizeCombinations(onlyPixels, [])).toMatchObject({ options: [], default: undefined });
    expect(applyPixelSizeCombinations(pixelParam, []).default).toBe('auto');
  });

  it('preserves a declared null default as an omitted optional API parameter', () => {
    const param: ParamSpec = { ...pixelParam, default: null, options: [...pixelParam.options!, { label: 'Provider default', value: null }] };
    const selected = requireOption(buildPixelSizeCombinations(param, ['4:3'], ['2K'])[0].option);
    const applied = applyPixelSizeCombinations(param, [selected]);
    expect(applied.default).toBeNull();
    expect(resolveParamValue(applied, undefined)).toBeUndefined();
  });

  it('reports the same wire dimensions assigned to distinct pairs instead of dropping a choice', () => {
    const combinations = buildPixelSizeCombinations(pixelParam, ['1:1', '2:2'], ['1K']);
    const options = combinations.map(choice => requireOption(choice.option));
    const conflicts = findPixelSizeCombinationConflicts(options);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].value).toBe('1024x1024');
    expect(conflicts[0].options).toEqual(options);
    expect(() => applyPixelSizeCombinations(pixelParam, options)).toThrow(/同一接口尺寸不能对应不同的比例或分辨率/);
    expect(pixelParam.options).toHaveLength(3);
  });

  it('detects conflicts for semantic JSON wire values and prevents special values from being remapped', () => {
    const first: ParameterOption = { label: 'First', value: { width: 1000, height: 500 }, size: { ratio: '2:1', resolution: '1000px' } };
    const second: ParameterOption = { label: 'Second', value: { height: 500, width: 1000 }, size: { ratio: '16:9', resolution: '1000px' } };
    expect(findPixelSizeCombinationConflicts([first, second])).toHaveLength(1);
    expect(() => applyPixelSizeCombinations(pixelParam, [{ label: 'Bad auto mapping', value: 'auto', size: { ratio: '1:1', resolution: '1K' } }])).toThrow(/auto/);
    const same: ParameterOption = { ...first, label: 'Duplicate' };
    expect(findPixelSizeCombinationConflicts([first, same])).toEqual([]);
    expect(applyPixelSizeCombinations({ ...pixelParam, options: [] }, [first, same]).options).toEqual([first]);
  });

  it('sends explicitly applied rounded dimensions unchanged through the original request template', async () => {
    const param: ParamSpec = { ...pixelParam, options: [{ label: 'Original', value: '1024*1024' }], default: '1024*1024' };
    const applied = applyPixelSizeCombinations(param, [requireOption(buildPixelSizeCombinations(param, ['3:2'], ['1K'])[0].option)]);
    const profile = channelProfileSchema.parse({ version: 2, id: 'combined', name: 'Combined', baseUrl: 'https://fixture.invalid', auth: { type: 'none' },
      operations: { 'image.generate': { method: 'POST', path: '/images', body: 'json', template: { size: '{{param.size}}' }, response: { mode: 'sync', outputs: [] } } },
      models: [{ id: 'image', operations: ['image.generate'], params: [applied] }] });
    const { request } = await renderRequest(profile, { jobId: 'fixture', channelId: profile.id, modelId: 'image', operation: 'image.generate', prompt: 'Combined frame', params: {}, refs: [], count: 1 }, '', async () => '');
    expect(request.body).toEqual({ mode: 'json', json: { size: '1024*683' } });
    expect(applied.options?.[0].size).toEqual({ ratio: '3:2', resolution: '1K' });
  });
});
