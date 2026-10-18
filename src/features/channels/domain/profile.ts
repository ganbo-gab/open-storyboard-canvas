import { z } from 'zod';
import type { JsonValue } from '../runtime/types';

export type { JsonValue } from '../runtime/types';
export type Template = JsonValue;
export const operationKinds = ['chat', 'image.generate', 'image.edit', 'video.generate', 'audio.generate', 'models.list'] as const;
export type OperationKind = typeof operationKinds[number];
export type OutputSpec = { path: string; as: 'url' | 'base64' | 'data-url'; kind?: 'image' | 'video' | 'audio' }
  | { url: string; kind: 'image' | 'video' | 'audio'; auth?: boolean };
export interface SyncResponse { mode: 'sync'; outputs: OutputSpec[] }
export interface AsyncResponse {
  mode: 'async'; taskIdPath: string;
  poll: { method: 'GET' | 'POST'; path: string; template?: Template; intervalSec: number; timeoutMin: number;
    statusPath?: string; success: string[]; failure: string[]; progressPath?: string; outputs: OutputSpec[];
    resultRequest?: { method: 'GET' | 'POST'; path: string; template?: Template } };
}
export interface OperationSpec {
  method: 'POST' | 'GET'; path: string; body: 'json' | 'multipart' | 'none'; template?: Template;
  files?: { field: string; cardinality: 'single' | 'array' | 'repeat' };
  imageEncoding?: 'url' | 'data-url' | 'base64'; response: SyncResponse | AsyncResponse; errorPath?: string;
}
export interface ParamSpec {
  key: string; label: string; type: 'enum' | 'number' | 'boolean' | 'text';
  options?: { label: string; value: JsonValue }[]; min?: number; max?: number; step?: number;
  default?: JsonValue; required?: boolean;
}
export interface ModelSpec {
  id: string; label?: string; operations: OperationKind[]; params: ParamSpec[];
  refs?: { image?: number; video?: number; audio?: number }; mention?: 'zh-at' | 'en-at' | 'zh-bare' | 'natural';
}
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
  z.strictObject({ path: text, as: z.enum(['url', 'base64', 'data-url']), kind: z.enum(['image', 'video', 'audio']).optional() }),
  z.strictObject({ url: text, kind: z.enum(['image', 'video', 'audio']), auth: z.boolean().optional() }),
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
  method: z.enum(['POST', 'GET']), path: text, body: z.enum(['json', 'multipart', 'none']), template: json.optional(),
  files: z.strictObject({ field: text, cardinality: z.enum(['single', 'array', 'repeat']) }).optional(),
  imageEncoding: z.enum(['url', 'data-url', 'base64']).optional(), response: responseSchema, errorPath: text.optional(),
}).superRefine((op, ctx) => {
  if (op.body === 'multipart' && !op.files) ctx.addIssue({ code: 'custom', path: ['files'], message: 'multipart 请求必须声明文件字段' });
  if (op.body !== 'multipart' && op.files) ctx.addIssue({ code: 'custom', path: ['files'], message: '仅 multipart 请求可以声明文件字段' });
});
export const paramSpecSchema = z.strictObject({
  key: text.regex(/^[\w-]+$/, '参数名只能包含字母、数字、下划线或连字符'), label: text,
  type: z.enum(['enum', 'number', 'boolean', 'text']), options: z.array(z.strictObject({ label: text, value: json })).optional(),
  min: z.number().optional(), max: z.number().optional(), step: z.number().positive().optional(), default: json.optional(), required: z.boolean().optional(),
});
export const modelSpecSchema = z.strictObject({
  id: text, label: text.optional(), operations: z.array(z.enum(operationKinds)), params: z.array(paramSpecSchema),
  refs: z.strictObject({ image: z.number().int().nonnegative().optional(), video: z.number().int().nonnegative().optional(), audio: z.number().int().nonnegative().optional() }).optional(),
  mention: z.enum(['zh-at', 'en-at', 'zh-bare', 'natural']).optional(),
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
    const keys = new Set<string>();
    for (const [paramIndex, param] of model.params.entries()) {
      if (keys.has(param.key)) ctx.addIssue({ code: 'custom', path: ['models', index, 'params', paramIndex, 'key'], message: '参数名重复' });
      keys.add(param.key);
    }
    for (const kind of model.operations) if (!profile.operations[kind]) ctx.addIssue({ code: 'custom', path: ['models', index, 'operations'], message: `操作 ${kind} 未配置` });
  }
  for (const kind of operationKinds) {
    const op = profile.operations[kind]; if (!op) continue;
    const sources: [string[], Template | undefined, boolean][] = [[['path'], op.path, false], [['template'], op.template, false]];
    if (op.response.mode === 'async') sources.push([['response', 'poll', 'path'], op.response.poll.path, true], [['response', 'poll', 'template'], op.response.poll.template, true]);
    if (op.response.mode === 'async' && op.response.poll.resultRequest) sources.push([['response', 'poll', 'resultRequest', 'path'], op.response.poll.resultRequest.path, true], [['response', 'poll', 'resultRequest', 'template'], op.response.poll.resultRequest.template, true]);
    const outputs = op.response.mode === 'sync' ? op.response.outputs : op.response.poll.outputs;
    outputs.forEach((output, index) => { if ('url' in output) sources.push([['response', ...(op.response.mode === 'async' ? ['poll'] : []), 'outputs', String(index), 'url'], output.url, true]); });
    for (const [path, value, polling] of sources) for (const variable of templateVariables(value)) {
      if (variable.startsWith('param.')) {
        const key = variable.slice(6).split('.')[0];
        for (const model of profile.models.filter((candidate) => candidate.operations.includes(kind))) if (!model.params.some((param) => param.key === key)) ctx.addIssue({ code: 'custom', path: ['operations', kind, ...path], message: `模型 ${model.id} 未声明参数 ${key}` });
      } else if (!(polling && variable.startsWith('submit.')) && !['model', 'prompt', 'images', 'image', 'videos', 'audios', 'messages', ...(kind === 'chat' ? ['tools', 'toolChoice'] : []), ...(polling ? ['taskId'] : [])].includes(variable)) ctx.addIssue({ code: 'custom', path: ['operations', kind, ...path], message: `未声明的模板变量 ${variable}` });
    }
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
