import type { ParamSpec } from '../domain/profile';
import { sameParameterValue } from '../domain/parameterValue';

export interface SizeChoice { index: number; ratio: string; resolution: string; label: string }
const gcd = (left: number, right: number): number => right === 0 ? left : gcd(right, left % right);

/** UI metadata only. Every selection always resolves to an existing, unchanged API value. */
export function pixelSizeChoices(param: ParamSpec): SizeChoice[] {
  if (param.type !== 'enum') return [];
  return (param.options ?? []).flatMap((option, index) => {
    if (option.size) return [{ index, ...option.size, label: option.label }];
    const match = typeof option.value === 'string' ? /^(\d{2,5})\s*[x×*]\s*(\d{2,5})$/i.exec(option.value) : null;
    if (!match) return [];
    const width = Number(match[1]), height = Number(match[2]), factor = gcd(width, height);
    if (!width || !height) return [];
    const longest = Math.max(width, height);
    const resolution = [1024, 2048, 4096].includes(longest) ? `${longest / 1024}K` : `${longest}px`;
    return [{ index, ratio: `${width / factor}:${height / factor}`, resolution, label: option.label }];
  });
}
export function configureSizeDisplay(param: ParamSpec, display: NonNullable<ParamSpec['sizeDisplay']>): ParamSpec {
  const choices = pixelSizeChoices(param);
  return { ...param, sizeDisplay: display, options: param.options?.map((option, index) => {
    const size = choices.find(choice => choice.index === index);
    return size ? { ...option, size: { ratio: size.ratio, resolution: size.resolution } } : option;
  }) };
}
export function sizeChoiceIndex(param: ParamSpec, value: unknown): number {
  return param.options?.findIndex(option => sameParameterValue(option.value, value)) ?? -1;
}
