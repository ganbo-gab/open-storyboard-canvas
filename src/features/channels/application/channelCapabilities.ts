import type { ChannelProfileV2, ModelSpec, OperationKind, ParamSpec, RefSlot } from '../domain/profile';
import { listModelModes } from './modelModes';

/** What a model can produce, as users browse it: 大语言模型 / 图片 / 视频 / 音频 / 3D. */
export const channelCapabilities = ['chat', 'image', 'video', 'audio', 'model'] as const;
export type ChannelCapability = typeof channelCapabilities[number];
export type CapabilityCounts = Record<ChannelCapability, number>;

/** Output capability of one operation. `models.list` is discovery, never a generation capability. */
export function operationCapability(operation: OperationKind): ChannelCapability | null {
  switch (operation) {
    case 'chat': return 'chat';
    case 'image.generate':
    case 'image.edit': return 'image';
    case 'video.generate': return 'video';
    case 'audio.generate': return 'audio';
    case 'model.generate': return 'model';
    case 'models.list': return null;
  }
}

/**
 * Effective operations: declared modes replace the model-level list (the same precedence as the
 * channel catalog projection). Reference inputs (`refs`, slot kinds) never imply an output kind.
 */
export function effectiveOperations(model: ModelSpec): OperationKind[] {
  return model.modes ? model.modes.map((mode) => mode.operation) : model.operations;
}

export function modelCapabilities(model: ModelSpec): ChannelCapability[] {
  const found = new Set(effectiveOperations(model).flatMap((operation) => operationCapability(operation) ?? []));
  return channelCapabilities.filter((capability) => found.has(capability));
}

export function emptyCapabilityCounts(): CapabilityCounts {
  return { chat: 0, image: 0, video: 0, audio: 0, model: 0 };
}

/** Number of models per capability; a model producing two kinds counts once in each. */
export function modelCapabilityCounts(models: readonly ModelSpec[]): CapabilityCounts {
  const counts = emptyCapabilityCounts();
  for (const model of models) for (const capability of modelCapabilities(model)) counts[capability] += 1;
  return counts;
}

export function profileCapabilities(profile: ChannelProfileV2): ChannelCapability[] {
  const counts = modelCapabilityCounts(profile.models);
  return channelCapabilities.filter((capability) => counts[capability] > 0);
}

export function modelsWithCapability<T extends ModelSpec>(models: readonly T[], capability: ChannelCapability): T[] {
  return models.filter((model) => modelCapabilities(model).includes(capability));
}

export type ReferenceLimits = Partial<Record<RefSlot['kind'], number>>;

/** Largest accepted reference count per media kind over all modes (inputs, not outputs). */
export function modelReferenceLimits(model: ModelSpec): ReferenceLimits {
  const limits: ReferenceLimits = {};
  for (const mode of listModelModes(model)) {
    const perKind: ReferenceLimits = {};
    for (const slot of mode.slots) perKind[slot.kind] = (perKind[slot.kind] ?? 0) + slot.max;
    for (const kind of ['image', 'video', 'audio'] as const) {
      const max = perKind[kind];
      if (max && max > (limits[kind] ?? 0)) limits[kind] = max;
    }
  }
  return limits;
}

/** Basic-group parameters of the first mode — what users usually adjust (resolution, duration, ratio …). */
export function modelKeyParams(model: ModelSpec): ParamSpec[] {
  const params = new Map<string, ParamSpec>();
  for (const mode of listModelModes(model)) {
    for (const param of mode.params) if ((param.group ?? 'basic') === 'basic' && !params.has(param.key)) params.set(param.key, param);
  }
  return [...params.values()];
}

/**
 * A fetched model ID joins the channel as an exact copy of a model the user picked, so its
 * operations, modes and parameters come from a declared template — never from the ID text.
 */
export function cloneModelAs(template: ModelSpec, id: string): ModelSpec {
  return { ...structuredClone(template), id, label: id };
}
