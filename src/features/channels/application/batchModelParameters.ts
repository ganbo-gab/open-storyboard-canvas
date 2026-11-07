import { paramSpecSchema, SIZE_PARAM_KEYS, templateVariables, type ChannelProfileV2, type JsonValue, type OperationKind, type ParamSpec } from '../domain/profile';
import { resolveParamValue } from '../domain/template';
import { pixelSizeChoices } from '../ui/sizeParameterPresentation';
import { listModelModes } from './modelModes';

export interface BatchModelParameterTarget { modelId: string; modeId: string }
export interface BatchModelParameterSelection {
  source: BatchModelParameterTarget;
  targets: BatchModelParameterTarget[];
  selectedKeys: string[];
  copyDefaults?: boolean;
}
export interface BatchModelParameterContext extends BatchModelParameterTarget {
  modelLabel: string;
  modeLabel: string;
  operation: OperationKind;
  params: ParamSpec[];
}
export interface BatchModelParameterChange { key: string; before?: ParamSpec; after: ParamSpec }
export interface BatchModelParameterPreview {
  target: BatchModelParameterTarget;
  compatible: boolean;
  reasons: string[];
  changes: BatchModelParameterChange[];
  preservedExtraCount: number;
}
const supportedOperations: Partial<Record<OperationKind, true>> = { 'image.generate': true, 'image.edit': true, 'video.generate': true };
const unique = (values: string[]) => values.filter((value, index) => values.indexOf(value) === index);
const sameTarget = (left: BatchModelParameterTarget, right: BatchModelParameterTarget) => left.modelId === right.modelId && left.modeId === right.modeId;

export function listBatchModelParameterContexts(profile: ChannelProfileV2): BatchModelParameterContext[] {
  return profile.models.flatMap(model => listModelModes(model).filter(mode => supportedOperations[mode.operation]).map(mode => ({
    modelId: model.id, modelLabel: model.label ?? model.id, modeId: mode.mode.id, modeLabel: mode.mode.label,
    operation: mode.operation, params: structuredClone(mode.params),
  })));
}

function contextFor(profile: ChannelProfileV2, target: BatchModelParameterTarget) {
  const model = profile.models.find(candidate => candidate.id === target.modelId);
  const mode = model ? listModelModes(model).find(candidate => candidate.mode.id === target.modeId) : undefined;
  return model && mode ? { model, mode, endpoint: mode.operationSpec ?? profile.operations[mode.operation] } : undefined;
}
function validDefault(param: ParamSpec, value: JsonValue | undefined): boolean {
  try { resolveParamValue({ ...param, default: value }, undefined); return true; }
  catch { return false; }
}
function enumWireShape(value: JsonValue): string {
  if (Array.isArray(value)) return `array(${unique(value.map(enumWireShape)).sort().join('|')})`;
  if (value === null) return 'null';
  if (typeof value === 'object') return `object(${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${key}:${enumWireShape(item)}`).join(',')})`;
  return typeof value;
}
function enumWireShapes(param: ParamSpec): string[] {
  return unique((param.options ?? []).flatMap(option => option.value === null ? [] : [enumWireShape(option.value)])).sort();
}
function copiedParameter(source: ParamSpec, target: ParamSpec | undefined, copyDefaults: boolean): ParamSpec | undefined {
  const copied = structuredClone(source);
  if (copyDefaults) return validDefault(copied, source.default) ? copied : undefined;
  if (target && validDefault(copied, target.default)) return { ...copied, default: structuredClone(target.default) };
  if (validDefault(copied, source.default)) return copied;
  if (copied.type === 'enum') {
    const first = copied.options?.find(option => validDefault(copied, option.value));
    if (first) return { ...copied, default: structuredClone(first.value) };
  }
  return !copied.required ? { ...copied, default: undefined } : undefined;
}

/** A preview is read-only; apply recomputes compatibility against the current profile. */
export function previewBatchModelParameters(profile: ChannelProfileV2, selection: BatchModelParameterSelection): BatchModelParameterPreview[] {
  const source = contextFor(profile, selection.source);
  const keys = unique(selection.selectedKeys);
  return selection.targets.map(target => {
    const destination = contextFor(profile, target);
    const reasons: string[] = [];
    const changes: BatchModelParameterChange[] = [];
    const preservedExtraCount = destination?.mode.params.filter(param => !keys.includes(param.key)).length ?? 0;
    const result = (): BatchModelParameterPreview => ({ target: { ...target }, compatible: reasons.length === 0, reasons, changes, preservedExtraCount });
    if (!source) reasons.push('来源模型或模式不存在');
    if (!destination) reasons.push('目标模型或模式不存在');
    if (!keys.length) reasons.push('请至少选择一个参数');
    if (!source || !destination) return result();
    if (sameTarget(selection.source, target)) reasons.push('来源与目标不能是同一模型模式');
    if (!supportedOperations[source.mode.operation] || source.mode.operation !== destination.mode.operation) reasons.push('仅支持相同的图片生成、图片编辑或视频生成操作');
    if (!destination.model.modes && destination.model.operations.some(operation => operation !== 'models.list' && operation !== source.mode.operation)) {
      reasons.push('目标共用参数影响多个用途，请先拆成独立模式');
    }
    if (!destination.endpoint) reasons.push('目标模式没有可用的请求配置');
    const used = templateVariables(destination.endpoint?.template);
    for (const key of keys) {
      const original = source.mode.params.find(param => param.key === key);
      const before = destination.mode.params.find(param => param.key === key);
      if (!original) { reasons.push(`来源未声明参数：${key}`); continue; }
      const parsed = paramSpecSchema.safeParse(original);
      if (!parsed.success || (original.type === 'number' && original.min !== undefined && original.max !== undefined && original.min > original.max)) {
        reasons.push(`来源参数声明无效：${key}`); continue;
      }
      if (before && original.type !== before.type) { reasons.push(`参数 ${key} 的值类型不同`); continue; }
      if (before && original.type === 'enum' && JSON.stringify(enumWireShapes(original)) !== JSON.stringify(enumWireShapes(before))) {
        reasons.push(`参数 ${key} 的枚举接口值结构不同`); continue;
      }
      if (!before && !used.some(variable => variable === `param.${key}` || variable.startsWith(`param.${key}.`))) {
        reasons.push(`目标请求模板未引用缺失参数：${key}`); continue;
      }
      if (before && SIZE_PARAM_KEYS.includes(key) && original.type === 'enum'
        && Boolean(pixelSizeChoices(original).length) !== Boolean(pixelSizeChoices(before).length)) {
        reasons.push(`参数 ${key} 的像素尺寸与符号分辨率格式不同`); continue;
      }
      const after = copiedParameter(original, before, selection.copyDefaults ?? false);
      if (!after) { reasons.push(`参数 ${key} 没有符合声明的默认值`); continue; }
      changes.push({ key, ...(before ? { before: structuredClone(before) } : {}), after });
    }
    return result();
  });
}

/** All selected targets pass before any cloned profile is changed; no endpoint or sibling mode is rewritten. */
export function applyBatchModelParameters(profile: ChannelProfileV2, selection: BatchModelParameterSelection): ChannelProfileV2 {
  const preview = previewBatchModelParameters(profile, selection);
  if (!preview.length) throw new Error('请至少选择一个目标模型或模式');
  const blocked = preview.filter(target => !target.compatible);
  if (blocked.length) throw new Error(blocked.map(target => `${target.target.modelId}/${target.target.modeId}：${target.reasons.join('；')}`).join('\n'));
  const updated = structuredClone(profile);
  for (const target of preview.filter((entry, index) => preview.findIndex(candidate => sameTarget(candidate.target, entry.target)) === index)) {
    const model = updated.models.find(candidate => candidate.id === target.target.modelId);
    if (!model) throw new Error('目标模型已不存在');
    const replace = (params: ParamSpec[]) => {
      const result = params.map(param => target.changes.find(change => change.key === param.key)?.after ?? param);
      for (const change of target.changes) if (!result.some(param => param.key === change.key)) result.push(change.after);
      return structuredClone(result);
    };
    if (model.modes) {
      const mode = model.modes.find(candidate => candidate.id === target.target.modeId);
      if (!mode) throw new Error('目标模式已不存在');
      mode.params = replace(mode.params ?? []);
    } else model.params = replace(model.params);
  }
  return updated;
}
