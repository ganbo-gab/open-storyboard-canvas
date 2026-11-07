import type { ParamSpec } from '../domain/profile';

import { sameParameterValue } from '../domain/parameterValue';
import { pixelSizeChoices } from './sizeParameterPresentation';
export { sameParameterValue } from '../domain/parameterValue';

const friendlyLabels: Record<string, string> = { size: '画面尺寸', aspectRatio: '画面比例', aspect_ratio: '画面比例', ratio: '画面比例', webHook: '回调地址', shutProgress: '关闭进度推送', duration: '时长', seconds: '时长', n: '数量', count: '数量' };
export function parameterDisplayName(param: ParamSpec): string { return param.label === param.key ? friendlyLabels[param.key] ?? param.label : param.label; }
export function parameterIsAdvanced(param: ParamSpec): boolean { return param.group === 'advanced' || (!param.group && ['webHook', 'shutProgress'].includes(param.key)); }

export function parameterLabel(param: ParamSpec, value: unknown): string {
  if (param.sizeDisplay === 'ratio-resolution') {
    const index = param.options?.findIndex(option => sameParameterValue(option.value, value));
    const size = pixelSizeChoices(param).find(choice => choice.index === index);
    if (size) return `${size.ratio} · ${size.resolution}`;
  }
  const option = param.options?.find((item) => sameParameterValue(item.value, value));
  if (option) return option.label;
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

/** Slider stops always refer to declared values, including sparse numeric choices. */
export function numericParameterOptions(param: ParamSpec): number[] | null {
  if (param.type !== 'enum' || !param.options || param.options.length < (param.display === 'slider' ? 2 : 6)) return null;
  const values = param.options.map((option) => typeof option.value === 'number' ? option.value
    : typeof option.value === 'string' && /^\d+(\.\d+)?$/.test(option.value) ? Number(option.value) : NaN);
  if (values.some((value) => !Number.isFinite(value))) return null;
  return values.every((value, index) => index === 0 || value > values[index - 1]) ? values : null;
}

export function parameterSummary(params: ParamSpec[], values: Record<string, unknown>): string[] {
  return params.filter((param) => param.display !== 'hidden' && ['ratio', 'aspect_ratio', 'aspectRatio', 'size', 'resolution', 'duration', 'seconds', 'n', 'count'].includes(param.key))
    .map((param) => parameterLabel(param, values[param.key] ?? param.default)).filter(Boolean);
}
