import { z } from 'zod';
import { resolveNativeChannelModel } from '@/features/channels/application/channelService';
import { resolveParamValue } from '@/features/channels/domain/template';
import { RATIO_PARAM_KEYS, SIZE_PARAM_KEYS, type ModelSpec, type ParamSpec } from '@/features/channels/domain/profile';
import { getChannelCatalogProviders } from '@/features/channels/application/channelCatalog';
import { buildVideoModelCatalog } from '@/features/canvas/application/videoModelCatalog';
import { DREAMINA_IMAGE_MODEL_CAPABILITIES } from '@/features/canvas/application/dreaminaCapabilities';
import type { WorkbenchDraft, WorkbenchReference } from '../domain/types';
import { resolveWorkbenchMode, usesAutomaticImageMode } from './workbenchImageMode';
import { listModelModes } from '@/features/channels/application/modelModes';

export interface WorkbenchValidationIssue {
  field: 'prompt' | 'references' | 'slot' | 'duration' | 'count' | 'param';
  code: string;
  params: Record<string, string | number>;
  slotKey?: string;
  paramKey?: string;
}
export interface WorkbenchReferenceLimits { image?: number; video?: number; audio?: number; maxBytes?: number }
export interface WorkbenchValidationContext {
  nativeModel?: ModelSpec;
  referenceLimits?: WorkbenchReferenceLimits;
  referenceMinimums?: Partial<Record<'image' | 'video' | 'audio', number>>;
  durations?: readonly (number | string)[];
  params?: readonly ParamSpec[];
  promptMaxLength?: number;
}
export interface WorkbenchDraftValidation { issues: WorkbenchValidationIssue[]; blocking: boolean }
export class WorkbenchDraftValidationError extends Error {
  readonly code: string;
  constructor(readonly issues: WorkbenchValidationIssue[]) {
    super(issues[0]?.code ?? 'workbench.validation.invalid');
    this.name = 'WorkbenchDraftValidationError';
    this.code = issues[0]?.code ?? 'workbench.validation.invalid';
  }
}
const mediaKinds = ['image', 'video', 'audio'] as const;
const durationKeys = ['seconds', 'duration'];
const countKeys = ['n', 'count', 'num_images', 'num_outputs', 'number_of_images', 'batch_size'];
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Read the same declarations as useCreationModels, deliberately excluding catalog UI fallbacks. */
export function getWorkbenchValidationContext(draft: WorkbenchDraft): WorkbenchValidationContext {
  const native = resolveNativeChannelModel(draft.model);
  if (native) return { nativeModel: native.model };
  if (draft.kind === 'image' && draft.model.startsWith('dreamina:')) {
    const capability = DREAMINA_IMAGE_MODEL_CAPABILITIES.find((item) => `dreamina:${item.model}` === draft.model);
    if (capability) return { referenceLimits: { image: capability.inputImages.max }, params: [
      { key: 'count', label: 'count', type: 'number', min: capability.generateCount.min, max: capability.generateCount.max },
    ] };
  }
  const providers = getChannelCatalogProviders();
  const provider = providers.find((item) => item.models.some((model) => `custom:${item.id}:${model}` === draft.model));
  const extra = provider?.extraParams;
  const context: WorkbenchValidationContext = {};
  if (draft.kind === 'video') {
    const entry = buildVideoModelCatalog(providers, { loggedIn: true }).find((item) => item.id === draft.model);
    if (entry && draft.model.startsWith('dreamina:')) {
      context.durations = entry.supportedDurations;
      context.referenceLimits = { image: entry.inputSchema.images.max, video: entry.inputSchema.video.max, audio: entry.inputSchema.audio.max };
      context.referenceMinimums = { image: entry.inputSchema.images.min, video: entry.inputSchema.video.min, audio: entry.inputSchema.audio.min };
    } else {
      const durations = extra?.supportedDurations;
      if (Array.isArray(durations)) context.durations = durations.filter((value): value is string | number => typeof value === 'string' || typeof value === 'number');
      const modelId = entry?.modelId;
      const schemas = record(extra?.videoInputSchemasByModel);
      const base = record(extra?.videoInputSchema);
      const modelSchema = modelId ? record(schemas?.[modelId]) : undefined;
      const limits: WorkbenchReferenceLimits = {};
      const minimums: WorkbenchValidationContext['referenceMinimums'] = {};
      for (const kind of mediaKinds) {
        const key = kind === 'image' ? 'images' : kind;
        const declaration = { ...record(base?.[key]), ...record(modelSchema?.[key]) };
        const max = declaration.enabled === false ? 0 : typeof declaration.max === 'number' && Number.isFinite(declaration.max) ? declaration.max : undefined;
        if (max !== undefined) limits[kind] = max;
        const min = declaration.enabled === false ? 0 : typeof declaration.min === 'number' && Number.isFinite(declaration.min) ? declaration.min : undefined;
        if (min !== undefined) minimums[kind] = min;
      }
      context.referenceLimits = limits;
      context.referenceMinimums = minimums;
    }
  }
  return context;
}

function selectedMode(draft: WorkbenchDraft, context: WorkbenchValidationContext) {
  if (!context.nativeModel) return undefined;
  try { return resolveWorkbenchMode(draft, context.nativeModel); } catch { return undefined; }
}
export function describeReferenceLimits(draft: WorkbenchDraft, context = getWorkbenchValidationContext(draft)): WorkbenchReferenceLimits {
  if (!context.nativeModel) return { ...context.referenceLimits };
  if (!context.nativeModel.modes) return { ...context.nativeModel.refs };
  if (usesAutomaticImageMode(draft, context.nativeModel)) {
    const image = Math.max(0, ...listModelModes(context.nativeModel).filter(mode => mode.slots.filter(slot => slot.kind === 'image').length === 1)
      .map(mode => mode.slots.find(slot => slot.kind === 'image')?.max ?? 0));
    return { image, video: 0, audio: 0 };
  }
  const mode = selectedMode(draft, context);
  if (!mode) return {};
  // Explicit modes declare the entire slot surface, so an absent kind is explicitly unsupported.
  return Object.fromEntries(mediaKinds.map((kind) => [kind, mode.slots.filter((slot) => slot.kind === kind).reduce((sum, slot) => sum + slot.max, 0)]));
}
function sourceKind(source: string, references: WorkbenchReference[]): WorkbenchReference['kind'] | undefined {
  const mime = /^data:(image|video|audio)\//i.exec(source)?.[1]
    ?? /^asset-media:(image|video|audio)(?:%2[fF]|\/)/i.exec(source)?.[1];
  if (mime === 'image' || mime === 'video' || mime === 'audio') return mime;
  const extension = source.split(/[?#]/, 1)[0].split('.').at(-1)?.toLowerCase() ?? '';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp', 'svg', 'heic'].includes(extension)) return 'image';
  if (['mp4', 'mov', 'webm', 'mkv'].includes(extension)) return 'video';
  if (['mp3', 'wav', 'm4a', 'flac', 'ogg'].includes(extension)) return 'audio';
  return references.find((item) => item.source === source)?.kind;
}
function parameterValue(param: ParamSpec, draft: WorkbenchDraft): unknown {
  const config = draft.config;
  const hint = durationKeys.includes(param.key) ? config?.seconds
    : SIZE_PARAM_KEYS.includes(param.key) ? config?.size || undefined
      : RATIO_PARAM_KEYS.includes(param.key) ? config?.aspectRatio || undefined : undefined;
  if (hint !== undefined) {
    const option = param.options?.find(({ value }) => (typeof value === 'number' || typeof value === 'string') && String(value) === String(hint));
    return option ? option.value : param.type === 'number' ? Number(hint) : hint;
  }
  const explicit = config?.extraParams?.[param.key];
  return explicit === undefined ? param.default : explicit;
}

/** Pure: unknown capabilities never become invented restrictions. All reported issues block submit. */
export function validateWorkbenchDraft(draft: WorkbenchDraft, context: WorkbenchValidationContext): WorkbenchDraftValidation {
  const issues: WorkbenchValidationIssue[] = [];
  const add = (field: WorkbenchValidationIssue['field'], code: string, params: WorkbenchValidationIssue['params'] = {}, detail: Pick<WorkbenchValidationIssue, 'slotKey' | 'paramKey'> = {}) => {
    issues.push({ field, code, params, ...detail });
  };
  if (!draft.prompt.trim()) add('prompt', 'prompt.required');
  if (!draft.model.trim()) add('param', 'model.required');
  else if (draft.kind === 'audio' && !context.nativeModel) add('param', 'model.unavailable');
  const mode = selectedMode(draft, context);
  if (context.nativeModel && !mode) add('param', usesAutomaticImageMode(draft, context.nativeModel) ? 'mode.autoUnavailable' : 'mode.unknown', { mode: draft.channelModeId ?? '' });
  if (mode && (context.nativeModel?.modes ? !mode.operation.startsWith(`${draft.kind}.`) && mode.operation !== draft.kind
    : !context.nativeModel?.operations.some((operation) => operation === draft.kind || operation.startsWith(`${draft.kind}.`)))) {
    add('param', 'model.incompatible', { kind: draft.kind });
  }
  const promptSpec = mode?.params.find((param) => param.key === 'prompt' && param.type === 'text');
  const maxLength = context.promptMaxLength ?? promptSpec?.max;
  const promptLength = Array.from(draft.prompt.trim()).length;
  if (maxLength !== undefined && promptLength > maxLength) add('prompt', 'prompt.tooLong', { max: maxLength, count: promptLength });
  const refs = draft.references ?? [];
  if (context.nativeModel?.modes && mode) {
    const slots = draft.referenceSlots ?? {};
    for (const [slotKey, sources] of Object.entries(slots)) {
      const slot = mode.slots.find((item) => item.key === slotKey);
      if (!slot) { add('slot', 'slot.unknown', { slot: slotKey }, { slotKey }); continue; }
      if (sources.some((source) => { const kind = sourceKind(source, refs); return kind !== undefined && kind !== slot.kind; })) {
        add('slot', 'slot.kindMismatch', { slot: slot.label, kind: slot.kind }, { slotKey });
      }
      if (sources.some((source) => !source.trim())) add('slot', 'slot.sourceRequired', { slot: slot.label }, { slotKey });
    }
    for (const slot of mode.slots) {
      const count = slots[slot.key]?.length ?? 0;
      if (count < (slot.min ?? 0)) add('slot', 'slot.minNotMet', { slot: slot.label, min: slot.min ?? 0, count }, { slotKey: slot.key });
      if (count > slot.max) add('slot', 'slot.maxExceeded', { slot: slot.label, max: slot.max, count }, { slotKey: slot.key });
    }
    if (refs.some((ref) => ref.kind !== 'text')) add('references', 'references.slotRequired');
  } else if (!(context.nativeModel?.modes && usesAutomaticImageMode(draft, context.nativeModel) && !mode)) {
    const limits = describeReferenceLimits(draft, context);
    for (const kind of mediaKinds) {
      const count = refs.filter((ref) => ref.kind === kind).length;
      const max = limits[kind]; const min = context.referenceMinimums?.[kind];
      if (max !== undefined && count > max) add('references', 'references.maxExceeded', { kind, max, count });
      if (min !== undefined && count < min) add('references', 'references.minNotMet', { kind, min, count });
    }
  } else if (refs.some((ref) => ref.kind !== 'text')) {
    add('references', 'references.slotRequired');
  }
  if (draft.config?.seconds !== undefined && (!Number.isFinite(draft.config.seconds) || draft.config.seconds <= 0)) add('duration', 'duration.invalid');
  if (context.durations?.length && draft.config?.seconds !== undefined && !context.durations.some((value) => Number(value) === draft.config?.seconds)) {
    add('duration', 'duration.unsupported', { values: context.durations.join(', ') });
  }
  for (const param of mode?.params ?? context.params ?? []) {
    const field = durationKeys.includes(param.key) ? 'duration' : countKeys.includes(param.key) ? 'count' : 'param';
    const value = parameterValue(param, draft);
    const detail = { paramKey: param.key };
    if (value === undefined || value === null || value === '') {
      if (param.required) add(field, 'param.required', { param: param.label }, detail);
      continue;
    }
    if (typeof value === 'number' && ((param.min !== undefined && value < param.min) || (param.max !== undefined && value > param.max))) {
      add(field, 'param.outOfRange', { param: param.label, ...(param.min !== undefined ? { min: param.min } : {}), ...(param.max !== undefined ? { max: param.max } : {}) }, detail);
      continue;
    }
    const json = z.json().safeParse(value);
    try {
      if (!json.success) throw new Error('Invalid JSON parameter');
      resolveParamValue(param, json.data);
    } catch {
      add(field, 'param.invalid', { param: param.label }, detail);
    }
  }
  return { issues, blocking: issues.length > 0 };
}
