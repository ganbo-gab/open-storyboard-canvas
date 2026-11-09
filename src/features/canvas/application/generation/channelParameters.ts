import { resolveNativeChannelModel } from '@/features/channels/application/channelService';
import { modeParamDefaults, resolveModelMode } from '@/features/channels/application/modelModes';
import { RATIO_PARAM_KEYS, SIZE_PARAM_KEYS, type JsonValue, type ParamSpec } from '@/features/channels/domain/profile';
import { resolveParamValue } from '@/features/channels/domain/template';
import { automaticImageParameters, imageModeReferenceCount, resolveImageMode } from '@/features/channels/application/imageModeSelection';
import type { GenerateImagePayload } from '../ports';
import { readGenerationConfiguration } from '../../domain/generationConfiguration';

/** Select before projecting parameters, so defaults and the request use the same image mode. */
export function mapImageChannelGenerationParameters(input: GenerateImagePayload): GenerateImagePayload {
  const native = resolveNativeChannelModel(input.model);
  if (!native?.model.modes) return input;
  const count = imageModeReferenceCount(native.model, input.referenceImages, input.referenceSlots);
  const mode = resolveImageMode(native.model, count, input.channelModeId);
  return mapChannelGenerationParameters({ ...input, channelModeId: mode.mode.id,
    extraParams: input.channelModeId === undefined ? automaticImageParameters(mode, input.extraParams) : input.extraParams });
}

/** Describe the assembled request, including mode defaults, without sending or reading credentials. */
export function describeImageGenerationRequest(input: GenerateImagePayload) {
  const native = resolveNativeChannelModel(input.model);
  const mode = native ? resolveImageMode(native.model,
    imageModeReferenceCount(native.model, input.referenceImages, input.referenceSlots), input.channelModeId) : undefined;
  const effective = mode ? Object.fromEntries(mode.params.flatMap(param => {
    const hint = SIZE_PARAM_KEYS.includes(param.key) ? input.size || undefined
      : RATIO_PARAM_KEYS.includes(param.key) ? input.aspectRatio || undefined : undefined;
    const value = input.extraParams?.[param.key] ?? hint ?? param.default;
    return value === undefined ? [] : [[param.key, value]];
  })) : input.extraParams ?? {};
  return readGenerationConfiguration({ modelConfig: { entryId: input.model,
    ratio: input.aspectRatio || undefined, resolution: input.size || undefined, extraParams: effective } });
}

interface GenerationParameterInput {
  model: string;
  size: string;
  aspectRatio?: string;
  seconds?: number;
  channelModeId?: string;
  extraParams?: Record<string, unknown>;
}

const DURATION_KEYS: readonly string[] = ['seconds', 'duration'];
function chipValue(key: string, input: GenerationParameterInput): string | number | undefined {
  return SIZE_PARAM_KEYS.includes(key) ? input.size || undefined
    : RATIO_PARAM_KEYS.includes(key) ? input.aspectRatio || undefined
      : DURATION_KEYS.includes(key) ? input.seconds : undefined;
}
function scalarValue(param: ParamSpec, hint: string | number): JsonValue {
  const option = param.options?.find(({ value }) => (typeof value === 'string' || typeof value === 'number') && String(value) === String(hint));
  const value = option ? option.value : param.type === 'number' ? Number(hint) : hint;
  resolveParamValue(param, value);
  return value;
}

/** Legacy chips are projections of declared values, never extra transport fields for explicit modes. */
export function mapChannelGenerationParameters<T extends GenerationParameterInput>(input: T): T {
  const native = resolveNativeChannelModel(input.model);
  if (!native?.model.modes) return input;
  const mode = resolveModelMode(native.model, input.channelModeId);
  const params: Record<string, unknown> = { ...modeParamDefaults(mode) };
  for (const param of mode.params) {
    const explicit = input.extraParams?.[param.key];
    if (explicit !== undefined) params[param.key] = explicit;
    const hint = chipValue(param.key, input);
    if (hint !== undefined) {
      params[param.key] = scalarValue(param, hint);
      continue;
    }
    // Correlated declarations (e.g. Hailuo output) must select one whole allowed value.
    // A value selected in DeclaredParameters wins over unrelated hidden legacy chips.
    if (explicit !== undefined || !param.options) continue;
    const objects = param.options.flatMap(({ value }) => value && typeof value === 'object' && !Array.isArray(value) ? [value] : []);
    if (!objects.length) continue;
    const keys = [...new Set(objects.flatMap((value) => Object.keys(value)))];
    const choices = keys.flatMap((key) => {
      const value = chipValue(key, input);
      return value === undefined ? [] : [{ key, value }];
    });
    if (!choices.length) continue;
    if (choices.some((choice) => !objects.some((value) => String(value[choice.key]) === String(choice.value)))) continue;
    const selected = objects.find((value) => choices.every((choice) => String(value[choice.key]) === String(choice.value)));
    if (!selected) throw new Error(`参数 ${param.label} 未声明所选时长、尺寸或比例组合`);
    params[param.key] = selected;
  }
  return { ...input, size: '', aspectRatio: '', seconds: undefined, extraParams: params };
}
