import type { CustomProviderConfig } from '@/stores/customProvidersStore';
import {
  normalizeCustomImageRequestContract,
  setValueAtSafePath,
  type CustomImageRequestContractV1,
  type ImageRequestVariantV1,
} from '@/features/canvas/application/customImageProviderContract';
import { buildProviderUrl, normalizeProviderBaseUrl } from '@/features/canvas/application/providerUrl';
import { resolveCustomProviderBodyMode } from '@/features/canvas/infrastructure/customProviderTransport';
import type {
  ChannelProfileV2, JsonValue, OperationKind, OperationSpec, OutputSpec, ParamSpec, Template,
} from '../domain/profile';

export interface UnmigratedLegacyField { key: string; value: unknown; reason: string }
export interface LegacyConfigMigration {
  profile: ChannelProfileV2;
  unmigrated: UnmigratedLegacyField[];
}

const SECRET = /authorization|cookie|api[-_ ]?key|token|secret|signature|credential|password|passphrase|bearer/i;
const SECRET_VALUE_KEY = /^(?:authorization|cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|credential|password|passphrase)$/i;
const PARAMETER_KEYS: Record<string, true> = Object.fromEntries([
  'size', 'aspect_ratio', 'aspectRatio', 'resolution', 'resolutionType', 'modelVersion',
  'n', 'num_images', 'quality', 'style', 'seed', 'negative_prompt', 'negativePrompt',
  'strength', 'guidance_scale', 'num_inference_steps', 'steps', 'width', 'height',
  'seconds', 'duration', 'fps', 'output_format', 'response_format', 'web_search',
  'temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'stream',
].map((key) => [key, true]));
const ARRAY_FIELDS: Record<string, true> = { images: true, reference_images: true, referenceimages: true, image_urls: true, urls: true, input_images: true };
const PARAMETER_ALIASES: Record<string, string> = { resolutionType: 'size', negativePrompt: 'negative_prompt', aspectRatio: 'aspectRatio' };
const OPTIONAL_PARAMETER_TYPES: Record<string, ParamSpec['type']> = {
  n: 'number', num_images: 'number', seed: 'number', strength: 'number', guidance_scale: 'number',
  num_inference_steps: 'number', steps: 'number', width: 'number', height: 'number', seconds: 'number',
  duration: 'number', fps: 'number', temperature: 'number', top_p: 'number', max_tokens: 'number',
  max_completion_tokens: 'number', web_search: 'boolean', stream: 'boolean',
};
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const strings = (value: unknown): string[] => Array.isArray(value)
  ? [...new Set(value.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim())).map((entry) => entry.trim()))]
  : [];
const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const taskTokens = (value: string): string => value.replace(/\{\{?\s*taskId\s*\}?\}/g, '{{taskId}}');

/** Pure migration. Credentials remain in the caller's credential store, never in this result's profile.
 * Unsupported wire semantics are reported rather than replaced with a plausible HTTP request.
 * Incomplete legacy templates use a reserved, non-routable URL and expose no operations.
 */
export function migrateLegacyConfig(config: CustomProviderConfig): LegacyConfigMigration {
  const used = new Set<string>(['apiKey']);
  const problems = new Map<string, UnmigratedLegacyField>();
  const extra = record(config.extraParams);
  const params = new Map<string, ParamSpec>();
  const secret = config.apiKey.trim();
  const containsSecret = (value: unknown): boolean => {
    if (typeof value === 'string') return Boolean(secret && value.includes(secret));
    if (Array.isArray(value)) return value.some(containsSecret);
    return value !== null && typeof value === 'object'
      && Object.entries(value).some(([key, entry]) => SECRET_VALUE_KEY.test(key) || containsSecret(entry));
  };
  const redact = (value: unknown): unknown => {
    if (typeof value === 'string') return secret ? value.split(secret).join('[redacted]') : value;
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) =>
      [key, SECRET_VALUE_KEY.test(key) ? '[redacted]' : redact(entry)]));
    return value;
  };
  const take = (path: string): void => { used.add(path); };
  const report = (key: string, value: unknown, reason: string): void => {
    take(key);
    if (!problems.has(key)) problems.set(key, { key, value: redact(value), reason });
  };
  const json = (value: unknown, path: string): JsonValue | undefined => {
    if (containsSecret(value)) {
      report(path, value, '含密钥的值不能存入渠道配置，请改用独立凭据。');
      return undefined;
    }
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) {
      const result = value.map((entry, index) => json(entry, `${path}[${index}]`));
      return result.every((entry) => entry !== undefined) ? result as JsonValue[] : undefined;
    }
    if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      const result: Record<string, JsonValue> = {};
      for (const [key, entry] of Object.entries(value)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) {
          report(path, value, '不允许原型或构造器字段。');
          return undefined;
        }
        const parsed = json(entry, `${path}.${key}`);
        if (parsed === undefined) return undefined;
        result[key] = parsed;
      }
      return result;
    }
    report(path, value, '不是可保存的 JSON 值。');
    return undefined;
  };
  const parameter = (key: string, value?: JsonValue, options?: ParamSpec['options']): string => {
    if (!params.has(key)) {
      const type = options || (value !== undefined && typeof value === 'object') ? 'enum'
        : typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean'
          : value === undefined ? OPTIONAL_PARAMETER_TYPES[key] ?? 'text' : 'text';
      params.set(key, {
        key, label: key, type,
        ...(options ? { options } : type === 'enum' && value !== undefined ? { options: [{ label: key, value }] } : {}),
        ...(value !== undefined ? { default: value } : {}),
      });
    } else if (options) {
      params.set(key, { ...params.get(key)!, type: 'enum', options });
    }
    return `{{param.${key}}}`;
  };
  const literal = (value: string, path: string): string => {
    if (containsSecret(value) || /{{/.test(value)) {
      report(path, value, '连接或标识含密钥/模板表达式，无法安全迁移。');
      return '';
    }
    take(path);
    return value.trim();
  };
  const profile: ChannelProfileV2 = {
    version: 2,
    id: literal(config.id, 'id') || 'legacy-incomplete',
    name: literal(config.label, 'label') || '未完成的旧渠道',
    baseUrl: 'https://invalid.invalid',
    auth: { type: 'bearer' }, operations: {}, models: [],
  };
  if (!config.id.trim()) report('id', config.id, '空 ID 已替换为迁移标识。');
  if (!config.label.trim()) report('label', config.label, '空名称已替换为未完成的旧渠道。');
  const notes: string[] = [];
  if (config.note) {
    const note = json(config.note, 'note');
    if (typeof note === 'string') { notes.push(note); take('note'); }
  } else take('note');
  let usableUrl = true;
  const baseQuery: Record<string, string> = {};
  let originalBase = normalizeProviderBaseUrl(config.baseUrl);
  try {
    const url = new URL(originalBase);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('protocol');
    if (url.username || url.password || containsSecret(url.origin + url.pathname)) throw new Error('credentials');
    const query: Record<string, string> = {};
    url.searchParams.forEach((value, key) => { query[key] = value; });
    if (url.search || url.hash) {
      report('baseUrl', config.baseUrl, 'URL 查询参数已迁入操作路径；片段不参与 HTTP 请求。');
      // Do not put a key embedded in an old URL into any template.
      for (const [key, value] of Object.entries(query)) {
        if (SECRET.test(key) || containsSecret(value)) {
          report(`baseUrl.query.${key}`, value, 'URL 中的凭据必须迁入独立凭据存储。');
          delete query[key];
        }
      }
      url.search = ''; url.hash = '';
      originalBase = url.toString().replace(/\/+$/, '');
      Object.assign(baseQuery, query);
    }
    profile.baseUrl = url.origin;
    take('baseUrl');
  } catch {
    // A complete absolute endpoint can rescue a legacy draft with no base URL.
    try {
      const endpoint = new URL(config.endpointPath ?? '');
      if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password
        || containsSecret(endpoint.toString())) throw new Error('endpoint');
      profile.baseUrl = endpoint.origin;
      originalBase = endpoint.origin;
      report('baseUrl', config.baseUrl, '无效根地址；使用完整接口地址的 origin。');
    } catch {
      usableUrl = false;
      report('baseUrl', config.baseUrl, '缺少有效 HTTP 根地址；渠道已禁用，需补全后启用。');
      notes.push('迁移未完成：缺少有效地址，所有操作均已禁用；invalid.invalid 仅为不可用的保留标记。');
    }
  }

  function safeHeader(name: string, value: unknown, path: string): void {
    if (SECRET.test(name) || containsSecret(value)) {
      report(path, value, '密钥类请求头不能静态保存，请改用 auth 和独立凭据。');
    } else if (typeof value === 'string' && name.trim() && !/[\r\n]/.test(name + value)) {
      (profile.headers ??= {})[name.trim()] = value;
      take(path);
    } else report(path, value, '无法迁移的请求头。');
  }
  for (const [name, value] of Object.entries(config.extraHeaders ?? {})) safeHeader(name, value, `extraHeaders.${name}`);
  const kind = string(extra.providerKind);
  const media = config.mediaType === 'chat' || extra.mediaType === 'chat' ? 'chat'
    : config.mediaType === 'video' || extra.mediaType === 'video' ? 'video' : 'image';
  take('mediaType'); take('extraParams.mediaType');
  const auth = record(extra.auth);
  const authMode = string(auth.mode ?? auth.type ?? extra.authMode) || 'bearer';
  const authName = string(auth.name ?? extra.authName) || (authMode === 'query' ? 'key' : 'x-api-key');
  let authSupported = true;
  if (kind === 'google-gemini' || kind === 'google-video') {
    profile.auth = media === 'chat' ? { type: 'query', name: 'key' } : { type: 'header', name: 'x-goog-api-key' };
  } else if (kind === 'anthropic-messages' || config.apiStyle === 'anthropic') {
    profile.auth = { type: 'header', name: 'x-api-key' };
    profile.headers = { 'anthropic-version': '2023-06-01', ...profile.headers };
  } else if (authMode === 'header' || authMode === 'query') profile.auth = { type: authMode, name: authName };
  else if (authMode === 'none' || authMode === 'bearer') profile.auth = { type: authMode };
  else {
    authSupported = false;
    report('extraParams.auth', extra.auth ?? authMode, '无法识别的鉴权模式；生成操作已禁用。');
  }
  for (const key of ['mode', 'type', 'name']) take(`extraParams.auth.${key}`);
  for (const key of ['authMode', 'authName']) take(`extraParams.${key}`);
  const prefix = string(auth.prefix ?? extra.authPrefix);
  if (prefix && profile.auth.type === 'header' && !containsSecret(prefix)) {
    profile.auth.prefix = `${prefix} `;
    take('extraParams.auth.prefix'); take('extraParams.authPrefix');
  } else if (prefix) {
    authSupported = false;
    report(own(auth, 'prefix') ? 'extraParams.auth.prefix' : 'extraParams.authPrefix', prefix,
      '此鉴权前缀不能安全表达；操作已禁用，避免发送错误鉴权。');
  } else { take('extraParams.auth.prefix'); take('extraParams.authPrefix'); }
  if ('name' in profile.auth && (containsSecret(profile.auth.name) || /[\r\n]/.test(profile.auth.name))) {
    authSupported = false;
    report('extraParams.auth.name', authName, '鉴权名称包含密钥或非法字符；操作已禁用。');
    profile.auth = { type: 'none' };
  }

  const query: Record<string, string> = { ...baseQuery };
  for (const [key, value] of Object.entries(config.queryParams ?? {})) {
    if (SECRET.test(key) || containsSecret(value)) report(`queryParams.${key}`, value, '查询凭据必须通过 auth 配置。');
    else { query[key] = value; take(`queryParams.${key}`); }
  }
  const template = (value: unknown, path: string): Template | undefined => {
    const parsed = json(value, path);
    if (parsed === undefined) return undefined;
    const convert = (entry: JsonValue): JsonValue => {
      if (typeof entry === 'string') return taskTokens(entry).replace(/{{\s*([^{}]+?)\s*}}/g, (_match, token: string) => {
        if (token === 'size') return parameter('size');
        if (token === 'aspectRatio') return parameter('aspectRatio');
        if (token === 'firstImage') return '{{image}}';
        if (token.startsWith('extra.')) {
          const name = token.slice(6);
          const [root, ...members] = name.split('.');
          if (![root, ...members].every((part) => /^[\w-]+$/.test(part) && !['__proto__', 'prototype', 'constructor'].includes(part))) throw new Error(`不安全的旧参数 ${token}`);
          if (members.length && !params.has(root)) throw new Error(`嵌套旧参数 ${token} 缺少可迁移的默认对象`);
          parameter(root);
          return `{{param.${name}}}`;
        }
        if (token.startsWith('param.')) {
          parameter(token.slice(6).split('.')[0]);
          return `{{${token}}}`;
        }
        if (['model', 'prompt', 'images', 'image', 'videos', 'audios', 'messages', 'taskId'].includes(token)) return `{{${token}}}`;
        throw new Error(`不支持模板变量 ${token}`);
      });
      if (Array.isArray(entry)) return entry.map(convert);
      if (entry && typeof entry === 'object') return Object.fromEntries(Object.entries(entry).map(([key, child]) => [key, convert(child)]));
      return entry;
    };
    try { const result = convert(parsed); take(path); return result; }
    catch (error) { report(path, value, error instanceof Error ? error.message : '模板无法迁移。'); return undefined; }
  };
  const endpoint = (raw: string, path: string, dynamic: Record<string, unknown> = {}): string | undefined => {
    if (containsSecret(raw)) { report(path, raw, '接口地址含密钥。'); return undefined; }
    if (/[?&](?:api[-_]?key|key|access[-_]?token|token|secret)=/i.test(raw)) {
      report(path, raw, '接口地址包含静态查询凭据；请迁入 auth 后人工恢复地址。');
      return undefined;
    }
    let url = buildProviderUrl(originalBase, raw).replace(/\{\{?model(?:Id)?\}?\}/g, '{{model}}');
    for (const [key, value] of Object.entries({ ...query, ...dynamic })) {
      if (SECRET.test(key) || containsSecret(value)) { report(`${path}.query.${key}`, value, '查询凭据必须通过 auth 配置。'); continue; }
      const rendered = template(value, `${path}.query.${key}`);
      if (rendered === undefined) return undefined;
      const text = typeof rendered === 'object' ? JSON.stringify(rendered) : String(rendered);
      url += `${url.includes('?') ? '&' : '?'}${encodeURIComponent(key)}=${encodeURIComponent(text).replace(/%7B/gi, '{').replace(/%7D/gi, '}')}`;
    }
    const converted = template(url, path);
    if (typeof converted !== 'string') return undefined;
    if (converted.startsWith(profile.baseUrl + '/') || converted === profile.baseUrl || converted.startsWith(profile.baseUrl + '?')) {
      const suffix = converted.slice(profile.baseUrl.length);
      return suffix.startsWith('/') ? suffix : `/${suffix}`;
    }
    report(path, raw, '跨 origin 的接口地址不能共享渠道凭据；操作未迁移。');
    return undefined;
  };
  const put = (body: Record<string, JsonValue>, path: string, value: JsonValue, source: string): boolean => {
    try { setValueAtSafePath(body, path.replace(/\[\]$/, ''), value); return true; }
    catch (error) { report(source, path, error instanceof Error ? error.message : '不安全的字段路径。'); return false; }
  };
  const defaults: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(record(extra.defaultRequestParams))) {
    const source = `extraParams.defaultRequestParams.${key}`;
    if (SECRET_VALUE_KEY.test(key)) { report(source, value, '密钥参数不能静态保存。'); continue; }
    if (containsSecret(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) {
      report(source, value, '不安全或含密钥的参数名不能静态保存。');
      continue;
    }
    const parsed = json(value, source);
    if (parsed === undefined) continue;
    const paramKey = /^[\w-]+$/.test(key) ? key : `legacy_${Object.keys(defaults).length}`;
    const token = parameter(paramKey, parsed);
    defaults[key] = parsed === null || parsed === '' ? parsed : token;
    take(source);
  }
  for (const [key, value] of Object.entries(extra)) {
    if (!PARAMETER_KEYS[key]) continue;
    const parsed = json(value, `extraParams.${key}`);
    if (parsed !== undefined) {
      const paramKey = PARAMETER_ALIASES[key] ?? key;
      const wireKey = paramKey === 'aspectRatio' ? 'aspect_ratio' : paramKey;
      const token = parameter(paramKey, parsed);
      defaults[wireKey] = parsed === null || parsed === '' ? parsed : token;
      take(`extraParams.${key}`);
    }
  }
  const choices = (key: string, values: unknown, source: string): void => {
    const options = strings(values);
    if (containsSecret(options)) { report(source, values, '参数选项包含密钥，不能静态保存。'); return; }
    if (options.length) {
      parameter(key, undefined, options.map((value) => ({ label: value, value })));
      take(source);
    } else if (Array.isArray(values) && !values.length) take(source);
  };
  choices('size', config.supportedResolutions, 'supportedResolutions');
  choices('modelVersion', config.supportedModelVersions, 'supportedModelVersions');
  choices('aspectRatio', extra.supportedRatios, 'extraParams.supportedRatios');
  if (config.supportsWebSearch) params.set('web_search', { key: 'web_search', label: '联网搜索', type: 'boolean' });
  take('supportsWebSearch');

  const outputs = (paths: unknown, source: string, format = config.responseFormat): OutputSpec[] => {
    const declared = strings(paths);
    if (declared.length) {
      take('responseFormat');
      take(source);
      return declared.map((path) => ({ path, as: /b64|base64|inlineData\.data/.test(path) || (config.apiStyle === 'stability' && path === 'image') ? 'base64' : format === 'data-url' ? 'data-url' : 'url' }));
    }
    take('responseFormat');
    if (kind === 'google-gemini' && media === 'image') return [{ path: 'candidates[*].content.parts[*].inlineData.data', as: 'base64' }];
    if (media === 'chat') return [];
    if (format === 'url-array') return [{ path: '[*]', as: 'url' }, { path: 'images[*]', as: 'url' }];
    if (format === 'data-url') return [{ path: '$', as: 'data-url' }, { path: 'image', as: 'data-url' }, { path: 'data', as: 'data-url' }];
    if (format === 'generic') {
      report('responseFormat', format, '任意 JSON/Markdown/嵌套 JSON 图片扫描无法表达为 v2 固定路径，请确认输出路径。');
      return [
        { path: 'url', as: 'url' }, { path: 'image', as: 'url' }, { path: 'images[*].url', as: 'url' },
        { path: 'images[*]', as: 'url' }, { path: 'output[*]', as: 'url' },
        { path: 'data[*].url', as: 'url' }, { path: 'data[*].b64_json', as: 'base64' },
        { path: 'output[*].result', as: 'base64' },
      ];
    }
    return [{ path: 'data[*].url', as: 'url' }, { path: 'data[*].b64_json', as: 'base64' }];
  };
  const response = (raw: unknown, paths: unknown, source: string): OperationSpec['response'] | undefined => {
    const output = outputs(paths, `${source}.responseImagePaths`);
    if (media === 'video' && raw === undefined) {
      const pollPath = endpoint(taskTokens(string(extra.videoStatusEndpointPath) || `${basePath.replace(/\/+$/, '')}/{taskId}`), 'extraParams.videoStatusEndpointPath', record(extra.videoStatusQueryParams ?? extra.videoPollQueryParams));
      if (!pollPath) return undefined;
      const pollBody = extra.videoStatusRequestBody ?? extra.videoPollRequestBody;
      const pollTemplate = pollBody === undefined ? undefined : template(pollBody, 'extraParams.videoStatusRequestBody');
      if (pollBody !== undefined && pollTemplate === undefined) return undefined;
      for (const key of ['videoStatusEndpointPath', 'videoStatusMethod', 'videoPollMethod', 'videoStatusRequestBody', 'videoPollRequestBody', 'videoStatusQueryParams', 'videoPollQueryParams']) take(`extraParams.${key}`);
      for (const key of ['videoTaskIdPath', 'videoResponsePath']) take(`extraParams.${key}`);
      const contentPath = string(extra.videoContentEndpointPath)
        ? endpoint(taskTokens(string(extra.videoContentEndpointPath)), 'extraParams.videoContentEndpointPath') : undefined;
      return { mode: 'async', taskIdPath: string(extra.videoTaskIdPath) || 'id', poll: {
        method: String(extra.videoStatusMethod ?? extra.videoPollMethod).toUpperCase() === 'POST' ? 'POST' : 'GET',
        path: pollPath, ...(pollTemplate === undefined ? {} : { template: pollTemplate }),
        intervalSec: 1, timeoutMin: 15, statusPath: 'status',
        success: ['completed', 'succeeded', 'success', 'done'], failure: ['failed', 'error', 'cancelled', 'canceled'],
        outputs: contentPath ? [{ url: contentPath, kind: 'video', auth: true }]
          : string(extra.videoResponsePath) ? [{ path: string(extra.videoResponsePath), as: 'url', kind: 'video' }]
            : [{ path: 'video_url', as: 'url', kind: 'video' }, { path: 'url', as: 'url', kind: 'video' }, { path: 'output.url', as: 'url', kind: 'video' }],
      } };
    }
    if (raw === undefined || raw === null) return { mode: 'sync', outputs: output };
    const task = record(raw);
    if (task.enabled === false) { take(source); return { mode: 'sync', outputs: output }; }
    if (!string(task.resultEndpointPath)) { report(source, raw, '异步任务缺少轮询地址；操作未迁移。'); return undefined; }
    const pollPath = endpoint(taskTokens(string(task.resultEndpointPath)), `${source}.resultEndpointPath`);
    if (!pollPath) return undefined;
    const pollTemplate = task.requestBody === undefined ? undefined : template(task.requestBody, `${source}.requestBody`);
    if (task.requestBody !== undefined && pollTemplate === undefined) return undefined;
    for (const key of ['enabled', 'taskIdPath', 'resultMethod', 'imagePath', 'statusPath', 'successValues', 'failedValues', 'intervalMs', 'timeoutMs', 'progressPath']) take(`${source}.${key}`);
    // Pending is implicit in v2: every status other than success/failure remains running.
    take(`${source}.pendingValues`);
    const asyncOutputs = string(task.imagePath) ? outputs([task.imagePath], `${source}.imagePath`) : output;
    return { mode: 'async', taskIdPath: string(task.taskIdPath) || 'id', poll: {
      method: String(task.resultMethod).toUpperCase() === 'POST' ? 'POST' : 'GET', path: pollPath,
      ...(pollTemplate !== undefined ? { template: pollTemplate } : {}),
      intervalSec: Number.isFinite(Number(task.intervalMs)) ? Math.max(500, Number(task.intervalMs)) / 1000 : 1,
      timeoutMin: Number.isFinite(Number(task.timeoutMs)) ? Math.max(5000, Number(task.timeoutMs)) / 60000 : 2,
      ...(string(task.statusPath) ? { statusPath: string(task.statusPath) } : {}),
      success: strings(task.successValues).length ? strings(task.successValues) : ['succeeded', 'success', 'completed', 'complete', 'done', 'finished'],
      failure: strings(task.failedValues).length ? strings(task.failedValues) : ['failed', 'error', 'canceled', 'cancelled'],
      ...(string(task.progressPath) ? { progressPath: string(task.progressPath) } : {}), outputs: asyncOutputs,
    } };
  };

  let contract: CustomImageRequestContractV1 | undefined;
  let validContract = true;
  if (extra.imageRequestContract !== undefined) {
    const normalized = normalizeCustomImageRequestContract(extra.imageRequestContract);
    if (normalized.value && !normalized.issues.length) { contract = normalized.value; take('extraParams.imageRequestContract.version'); }
    else {
      validContract = false;
      report('extraParams.imageRequestContract', extra.imageRequestContract,
        normalized.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ') || '无效的 V1 合约。');
    }
  }
  const bodyMode = resolveCustomProviderBodyMode(config);
  const local = ['comfyui', 'dreamina-cli', 'minimax-h3', 'local-audio'].includes(config.apiStyle)
    || ['minimax-h3', 'dreamina-cli', 'local-audio'].includes(kind);
  const unsupportedTransport = local || bodyMode === 'signed';
  if (unsupportedTransport) report('apiStyle', config.apiStyle, local
    ? '此渠道必须使用专用适配器，不能迁为 HTTP 模板。' : '签名传输不能迁为静态 HTTP 鉴权。');
  else take('apiStyle');
  if (['openai-images', 'openai-chat-image', 'openai-responses', 'google-gemini', 'anthropic-messages', 'agnes-images', 'agnes-chat', 'fal', 'replicate', 'stability', 'midjourney'].includes(kind)) {
    take('extraParams.providerKind');
    if (extra.providerConfigVersion === 'new-v1') take('extraParams.providerConfigVersion');
  }
  const originalPath = new URL(usableUrl ? originalBase : profile.baseUrl).pathname;
  const basePath = string(config.endpointPath) || (media === 'chat'
    ? kind === 'openai-responses' ? '/v1/responses' : kind === 'anthropic-messages' || config.apiStyle === 'anthropic' ? '/v1/messages'
      : kind === 'google-gemini' ? '/v1beta/models/{model}:generateContent' : '/v1/chat/completions'
    : media === 'video' ? '/v1/videos'
      : config.apiStyle === 'openai-compatible'
        ? /\/(images\/(generations|edits)|responses|chat\/completions)$/.test(originalPath) ? ''
          : originalPath === '/' ? '/v1/images/generations' : '/images/generations'
        : config.apiStyle === 'fal' && originalPath === '/' ? '/{model}'
          : config.apiStyle === 'stability' ? '/v2beta/stable-image/generate/core' : '');
  const ratioSource = contract?.ratioMappings ? 'extraParams.imageRequestContract.ratioMappings' : 'extraParams.ratioMappings';
  const ratioMappings = record(contract?.ratioMappings ?? extra.ratioMappings);
  const ratioFieldKeys = [...new Set(Object.values(ratioMappings).flatMap((mapping) => Object.keys(record(record(mapping).fields))))];
  const ratioOptions: NonNullable<ParamSpec['options']> = [];
  let usableMappings = true;
  const mappingValue = (value: JsonValue, ratio: string, size: string | undefined): JsonValue => {
    if (typeof value === 'string') {
      if (/{{\s*(?!aspectRatio\s*}}|size\s*}})[^{}]+}}/.test(value)) throw new Error('映射字段含运行时变量，不能作为枚举值保存。');
      return value.replace(/{{\s*aspectRatio\s*}}/g, ratio).replace(/{{\s*size\s*}}/g, size ?? '');
    }
    if (Array.isArray(value)) return value.map((entry) => mappingValue(entry, ratio, size));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, mappingValue(entry, ratio, size)]));
    return value;
  };
  try {
    for (const [label, raw] of Object.entries(ratioMappings)) {
      if (containsSecret(label) || containsSecret(raw)) throw new Error('比例映射包含密钥，不能静态保存。');
      const mapping = record(raw);
      const ratio = string(mapping.ratio) || label;
      const size = string(mapping.size) || undefined;
      const value: Record<string, JsonValue> = { ratio, ...(size ? { size } : {}) };
      for (const [index, path] of ratioFieldKeys.entries()) {
        if (!own(record(mapping.fields), path)) continue;
        const parsed = json(record(mapping.fields)[path], `${ratioSource}.${label}.fields.${path}`);
        if (parsed === undefined) throw new Error('比例映射包含不可保存的值。');
        value[`field_${index}`] = mappingValue(parsed, ratio, size);
      }
      ratioOptions.push({ label, value });
    }
    if (ratioOptions.length) {
      params.set('aspectRatio', { key: 'aspectRatio', label: '比例', type: 'enum', options: ratioOptions });
      take(ratioSource);
    }
  } catch (error) {
    usableMappings = false;
    report(ratioSource, ratioMappings, error instanceof Error ? error.message : '比例映射无法迁移。');
  }
  const applyMappings = (body: Template): Template => {
    if (!ratioOptions.length) return body;
    const convert = (value: JsonValue): JsonValue => {
      if (typeof value === 'string') return value.replace(/{{param\.aspectRatio}}/g, '{{param.aspectRatio.ratio}}')
        .replace(/{{param\.size}}/g, '{{param.aspectRatio.size}}');
      if (Array.isArray(value)) return value.map(convert);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, convert(entry)]));
      return value;
    };
    const result = convert(body);
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      ratioFieldKeys.forEach((path, index) => put(result, path, `{{param.aspectRatio.field_${index}}}`, ratioSource));
    }
    return result;
  };
  const hints = record(extra.requestBodyHints);
  const buildBody = (edit: boolean): Record<string, JsonValue> => {
    const body: Record<string, JsonValue> = { ...defaults };
    if (media === 'chat') {
      if (kind === 'google-gemini') body.contents = [{ role: 'user', parts: [{ text: '{{prompt}}' }] }];
      else if (kind === 'openai-responses') { body.model = '{{model}}'; body.input = '{{prompt}}'; }
      else { body.model = '{{model}}'; body.messages = '{{messages}}'; }
      if (kind === 'anthropic-messages' || config.apiStyle === 'anthropic') body.max_tokens ??= parameter('max_tokens', 8192);
      return body;
    }
    if (kind === 'google-gemini') {
      return { contents: [{ role: 'user', parts: [{ text: '{{prompt}}' }] }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: {
          aspectRatio: parameter('aspectRatio'), imageSize: parameter('size'),
        } } };
    }
    if (kind === 'agnes-images') {
      return { ...defaults, model: '{{model}}', prompt: '{{prompt}}', size: parameter('size'), n: parameter('n', 1),
        ...(edit ? { tags: ['img2img'], extra_body: { image: '{{images}}', response_format: 'b64_json' } } : { return_base64: true }) };
    }
    if (extra.providerConfigVersion === 'new-v1' && kind === 'stability') {
      return { prompt: '{{prompt}}', aspect_ratio: parameter('aspectRatio'), output_format: 'png', ...defaults };
    }
    if (extra.providerConfigVersion === 'new-v1' && kind === 'fal') {
      return { prompt: '{{prompt}}', image_size: parameter('image_size', 'square_hd'), num_images: parameter('num_images', 1), ...defaults,
        ...(edit ? { image_url: '{{image}}' } : {}) };
    }
    if (extra.providerConfigVersion === 'new-v1' && kind === 'replicate') {
      return { ...defaults, version: defaults.version ?? '{{model}}', input: {
        prompt: '{{prompt}}', aspect_ratio: parameter('aspectRatio'), ...(edit ? { image: '{{image}}' } : {}),
      } };
    }
    if (media === 'image' && /\/responses$/.test(basePath)) {
      body.model = '{{model}}'; body.input = '{{prompt}}'; body.tools ??= [{ type: 'image_generation' }];
      return body;
    }
    if (media === 'image' && /\/chat\/completions$/.test(basePath)) {
      body.model = '{{model}}'; body.messages = [{ role: 'user', content: '{{prompt}}' }];
      body.modalities = ['image', 'text']; body.n = parameter('n', 1); body.size = parameter('size');
      return body;
    }
    body.model = '{{model}}'; body.prompt = '{{prompt}}'; body.size = parameter('size');
    if (media === 'video') body.seconds ??= parameter('seconds');
    else if (config.apiStyle === 'openai-compatible') body.n ??= parameter('n', 1);
    const mapping: [string, string, JsonValue][] = [
      ['modelField', 'model', '{{model}}'], ['promptField', 'prompt', '{{prompt}}'],
      ['sizeField', 'size', parameter('size')], ['ratioField', 'aspect_ratio', parameter('aspectRatio')],
    ];
    for (const [hint, canonical, token] of mapping) {
      if (own(hints, hint)) {
        delete body[canonical];
        if (string(hints[hint])) put(body, string(hints[hint]), token, `extraParams.requestBodyHints.${hint}`);
        take(`extraParams.requestBodyHints.${hint}`);
      } else if (hint === 'ratioField' && params.has('aspectRatio')) body[canonical] = token;
    }
    if (config.supportsWebSearch) body.web_search = parameter('web_search');
    if (params.has('modelVersion')) body.modelVersion = '{{param.modelVersion}}';
    if (edit) {
      const field = string(hints.referenceImageField) || (config.apiStyle === 'openai-compatible' ? 'image' : 'reference_images');
      const array = field.endsWith('[]') || ARRAY_FIELDS[field.toLowerCase().replace(/[_-]/g, '')] || ARRAY_FIELDS[field.toLowerCase()];
      put(body, field, array ? '{{images}}' : '{{image}}', 'extraParams.requestBodyHints.referenceImageField');
      take('extraParams.requestBodyHints.referenceImageField');
    }
    return body;
  };
  const migrateOperation = (operation: OperationKind, variant?: ImageRequestVariantV1, variantSource?: string): void => {
    const edit = operation === 'image.edit';
    const source = variantSource ?? 'extraParams';
    const mode = variant?.bodyMode ?? bodyMode;
    if (edit && !variant && (kind === 'google-gemini' || /\/chat\/completions$/.test(basePath))) {
      report('endpointPath', config.endpointPath, '旧多模态消息数组需要逐图转换，不能由 v2 静态模板忠实表达；图片编辑操作未迁移。');
      return;
    }
    if (mode === 'form-urlencoded') { report(variant ? `${source}.bodyMode` : 'extraParams.requestBodyMode', mode, 'v2 不支持 form-urlencoded；操作未迁移。'); return; }
    const pathRaw = variant?.endpointPath ?? (string(extra[edit ? 'imageEditEndpointPath' : 'imageGenerationEndpointPath']) || basePath);
    const path = endpoint(pathRaw, variant ? `${source}.endpointPath` : 'endpointPath', variant?.query);
    if (!path) return;
    const method = variant?.method ?? config.httpMethod ?? 'POST';
    let body: Template | undefined = variant?.bodyTemplate === undefined ? buildBody(edit)
      : template(variant.bodyTemplate, `${source}.bodyTemplate`);
    if (body === undefined) return;
    body = applyMappings(body);
    if (variant?.headers && Object.keys(variant.headers).length) {
      // Headers live on the channel, not the operation; promoting these would change sibling requests.
      report(`${source}.headers`, variant.headers, 'v2 无操作级请求头；不能提升为影响其他操作的全局请求头。');
      return;
    }
    const responsePaths = variant?.responseImagePaths ?? extra.responseImagePaths
      ?? (typeof extra.responseImagePath === 'string' ? [extra.responseImagePath] : undefined);
    const asyncRaw = variant ? variant.asyncTask : extra.asyncTask;
    const reply = response(asyncRaw, responsePaths, variant ? `${source}.asyncTask` : 'extraParams.asyncTask');
    if (!reply) return;
    const spec: OperationSpec = { method, path, body: method === 'GET' ? 'none' : mode === 'multipart' ? 'multipart' : 'json', response: reply };
    if (method === 'GET') {
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        report(variant ? `${source}.bodyTemplate` : 'httpMethod', variant?.bodyTemplate ?? method, 'GET 查询模板必须为对象。');
        return;
      }
      const queryPath = endpoint(pathRaw, variant ? `${source}.endpointPath` : 'endpointPath', { ...variant?.query, ...body });
      if (!queryPath) return;
      spec.path = queryPath;
    } else spec.template = body;
    if (mode === 'multipart' && method !== 'GET') {
      const fields = variant?.imageFields;
      if (fields && fields.length > 1) { report(`${source}.imageFields`, fields, 'v2 每个 multipart 操作只支持一个文件字段；操作未迁移。'); return; }
      const field = fields?.[0];
      const name = field?.name ?? (string(record(extra.multipart).fileField) || string(hints.referenceImageField) || (media === 'video' ? string(extra.videoReferenceField) || 'input_reference' : 'image'));
      spec.files = { field: name, cardinality: field?.mode ?? (name.endsWith('[]') ? 'array' : 'repeat') };
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        delete body.image; delete body.images; delete body.reference_images;
        delete body[name]; delete body[name.replace(/\[\]$/, '')];
      }
      if (fields) take(`${source}.imageFields`);
      for (const key of ['enabled', 'fileField']) take(`extraParams.multipart.${key}`);
      take('extraParams.requestBodyHints.referenceImageField'); take('extraParams.videoReferenceField');
    } else if (variant?.imageFields?.length) {
      const encodings = new Set(variant.imageFields.map((field) => field.encoding ?? 'data-url'));
      if (encodings.size > 1) { report(`${source}.imageFields`, variant.imageFields, 'v2 每个 JSON 操作只能有一种图片编码；操作未迁移。'); return; }
      spec.imageEncoding = variant.imageFields[0].encoding ?? 'data-url';
      if (!body || typeof body !== 'object' || Array.isArray(body)) { report(`${source}.imageFields`, variant.imageFields, '图片字段需要对象请求体。'); return; }
      delete body.image; delete body.images; delete body.reference_images;
      for (const field of variant.imageFields) if (!put(body, field.name, field.mode === 'single' ? '{{image}}' : '{{images}}', `${source}.imageFields`)) return;
      take(`${source}.imageFields`);
    } else if (edit && string(hints.referenceImageField) === 'urls') spec.imageEncoding = 'base64';
    if (string(record(asyncRaw).errorPath)) { spec.errorPath = string(record(asyncRaw).errorPath); take(`${variant ? source + '.asyncTask' : 'extraParams.asyncTask'}.errorPath`); }
    profile.operations[operation] = spec;
    take('httpMethod');
    if (!variant) {
      for (const key of ['requestBodyMode', 'bodyMode', edit ? 'imageEditEndpointPath' : 'imageGenerationEndpointPath', 'responseImagePath', 'responseImagePaths']) take(`extraParams.${key}`);
    }
    if (responsePaths !== undefined) {
      if (extra.responseImagePath !== undefined) take('extraParams.responseImagePath');
      if (extra.responseImagePaths !== undefined) take('extraParams.responseImagePaths');
    }
    if (variant) {
      if (variant.bodyTemplate === undefined && extra.imageRequestContractLegacyFallback === true) take('extraParams.imageRequestContractLegacyFallback');
      if (variant.endpointPath === config.endpointPath) take('endpointPath');
      for (const key of ['requestBodyMode', 'bodyMode']) if (extra[key] === variant.bodyMode) take(`extraParams.${key}`);
      const endpointKey = edit ? 'imageEditEndpointPath' : 'imageGenerationEndpointPath';
      if (extra[endpointKey] === variant.endpointPath) take(`extraParams.${endpointKey}`);
      if (JSON.stringify(extra.asyncTask) === JSON.stringify(variant.asyncTask)) take('extraParams.asyncTask');
      for (const key of ['method', 'bodyMode', 'endpointPath', 'responseImagePaths', 'query']) take(`${source}.${key}`);
    }
  };
  if (usableUrl && authSupported && !unsupportedTransport && usableMappings && validContract) {
    if (media === 'image') {
      if (contract) {
        if (contract.textToImage) migrateOperation('image.generate', contract.textToImage, 'extraParams.imageRequestContract.textToImage');
        if (contract.imageToImage) migrateOperation('image.edit', contract.imageToImage, 'extraParams.imageRequestContract.imageToImage');
      } else {
        migrateOperation('image.generate');
        migrateOperation('image.edit');
      }
    } else migrateOperation(media === 'chat' ? 'chat' : 'video.generate');
    if (string(config.modelListEndpointPath)) {
      const path = endpoint(string(config.modelListEndpointPath), 'modelListEndpointPath');
      if (path) profile.operations['models.list'] = { method: 'GET', path, body: 'none', response: { mode: 'sync', outputs: [] } };
    } else take('modelListEndpointPath');
  }
  const operations = Object.keys(profile.operations) as OperationKind[];
  const ids = new Set<string>();
  config.models.forEach((id, index) => {
    if (!id.trim() || containsSecret(id) || /{{/.test(id) || ids.has(id)) {
      report(`models[${index}]`, id, '空白、重复或含密钥/模板的模型 ID 无法迁移。'); return;
    }
    ids.add(id);
    const editOp = profile.operations['image.edit'];
    const imageRefs = editOp?.files?.cardinality === 'single' || (!editOp?.files && JSON.stringify(editOp?.template ?? null).includes('{{image}}')) ? 1 : Number.MAX_SAFE_INTEGER;
    profile.models.push({ id, operations: [...operations], params: [...params.values()].map((param) => ({ ...param })),
      ...(operations.includes('image.edit') || operations.includes('video.generate') ? { refs: { image: imageRefs } } : {}) });
  });
  take('models');
  if (notes.length) profile.notes = notes;
  // Report every field that was not represented, including vendor extensions and inactive mirrors.
  const covered = (path: string): boolean => [...used].some((key) => path === key || path.startsWith(`${key}.`) || path.startsWith(`${key}[`));
  const remaining = (value: unknown, path: string): void => {
    if (covered(path)) return;
    const descendants = [...used].some((key) => key.startsWith(`${path}.`) || key.startsWith(`${path}[`));
    if (descendants && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [key, child] of Object.entries(value)) remaining(child, path ? `${path}.${key}` : key);
    } else if (value !== undefined && !(value && typeof value === 'object' && !Object.keys(value).length)) {
      report(path, value, 'v2 无对应字段，未参与请求；请人工审阅。');
    }
  };
  for (const [key, value] of Object.entries(config)) remaining(value, key);
  return { profile, unmigrated: [...problems.values()] };
}

