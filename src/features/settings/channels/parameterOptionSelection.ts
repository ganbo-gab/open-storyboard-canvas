import { RATIO_PARAM_KEYS, SIZE_PARAM_KEYS, type ParamSpec } from '@/features/channels/domain/profile';
import { sameParameterValue } from '@/features/channels/domain/parameterValue';

export type ParameterOption = NonNullable<ParamSpec['options']>[number];

const commonRatios = ['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16', '21:9', '9:21', '2:1', '1:2', '4:5', '5:4'];
// Explicit examples only: these are not a promise of provider support or a ratio/tier product.
const commonPixels = [
  [512, 512], [768, 768], [1024, 1024], [1536, 1024], [1024, 1536], [2048, 2048],
  [1280, 720], [720, 1280], [1920, 1080], [1080, 1920], [2560, 1440], [1440, 2560],
  [3840, 2160], [2160, 3840], [4096, 4096],
  [1024, 768], [768, 1024], [1280, 1024], [1024, 1280],
  [2048, 1024], [1024, 2048], [1792, 768], [768, 1792],
];
const commonK = [1, 2, 4, 8];
const commonP = [480, 512, 720, 768, 1080, 1440, 2160];
const option = (value: string): ParameterOption => ({ label: value, value });

export function isFrameChoiceParameter(param: ParamSpec): boolean {
  return param.type === 'enum' && (SIZE_PARAM_KEYS.includes(param.key) || RATIO_PARAM_KEYS.includes(param.key));
}

/** Suggestions remain disabled until selected; never rewrite existing provider values. */
export function commonFrameOptions(param: ParamSpec): ParameterOption[] {
  if (!isFrameChoiceParameter(param)) return [];
  if (RATIO_PARAM_KEYS.includes(param.key)) return commonRatios.map(option);
  const values = [...(param.options ?? []).map(entry => entry.value), param.default];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const pixels = /^(\d{2,5})(\s*[x*×]\s*)(\d{2,5})$/i.exec(value);
    if (pixels && Number(pixels[1]) > 0 && Number(pixels[3]) > 0) {
      return commonPixels.map(([width, height]) => option(`${width}${pixels[2]}${height}`));
    }
    const tier = /^(\d+(?:\.\d+)?)([kKpP])$/.exec(value);
    if (tier && Number(tier[1]) > 0) {
      const levels = tier[2].toLowerCase() === 'k' ? commonK : commonP;
      return levels.map(level => option(`${level}${tier[2]}`));
    }
  }
  return [];
}

/** Earlier lists own labels and metadata for semantically equal JSON values. */
export function mergeParameterOptions(...lists: ParameterOption[][]): ParameterOption[] {
  const merged: ParameterOption[] = [];
  for (const list of lists) for (const entry of list) {
    if (!merged.some(existing => sameParameterValue(existing.value, entry.value))) merged.push(entry);
  }
  return merged;
}

export function setParameterOptionEnabled(param: ParamSpec, entry: ParameterOption, enabled: boolean): ParamSpec {
  if (param.type !== 'enum') return param;
  const options = enabled ? mergeParameterOptions(param.options ?? [], [entry])
    : (param.options ?? []).filter(existing => !sameParameterValue(existing.value, entry.value));
  const removedDefault = !enabled && param.default !== undefined && sameParameterValue(param.default, entry.value);
  return { ...param, options, ...(removedDefault ? { default: options[0]?.value } : {}) };
}
