import type { ModelSpec, OperationKind } from '../domain/profile';
import { listModelModes, resolveModelMode, type ResolvedMode } from './modelModes';
import { modeParamDefaults } from './modelModes';
import { resolveParamValue } from '../domain/template';
import { z } from 'zod';

/** Automatic mode changes keep valid user settings and seed the destination's defaults. */
export function automaticImageParameters(mode: ResolvedMode, values: Record<string, unknown> = {}): Record<string, unknown> {
  const next: Record<string, unknown> = { ...modeParamDefaults(mode) };
  for (const param of mode.params) {
    if (values[param.key] === undefined) continue;
    const parsed = z.json().safeParse(values[param.key]);
    if (!parsed.success) continue;
    try { resolveParamValue(param, parsed.data); next[param.key] = parsed.data; } catch { /* Use the new mode's declared default. */ }
  }
  return next;
}

export function imageModeReferenceCount(model: ModelSpec, images: readonly string[] = [], slots?: Record<string, string[]>): number {
  if (slots === undefined) return images.length;
  const keys = listModelModes(model).flatMap(mode => mode.slots.filter(slot => slot.kind === 'image').map(slot => slot.key));
  return Object.entries(slots).reduce((sum, [key, sources]) => sum + (keys.includes(key) ? sources.length : 0), 0);
}

const imageOperations: Partial<Record<OperationKind, true>> = { 'image.generate': true, 'image.edit': true };
export function isImageModeOperation(operation: OperationKind): boolean { return Boolean(imageOperations[operation]); }

/** Auto selection only uses declared capacity; role names and reference order are never guessed. */
export function resolveImageMode(model: ModelSpec, imageCount: number, requestedModeId?: string): ResolvedMode {
  if (requestedModeId !== undefined || !model.modes) return resolveModelMode(model, requestedModeId);
  if (!Number.isSafeInteger(imageCount) || imageCount < 0) throw new Error('参考图片数量无效，请检查图片后重试');
  const modes = listModelModes(model).filter(mode => isImageModeOperation(mode.operation));
  const withoutRequiredReferences = (mode: ResolvedMode) => mode.slots.every(slot => (slot.min ?? 0) === 0);
  const acceptsImages = (mode: ResolvedMode) => {
    const imageSlots = mode.slots.filter(slot => slot.kind === 'image');
    const slot = imageSlots[0];
    return imageSlots.length === 1 && imageCount >= (slot.min ?? 0) && imageCount <= slot.max
      && mode.slots.every(other => other.kind === 'image' || (other.min ?? 0) === 0);
  };
  const preferred = imageCount === 0
    ? modes.filter(mode => mode.operation === 'image.generate' && withoutRequiredReferences(mode))
    : modes.filter(mode => mode.operation === 'image.edit' && acceptsImages(mode));
  const candidates = preferred.length || imageCount === 0 ? preferred
    : modes.filter(mode => mode.operation === 'image.generate' && acceptsImages(mode));
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) throw new Error('有多个模式可以处理当前图片，请手动选择生成模式');
  throw new Error(imageCount > 0 ? '没有可自动接入这些图片的模式，请手动选择模式并分配参考图片槽位' : '没有可用的文生图模式，请选择模式并补齐所需参考素材');
}
