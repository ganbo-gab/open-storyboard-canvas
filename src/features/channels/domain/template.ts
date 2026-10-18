import type { ChannelProfileV2, ModelSpec, OperationSpec, ParamSpec, Template } from './profile';
import { templateVariables, validateProfile } from './profile';
import type { JobInput, JobRef, JsonValue, RequestPreview } from '../runtime/types';

export type ImageEncoding = 'url' | 'data-url' | 'base64';
export type ResolveRef = (ref: JobRef, encoding: ImageEncoding) => Promise<string>;
export interface MultipartFile { name: string; path: string; mime: string; filename: string }
export type RequestBody = { mode: 'json'; json: JsonValue } | { mode: 'multipart'; fields: { name: string; value: string }[]; files: MultipartFile[] } | { mode: 'none' };
export interface HttpRequest { method: 'GET' | 'POST'; url: string; headers: Record<string, string>; body: RequestBody; signal?: AbortSignal }
export interface RenderedRequest { request: HttpRequest; preview: RequestPreview }
export interface TemplateVars { [name: string]: unknown }
export class TemplateValidationError extends Error {
  constructor(public readonly path: string, message: string) { super(message); this.name = 'TemplateValidationError'; }
}
const missing = (value: unknown): boolean => value === undefined || value === null || value === '';
function lookup(vars: TemplateVars, variable: string): unknown {
  let value: unknown = vars;
  for (const key of variable.split('.')) {
    if (!value || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** Missing optional values remove their whole field, including embedded variables. */
export function render(template: Template, vars: TemplateVars, required: readonly string[] = ['model', 'prompt']): JsonValue | undefined {
  function variable(name: string): unknown {
    const value = lookup(vars, name);
    if (missing(value) && required.includes(name)) throw new TemplateValidationError(name, `缺少必填值：${name}`);
    return missing(value) ? undefined : value;
  }
  function visit(value: Template): JsonValue | undefined {
    if (typeof value === 'string') {
      const whole = /^{{\s*([^{}]+?)\s*}}$/.exec(value);
      if (whole) return variable(whole[1].trim()) as JsonValue | undefined;
      let absent = false;
      const result = value.replace(/{{\s*([^{}]+?)\s*}}/g, (_, raw: string) => {
        const item = variable(raw.trim());
        if (item === undefined) { absent = true; return ''; }
        return typeof item === 'object' ? JSON.stringify(item) : String(item);
      });
      return absent ? undefined : result;
    }
    if (Array.isArray(value)) return value.flatMap((item) => { const rendered = visit(item); return rendered === undefined ? [] : [rendered]; });
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
      const rendered = visit(item); return rendered === undefined ? [] : [[key, rendered]];
    }));
    return value;
  }
  return visit(template);
}
function paramValue(param: ParamSpec, value: JsonValue | undefined): JsonValue | undefined {
  const resolved = value === undefined ? param.default : value;
  if (missing(resolved)) {
    if (param.required) throw new TemplateValidationError(`param.${param.key}`, `缺少必填参数：${param.label}`);
    return undefined;
  }
  const fail = () => { throw new TemplateValidationError(`param.${param.key}`, `参数 ${param.label} 的值不符合声明`); };
  if (param.type === 'enum' && !param.options?.some((option) => JSON.stringify(option.value) === JSON.stringify(resolved))) fail();
  if (param.type === 'number') {
    if (typeof resolved !== 'number' || !Number.isFinite(resolved)) fail();
    const n = resolved as number;
    if ((param.min !== undefined && n < param.min) || (param.max !== undefined && n > param.max)) fail();
    if (param.step !== undefined && Math.abs((n - (param.min ?? 0)) / param.step - Math.round((n - (param.min ?? 0)) / param.step)) > 1e-8) fail();
  }
  if (param.type === 'boolean' && typeof resolved !== 'boolean') fail();
  if (param.type === 'text' && typeof resolved !== 'string') fail();
  return resolved;
}
function prepare(profile: ChannelProfileV2, job: JobInput): { op: OperationSpec; model?: ModelSpec; vars: TemplateVars; required: string[] } {
  const errors = validateProfile(profile);
  if (errors.length) throw new TemplateValidationError(errors[0].path, errors[0].message);
  const op = profile.operations[job.operation];
  if (!op) throw new TemplateValidationError('operation', `渠道未配置操作：${job.operation}`);
  const model = profile.models.find((candidate) => candidate.id === job.modelId);
  if (job.operation !== 'models.list' && (!job.modelId.trim() || !model)) throw new TemplateValidationError('model', '缺少或未声明模型');
  if (model && job.operation !== 'models.list' && !model.operations.includes(job.operation)) throw new TemplateValidationError('operation', '模型不支持此操作');
  const params: Record<string, JsonValue> = {};
  for (const param of model?.params ?? []) { const value = paramValue(param, job.params[param.key]); if (value !== undefined) params[param.key] = value; }
  for (const kind of ['image', 'video', 'audio'] as const) {
    const count = job.refs.filter((ref) => ref.kind === kind).length;
    if (count > (model?.refs?.[kind] ?? 0)) throw new TemplateValidationError('refs', `${kind} 参考素材数量超出模型声明上限`);
  }
  return { op, model, vars: { model: job.modelId || undefined, prompt: job.prompt || undefined, param: params,
    messages: job.messages ?? [{ role: 'user', content: job.prompt }],
    ...(job.operation === 'chat' ? { tools: job.tools, toolChoice: job.toolChoice } : {}) },
    required: ['model', 'prompt', ...(model?.params.filter((param) => param.required).map((param) => `param.${param.key}`) ?? [])] };
}
function refSummary(ref: JobRef, index: number): string {
  const dimensions = ref.width && ref.height ? `${ref.width}×${ref.height} ` : '';
  return `<${ref.kind} ${index + 1}: ${dimensions}${ref.mime.split('/')[1] ?? ref.mime}>`;
}
function refVariables(job: JobInput, values: string[]): TemplateVars {
  const kind = (media: JobRef['kind']) => job.refs.flatMap((ref, index) => ref.kind === media ? [values[index]] : []);
  const images = kind('image');
  return { images: images.length ? images : undefined, image: images[0], videos: kind('video').length ? kind('video') : undefined, audios: kind('audio').length ? kind('audio') : undefined };
}
function makeRequest(profile: ChannelProfileV2, job: JobInput, op: OperationSpec, vars: TemplateVars, required: string[], apiKey: string, summaries: boolean): HttpRequest {
  const pathVars: TemplateVars = { ...vars, model: typeof vars.model === 'string' ? vars.model.split('/').map(encodeURIComponent).join('/') : vars.model,
    taskId: typeof vars.taskId === 'string' ? encodeURIComponent(vars.taskId) : vars.taskId };
  const queryStart = op.path.indexOf('?');
  const path = render(queryStart < 0 ? op.path : op.path.slice(0, queryStart), pathVars, required);
  if (typeof path !== 'string') throw new TemplateValidationError('path', '请求路径缺少变量');
  const absolute = /^https?:\/\//i.test(path);
  if (absolute && !templateVariables(op.path).some((variable) => variable.startsWith('submit.'))) throw new TemplateValidationError('path', '仅提交响应提供的轮询路径允许绝对 URL');
  if (!absolute && (!path.startsWith('/') || path.startsWith('//'))) throw new TemplateValidationError('path', '请求路径必须以单个 / 开头');
  const url = new URL(absolute ? path : `${profile.baseUrl}${path}`);
  if (url.origin !== new URL(profile.baseUrl).origin || url.username || url.password) throw new TemplateValidationError('path', '轮询 URL 必须与渠道同源，禁止向其他站点泄露密钥');
  if (queryStart >= 0) {
    const query = new URLSearchParams(op.path.slice(queryStart + 1));
    for (const [name, template] of query) {
      const value = render(template, vars, required);
      if (value !== undefined) url.searchParams.append(name, typeof value === 'string' ? value : JSON.stringify(value));
    }
  }
  const headers = { ...profile.headers };
  if (profile.auth.type !== 'none' && !apiKey.trim()) throw new TemplateValidationError('apiKey', '缺少 API Key');
  if (profile.auth.type === 'bearer') headers.Authorization = summaries ? 'Bearer ***' : `Bearer ${apiKey}`;
  if (profile.auth.type === 'header') headers[profile.auth.name] = `${profile.auth.prefix ?? ''}${summaries ? '***' : apiKey}`;
  if (profile.auth.type === 'query') url.searchParams.set(profile.auth.name, summaries ? '***' : apiKey);
  const rendered = op.template === undefined ? {} : render(op.template, vars, required);
  let body: RequestBody = { mode: 'none' };
  if (op.body === 'json') {
    headers['Content-Type'] = 'application/json';
    body = { mode: 'json', json: rendered ?? {} };
  } else if (op.body === 'multipart') {
    if (!rendered || Array.isArray(rendered) || typeof rendered !== 'object') throw new TemplateValidationError('template', 'multipart 文本字段必须是对象');
    const fields = Object.entries(rendered).map(([name, value]) => ({ name, value: typeof value === 'string' ? value : JSON.stringify(value) }));
    const spec = op.files!;
    const refs = spec.cardinality === 'single' ? job.refs.slice(0, 1) : job.refs;
    const name = spec.cardinality === 'array' && !spec.field.endsWith('[]') ? `${spec.field}[]` : spec.field;
    const files = refs.map((ref, index) => ({ name, path: ref.path, mime: ref.mime, filename: ref.path.split(/[\\/]/).pop() || `reference-${index + 1}` }));
    if (summaries) refs.forEach((ref, index) => fields.push({ name, value: refSummary(ref, index) }));
    body = { mode: 'multipart', fields, files: summaries ? [] : files };
  }
  return { method: op.method, url: url.toString(), headers, body };
}
function asPreview(request: HttpRequest): RequestPreview {
  return { method: request.method, url: request.url, headers: request.headers, body: request.body.mode === 'multipart' ? { mode: 'multipart', fields: request.body.fields } : request.body };
}
function build(profile: ChannelProfileV2, job: JobInput, apiKey: string, values: string[], taskId?: string, submit?: unknown, result = false): RenderedRequest {
  const prepared = prepare(profile, job);
  const op = taskId === undefined ? prepared.op : pollOperation(prepared.op, result);
  const vars = { ...prepared.vars, ...refVariables(job, values), taskId, submit };
  const previewVars = { ...prepared.vars, ...refVariables(job, job.refs.map(refSummary)), taskId, submit };
  return { request: makeRequest(profile, job, op, vars, [...prepared.required, ...(taskId === undefined ? [] : ['taskId'])], apiKey, false),
    preview: asPreview(makeRequest(profile, job, op, previewVars, prepared.required, apiKey, true)) };
}
function pollOperation(op: OperationSpec, result = false): OperationSpec {
  if (op.response.mode !== 'async') throw new TemplateValidationError('operation', '此操作不支持轮询');
  const poll = result ? op.response.poll.resultRequest : op.response.poll;
  if (!poll) throw new TemplateValidationError('operation', '此操作未配置结果查询请求');
  return { method: poll.method, path: poll.path, body: poll.template === undefined ? 'none' : 'json', template: poll.template, response: { mode: 'sync', outputs: op.response.poll.outputs } };
}
export async function renderRequest(profile: ChannelProfileV2, job: JobInput, apiKey: string, resolveRef: ResolveRef, taskId?: string, submit?: unknown, result = false): Promise<RenderedRequest> {
  const { op } = prepare(profile, job);
  const used = templateVariables(taskId === undefined ? op.template : op.response.mode === 'async' ? op.response.poll.template : undefined);
  const needs = (ref: JobRef) => ref.kind === 'image' ? used.includes('images') || used.includes('image') : used.includes(ref.kind === 'video' ? 'videos' : 'audios');
  const values = await Promise.all(job.refs.map((ref, index) => needs(ref) ? resolveRef(ref, op.imageEncoding ?? 'data-url') : Promise.resolve(refSummary(ref, index))));
  return build(profile, job, apiKey, values, taskId, submit, result);
}
/** Synchronous preview performs no file reads; request and preview share the renderer. */
export function renderPreview(profile: ChannelProfileV2, job: JobInput, apiKey = 'preview-key'): RequestPreview {
  return build(profile, job, apiKey, job.refs.map(refSummary)).preview;
}
