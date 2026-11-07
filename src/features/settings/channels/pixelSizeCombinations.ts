import type { JsonValue, ParamSpec } from '@/features/channels/domain/profile';
import { sameParameterValue } from '@/features/channels/domain/parameterValue';
import { pixelSizeChoices } from '@/features/channels/ui/sizeParameterPresentation';
import { mergeParameterOptions, type ParameterOption } from './parameterOptionSelection';

export interface PixelSizeCombination {
  ratio: string;
  resolution: string;
  option?: ParameterOption;
  suggested: boolean;
}
export interface PixelSizeCombinationConflict {
  value: JsonValue;
  options: ParameterOption[];
}

const tierLongEdges: Record<string, number> = { '1k': 1024, '2k': 2048, '4k': 4096 };
const unique = (values: string[]) => values.filter((value, index) => values.indexOf(value) === index);

function longEdge(resolution: string): number | undefined {
  const tier = tierLongEdges[resolution.trim().toLowerCase()];
  if (tier !== undefined) return tier;
  const pixels = /^(\d+)px$/i.exec(resolution.trim());
  const value = pixels ? Number(pixels[1]) : undefined;
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function separatorFor(param: ParamSpec): string {
  for (const value of [...(param.options ?? []).map(option => option.value), param.default]) {
    const match = typeof value === 'string' ? /^(\d{2,5})(\s*[x×*]\s*)(\d{2,5})$/i.exec(value) : null;
    if (match && Number(match[1]) > 0 && Number(match[3]) > 0) return match[2];
  }
  return 'x';
}

/** Suggestions require explicit UI confirmation; this function never enables or saves them. */
export function buildPixelSizeCombinations(param: ParamSpec, ratios: string[], resolutions: string[]): PixelSizeCombination[] {
  if (param.type !== 'enum') return [];
  const existing = pixelSizeChoices(param);
  const separator = separatorFor(param);
  return unique(ratios).flatMap(ratio => unique(resolutions).map(resolution => {
    const declared = existing.find(choice => choice.ratio === ratio && choice.resolution === resolution);
    if (declared) return { ratio, resolution, option: param.options?.[declared.index], suggested: false };
    const pair = /^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(ratio);
    const longest = longEdge(resolution);
    const widthRatio = pair ? Number(pair[1]) : undefined, heightRatio = pair ? Number(pair[2]) : undefined;
    if (!longest || widthRatio === undefined || heightRatio === undefined || !Number.isFinite(widthRatio) || !Number.isFinite(heightRatio)
      || widthRatio <= 0 || heightRatio <= 0) return { ratio, resolution, suggested: true };
    const shortest = Math.round(longest * Math.min(widthRatio, heightRatio) / Math.max(widthRatio, heightRatio));
    if (!Number.isSafeInteger(shortest) || shortest < 1) return { ratio, resolution, suggested: true };
    const width = widthRatio >= heightRatio ? longest : shortest, height = widthRatio >= heightRatio ? shortest : longest;
    const option: ParameterOption = { label: `${ratio} · ${resolution}`, value: `${width}${separator}${height}`, size: { ratio, resolution } };
    return { ratio, resolution, option, suggested: true };
  }));
}

/** The same wire value cannot identify two distinct ratio/tier choices in the workbench. */
export function findPixelSizeCombinationConflicts(options: ParameterOption[]): PixelSizeCombinationConflict[] {
  const choices = pixelSizeChoices({ key: 'size', label: 'Size', type: 'enum', options });
  const groups: Array<{ value: JsonValue; entries: Array<{ option: ParameterOption; size: ParameterOption['size'] }> }> = [];
  for (const [index, option] of options.entries()) {
    const size = choices.find(choice => choice.index === index);
    const entry = { option, size: size ? { ratio: size.ratio, resolution: size.resolution } : undefined };
    const group = groups.find(candidate => sameParameterValue(candidate.value, option.value));
    if (group) group.entries.push(entry);
    else groups.push({ value: option.value, entries: [entry] });
  }
  return groups.filter(group => group.entries.some(entry => entry.size?.ratio !== group.entries[0].size?.ratio
    || entry.size?.resolution !== group.entries[0].size?.resolution))
    .map(group => ({ value: group.value, options: group.entries.map(entry => entry.option) }));
}

/** Only confirmed options replace frame mappings; automatic/provider special values survive. */
export function applyPixelSizeCombinations(param: ParamSpec, options: ParameterOption[]): ParamSpec {
  if (param.type !== 'enum') return param;
  const mapped = pixelSizeChoices(param);
  const special = (param.options ?? []).filter((_, index) => !mapped.some(choice => choice.index === index));
  const selected = [...options, ...special];
  const conflicts = findPixelSizeCombinationConflicts(selected);
  if (conflicts.length) throw new Error(`同一接口尺寸不能对应不同的比例或分辨率：${conflicts.map(conflict => typeof conflict.value === 'string' ? conflict.value : JSON.stringify(conflict.value)).join('、')}`);
  const merged = mergeParameterOptions(options, special);
  const preservedDefault = merged.find(option => sameParameterValue(option.value, param.default));
  return { ...param, options: merged, default: preservedDefault ? preservedDefault.value : merged[0]?.value };
}
