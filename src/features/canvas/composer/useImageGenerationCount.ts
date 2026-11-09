import { channelNativeCountParam } from '@/features/channels/application/modelModes';
import { resolveParamValue } from '@/features/channels/domain/template';
import type { ModelConfigValue } from '@/features/canvas/ui/ModelConfigPicker';
import { useNativeImageMode } from './useNativeImageMode';

const batchChoices = Array.from({ length: 10 }, (_, index) => index + 1);

/** Native count has one source of truth: the same parameter edited in the full panel. */
export function useImageGenerationCount(nodeId: string, value: ModelConfigValue | null, fallback: number,
  onChange: (value: ModelConfigValue) => void, onFallbackChange: (count: number) => void) {
  const mode = useNativeImageMode(nodeId, value);
  const operation = mode?.count && mode.native.model.operations.includes('image.edit') ? 'image.edit' : 'image.generate';
  const param = mode && !mode.error ? channelNativeCountParam(mode.native.profile, mode.native.model.id, mode.active.mode.id, operation) : undefined;
  const current = param ? mode?.params[param.key] ?? param.default ?? 1 : fallback;
  return {
    count: typeof current === 'number' ? current : 1,
    choices: param ? batchChoices.filter(count => { try { resolveParamValue(param, count); return true; } catch { return false; } }) : batchChoices,
    // Explicit undefined also removes a history-reuse count override in NodeComposer.
    requestCount: param ? undefined : fallback,
    setCount: (count: number) => {
      if (param && value && mode) onChange({ ...value, extraParams: { ...mode.params, [param.key]: count } });
      else onFallbackChange(count);
    },
  };
}
