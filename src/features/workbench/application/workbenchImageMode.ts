import type { ModelSpec } from '@/features/channels/domain/profile';
import { listModelModes, resolveModelMode, type ResolvedMode } from '@/features/channels/application/modelModes';
import { resolveImageMode } from '@/features/channels/application/imageModeSelection';
import type { WorkbenchSubmitInput } from '../domain/types';

export function usesAutomaticImageMode(input: WorkbenchSubmitInput, model: ModelSpec): boolean {
  return input.kind === 'image' && !input.channelModeId && Boolean(model.modes?.length)
    && model.modes!.every(mode => mode.operation === 'image.generate' || mode.operation === 'image.edit');
}
export function workbenchImageCount(input: WorkbenchSubmitInput, model: ModelSpec): number {
  const imageKeys = listModelModes(model).flatMap(mode => mode.slots.filter(slot => slot.kind === 'image').map(slot => slot.key));
  return (input.references ?? []).filter(ref => ref.kind === 'image').length
    + Object.entries(input.referenceSlots ?? {}).reduce((count, [key, sources]) => count + (imageKeys.includes(key) ? sources.length : 0), 0);
}
export function resolveWorkbenchMode(input: WorkbenchSubmitInput, model: ModelSpec): ResolvedMode {
  return usesAutomaticImageMode(input, model) ? resolveImageMode(model, workbenchImageCount(input, model)) : resolveModelMode(model, input.channelModeId);
}
