import type { ChannelProfileV2, ModelSpec, OperationSpec, ParamSpec, Template } from './profile';
import { templateVariables, validateProfile } from './profile';
import type { JobInput, JobRef, JsonValue, RequestPreview } from '../runtime/types';
import { resolveModelMode } from '../application/modelModes';
import { compileReferenceMentions } from './mentions';
import { isPublicReferenceUrl, ReferenceNeedsPublicUrlError } from './referenceErrors';
import { sameParameterValue } from './parameterValue';

export type ImageEncoding = 'url' | 'data-url' | 'base64';
export type ResolveRef = (ref: JobRef, encoding: ImageEncoding) => Promise<string>;
export interface MultipartFile { name: string; path: string; mime: string; filename: string }
export type RequestBody = { mode: 'json'; json: JsonValue } | { mode: 'form-urlencoded'; fields: { name: string; value: string }[] } | { mode: 'multipart'; fields: { name: string; value: string }[]; files: MultipartFile[] } | { mode: 'none' };
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
export function resolveParamValue(param: ParamSpec, value: JsonValue | undefined): JsonValue | undefined {
  const resolved = value === undefined ? param.default : value;
  if (missing(resolved)) {
    if (param.required) throw new TemplateValidationError(`param.${param.key}`, `缺少必填参数：${param.label}`);
    return undefined;
  }
  const fail = () => { throw new TemplateValidationError(`param.${param.key}`, `参数 ${param.label} 的值不符合声明`); };
  if (param.type === 'enum' && !param.options?.some((option) => sameParameterValue(option.value, resolved))) fail();
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
/** Shared endpoint selection for rendering, response parsing and durable recovery. */
export function resolveJobOperation(profile: ChannelProfileV2, job: JobInput): OperationSpec {
  const model = profile.models.find((candidate) => candidate.id === job.modelId);
  const resolved = model?.modes ? resolveModelMode(model, job.modeId) : undefined;
  if (resolved && resolved.operation !== job.operation) throw new TemplateValidationError('operation', '任务操作与模型模式不一致');
  const op = resolved?.operationSpec ?? profile.operations[job.operation];
  if (!op) throw new TemplateValidationError('operation', `渠道未配置操作：${job.operation}`);
  return op;
}
function prepare(profile: ChannelProfileV2, job: JobInput, polling = false): { op: OperationSpec; model?: ModelSpec; vars: TemplateVars; required: string[] } {
  const errors = validateProfile(profile);
  if (errors.length) throw new TemplateValidationError(errors[0].path, errors[0].message);
  const op = resolveJobOperation(profile, job);
  const model = profile.models.find((candidate) => candidate.id === job.modelId);
  if (job.operation !== 'models.list' && (!job.modelId.trim() || !model)) throw new TemplateValidationError('model', '缺少或未声明模型');
  if (!polling && job.operation !== 'models.list' && job.operation !== 'chat' && job.operation !== 'model.generate' && !job.prompt.trim()) throw new TemplateValidationError('prompt', '缺少必填值：prompt');
  const resolved = model ? resolveModelMode(model, job.modeId) : undefined;
  if (model && !model.modes && job.operation !== 'models.list' && !model.operations.includes(job.operation)) throw new TemplateValidationError('operation', '模型不支持此操作');
  const specs = resolved?.params ?? [];
  const params: Record<string, JsonValue> = {};
  for (const param of specs) { const value = resolveParamValue(param, job.params[param.key]); if (value !== undefined) params[param.key] = value; }
  if (!polling && model?.modes) {
    for (const ref of job.refs) {
      const slot = resolved?.slots.find((entry) => entry.key === ref.slot);
      if (!slot) throw new TemplateValidationError('refs', `未声明参考素材槽位：${ref.slot ?? '未分配'}`);
      if (slot.kind !== ref.kind) throw new TemplateValidationError('refs', `槽位 ${slot.label} 只接受 ${slot.kind} 素材`);
    }
    for (const slot of resolved?.slots ?? []) {
      const count = job.refs.filter((ref) => ref.slot === slot.key).length;
      if (count < (slot.min ?? 0) || count > slot.max) throw new TemplateValidationError(`slot.${slot.key}`, `槽位 ${slot.label} 需要 ${slot.min ?? 0}–${slot.max} 个参考素材`);
    }
  } else if (!polling) for (const kind of ['image', 'video', 'audio'] as const) {
    const count = job.refs.filter((ref) => ref.kind === kind).length;
    if (count > (model?.refs?.[kind] ?? 0)) throw new TemplateValidationError('refs', `${kind} 参考素材数量超出模型声明上限`);
  }
  return { op, model, vars: { model: job.modelId || undefined, mode: resolved?.mode.id, prompt: job.prompt || undefined, param: params,
    messages: job.messages ?? [{ role: 'user', content: job.prompt }],
    ...(job.operation === 'chat' ? { tools: job.tools, toolChoice: job.toolChoice, chatPayload: job.chatPayload } : {}) },
    required: ['model', 'prompt', ...specs.filter((param) => param.required).map((param) => `param.${param.key}`)] };
}
function refSummary(ref: JobRef, index: number): string {
  const dimensions = ref.width && ref.height ? `${ref.width}×${ref.height} ` : '';
  return `<${ref.kind} ${index + 1}: ${dimensions}${ref.mime.split('/')[1] ?? ref.mime}>`;
}
function refVariables(job: JobInput, values: string[], explicitMode: boolean): TemplateVars {
  const kind = (media: JobRef['kind']) => job.refs.flatMap((ref, index) => ref.kind === media ? [values[index]] : []);
  const images = kind('image');
  const videos = kind('video');
  const audios = kind('audio');
  const imageContent = images.map((url) => ({ type: 'image_url', image_url: { url } }));
  const geminiImages = images.map((url) => {
    const data = /^data:([^;,]+);base64,(.*)$/s.exec(url);
    return data ? { inlineData: { mimeType: data[1], data: data[2] } } : { fileData: { fileUri: url } };
  });
  const slots = new Map<string, string[]>();
  for (const [index, ref] of job.refs.entries()) if (ref.slot) {
    const valuesForSlot = slots.get(ref.slot);
    if (valuesForSlot) valuesForSlot.push(values[index]);
    else slots.set(ref.slot, [values[index]]);
  }
  const slot = Object.fromEntries(slots);
  const seedanceContent: JsonValue[] = job.refs.flatMap((ref, index) => ref.kind === 'image' || (explicitMode && ref.slot) ? [{
    type: `${ref.kind}_url`, [`${ref.kind}_url`]: { url: values[index] }, ...(explicitMode && ref.slot ? { role: ref.slot } : {}),
  }] : []);
  return { slot, slotFirst: Object.fromEntries(Object.entries(slot).map(([key, refs]) => [key, refs[0]])),
    images: images.length ? images : undefined, image: images[0],
    videos: videos.length ? videos : undefined, video: videos[0],
    audios: audios.length ? audios : undefined, audio: audios[0],
    firstImageUrl: images[0] ? { url: images[0] } : undefined,
    seedanceContent: [...seedanceContent, { type: 'text', text: job.prompt }],
    wanMedia: explicitMode && job.refs.length ? job.refs.map((ref, index) => ({ type: ref.slot, url: values[index] })) : undefined,
    openaiImageContent: images.length ? [{ type: 'text', text: job.prompt }, ...imageContent] : job.prompt,
    openaiImageInput: [{ type: 'input_text', text: job.prompt }, ...images.map((image_url) => ({ type: 'input_image', image_url }))],
    geminiParts: [{ text: job.prompt }, ...geminiImages] };
}
function makeRequest(profile: ChannelProfileV2, job: JobInput, op: OperationSpec, vars: TemplateVars, required: string[], apiKey: string, summaries: boolean): HttpRequest {
  const pathVars: TemplateVars = { ...vars, model: typeof vars.model === 'string' ? vars.model.split('/').map(encodeURIComponent).join('/') : vars.model,
    taskId: typeof vars.taskId === 'string' ? encodeURIComponent(vars.taskId) : vars.taskId };
  const queryStart = op.path.indexOf('?');
  const path = render(queryStart < 0 ? op.path : op.path.slice(0, queryStart), pathVars, required);
  if (typeof path !== 'string') throw new TemplateValidationError('path', '请求路径缺少变量');
  const absolute = /^https?:\/\//i.test(path);
  if (absolute && !templateVariables(op.path).some((variable) => variable.startsWith('submit.') || variable.startsWith('poll.'))) throw new TemplateValidationError('path', '仅响应提供的轮询或结果路径允许绝对 URL');
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
  } else if (op.body === 'form-urlencoded') {
    if (!rendered || Array.isArray(rendered) || typeof rendered !== 'object') throw new TemplateValidationError('template', '表单字段必须是对象');
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = { mode: 'form-urlencoded', fields: Object.entries(rendered).map(([name, value]) => ({ name, value: typeof value === 'string' ? value : JSON.stringify(value) })) };
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
function build(profile: ChannelProfileV2, job: JobInput, apiKey: string, values: string[], taskId?: string, submit?: unknown, result = false, poll?: unknown): RenderedRequest {
  const model = profile.models.find((entry) => entry.id === job.modelId);
  job = { ...job, prompt: compileReferenceMentions(job.prompt, model?.mention) };
  const prepared = prepare(profile, job, taskId !== undefined);
  const op = taskId === undefined ? prepared.op : pollOperation(prepared.op, result);
  const vars = { ...prepared.vars, ...refVariables(job, values, Boolean(prepared.model?.modes)), taskId, submit, poll };
  const previewVars = { ...prepared.vars, ...refVariables(job, job.refs.map(refSummary), Boolean(prepared.model?.modes)), taskId, submit, poll };
  const required = [...prepared.required, ...(taskId === undefined ? [] : ['taskId']),
    ...[...templateVariables(op.path), ...templateVariables(op.template)].filter((variable) => variable.startsWith('poll.'))];
  return { request: makeRequest(profile, job, op, vars, required, apiKey, false),
    preview: asPreview(makeRequest(profile, job, op, previewVars, required, apiKey, true)) };
}
function pollOperation(op: OperationSpec, result = false): OperationSpec {
  if (op.response.mode !== 'async') throw new TemplateValidationError('operation', '此操作不支持轮询');
  const poll = result ? op.response.poll.resultRequest : op.response.poll;
  if (!poll) throw new TemplateValidationError('operation', '此操作未配置结果查询请求');
  return { method: poll.method, path: poll.path, body: poll.template === undefined ? 'none' : 'json', template: poll.template, response: { mode: 'sync', outputs: op.response.poll.outputs } };
}
function referencedByTemplate(ref: JobRef, index: number, job: JobInput, used: string[]): boolean {
  return used.some((variable) => {
    if (variable === 'seedanceContent') return ref.kind === 'image' || ref.slot !== undefined;
    if (variable === 'wanMedia') return true;
    if (variable === `slot.${ref.slot}` && ref.slot !== undefined) return true;
    if (variable === `slotFirst.${ref.slot}` && ref.slot !== undefined) return job.refs.findIndex((entry) => entry.slot === ref.slot) === index;
    if (ref.kind === 'image' && ['images', 'openaiImageContent', 'openaiImageInput', 'geminiParts'].includes(variable)) return true;
    if (variable === `${ref.kind}s`) return true;
    if (variable === ref.kind || (ref.kind === 'image' && variable === 'firstImageUrl')) return job.refs.findIndex((entry) => entry.kind === ref.kind) === index;
    return false;
  });
}

/** Validate URL-only references synchronously before any durable job or paid submit. */
export function validateChannelReferenceUrls(profile: ChannelProfileV2, job: JobInput): void {
  const op = resolveJobOperation(profile, job);
  if (op.imageEncoding !== 'url') return;
  const used = [...templateVariables(op.path), ...templateVariables(op.template)];
  for (const [index, ref] of job.refs.entries()) {
    if (referencedByTemplate(ref, index, job, used) && !isPublicReferenceUrl(ref.path)) throw new ReferenceNeedsPublicUrlError(ref);
  }
}

export async function renderRequest(profile: ChannelProfileV2, job: JobInput, apiKey: string, resolveRef: ResolveRef, taskId?: string, submit?: unknown, result = false, poll?: unknown): Promise<RenderedRequest> {
  const { op } = prepare(profile, job, taskId !== undefined);
  const renderedOp = taskId === undefined ? op : pollOperation(op, result);
  const used = [...templateVariables(renderedOp.path), ...templateVariables(renderedOp.template)];
  const values = await Promise.all(job.refs.map((ref, index) => referencedByTemplate(ref, index, job, used) ? resolveRef(ref, op.imageEncoding ?? 'data-url') : Promise.resolve(refSummary(ref, index))));
  return build(profile, job, apiKey, values, taskId, submit, result, poll);
}
/** Synchronous preview performs no file reads; request and preview share the renderer. */
export function renderPreview(profile: ChannelProfileV2, job: JobInput, apiKey = 'preview-key'): RequestPreview {
  return build(profile, job, apiKey, job.refs.map(refSummary)).preview;
}
