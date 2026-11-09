import { templateVariables, type ChannelProfileV2, type JsonValue, type ModeSpec, type ModelSpec, type OperationKind, type OperationSpec, type ParamSpec, type RefSlot } from '../domain/profile';

export interface ResolvedMode {
  mode: ModeSpec;
  operation: OperationKind;
  /** Only the mode override; otherwise use the channel's operation declaration. */
  operationSpec?: OperationSpec;
  params: ParamSpec[];
  slots: RefSlot[];
}

/** Legacy models keep their operations/refs contract and expose one implicit UI mode. */
export function listModelModes(model: ModelSpec): ResolvedMode[] {
  const modes: ModeSpec[] = model.modes ?? [{ id: 'default', label: '默认', operation: model.operations[0] ?? 'image.generate',
    slots: (['image', 'video', 'audio'] as const).flatMap((kind) => {
      const max = model.refs?.[kind] ?? 0;
      return max > 0 ? [{ key: kind, label: kind === 'image' ? '参考图' : kind === 'video' ? '参考视频' : '参考音频', kind, max }] : [];
    }),
  }];
  return modes.map((mode) => ({
    mode, operation: mode.operation, operationSpec: mode.endpoint,
    params: [...new Map([...model.params, ...(mode.params ?? [])].map((param) => [param.key, param])).values()],
    slots: mode.slots ?? [],
  }));
}

export function resolveModelMode(model: ModelSpec, modeId?: string): ResolvedMode {
  const modes = listModelModes(model);
  const resolved = modeId === undefined ? modes[0] : modes.find((entry) => entry.mode.id === modeId);
  if (!resolved) throw new Error(`模型 ${model.id} 未声明模式：${modeId ?? ''}`);
  return resolved;
}

/** Defaults are editable parameter state, never an implicit HTTP body merge. */
export function modeParamDefaults(resolved: ResolvedMode): Record<string, JsonValue> {
  return Object.fromEntries(resolved.params.flatMap((param) => param.default === undefined ? [] : [[param.key, param.default]]));
}

/** Count is native only when a declared numeric parameter reaches the initial submission. */
export function channelNativeCountParam(profile: ChannelProfileV2, modelId: string, modeId?: string, operationKind?: OperationKind): ParamSpec | undefined {
  const model = profile.models.find((entry) => entry.id === modelId);
  if (!model) return undefined;
  const resolved = resolveModelMode(model, modeId);
  if (!model.modes && operationKind !== undefined && !model.operations.includes(operationKind)) return undefined;
  const imageOperations = model.operations.filter(operation => operation === 'image.generate' || operation === 'image.edit');
  // Legacy models choose generate/edit from their references later. Without an
  // actual operation, native count must work on every possible image submission.
  // Callers with the chosen route avoid both an ignored count and multiplied batches.
  const legacyOperations = operationKind === undefined ? imageOperations.length ? imageOperations : [resolved.operation] : [operationKind];
  const operations = model.modes ? [resolved.operationSpec ?? profile.operations[resolved.operation]]
    : legacyOperations.map(operation => profile.operations[operation]);
  if (operations.some(operation => operation === undefined)) return undefined;
  // Poll/result parameters cannot request more outputs after a task is accepted.
  // A body:none template is never sent by the shared request renderer.
  const used = operations.map(operation => [...templateVariables(operation?.path),
    ...(operation?.body === 'none' ? [] : templateVariables(operation?.template))]);
  const keys = ['n', 'count', 'num_images', 'num_outputs', 'number_of_images', 'batch_size'];
  return keys.flatMap((key) => resolved.params.filter((param) => param.key === key && used.every(variables => variables.includes(`param.${key}`)) && (param.type === 'number'
    || (param.type === 'enum' && param.options?.every((option) => typeof option.value === 'number')))))[0];
}

/** UI resolution: a stale/removed mode id (persisted draft, edited profile) falls back to the first mode. */
export function resolveModelModeOrFirst(model: ModelSpec, modeId?: string): ResolvedMode {
  const modes = listModelModes(model);
  return modes.find((entry) => entry.mode.id === modeId) ?? modes[0];
}

/**
 * State carried across a mode switch: only parameters the new mode declares,
 * only its slots, each trimmed to the slot's maximum. Nothing undeclared survives.
 */
export function retainModeState(
  resolved: ResolvedMode,
  params: Record<string, unknown>,
  slots: Record<string, string[]>,
): { params: Record<string, unknown>; slots: Record<string, string[]> } {
  const keys = new Set(resolved.params.map((param) => param.key));
  const maxBySlot = new Map(resolved.slots.map((slot) => [slot.key, slot.max]));
  return {
    params: Object.fromEntries(Object.entries(params).filter(([key]) => keys.has(key))),
    slots: Object.fromEntries(Object.entries(slots).flatMap(([key, sources]) => {
      const max = maxBySlot.get(key);
      return max === undefined || max === 0 ? [] : [[key, sources.slice(0, max)]];
    })),
  };
}

/** What an agent needs to pick a declared mode and fill its slots; never request templates or endpoints. */
export interface AgentModeSummary {
  id: string;
  label: string;
  operation: OperationKind;
  description?: string;
  slots: Array<{ key: string; label: string; kind: RefSlot['kind']; min: number; max: number }>;
  params: Array<{ key: string; label: string; type: ParamSpec['type']; required?: boolean; values?: JsonValue[]; default?: JsonValue; min?: number; max?: number }>;
}

/** Explicit modes only: the implicit legacy mode has no id an agent could pass back. */
export function summarizeModesForAgent(modes: readonly ResolvedMode[] | undefined): AgentModeSummary[] | undefined {
  if (!modes?.length || (modes.length === 1 && modes[0].mode.id === 'default')) return undefined;
  return modes.map(({ mode, operation, params, slots }) => ({
    id: mode.id,
    label: mode.label,
    operation,
    ...(mode.description ? { description: mode.description } : {}),
    slots: slots.map((slot) => ({ key: slot.key, label: slot.label, kind: slot.kind, min: slot.min ?? 0, max: slot.max })),
    params: params.map((param) => ({
      key: param.key,
      label: param.label,
      type: param.type,
      ...(param.required ? { required: true } : {}),
      ...(param.options ? { values: param.options.map((option) => option.value) } : {}),
      ...(param.default !== undefined ? { default: param.default } : {}),
      ...(param.min !== undefined ? { min: param.min } : {}),
      ...(param.max !== undefined ? { max: param.max } : {}),
    })),
  }));
}
