import { z } from 'zod';
import type { JsonValue } from '../runtime/types';

export type { JsonValue } from '../runtime/types';
export type Template = JsonValue;
export const operationKinds = ['chat', 'image.generate', 'image.edit', 'video.generate', 'audio.generate', 'model.generate', 'models.list'] as const;
export type OperationKind = typeof operationKinds[number];
export type OutputSpec = { path: string; as: 'url' | 'base64' | 'data-url'; kind?: 'image' | 'video' | 'audio' | 'model' }
  | { url: string; kind: 'image' | 'video' | 'audio' | 'model'; auth?: boolean };
export interface SyncResponse { mode: 'sync'; outputs: OutputSpec[] }
export interface AsyncResponse {
  mode: 'async'; taskIdPath: string;
  poll: { method: 'GET' | 'POST'; path: string; template?: Template; intervalSec: number; timeoutMin: number;
    statusPath?: string; success: string[]; failure: string[]; progressPath?: string; outputs: OutputSpec[];
    resultRequest?: { method: 'GET' | 'POST'; path: string; template?: Template } };
}
export interface OperationSpec {
  method: 'POST' | 'GET'; path: string; body: 'json' | 'multipart' | 'form-urlencoded' | 'none'; template?: Template;
  files?: { field: string; cardinality: 'single' | 'array' | 'repeat' };
  imageEncoding?: 'url' | 'data-url' | 'base64'; response: SyncResponse | AsyncResponse; errorPath?: string;
}
export interface ParamSpec {
  key: string; label: string; type: 'enum' | 'number' | 'boolean' | 'text';
  options?: { label: string; value: JsonValue; size?: { ratio: string; resolution: string } }[]; min?: number; max?: number; step?: number;
  default?: JsonValue; required?: boolean; description?: string; group?: 'basic' | 'advanced';
  display?: 'auto' | 'buttons' | 'select' | 'slider' | 'hidden';
  sizeDisplay?: 'pixels' | 'ratio-resolution';
}
export interface RefSlot {
  key: string; label: string; kind: 'image' | 'video' | 'audio'; min?: number; max: number; description?: string;
}
export interface ModeSpec {
  id: string; label: string; description?: string; operation: OperationKind;
  endpoint?: OperationSpec; params?: ParamSpec[]; slots?: RefSlot[];
}
export interface ModelSpec {
  id: string; label?: string; operations: OperationKind[]; params: ParamSpec[];
  refs?: { image?: number; video?: number; audio?: number }; mention?: 'zh-at' | 'en-at' | 'zh-bare' | 'natural'; modes?: ModeSpec[];
  capabilities?: { contextWindow?: number; maxOutputTokens?: number; supportsMultimodal?: boolean; supportsTools?: boolean; supportsStreaming?: boolean };
}
/** Declared parameter keys that carry the canvas resolution / aspect-ratio choice. */
export const SIZE_PARAM_KEYS: readonly string[] = ['size', 'resolution', 'resolutionType', 'imageSize', 'image_size'];
export const RATIO_PARAM_KEYS: readonly string[] = ['aspectRatio', 'aspect_ratio', 'ratio'];
export interface ChannelProfileV2 {
  version: 2; id: string; name: string; baseUrl: string;
  auth: { type: 'bearer' } | { type: 'header'; name: string; prefix?: string } | { type: 'query'; name: string } | { type: 'none' };
  headers?: Record<string, string>; docsUrl?: string; notes?: string[];
  operations: Partial<Record<OperationKind, OperationSpec>>; models: ModelSpec[];
}
export interface ProfileValidationError { path: string; message: string }
export const secretHeaderName = /(authorization|cookie|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|secret|signature|credential|password|passphrase|bearer|token)/i;
const text = z.string().min(1, '不能为空');
const json: z.ZodType<JsonValue> = z.lazy(() => z.union([z.string(), z.number().finite(), z.boolean(), z.null(), z.array(json), z.record(z.string(), json)]));
export const outputSpecSchema = z.union([
  z.strictObject({ path: text, as: z.enum(['url', 'base64', 'data-url']), kind: z.enum(['image', 'video', 'audio', 'model']).optional() }),
  z.strictObject({ url: text, kind: z.enum(['image', 'video', 'audio', 'model']), auth: z.boolean().optional() }),
]);
const responseSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('sync'), outputs: z.array(outputSpecSchema) }),
  z.strictObject({ mode: z.literal('async'), taskIdPath: text, poll: z.strictObject({
    method: z.enum(['GET', 'POST']), path: text, template: json.optional(), intervalSec: z.number().positive(),
    timeoutMin: z.number().positive(), statusPath: text.optional(), success: z.array(text), failure: z.array(text),
    progressPath: text.optional(), outputs: z.array(outputSpecSchema),
    resultRequest: z.strictObject({ method: z.enum(['GET', 'POST']), path: text, template: json.optional() }).optional(),
  }) }),
]);
export const operationSpecSchema = z.strictObject({
  method: z.enum(['POST', 'GET']), path: text, body: z.enum(['json', 'multipart', 'form-urlencoded', 'none']), template: json.optional(),
  files: z.strictObject({ field: text, cardinality: z.enum(['single', 'array', 'repeat']) }).optional(),
  imageEncoding: z.enum(['url', 'data-url', 'base64']).optional(), response: responseSchema, errorPath: text.optional(),
}).superRefine((op, ctx) => {
  if (op.body === 'multipart' && !op.files) ctx.addIssue({ code: 'custom', path: ['files'], message: 'multipart 请求必须声明文件字段' });
  if (op.body !== 'multipart' && op.files) ctx.addIssue({ code: 'custom', path: ['files'], message: '仅 multipart 请求可以声明文件字段' });
});
export const paramSpecSchema = z.strictObject({
  key: text.regex(/^[\w-]+$/, '参数名只能包含字母、数字、下划线或连字符'), label: text,
  type: z.enum(['enum', 'number', 'boolean', 'text']), options: z.array(z.strictObject({ label: text, value: json,
    size: z.strictObject({ ratio: text, resolution: text }).optional() })).optional(),
  min: z.number().optional(), max: z.number().optional(), step: z.number().positive().optional(), default: json.optional(), required: z.boolean().optional(),
  description: z.string().optional(), group: z.enum(['basic', 'advanced']).optional(),
  display: z.enum(['auto', 'buttons', 'select', 'slider', 'hidden']).optional(),
  sizeDisplay: z.enum(['pixels', 'ratio-resolution']).optional(),
});
export const refSlotSchema = z.strictObject({
  key: text.regex(/^[\w-]+$/, '槽位名只能包含字母、数字、下划线或连字符'), label: text, kind: z.enum(['image', 'video', 'audio']),
  min: z.number().int().nonnegative().optional(), max: z.number().int().nonnegative(), description: z.string().optional(),
}).superRefine((slot, ctx) => {
  if (slot.max < (slot.min ?? 0)) ctx.addIssue({ code: 'custom', path: ['max'], message: '槽位上限不能小于下限' });
});
export const modeSpecSchema = z.strictObject({
  id: text, label: text, description: z.string().optional(), operation: z.enum(operationKinds),
  endpoint: operationSpecSchema.optional(), params: z.array(paramSpecSchema).optional(), slots: z.array(refSlotSchema).optional(),
});
export const modelSpecSchema = z.strictObject({
  id: text, label: text.optional(), operations: z.array(z.enum(operationKinds)), params: z.array(paramSpecSchema),
  refs: z.strictObject({ image: z.number().int().nonnegative().optional(), video: z.number().int().nonnegative().optional(), audio: z.number().int().nonnegative().optional() }).optional(),
  mention: z.enum(['zh-at', 'en-at', 'zh-bare', 'natural']).optional(), modes: z.array(modeSpecSchema).min(1, '模式列表不能为空').optional(),
  capabilities: z.strictObject({ contextWindow: z.number().int().positive().optional(), maxOutputTokens: z.number().int().positive().optional(), supportsMultimodal: z.boolean().optional(), supportsTools: z.boolean().optional(), supportsStreaming: z.boolean().optional() }).optional(),
});

/** Enumerates variables in values, never object keys (keys are literal HTTP fields). */
export function templateVariables(value: Template | undefined): string[] {
  if (typeof value === 'string') return [...value.matchAll(/{{\s*([^{}]+?)\s*}}/g)].map((match) => match[1].trim());
  if (Array.isArray(value)) return value.flatMap(templateVariables);
  if (value && typeof value === 'object') return Object.values(value).flatMap(templateVariables);
  return [];
}
export const channelProfileSchema: z.ZodType<ChannelProfileV2> = z.strictObject({
  version: z.literal(2), id: text, name: text,
  baseUrl: z.url({ protocol: /^https?$/ }).refine((url) => !url.endsWith('/'), 'baseUrl 不能以斜杠结尾').refine((url) => {
    const parsed = new URL(url); return !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
  }, 'baseUrl 不能包含账号、密钥、查询参数或片段'),
  auth: z.discriminatedUnion('type', [z.strictObject({ type: z.literal('bearer') }), z.strictObject({ type: z.literal('header'), name: text, prefix: z.string().optional() }), z.strictObject({ type: z.literal('query'), name: text }), z.strictObject({ type: z.literal('none') })]),
  headers: z.record(text, z.string()).optional(), docsUrl: z.url().optional(), notes: z.array(z.string()).optional(),
  operations: z.strictObject(Object.fromEntries(operationKinds.map((kind) => [kind, operationSpecSchema.optional()])) as Record<OperationKind, z.ZodOptional<typeof operationSpecSchema>>),
  models: z.array(modelSpecSchema),
}).superRefine((profile, ctx) => {
  for (const name of Object.keys(profile.headers ?? {})) if (secretHeaderName.test(name)) ctx.addIssue({ code: 'custom', path: ['headers', name], message: '密钥类请求头必须通过 auth 配置，不能保存在 headers 中' });
  const ids = new Set<string>();
  for (const [index, model] of profile.models.entries()) {
    if (ids.has(model.id)) ctx.addIssue({ code: 'custom', path: ['models', index, 'id'], message: '模型 ID 重复' });
    ids.add(model.id);
    const checkParams = (params: ParamSpec[], path: (string | number)[]) => {
      const keys = new Set<string>();
      for (const [paramIndex, param] of params.entries()) {
        if (keys.has(param.key)) ctx.addIssue({ code: 'custom', path: [...path, paramIndex, 'key'], message: '参数名重复' });
        keys.add(param.key);
      }
    };
    checkParams(model.params, ['models', index, 'params']);
    if (!model.modes) {
      for (const kind of model.operations) if (!profile.operations[kind]) ctx.addIssue({ code: 'custom', path: ['models', index, 'operations'], message: `操作 ${kind} 未配置` });
    } else {
      const modes = new Set<string>();
      for (const [modeIndex, mode] of model.modes.entries()) {
        const path = ['models', index, 'modes', modeIndex];
        if (modes.has(mode.id)) ctx.addIssue({ code: 'custom', path: [...path, 'id'], message: '模式 ID 重复' });
        modes.add(mode.id);
        checkParams(mode.params ?? [], [...path, 'params']);
        const slots = new Set<string>();
        for (const [slotIndex, slot] of (mode.slots ?? []).entries()) {
          if (slots.has(slot.key)) ctx.addIssue({ code: 'custom', path: [...path, 'slots', slotIndex, 'key'], message: '槽位名重复' });
          slots.add(slot.key);
        }
        if (!mode.endpoint && !profile.operations[mode.operation]) ctx.addIssue({ code: 'custom', path: [...path, 'operation'], message: `操作 ${mode.operation} 未配置` });
      }
    }
  }
  type Usage = { label: string; params: ParamSpec[]; slots: RefSlot[] };
  const validateOperation = (kind: OperationKind, op: OperationSpec, base: (string | number)[], usages: Usage[]) => {
    const sources: [string[], Template | undefined, boolean, boolean?][] = [[['path'], op.path, false], [['template'], op.template, false]];
    if (op.response.mode === 'async') sources.push([['response', 'poll', 'path'], op.response.poll.path, true], [['response', 'poll', 'template'], op.response.poll.template, true]);
    if (op.response.mode === 'async' && op.response.poll.resultRequest) sources.push([['response', 'poll', 'resultRequest', 'path'], op.response.poll.resultRequest.path, true, true], [['response', 'poll', 'resultRequest', 'template'], op.response.poll.resultRequest.template, true, true]);
    const outputs = op.response.mode === 'sync' ? op.response.outputs : op.response.poll.outputs;
    if (kind === 'model.generate' && !outputs.some((output) => ('kind' in output ? output.kind ?? 'model' : 'model') === 'model')) {
      ctx.addIssue({ code: 'custom', path: [...base, 'response'], message: '模型生成必须声明 model 输出，可额外声明 image 预览' });
    }
    outputs.forEach((output, index) => { if ('url' in output) sources.push([['response', ...(op.response.mode === 'async' ? ['poll'] : []), 'outputs', String(index), 'url'], output.url, true]); });
    for (const [path, value, polling, resultRequest] of sources) for (const variable of templateVariables(value)) {
      const issue = (message: string) => ctx.addIssue({ code: 'custom', path: [...base, ...path], message });
      if (/^param\.[\w-]+(?:\.[\w-]+)*$/.test(variable)) {
        const key = variable.slice(6).split('.')[0];
        for (const usage of usages) if (!usage.params.some((param) => param.key === key)) issue(`${usage.label} 未声明参数 ${key}`);
      } else if (/^(slot|slotFirst)\.[\w-]+$/.test(variable)) {
        const key = variable.split('.')[1];
        if (!usages.length) issue(`未声明的模板变量 ${variable}`);
        for (const usage of usages) if (!usage.slots.some((slot) => slot.key === key)) issue(`${usage.label} 未声明槽位 ${key}`);
      } else if (!(polling && /^submit\.[\w-]+(?:\.[\w-]+)*$/.test(variable)) && !(resultRequest && /^poll\.[\w-]+(?:\.[\w-]+)*$/.test(variable)) && !(kind === 'chat' && /^chatPayload\.[\w-]+$/.test(variable)) && !['model', 'mode', 'prompt', 'images', 'image', 'firstImageUrl', 'seedanceContent', 'wanMedia', 'videos', 'video', 'audios', 'audio', 'messages', 'openaiImageContent', 'openaiImageInput', 'geminiParts', ...(kind === 'chat' ? ['tools', 'toolChoice'] : []), ...(polling ? ['taskId'] : [])].includes(variable)) issue(`未声明的模板变量 ${variable}`);
    }
  };
  for (const kind of operationKinds) {
    const op = profile.operations[kind]; if (!op) continue;
    const usages: Usage[] = profile.models.flatMap((model) => model.modes
      ? model.modes.filter((mode) => mode.operation === kind && !mode.endpoint).map((mode) => ({
        label: `模型 ${model.id} 模式 ${mode.id}`, params: [...new Map([...model.params, ...(mode.params ?? [])].map((param) => [param.key, param])).values()], slots: mode.slots ?? [],
      }))
      : model.operations.includes(kind) ? [{ label: `模型 ${model.id}`, params: model.params, slots: [] }] : []);
    validateOperation(kind, op, ['operations', kind], usages);
  }
  for (const [modelIndex, model] of profile.models.entries()) for (const [modeIndex, mode] of (model.modes ?? []).entries()) {
    if (mode.endpoint) validateOperation(mode.operation, mode.endpoint, ['models', modelIndex, 'modes', modeIndex, 'endpoint'], [{
      label: `模型 ${model.id} 模式 ${mode.id}`, params: [...new Map([...model.params, ...(mode.params ?? [])].map((param) => [param.key, param])).values()], slots: mode.slots ?? [],
    }]);
  }
});

/** Proven OpenAI chat tool wire shape; other protocols remain capability-false. */
export function supportsOpenAIChatTools(profile: ChannelProfileV2): boolean {
  const op = profile.operations.chat;
  if (!op || op.method !== 'POST' || op.body !== 'json' || op.response.mode !== 'sync') return false;
  const path = new URL(op.path, `${profile.baseUrl}/`).pathname;
  if (!/\/chat\/completions\/?$/.test(path)) return false;
  const body = op.template;
  return Boolean(body && typeof body === 'object' && !Array.isArray(body)
    && body.messages === '{{messages}}' && body.tools === '{{tools}}' && body.stream !== true);
}

/** Chinese errors are the public validation boundary; raw zod issues are not UI text. */
export function validateProfile(input: unknown): ProfileValidationError[] {
  const result = channelProfileSchema.safeParse(input);
  if (result.success) return [];
  function translate(issue: z.core.$ZodIssue, parent: PropertyKey[] = []): ProfileValidationError[] {
    const segments = [...parent, ...issue.path];
    const path = segments.map(String).join('.');
    if (issue.code === 'invalid_union') {
      const unknowns = issue.errors.flat().filter((nested) => nested.code === 'unrecognized_keys');
      if (unknowns.length) return unknowns.flatMap((nested) => translate(nested, segments));
    }
    if (issue.code === 'unrecognized_keys') return issue.keys.map((key) => ({ path: [path, key].filter(Boolean).join('.'), message: `不允许未知字段：${key}` }));
    return [{ path, message: issue.code === 'custom' ? issue.message : `配置值无效：${path || '配置'}（类型、格式或取值不符合要求）` }];
  }
  return result.error.issues.flatMap((issue) => translate(issue));
}
