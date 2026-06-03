import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Copy, CheckCircle2, Trash2, Upload, Plus, Eye, EyeOff, Lightbulb, Save, Pencil, List, Plug, Loader2, AlertTriangle } from 'lucide-react';

import {
  CUSTOM_PROVIDER_PRESETS,
  CUSTOM_PROVIDER_TUTORIAL_PROMPT,
  isVideoCustomProvider,
  useCustomProvidersStore,
  type CustomProviderConfig,
} from '@/stores/customProvidersStore';
import {
  fetchCustomProviderModels,
  testCustomProviderConnectivity,
  type CustomProviderModelListResult,
  type CustomProviderTestResult,
} from '@/features/canvas/infrastructure/customProviderGateway';
import {
  normalizeImportedExtraParamsForTransport,
  resolveCustomProviderBodyMode,
  type CustomProviderBodyMode,
} from '@/features/canvas/infrastructure/customProviderTransport';

/** Which half of the split UI to render. `both` keeps the original tabbed view
 *  (kept for backwards compat); `add` is the new "添加服务商" settings tab
 *  (form + tips + import only); `list` is the new "我的配置" settings tab. */
type SectionMode = 'add' | 'list' | 'both';

interface CustomProvidersSectionProps {
  mode?: SectionMode;
  /** Callback for `list` mode — lets the host switch the sidebar to the add tab
   *  when the user clicks "+ 新增配置" from an empty list. */
  onRequestAdd?: (target?: 'new' | 'old' | 'video') => void;
}

const PRESET_RATIOS = ['21:9', '16:9', '4:1', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16', '2:1'] as const;
const PRESET_RESOLUTIONS = ['auto', '512x512', '768x768', '1024x1024', '1536x1024', '1024x1536', '1k', '2k', '4k'] as const;
const HTTP_METHODS = ['POST', 'GET'] as const;
const RESPONSE_FORMATS = ['openai-images', 'url-array', 'data-url', 'generic'] as const;
const API_STYLE_HELP: Record<string, { title: string; body: string; warning?: string }> = {
  'openai-compatible': {
    title: 'OpenAI-compatible',
    body: '按 Images API 的 JSON 结构发送 model、prompt、size、aspect_ratio，并默认用 Bearer Key 鉴权。',
  },
  fal: {
    title: 'Fal.ai',
    body: 'Fal 每个模型通常对应独立 endpoint，返回结构按模型变化较大。',
    warning: '如果测试失败，把模型页里的完整 endpoint 填到 baseUrl，响应格式优先选 generic。',
  },
  replicate: {
    title: 'Replicate',
    body: 'Replicate 常见流程是创建 prediction 后轮询结果，不一定是同步生图。',
    warning: '当前通用表单不会自动处理 version/input/轮询细节，建议用教程提示词生成代理配置。',
  },
  stability: {
    title: 'Stability AI',
    body: 'Stability 官方接口常见 multipart/form-data 或专用字段。',
    warning: '普通 multipart 表单会直连发送；若服务商只返回二进制图片或要求专用签名，建议走代理。',
  },
  volcengine: {
    title: '火山 / 即梦',
    body: '火山官方接口常带签名、动作名或异步任务结构。',
    warning: '如果不是 OpenAI 兼容中转，建议优先使用即梦 CLI 或服务端代理。',
  },
  'generic-json': {
    title: 'Generic JSON',
    body: '完全手动模式：按通用 JSON 字段发送请求，并递归扫描响应里的图片 URL。',
    warning: '适合“其他/手动配置”。multipart 或 x-www-form-urlencoded 请用对应预设或 requestBodyMode 标记；复杂签名接口建议走代理。',
  },
  'dreamina-cli': {
    title: 'Dreamina CLI',
    body: '用于本地即梦 CLI 登录态路线，通常不需要 API Key。',
  },
};
const RESPONSE_FORMAT_HELP: Record<typeof RESPONSE_FORMATS[number], string> = {
  'openai-images': '解析 data[0].url 或 data[0].b64_json，最适合 OpenAI Images 兼容接口。',
  'url-array': '解析根数组第一个 URL，或 images[0]。',
  'data-url': '解析返回的 data:image 字符串，或 image/data 字段。',
  generic: '递归扫描任意 JSON 字段里的图片 URL/data URL，容错最高但不够精确。',
};

interface DraftConfig extends Omit<CustomProviderConfig, 'id'> {
  id: string | null; // null while editing a new draft
  supportedRatios: string[];
}

function emptyDraft(): DraftConfig {
  return {
    id: null,
    mediaType: 'image',
    label: '',
    baseUrl: '',
    endpointPath: '',
    modelListEndpointPath: '/models',
    httpMethod: 'POST',
    apiKey: '',
    apiStyle: 'openai-compatible',
    models: [],
    supportsWebSearch: false,
    supportedRatios: ['auto', '16:9', '1:1'],
    supportedResolutions: [],
    supportedModelVersions: [],
    extraHeaders: {},
    queryParams: {},
    responseFormat: 'openai-images',
    extraParams: {},
    note: '',
  };
}

function isModernProviderConfig(provider: CustomProviderConfig): boolean {
  return provider.extraParams?.providerConfigVersion === 'new-v1';
}

function providerKindLabel(provider: CustomProviderConfig): {
  label: string;
  className: string;
} {
  if (isVideoCustomProvider(provider)) {
    return {
      label: '视频配置',
      className: 'border-sky-500/30 bg-sky-500/10 text-sky-300',
    };
  }
  if (isModernProviderConfig(provider)) {
    return {
      label: '图片新配置',
      className: 'border-accent/35 bg-accent/15 text-accent',
    };
  }
  return {
    label: '图片老配置',
    className: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  };
}

/** Turn a stored provider into an editable draft. */
function toDraft(p: CustomProviderConfig): DraftConfig {
  const extraRatios = (p.extraParams && typeof p.extraParams === 'object' && Array.isArray((p.extraParams as { supportedRatios?: unknown }).supportedRatios))
    ? ((p.extraParams as { supportedRatios: string[] }).supportedRatios)
    : ['auto', '16:9', '1:1'];
  return {
    ...p,
    endpointPath: p.endpointPath ?? '',
    modelListEndpointPath: p.modelListEndpointPath ?? '/models',
    httpMethod: p.httpMethod ?? 'POST',
    queryParams: p.queryParams ?? {},
    responseFormat: p.responseFormat ?? 'openai-images',
    supportedRatios: extraRatios,
    supportedResolutions: p.supportedResolutions ?? [],
    supportedModelVersions: p.supportedModelVersions ?? [],
  };
}

/** Materialize a draft back into a stored provider shape. */
function fromDraft(d: DraftConfig, fallbackId: string): CustomProviderConfig {
  return {
    id: d.id ?? fallbackId,
    label: d.label.trim() || '未命名配置',
    mediaType: d.mediaType ?? 'image',
    baseUrl: d.baseUrl.trim(),
    endpointPath: d.endpointPath?.trim() || '',
    modelListEndpointPath: d.modelListEndpointPath?.trim() || '',
    httpMethod: d.httpMethod ?? 'POST',
    apiKey: d.apiKey,
    apiStyle: d.apiStyle,
    models: d.models,
    supportsWebSearch: d.supportsWebSearch,
    extraHeaders: d.extraHeaders ?? {},
    queryParams: d.queryParams ?? {},
    responseFormat: d.responseFormat ?? 'openai-images',
    supportedResolutions: (d.supportedResolutions ?? []).length > 0 ? d.supportedResolutions : undefined,
    supportedModelVersions: (d.supportedModelVersions ?? []).length > 0 ? d.supportedModelVersions : undefined,
    extraParams: { ...(d.extraParams ?? {}), mediaType: d.mediaType ?? 'image', supportedRatios: d.supportedRatios },
    note: d.note ?? '',
  };
}

function stringifyDefaultRequestParams(extraParams: Record<string, unknown> | undefined): string {
  const raw = extraParams?.defaultRequestParams;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return '{}';
  }
  return JSON.stringify(raw, null, 2);
}

function parseDefaultRequestParams(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return {};
  }
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('必须是 JSON 对象，例如 { "quality": "high" }');
  }
  return parsed as Record<string, unknown>;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  values.forEach((value) => {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      return;
    }
    seen.add(trimmed);
    next.push(trimmed);
  });
  return next;
}

function resolveImportPreset(block: Record<string, unknown>) {
  const explicitKey = typeof block.templateKey === 'string' ? block.templateKey.trim() : '';
  const rawEndpointPath = String(block.endpointPath ?? '').toLowerCase();
  const rawBaseUrl = String(block.baseUrl ?? '').toLowerCase();
  const rawLabel = String(block.label ?? '').toLowerCase();
  if ((explicitKey === 'generic_json' || explicitKey === 'manual')
    && (rawBaseUrl.includes('dakka.com.cn') || rawBaseUrl.includes('grsai') || rawLabel.includes('grs ai') || rawEndpointPath.includes('/v1/draw/'))) {
    return CUSTOM_PROVIDER_PRESETS.find((preset) => preset.key === 'grsai_draw_async');
  }
  const explicitAlias: Record<string, string> = {
    replicate: 'replicate_prediction_async',
    openai_video: 'openai_videos',
    openai_videos: 'openai_videos',
    video: 'openai_videos',
  };
  const resolvedExplicitKey = explicitAlias[explicitKey] ?? explicitKey;
  const explicitPreset = CUSTOM_PROVIDER_PRESETS.find((preset) => preset.key === resolvedExplicitKey);
  if (explicitPreset) return explicitPreset;

  const apiStyle = String(block.apiStyle ?? '').toLowerCase();
  const endpointPath = rawEndpointPath;
  const baseUrl = rawBaseUrl;
  const responseFormat = String(block.responseFormat ?? '').toLowerCase();
  const extraParams = block.extraParams && typeof block.extraParams === 'object' ? block.extraParams as Record<string, unknown> : {};

  if (apiStyle === 'fal' || baseUrl.includes('fal.ai') || baseUrl.includes('fal.run')) {
    return CUSTOM_PROVIDER_PRESETS.find((preset) => preset.key === (baseUrl.includes('queue.') || endpointPath.includes('/status') ? 'fal_queue_async' : 'fal'));
  }
  if (apiStyle === 'replicate' || baseUrl.includes('replicate.com')) {
    return CUSTOM_PROVIDER_PRESETS.find((preset) => preset.key === 'replicate_prediction_async');
  }
  if (baseUrl.includes('dakka.com.cn') || baseUrl.includes('grsai') || endpointPath.includes('/v1/draw/')) {
    return CUSTOM_PROVIDER_PRESETS.find((preset) => preset.key === 'grsai_draw_async');
  }
  if (apiStyle === 'stability' || baseUrl.includes('stability.ai')) {
    return CUSTOM_PROVIDER_PRESETS.find((preset) => preset.key === 'stability');
  }
  if (apiStyle === 'volcengine' || baseUrl.includes('volcengineapi.com') || endpointPath.includes('volcengine')) {
    return CUSTOM_PROVIDER_PRESETS.find((preset) => preset.key === 'volc_jimeng');
  }
  if (endpointPath.includes('/videos') || String(block.mediaType ?? '').toLowerCase() === 'video') {
    return CUSTOM_PROVIDER_PRESETS.find((preset) => preset.key === 'openai_videos');
  }
  if (endpointPath.includes('/responses')) {
    return CUSTOM_PROVIDER_PRESETS.find((preset) => preset.key === 'openai_responses_image');
  }
  if (endpointPath.includes('/chat/completions')) {
    return CUSTOM_PROVIDER_PRESETS.find((preset) => preset.key === 'openai_chat_image');
  }
  if (extraParams.asyncTask && typeof extraParams.asyncTask === 'object') {
    return CUSTOM_PROVIDER_PRESETS.find((preset) => preset.key === 'generic_async_poll');
  }
  if (apiStyle === 'openai-compatible' && responseFormat === 'openai-images') {
    return CUSTOM_PROVIDER_PRESETS.find((preset) => preset.key === 'openai_proxy');
  }
  if (apiStyle === 'generic-json' || responseFormat === 'generic') {
    return CUSTOM_PROVIDER_PRESETS.find((preset) => preset.key === 'generic_json');
  }
  return CUSTOM_PROVIDER_PRESETS.find((preset) => preset.key === 'manual');
}

function pickImportPlan(block: Record<string, unknown>): Record<string, unknown> | null {
  const entries = Object.entries({
    templateKey: block.templateKey,
    templateReason: block.templateReason,
    compatibility: block.compatibility,
    requestPlan: block.requestPlan,
    responsePlan: block.responsePlan,
  }).filter(([, value]) => value !== undefined && value !== null && value !== '');
  if (entries.length === 0) {
    return null;
  }
  return Object.fromEntries(entries);
}

function formatBodyModeLabel(mode: CustomProviderBodyMode): string {
  if (mode === 'multipart') return 'multipart/form-data';
  if (mode === 'form-urlencoded') return 'application/x-www-form-urlencoded';
  if (mode === 'signed') return '签名/代理';
  return 'JSON';
}

function applyBodyModeToExtraParams(
  extraParams: Record<string, unknown> | undefined,
  mode: CustomProviderBodyMode,
): Record<string, unknown> {
  const next = { ...(extraParams ?? {}) };
  if (mode === 'json') {
    delete next.requestBodyMode;
    delete next.bodyMode;
    delete next.transport;
    delete next.needsProxy;
    delete next.signedAuth;
    delete next.multipart;
    return next;
  }

  if (mode === 'form-urlencoded') {
    delete next.bodyMode;
    delete next.transport;
    delete next.needsProxy;
    delete next.signedAuth;
    delete next.multipart;
    return {
      ...next,
      requestBodyMode: 'form-urlencoded',
    };
  }

  if (mode === 'multipart') {
    delete next.transport;
    delete next.needsProxy;
    delete next.signedAuth;
    const multipart = next.multipart && typeof next.multipart === 'object' && !Array.isArray(next.multipart)
      ? next.multipart as Record<string, unknown>
      : {};
    const requestBodyHints = next.requestBodyHints && typeof next.requestBodyHints === 'object' && !Array.isArray(next.requestBodyHints)
      ? next.requestBodyHints as Record<string, unknown>
      : {};
    const fileField = typeof multipart.fileField === 'string' && multipart.fileField.trim()
      ? multipart.fileField.trim()
      : typeof requestBodyHints.referenceImageField === 'string' && requestBodyHints.referenceImageField.trim()
        ? requestBodyHints.referenceImageField.trim()
        : 'image';
    return {
      ...next,
      requestBodyMode: 'multipart',
      multipart: {
        ...multipart,
        enabled: true,
        fileField,
      },
      requestBodyHints: {
        ...requestBodyHints,
        referenceImageField: typeof requestBodyHints.referenceImageField === 'string' && requestBodyHints.referenceImageField.trim()
          ? requestBodyHints.referenceImageField
          : fileField,
      },
    };
  }

  delete next.requestBodyMode;
  delete next.bodyMode;
  delete next.multipart;
  return {
    ...next,
    transport: 'signed',
    needsProxy: true,
    signedAuth: {
      required: true,
      ...((next.signedAuth && typeof next.signedAuth === 'object' && !Array.isArray(next.signedAuth))
        ? next.signedAuth as Record<string, unknown>
        : {}),
    },
  };
}

function formatImportPlanPreview(extraParams: Record<string, unknown> | undefined): string | null {
  const plan = extraParams?.importPlan;
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    return null;
  }
  try {
    return JSON.stringify(plan, null, 2);
  } catch {
    return null;
  }
}

/**
 * "配置模型服务" section. Two tabs:
 *   - configure: top import row + two-column form (left: params, right: tips).
 *     Clicking 保存 persists into the store; the new entry shows up in 我的配置.
 *   - list: list of saved configs. Each row has 查看配置 + 查看模型 buttons.
 *     查看配置 opens the edit drawer (same form, 保存 后生效).
 */
export const CustomProvidersSection = memo(({ mode = 'both', onRequestAdd }: CustomProvidersSectionProps) => {
  const providers = useCustomProvidersStore((s) => s.providers);
  const addProvider = useCustomProvidersStore((s) => s.addProvider);
  const updateProvider = useCustomProvidersStore((s) => s.updateProvider);
  const removeProvider = useCustomProvidersStore((s) => s.removeProvider);
  const pendingEditId = useCustomProvidersStore((s) => s.pendingEditId);
  const setPendingEditId = useCustomProvidersStore((s) => s.setPendingEditId);

  // Legacy tabbed view only. In `add` / `list` mode the tab state is unused.
  const [tab, setTab] = useState<'configure' | 'list'>(mode === 'list' ? 'list' : 'configure');
  const [draft, setDraft] = useState<DraftConfig>(emptyDraft);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState('');
  const [importSuccess, setImportSuccess] = useState(false);
  const [promptCopied, setPromptCopied] = useState(false);
  const [revealKey, setRevealKey] = useState(false);
  const [saveFlash, setSaveFlash] = useState(false);
  const [modelsDialogFor, setModelsDialogFor] = useState<string | null>(null);
  // Inline "add custom ratio" input state — shows when user hits the + chip.
  const [ratioInputOpen, setRatioInputOpen] = useState(false);
  const [ratioInputValue, setRatioInputValue] = useState('');
  const [resolutionInputOpen, setResolutionInputOpen] = useState(false);
  const [resolutionInputValue, setResolutionInputValue] = useState('');
  // Query-params small table UI state (single row editor).
  const [newQueryKey, setNewQueryKey] = useState('');
  const [newQueryValue, setNewQueryValue] = useState('');
  const [newHeaderKey, setNewHeaderKey] = useState('');
  const [newHeaderValue, setNewHeaderValue] = useState('');
  const [defaultParamsText, setDefaultParamsText] = useState('{}');
  const [defaultParamsError, setDefaultParamsError] = useState('');
  // Connectivity test state.
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<CustomProviderTestResult | null>(null);
  const [testingProviderId, setTestingProviderId] = useState<string | null>(null);
  const [providerTestResults, setProviderTestResults] = useState<Record<string, CustomProviderTestResult | undefined>>({});
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelFetchResult, setModelFetchResult] = useState<CustomProviderModelListResult | null>(null);
  const [modelAddOpen, setModelAddOpen] = useState(false);
  const [modelAddValue, setModelAddValue] = useState('');
  const [modelEditMode, setModelEditMode] = useState(false);

  const handleTestConnectivity = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const fallbackId = draft.id ?? `cp-draft-${Date.now()}`;
      const defaultRequestParams = parseDefaultRequestParams(defaultParamsText);
      setDefaultParamsError('');
      const full = fromDraft({
        ...draft,
        extraParams: {
          ...(draft.extraParams ?? {}),
          defaultRequestParams,
        },
      }, fallbackId);
      const res = await testCustomProviderConnectivity(full);
      setTestResult(res);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setDefaultParamsError(message);
      setTestResult({ ok: false, errorMessage: message });
    } finally {
      setTesting(false);
    }
  }, [defaultParamsText, draft]);

  const handleTestSavedProvider = useCallback(async (provider: CustomProviderConfig) => {
    setTestingProviderId(provider.id);
    setProviderTestResults((results) => ({ ...results, [provider.id]: undefined }));
    try {
      const res = await testCustomProviderConnectivity(provider);
      setProviderTestResults((results) => ({ ...results, [provider.id]: res }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setProviderTestResults((results) => ({
        ...results,
        [provider.id]: { ok: false, errorMessage: message },
      }));
    } finally {
      setTestingProviderId(null);
    }
  }, []);

  const handleFetchModels = useCallback(async () => {
    setFetchingModels(true);
    setModelFetchResult(null);
    try {
      const fallbackId = draft.id ?? `cp-draft-${Date.now()}`;
      const full = fromDraft(draft, fallbackId);
      const res = await fetchCustomProviderModels(full);
      setModelFetchResult(res);
      if (res.ok && res.models.length > 0) {
        setModelOptions(res.models);
        setDraft((d) => ({ ...d, models: res.models }));
      }
    } catch (e) {
      setModelFetchResult({
        ok: false,
        models: [],
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setFetchingModels(false);
    }
  }, [draft]);

  const modelsDialogProvider = useMemo(
    () => providers.find((p) => p.id === modelsDialogFor) ?? null,
    [providers, modelsDialogFor],
  );
  const selectedStyleHelp = API_STYLE_HELP[draft.apiStyle] ?? API_STYLE_HELP['generic-json'];
  const selectedResponseHelp = RESPONSE_FORMAT_HELP[draft.responseFormat ?? 'openai-images'];
  const selectedBodyMode = useMemo(
    () => resolveCustomProviderBodyMode(fromDraft(draft, draft.id ?? 'draft')),
    [draft],
  );
  const handleBodyModeChange = useCallback((mode: CustomProviderBodyMode) => {
    setDraft((current) => ({
      ...current,
      extraParams: applyBodyModeToExtraParams(current.extraParams, mode),
    }));
    setDefaultParamsError('');
  }, []);
  const importPlanPreview = useMemo(
    () => formatImportPlanPreview(draft.extraParams),
    [draft.extraParams],
  );
  const selectedPresetLabel = useMemo(
    () => CUSTOM_PROVIDER_PRESETS.find((preset) => preset.template.apiStyle === draft.apiStyle
      && (preset.template.endpointPath ?? '') === (draft.endpointPath ?? '')
      && (preset.template.responseFormat ?? 'openai-images') === (draft.responseFormat ?? 'openai-images'))?.label ?? null,
    [draft.apiStyle, draft.endpointPath, draft.responseFormat]
  );

  const toggleModelSelection = useCallback((model: string) => {
    setDraft((d) => {
      const selected = new Set(d.models);
      if (selected.has(model)) {
        selected.delete(model);
      } else {
        selected.add(model);
      }
      return { ...d, models: Array.from(selected) };
    });
  }, []);

  const handleAddModel = useCallback(() => {
    const value = modelAddValue.trim();
    if (!value) return;
    setModelOptions((items) => uniqueStrings([...items, value]));
    setDraft((d) => ({ ...d, models: uniqueStrings([...d.models, value]) }));
    setModelAddValue('');
    setModelAddOpen(false);
  }, [modelAddValue]);

  const handleRenameModel = useCallback((oldName: string, nextName: string) => {
    const next = nextName.trim();
    if (!next) return;
    setModelOptions((items) => uniqueStrings(items.map((item) => (item === oldName ? next : item))));
    setDraft((d) => ({
      ...d,
      models: uniqueStrings(d.models.map((item) => (item === oldName ? next : item))),
    }));
  }, []);

  const handleDeleteModel = useCallback((model: string) => {
    setModelOptions((items) => items.filter((item) => item !== model));
    setDraft((d) => ({ ...d, models: d.models.filter((item) => item !== model) }));
  }, []);

  // If the user clicks a preset from the configure tab, populate the draft.
  const applyPreset = useCallback((presetKey: string) => {
    const preset = CUSTOM_PROVIDER_PRESETS.find((p) => p.key === presetKey);
    if (!preset) return;
    setDraft({
      ...emptyDraft(),
      ...preset.template,
      apiKey: '',
      supportedRatios: Array.isArray((preset.template.extraParams as { supportedRatios?: unknown } | undefined)?.supportedRatios)
        ? ((preset.template.extraParams as { supportedRatios: string[] }).supportedRatios)
        : ['auto', '16:9', '1:1', '9:16'],
      supportedResolutions: preset.template.supportedResolutions ?? [],
      supportedModelVersions: preset.template.supportedModelVersions ?? [],
      queryParams: preset.template.queryParams ?? {},
      extraHeaders: preset.template.extraHeaders ?? {},
      responseFormat: preset.template.responseFormat ?? 'openai-images',
    });
    setModelOptions(preset.template.models ?? []);
    setDefaultParamsText(stringifyDefaultRequestParams(preset.template.extraParams));
    setDefaultParamsError('');
    setModelFetchResult(null);
    setTab('configure');
  }, []);

  // One-click import via JSON at the top.
  const handleImport = useCallback(() => {
    setImportError('');
    setImportSuccess(false);
    const raw = importText.trim();
    if (!raw) { setImportError('先粘贴 AI 返回的 JSON'); return; }
    try {
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
      const parsed = JSON.parse(cleaned);
      const block = Array.isArray(parsed) ? parsed[0] : parsed;
      if (!block || typeof block !== 'object') throw new Error('JSON 不是对象');
      const blockRecord = block as Record<string, unknown>;
      const preset = resolveImportPreset(blockRecord);
      const baseTemplate = preset?.template ?? emptyDraft();
      const method = String(blockRecord.httpMethod ?? baseTemplate.httpMethod ?? 'POST').toUpperCase();
      const importedModels = Array.isArray(blockRecord.models)
        ? uniqueStrings(blockRecord.models.map(String))
        : uniqueStrings(baseTemplate.models ?? []);
      const importedExtraParams = {
        ...(baseTemplate.extraParams ?? {}),
        ...((blockRecord.extraParams && typeof blockRecord.extraParams === 'object')
          ? blockRecord.extraParams as Record<string, unknown>
          : {}),
      };
      const importPlan = pickImportPlan(blockRecord);
      if (importPlan) {
        importedExtraParams.importPlan = importPlan;
      }
      const normalizedExtraParams = normalizeImportedExtraParamsForTransport(
        importedExtraParams,
        blockRecord,
      );
      setDraft({
        ...emptyDraft(),
        ...baseTemplate,
        label: String(blockRecord.label ?? baseTemplate.label ?? ''),
        mediaType: (blockRecord.mediaType === 'video' || baseTemplate.mediaType === 'video') ? 'video' : 'image',
        baseUrl: String(blockRecord.baseUrl ?? baseTemplate.baseUrl ?? ''),
        endpointPath: String(blockRecord.endpointPath ?? baseTemplate.endpointPath ?? ''),
        modelListEndpointPath: String(blockRecord.modelListEndpointPath ?? baseTemplate.modelListEndpointPath ?? ''),
        httpMethod: method === 'GET' ? 'GET' : 'POST',
        apiKey: String(blockRecord.apiKey ?? ''),
        apiStyle: String(blockRecord.apiStyle ?? baseTemplate.apiStyle ?? 'generic-json'),
        models: importedModels,
        supportsWebSearch: Boolean(blockRecord.supportsWebSearch ?? baseTemplate.supportsWebSearch),
        supportedRatios: Array.isArray(blockRecord.supportedRatios) && blockRecord.supportedRatios.length > 0
          ? blockRecord.supportedRatios.map(String)
          : (Array.isArray((baseTemplate.extraParams as { supportedRatios?: unknown } | undefined)?.supportedRatios)
            ? (baseTemplate.extraParams as { supportedRatios: string[] }).supportedRatios
            : ['auto', '16:9', '1:1']),
        supportedResolutions: Array.isArray(blockRecord.supportedResolutions)
          ? blockRecord.supportedResolutions.map(String).filter(Boolean)
          : baseTemplate.supportedResolutions ?? [],
        supportedModelVersions: Array.isArray(blockRecord.supportedModelVersions)
          ? blockRecord.supportedModelVersions.map(String).filter(Boolean)
          : baseTemplate.supportedModelVersions ?? [],
        extraHeaders: {
          ...(baseTemplate.extraHeaders ?? {}),
          ...((blockRecord.extraHeaders && typeof blockRecord.extraHeaders === 'object') ? blockRecord.extraHeaders as Record<string, string> : {}),
        },
        queryParams: (blockRecord.queryParams && typeof blockRecord.queryParams === 'object')
          ? {
            ...(baseTemplate.queryParams ?? {}),
            ...Object.fromEntries(Object.entries(blockRecord.queryParams).map(([k, v]) => [k, String(v)])),
          }
          : baseTemplate.queryParams ?? {},
        responseFormat: (['openai-images', 'url-array', 'data-url', 'generic'] as const).includes(
          blockRecord.responseFormat as never
        ) ? blockRecord.responseFormat as DraftConfig['responseFormat'] : baseTemplate.responseFormat ?? 'generic',
        extraParams: normalizedExtraParams,
        note: String(blockRecord.note ?? baseTemplate.note ?? ''),
      });
      setModelOptions(importedModels);
      setDefaultParamsText(stringifyDefaultRequestParams(normalizedExtraParams));
      setDefaultParamsError('');
      setModelFetchResult(null);
      setImportText('');
      setImportSuccess(true);
      setTimeout(() => setImportSuccess(false), 1800);
    } catch (err) {
      setImportError(err instanceof Error ? `解析失败：${err.message}` : '解析失败');
    }
  }, [importText]);

  const handleCopyTutorialPrompt = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(CUSTOM_PROVIDER_TUTORIAL_PROMPT);
      setPromptCopied(true);
      setTimeout(() => setPromptCopied(false), 1600);
    } catch { /* ignore */ }
  }, []);

  const handleSave = useCallback(() => {
    if (!draft.label.trim() && !draft.baseUrl.trim()) return;
    let defaultRequestParams: Record<string, unknown> | null = {};
    try {
      defaultRequestParams = parseDefaultRequestParams(defaultParamsText);
      setDefaultParamsError('');
    } catch (e) {
      setDefaultParamsError(e instanceof Error ? e.message : String(e));
      return;
    }
    const fallbackId = `cp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const full = fromDraft({
      ...draft,
      extraParams: {
        ...(draft.extraParams ?? {}),
        defaultRequestParams,
      },
    }, fallbackId);
    if (draft.id) {
      updateProvider(draft.id, full);
    } else {
      addProvider(full);
    }
    setDraft(emptyDraft());
    setModelOptions([]);
    setDefaultParamsText('{}');
    setSaveFlash(true);
    // In the legacy tabbed view, jump to the list tab so the user sees their
    // new entry; in `add` mode there is no list tab (it lives in a separate
    // sidebar category), so just flash the success message.
    if (mode === 'both') setTab('list');
    setTimeout(() => setSaveFlash(false), 1500);
  }, [defaultParamsText, draft, addProvider, updateProvider, mode]);

  const handleEdit = useCallback((id: string) => {
    const p = providers.find((x) => x.id === id);
    if (!p) return;
    // In 'both' / 'add' modes we can set draft directly. In 'list' mode the add
    // form lives in a different CustomProvidersSection instance, so we stash
    // the target id in the store and let the host switch tabs — the add
    // instance picks it up on mount via useEffect below.
    if (mode === 'both' || mode === 'add') {
      setDraft(toDraft(p));
      setModelOptions(p.models);
      setDefaultParamsText(stringifyDefaultRequestParams(p.extraParams));
      setDefaultParamsError('');
      if (mode === 'both') setTab('configure');
    }
    if (mode === 'list') {
      setPendingEditId(id);
      onRequestAdd?.(isVideoCustomProvider(p) ? 'video' : (isModernProviderConfig(p) ? 'new' : 'old'));
    }
  }, [providers, mode, onRequestAdd, setPendingEditId]);

  const handleNewFromScratch = useCallback(() => {
    setDraft(emptyDraft());
    setModelOptions([]);
    setDefaultParamsText('{}');
    setDefaultParamsError('');
    setModelFetchResult(null);
    if (mode === 'both') setTab('configure');
    else if (mode === 'list') onRequestAdd?.('new');
  }, [mode, onRequestAdd]);

  // Keep draft in sync when providers change externally (e.g. removal).
  useEffect(() => {
    if (draft.id && !providers.find((p) => p.id === draft.id)) {
      setDraft(emptyDraft());
    }
  }, [providers, draft.id]);

  // If the user clicked "查看配置" on the 我的配置 list, pick up the pending id
  // and hydrate the draft. This runs in the add-mode instance.
  useEffect(() => {
    if ((mode === 'add' || mode === 'both') && pendingEditId) {
      const p = providers.find((x) => x.id === pendingEditId);
      if (p) {
        setDraft(toDraft(p));
        setModelOptions(p.models);
        setDefaultParamsText(stringifyDefaultRequestParams(p.extraParams));
        setDefaultParamsError('');
        if (mode === 'both') setTab('configure');
      }
      setPendingEditId(null);
    }
  }, [mode, pendingEditId, providers, setPendingEditId]);

  const showConfigure = mode === 'add' || (mode === 'both' && tab === 'configure');
  const showList = mode === 'list' || (mode === 'both' && tab === 'list');

  return (
    <div className="space-y-5">
      {mode !== 'list' && (
        <div>
          <h2 className="text-base font-semibold text-text-dark">
            {mode === 'add' ? '图片生成（老）' : '配置模型服务'}
          </h2>
          <p className="mt-1 text-xs text-text-muted">
            如果供应商 API 符合官方或常见中转站调用格式，推荐使用「添加供应商（新）」。如果接口有自己的特殊路由、轮询任务、multipart、签名代理或复杂字段映射，再用这里的老版高级配置。
          </p>
        </div>
      )}
      {mode === 'list' && (
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-text-dark">我的配置</h2>
            <p className="mt-1 text-xs text-text-muted">
              已保存的图片新配置、图片老配置和视频配置。查看配置可回到对应表单继续编辑；查看模型展示该配置支持的模型与能力。
            </p>
          </div>
          <button
            type="button"
            onClick={handleNewFromScratch}
            className="shrink-0 inline-flex items-center gap-1 rounded-md bg-accent/20 px-3 py-1.5 text-xs text-accent hover:bg-accent/30"
          >
            <Plus className="h-3 w-3" /> 新增配置
          </button>
        </div>
      )}

      {/* Tabs (legacy, only in `both` mode) */}
      {mode === 'both' && (
        <div className="flex gap-1 border-b border-border-dark">
          <button
            type="button"
            onClick={() => setTab('configure')}
            className={`relative px-4 py-2 text-xs transition-colors ${tab === 'configure' ? 'text-text-dark' : 'text-text-muted hover:text-text-dark'}`}
          >
            <Pencil className="mr-1 inline h-3 w-3" /> 配置模型服务
            {tab === 'configure' && <span className="absolute inset-x-2 bottom-0 h-0.5 bg-accent" />}
          </button>
          <button
            type="button"
            onClick={() => setTab('list')}
            className={`relative px-4 py-2 text-xs transition-colors ${tab === 'list' ? 'text-text-dark' : 'text-text-muted hover:text-text-dark'}`}
          >
            <List className="mr-1 inline h-3 w-3" /> 我的配置 <span className="ml-1 rounded-full bg-bg-dark px-1.5 py-0.5 text-[10px] text-text-muted">{providers.length}</span>
            {tab === 'list' && <span className="absolute inset-x-2 bottom-0 h-0.5 bg-accent" />}
          </button>
        </div>
      )}

      {showConfigure && (
        <>
          {/* Top: one-click import */}
          <div className="rounded-lg border border-accent/30 bg-accent/5 p-4">
            <div className="flex items-center justify-between gap-2 mb-2">
              <div className="flex items-center gap-1.5 text-sm font-medium text-text-dark">
                <Upload className="h-4 w-4 text-accent" /> 一键导入 JSON
              </div>
              <div className="text-[11px] text-text-muted">复制教程提示词 → AI 自动判断模板 → 把 JSON 贴到这里</div>
            </div>
            <div className="flex gap-2">
              <textarea
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                placeholder='例：{ "templateKey": "openai_proxy", "label": "我的服务商", "baseUrl": "https://api.example.com/v1", "models": ["nano-banana"] }'
                className="flex-1 h-20 resize-none rounded-md border border-border-dark bg-surface-dark px-2.5 py-2 text-[11px] text-text-dark font-mono outline-none placeholder:text-text-muted/60 focus:border-accent/50"
              />
              <button
                type="button"
                onClick={handleImport}
                className="self-start inline-flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-xs text-black hover:bg-accent/90"
              >
                <Upload className="h-3 w-3" /> 导入
              </button>
            </div>
            {importError && <div className="mt-2 text-[11px] text-red-400">{importError}</div>}
            {importSuccess && <div className="mt-2 text-[11px] text-emerald-400 flex items-center gap-1"><CheckCircle2 className="h-3 w-3" /> 已填入下方表单，检查无误后点「保存配置」</div>}
          </div>

          {mode === 'add' && (
            <div className="rounded-lg border border-border-dark bg-bg-dark p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-1.5 text-xs font-medium text-text-dark">
                    <Lightbulb className="h-3.5 w-3.5 text-accent" /> 不知道怎么配？
                  </div>
                  <p className="mt-1 text-[11px] leading-5 text-text-muted">
                    复制教程提示词到任意 AI，贴上服务商文档 / cURL，让 AI 返回可导入 JSON；这里适合特殊路由、轮询、multipart、签名代理或复杂字段映射。普通 OpenAI Images、Gemini、Fal 等格式优先用「图片生成（新）」。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleCopyTutorialPrompt}
                  className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md bg-accent/20 px-2.5 text-[11px] text-accent hover:bg-accent/30"
                >
                  {promptCopied ? <CheckCircle2 className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  {promptCopied ? '已复制' : '复制教程提示词'}
                </button>
              </div>
            </div>
          )}

          {mode === 'add' && (
            <details className="rounded-lg border border-border-dark bg-bg-dark p-3">
              <summary className="cursor-pointer text-xs font-medium text-text-dark">
                主流格式预设 <span className="ml-2 text-[10px] font-normal text-text-muted">可选，不知道格式时再展开</span>
              </summary>
              <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                {CUSTOM_PROVIDER_PRESETS.map((preset) => (
                  <button
                    key={preset.key}
                    type="button"
                    onClick={() => applyPreset(preset.key)}
                    className="min-w-0 rounded-md border border-border-dark bg-surface-dark px-2.5 py-2 text-left hover:border-accent/50 hover:bg-accent/5"
                    title={preset.hint}
                  >
                    <div className="truncate text-[11px] font-medium text-text-dark">{preset.label}</div>
                    <div className="mt-0.5 truncate text-[10px] text-text-muted">{preset.hint}</div>
                  </button>
                ))}
              </div>
            </details>
          )}

          {/* When embedded in SettingsDialog's own 2-col layout (mode='add'),
              the outer right column already hosts tips, so we collapse the
              inner layout to a single form column. Legacy mode='both' keeps
              the 2-col internal layout for its standalone usage. */}
          <div className={mode === 'both' ? 'grid grid-cols-[1fr_280px] gap-4' : ''}>
            {/* Left: params form */}
            <div className="rounded-lg border border-border-dark bg-bg-dark p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium text-text-dark">{draft.id ? '编辑现有配置' : '新建配置'}</div>
                {draft.id && (
                  <button
                    type="button"
                    onClick={handleNewFromScratch}
                    className="text-[11px] text-text-muted hover:text-text-dark"
                  >
                    <Plus className="mr-0.5 inline h-3 w-3" /> 改为新建
                  </button>
                )}
              </div>
              <div className="rounded-lg border border-white/10 bg-surface-dark px-3 py-2 text-[11px] leading-5 text-text-muted">
                <div className="flex items-center gap-1.5 text-text-dark">
                  <Plug className="h-3.5 w-3.5 text-accent" />
                  {draft.apiStyle === 'generic-json' && !draft.baseUrl.trim()
                    ? '其他 / 手动配置'
                    : selectedPresetLabel ?? selectedStyleHelp.title}
                </div>
                <div className="mt-0.5">{selectedStyleHelp.body}</div>
                <div className="mt-0.5 text-text-muted/80">
                  当前请求：{formatBodyModeLabel(selectedBodyMode)} · 响应解析：{draft.responseFormat ?? 'openai-images'} · {selectedResponseHelp}
                </div>
                <label className="mt-2 flex items-center gap-2 text-[11px] text-text-muted">
                  <span className="shrink-0">请求体格式</span>
                  <select
                    value={selectedBodyMode}
                    onChange={(event) => handleBodyModeChange(event.target.value as CustomProviderBodyMode)}
                    className="h-7 rounded-md border border-border-dark bg-bg-dark px-2 text-text-dark outline-none focus:border-accent/50"
                  >
                    <option value="json">JSON</option>
                    <option value="multipart">multipart/form-data</option>
                    <option value="form-urlencoded">application/x-www-form-urlencoded</option>
                    <option value="signed">签名/代理</option>
                  </select>
                  {selectedBodyMode === 'multipart' && (
                    <span className="min-w-0 truncate text-text-muted/70">
                      文件字段：{String(((draft.extraParams?.multipart as { fileField?: unknown } | undefined)?.fileField) ?? (draft.extraParams?.requestBodyHints as { referenceImageField?: unknown } | undefined)?.referenceImageField ?? 'image')}
                    </span>
                  )}
                  {selectedBodyMode === 'form-urlencoded' && (
                    <span className="min-w-0 truncate text-text-muted/70">
                      按 requestBodyHints / 默认请求参数生成表单键值
                    </span>
                  )}
                </label>
                {selectedBodyMode === 'signed' && (
                  <div className="mt-1 flex gap-1.5 text-amber-300/90">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                    <span>该配置标记为签名/代理路线，当前通用直连不会伪造云厂商签名；请改用后端代理或换成普通 JSON/multipart 预设。</span>
                  </div>
                )}
                {selectedStyleHelp.warning && (
                  <div className="mt-1 flex gap-1.5 text-amber-300/90">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                    <span>{selectedStyleHelp.warning}</span>
                  </div>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2 text-[11px]">
                <label className="flex flex-col gap-1 col-span-2">
                  <span className="text-text-muted">显示名 / 简称</span>
                  <input
                    value={draft.label}
                    onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
                    placeholder="例：我的生图服务"
                    className="rounded-md border border-border-dark bg-surface-dark px-2 py-1 text-text-dark outline-none focus:border-accent/50"
                  />
                </label>
                <label className="flex flex-col gap-1 col-span-2">
                  <span className="text-text-muted">API 根地址</span>
                  <input
                    value={draft.baseUrl}
                    onChange={(e) => setDraft((d) => ({ ...d, baseUrl: e.target.value }))}
                    placeholder="https://api.example.com"
                    className="rounded-md border border-border-dark bg-surface-dark px-2 py-1 text-text-dark outline-none focus:border-accent/50"
                  />
                </label>
                <label className="flex flex-col gap-1 col-span-2">
                  <span className="text-text-muted">
                    生图接口路径 <span className="text-text-muted/60">（不同服务商千差万别：/images/generations、/create、/v1/chat/completions……留空则用 apiStyle 默认）</span>
                  </span>
                  <input
                    value={draft.endpointPath ?? ''}
                    onChange={(e) => setDraft((d) => ({ ...d, endpointPath: e.target.value }))}
                    placeholder="/v1/images/generations"
                    className="rounded-md border border-border-dark bg-surface-dark px-2 py-1 text-text-dark outline-none focus:border-accent/50 font-mono"
                  />
                </label>
                <label className="flex flex-col gap-1 col-span-2">
                  <span className="text-text-muted">
                    模型列表接口路径 <span className="text-text-muted/60">（可选；OpenAI 兼容通常是 /models，用于“获取模型”按钮）</span>
                  </span>
                  <input
                    value={draft.modelListEndpointPath ?? ''}
                    onChange={(e) => setDraft((d) => ({ ...d, modelListEndpointPath: e.target.value }))}
                    placeholder="/models"
                    className="rounded-md border border-border-dark bg-surface-dark px-2 py-1 text-text-dark outline-none focus:border-accent/50 font-mono"
                  />
                </label>
                <label className="flex flex-col gap-1 col-span-2">
                  <span className="text-text-muted">API Key</span>
                  <div className="relative">
                    <input
                      type={revealKey ? 'text' : 'password'}
                      value={draft.apiKey}
                      onChange={(e) => setDraft((d) => ({ ...d, apiKey: e.target.value }))}
                      placeholder="sk-..."
                      className="w-full rounded-md border border-border-dark bg-surface-dark px-2 py-1 pr-7 text-text-dark outline-none focus:border-accent/50"
                    />
                    <button
                      type="button"
                      onClick={() => setRevealKey((v) => !v)}
                      className="absolute right-1 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-dark"
                    >
                      {revealKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                </label>
                <div className="flex flex-col gap-1 col-span-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-text-muted">模型列表</span>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => {
                          setModelAddOpen((open) => !open);
                          setModelEditMode(false);
                        }}
                        className="inline-flex items-center gap-1 rounded-md border border-white/15 bg-white/5 px-2 py-1 text-[10px] text-text-dark hover:bg-white/10"
                        title="手动添加一个模型"
                      >
                        <Plus className="h-3 w-3" /> 添加
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setModelEditMode((editing) => !editing);
                          setModelAddOpen(false);
                        }}
                        disabled={modelOptions.length === 0}
                        className="inline-flex items-center gap-1 rounded-md border border-white/15 bg-white/5 px-2 py-1 text-[10px] text-text-dark hover:bg-white/10 disabled:opacity-40"
                        title="编辑模型名称或删除模型"
                      >
                        <Pencil className="h-3 w-3" /> {modelEditMode ? '完成' : '编辑'}
                      </button>
                      <button
                        type="button"
                        onClick={handleFetchModels}
                        disabled={fetchingModels || !draft.apiKey.trim() || !draft.baseUrl.trim()}
                        className="inline-flex items-center gap-1 rounded-md border border-white/15 bg-white/5 px-2 py-1 text-[10px] text-text-dark hover:bg-white/10 disabled:opacity-40"
                        title="向模型列表接口发 GET 请求，通常是 OpenAI-compatible 的 /models"
                      >
                        {fetchingModels ? <Loader2 className="h-3 w-3 animate-spin" /> : <List className="h-3 w-3" />}
                        {fetchingModels ? '获取中' : '获取模型'}
                      </button>
                    </div>
                  </div>
                  {modelAddOpen && (
                    <div className="flex gap-1 rounded-md border border-border-dark bg-surface-dark p-1">
                      <input
                        autoFocus
                        value={modelAddValue}
                        onChange={(e) => setModelAddValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleAddModel();
                          if (e.key === 'Escape') {
                            setModelAddOpen(false);
                            setModelAddValue('');
                          }
                        }}
                        placeholder="输入模型 ID，例如 gpt-image-1"
                        className="min-w-0 flex-1 bg-transparent px-1.5 text-[11px] text-text-dark outline-none placeholder:text-text-muted/60"
                      />
                      <button
                        type="button"
                        onClick={handleAddModel}
                        className="rounded bg-accent/20 px-2 py-0.5 text-[11px] text-accent hover:bg-accent/30"
                      >
                        保存
                      </button>
                    </div>
                  )}
                  {modelOptions.length === 0 ? (
                    <div className="rounded-md border border-dashed border-border-dark bg-surface-dark px-3 py-3 text-[11px] text-text-muted">
                      还没有模型。点「获取模型」自动拉取，或点「添加」手动输入。
                    </div>
                  ) : modelEditMode ? (
                    <div className="space-y-1.5 rounded-md border border-border-dark bg-surface-dark p-2">
                      {modelOptions.map((model) => (
                        <div key={model} className="flex items-center gap-1">
                          <input
                            value={model}
                            onChange={(e) => handleRenameModel(model, e.target.value)}
                            className="min-w-0 flex-1 rounded border border-border-dark bg-bg-dark px-2 py-1 font-mono text-[11px] text-text-dark outline-none focus:border-accent/50"
                          />
                          <button
                            type="button"
                            onClick={() => handleDeleteModel(model)}
                            className="inline-flex h-6 w-6 items-center justify-center rounded text-text-muted hover:bg-red-500/20 hover:text-red-400"
                            title="删除模型"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-1.5 rounded-md border border-border-dark bg-surface-dark p-2">
                      {modelOptions.map((model) => {
                        const selected = draft.models.includes(model);
                        return (
                          <button
                            key={model}
                            type="button"
                            onClick={() => toggleModelSelection(model)}
                            className={`max-w-full rounded-md border px-2 py-1 text-left font-mono text-[11px] transition-colors ${
                              selected
                                ? 'border-accent/60 bg-accent/20 text-accent'
                                : 'border-border-dark bg-bg-dark text-text-muted hover:border-accent/40'
                            }`}
                            title={selected ? '点击取消选择' : '点击选择'}
                          >
                            <span className="block max-w-[220px] truncate">{model}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {modelFetchResult && (
                    <div className={`text-[10px] ${modelFetchResult.ok ? 'text-emerald-400' : 'text-amber-300'}`}>
                      {modelFetchResult.ok
                        ? `已获取 ${modelFetchResult.models.length} 个模型，并默认全选；可点击取消非生图模型`
                        : `获取失败：${modelFetchResult.errorMessage ?? '模型接口不可用'}`}
                    </div>
                  )}
                  <div className="text-[10px] text-text-muted/70">
                    已选择 {draft.models.length} 个模型，保存后只会出现在模型选择器里。
                  </div>
                </div>
                <div className="flex flex-col gap-1 col-span-2">
                  <span className="text-text-muted text-[11px]">支持的生图比例（多选。含「智能」= 服务端自动决定；可用 + 增加自定义比例）</span>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {/* Smart chip (value = 'auto') */}
                    {(() => {
                      const on = draft.supportedRatios.includes('auto');
                      return (
                        <button
                          type="button"
                          onClick={() => setDraft((d) => ({ ...d, supportedRatios: on ? d.supportedRatios.filter((x) => x !== 'auto') : ['auto', ...d.supportedRatios] }))}
                          className={`rounded px-2 py-0.5 text-[11px] border transition-colors ${on ? 'bg-accent/20 border-accent/50 text-accent' : 'bg-surface-dark border-border-dark text-text-muted hover:border-accent/40'}`}
                        >
                          智能
                        </button>
                      );
                    })()}
                    {/* Preset chips */}
                    {PRESET_RATIOS.map((r) => {
                      const on = draft.supportedRatios.includes(r);
                      return (
                        <button
                          key={r}
                          type="button"
                          onClick={() => setDraft((d) => ({ ...d, supportedRatios: on ? d.supportedRatios.filter((x) => x !== r) : [...d.supportedRatios, r] }))}
                          className={`rounded px-2 py-0.5 text-[11px] border transition-colors ${on ? 'bg-accent/20 border-accent/50 text-accent' : 'bg-surface-dark border-border-dark text-text-muted hover:border-accent/40'}`}
                        >
                          {r}
                        </button>
                      );
                    })}
                    {/* User-added custom chips (anything not 'auto' and not in PRESET_RATIOS) */}
                    {draft.supportedRatios
                      .filter((r) => r !== 'auto' && !PRESET_RATIOS.includes(r as never))
                      .map((r) => (
                        <span
                          key={r}
                          className="relative group inline-flex items-center rounded bg-accent/20 border border-accent/50 text-accent px-2 py-0.5 text-[11px]"
                        >
                          {r}
                          <button
                            type="button"
                            aria-label="删除该自定义比例"
                            onClick={() => setDraft((d) => ({ ...d, supportedRatios: d.supportedRatios.filter((x) => x !== r) }))}
                            className="ml-1 inline-flex h-3 w-3 items-center justify-center rounded-full bg-red-500/70 text-white text-[9px] leading-none hover:bg-red-500"
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    {/* + / inline input */}
                    {!ratioInputOpen ? (
                      <button
                        type="button"
                        title="添加自定义比例"
                        onClick={() => { setRatioInputOpen(true); setRatioInputValue(''); }}
                        className="rounded px-2 py-0.5 text-[11px] border border-dashed border-border-dark text-text-muted hover:border-accent/50 hover:text-accent"
                      >
                        + 自定义
                      </button>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded border border-accent/50 bg-surface-dark px-1.5 py-0.5">
                        <input
                          autoFocus
                          value={ratioInputValue}
                          onChange={(e) => setRatioInputValue(e.target.value)}
                          placeholder="w:h 例 5:4"
                          className="w-20 bg-transparent text-[11px] text-text-dark outline-none placeholder:text-text-muted/60"
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              const v = ratioInputValue.trim();
                              if (/^\d+:\d+$/.test(v) && !draft.supportedRatios.includes(v)) {
                                setDraft((d) => ({ ...d, supportedRatios: [...d.supportedRatios, v] }));
                              }
                              setRatioInputOpen(false);
                              setRatioInputValue('');
                            } else if (e.key === 'Escape') {
                              setRatioInputOpen(false);
                              setRatioInputValue('');
                            }
                          }}
                        />
                        <button
                          type="button"
                          title="保存"
                          onClick={() => {
                            const v = ratioInputValue.trim();
                            if (/^\d+:\d+$/.test(v) && !draft.supportedRatios.includes(v)) {
                              setDraft((d) => ({ ...d, supportedRatios: [...d.supportedRatios, v] }));
                            }
                            setRatioInputOpen(false);
                            setRatioInputValue('');
                          }}
                          className="inline-flex h-4 w-4 items-center justify-center rounded bg-emerald-500/80 text-white text-[10px] hover:bg-emerald-500"
                        >√</button>
                        <button
                          type="button"
                          title="取消"
                          onClick={() => { setRatioInputOpen(false); setRatioInputValue(''); }}
                          className="inline-flex h-4 w-4 items-center justify-center rounded bg-red-500/80 text-white text-[10px] hover:bg-red-500"
                        >×</button>
                      </span>
                    )}
                  </div>
                </div>
                <label className="flex flex-col gap-1 col-span-2">
                  <span className="text-text-muted">支持的分辨率 <span className="text-text-muted/60">（可选。保存后会出现在 AI 图片「参数」里）</span></span>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {PRESET_RESOLUTIONS.map((resolution) => {
                      const on = (draft.supportedResolutions ?? []).includes(resolution);
                      return (
                        <button
                          key={resolution}
                          type="button"
                          onClick={() => setDraft((d) => ({
                            ...d,
                            supportedResolutions: on
                              ? (d.supportedResolutions ?? []).filter((x) => x !== resolution)
                              : [...(d.supportedResolutions ?? []), resolution],
                          }))}
                          className={`rounded px-2 py-0.5 text-[11px] border transition-colors ${on ? 'bg-accent/20 border-accent/50 text-accent' : 'bg-surface-dark border-border-dark text-text-muted hover:border-accent/40'}`}
                        >
                          {resolution === 'auto' ? '自动' : resolution}
                        </button>
                      );
                    })}
                    {(draft.supportedResolutions ?? [])
                      .filter((resolution) => !PRESET_RESOLUTIONS.includes(resolution as never))
                      .map((resolution) => (
                        <span
                          key={resolution}
                          className="inline-flex items-center rounded bg-accent/20 border border-accent/50 text-accent px-2 py-0.5 text-[11px]"
                        >
                          {resolution}
                          <button
                            type="button"
                            aria-label="删除该自定义分辨率"
                            onClick={() => setDraft((d) => ({
                              ...d,
                              supportedResolutions: (d.supportedResolutions ?? []).filter((x) => x !== resolution),
                            }))}
                            className="ml-1 inline-flex h-3 w-3 items-center justify-center rounded-full bg-red-500/70 text-white text-[9px] leading-none hover:bg-red-500"
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    {!resolutionInputOpen ? (
                      <button
                        type="button"
                        title="添加自定义分辨率"
                        onClick={() => { setResolutionInputOpen(true); setResolutionInputValue(''); }}
                        className="rounded px-2 py-0.5 text-[11px] border border-dashed border-border-dark text-text-muted hover:border-accent/50 hover:text-accent"
                      >
                        + 自定义
                      </button>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded border border-accent/50 bg-surface-dark px-1.5 py-0.5">
                        <input
                          autoFocus
                          value={resolutionInputValue}
                          onChange={(e) => setResolutionInputValue(e.target.value)}
                          placeholder="例 2048x2048"
                          className="w-24 bg-transparent text-[11px] text-text-dark outline-none placeholder:text-text-muted/60"
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              const v = resolutionInputValue.trim();
                              if (v && !(draft.supportedResolutions ?? []).includes(v)) {
                                setDraft((d) => ({ ...d, supportedResolutions: [...(d.supportedResolutions ?? []), v] }));
                              }
                              setResolutionInputOpen(false);
                              setResolutionInputValue('');
                            } else if (e.key === 'Escape') {
                              setResolutionInputOpen(false);
                              setResolutionInputValue('');
                            }
                          }}
                        />
                        <button
                          type="button"
                          title="保存"
                          onClick={() => {
                            const v = resolutionInputValue.trim();
                            if (v && !(draft.supportedResolutions ?? []).includes(v)) {
                              setDraft((d) => ({ ...d, supportedResolutions: [...(d.supportedResolutions ?? []), v] }));
                            }
                            setResolutionInputOpen(false);
                            setResolutionInputValue('');
                          }}
                          className="inline-flex h-4 w-4 items-center justify-center rounded bg-emerald-500/80 text-white text-[10px] hover:bg-emerald-500"
                        >√</button>
                        <button
                          type="button"
                          title="取消"
                          onClick={() => { setResolutionInputOpen(false); setResolutionInputValue(''); }}
                          className="inline-flex h-4 w-4 items-center justify-center rounded bg-red-500/80 text-white text-[10px] hover:bg-red-500"
                        >×</button>
                      </span>
                    )}
                  </div>
                </label>
                <details className="col-span-2 rounded-lg border border-border-dark bg-surface-dark p-3">
                  <summary className="cursor-pointer text-[11px] font-medium text-text-dark">
                    高级参数 <span className="ml-2 font-normal text-text-muted">特殊供应商、代理或测试失败时再改</span>
                  </summary>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <label className="flex flex-col gap-1">
                      <span className="text-text-muted">HTTP 方法</span>
                      <select
                        value={draft.httpMethod ?? 'POST'}
                        onChange={(e) => setDraft((d) => ({ ...d, httpMethod: e.target.value as 'POST' | 'GET' }))}
                        className="rounded-md border border-border-dark bg-bg-dark px-2 py-1 text-text-dark outline-none focus:border-accent/50"
                      >
                        {HTTP_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                      </select>
                    </label>
                    <label className="flex flex-col gap-1 col-span-2">
                      <span className="text-text-muted">响应格式</span>
                      <select
                        value={draft.responseFormat ?? 'openai-images'}
                        onChange={(e) => setDraft((d) => ({ ...d, responseFormat: e.target.value as typeof RESPONSE_FORMATS[number] }))}
                        className="rounded-md border border-border-dark bg-bg-dark px-2 py-1 text-text-dark outline-none focus:border-accent/50"
                      >
                        {RESPONSE_FORMATS.map((r) => <option key={r} value={r}>{r}</option>)}
                      </select>
                    </label>
                    <label className="flex items-center gap-2 col-span-2 text-text-muted">
                      <input
                        type="checkbox"
                        checked={draft.supportsWebSearch}
                        onChange={(e) => setDraft((d) => ({ ...d, supportsWebSearch: e.target.checked }))}
                        className="accent-accent"
                      />
                      支持联网搜索
                    </label>
                    <label className="flex flex-col gap-1 col-span-2">
                      <span className="text-text-muted">支持的模型版本 <span className="text-text-muted/60">（可选，逗号分隔；如 turbo,plus,max）</span></span>
                      <input
                        value={(draft.supportedModelVersions ?? []).join(',')}
                        onChange={(e) => setDraft((d) => ({
                          ...d,
                          supportedModelVersions: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                        }))}
                        placeholder="（选填）"
                        className="rounded-md border border-border-dark bg-bg-dark px-2 py-1 text-text-dark outline-none focus:border-accent/50"
                      />
                    </label>
                    <div className="flex flex-col gap-1 col-span-2">
                      <span className="text-text-muted text-[11px]">额外 Query 参数（URL ?key=value 形式，可选）</span>
                      <div className="flex flex-wrap items-center gap-1">
                        {Object.entries(draft.queryParams ?? {}).map(([k, v]) => (
                          <span key={k} className="inline-flex items-center gap-1 rounded border border-border-dark bg-bg-dark px-1.5 py-0.5 text-[10px] font-mono">
                            <span className="text-accent">{k}</span>=<span className="text-text-dark">{v}</span>
                            <button
                              type="button"
                              onClick={() => setDraft((d) => ({
                                ...d,
                                queryParams: Object.fromEntries(Object.entries(d.queryParams ?? {}).filter(([kk]) => kk !== k)),
                              }))}
                              className="ml-0.5 inline-flex h-3 w-3 items-center justify-center rounded-full bg-red-500/70 text-white text-[9px] hover:bg-red-500"
                            >×</button>
                          </span>
                        ))}
                        <input
                          value={newQueryKey}
                          onChange={(e) => setNewQueryKey(e.target.value)}
                          placeholder="key"
                          className="w-20 rounded border border-border-dark bg-bg-dark px-1.5 py-0.5 text-[11px] text-text-dark outline-none focus:border-accent/50"
                        />
                        <input
                          value={newQueryValue}
                          onChange={(e) => setNewQueryValue(e.target.value)}
                          placeholder="value"
                          className="w-24 rounded border border-border-dark bg-bg-dark px-1.5 py-0.5 text-[11px] text-text-dark outline-none focus:border-accent/50"
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && newQueryKey.trim()) {
                              setDraft((d) => ({
                                ...d,
                                queryParams: { ...(d.queryParams ?? {}), [newQueryKey.trim()]: newQueryValue },
                              }));
                              setNewQueryKey('');
                              setNewQueryValue('');
                            }
                          }}
                        />
                        <button
                          type="button"
                          onClick={() => {
                            if (!newQueryKey.trim()) return;
                            setDraft((d) => ({
                              ...d,
                              queryParams: { ...(d.queryParams ?? {}), [newQueryKey.trim()]: newQueryValue },
                            }));
                            setNewQueryKey('');
                            setNewQueryValue('');
                          }}
                          className="rounded bg-accent/20 px-2 py-0.5 text-[11px] text-accent hover:bg-accent/30"
                        >+</button>
                      </div>
                    </div>
                    <div className="flex flex-col gap-1 col-span-2">
                      <span className="text-text-muted text-[11px]">额外 Header 参数（Referer、版本号等，可选）</span>
                      <div className="flex flex-wrap items-center gap-1">
                        {Object.entries(draft.extraHeaders ?? {}).map(([k, v]) => (
                          <span key={k} className="inline-flex items-center gap-1 rounded border border-border-dark bg-bg-dark px-1.5 py-0.5 text-[10px] font-mono">
                            <span className="text-accent">{k}</span>:<span className="text-text-dark">{v}</span>
                            <button
                              type="button"
                              onClick={() => setDraft((d) => ({
                                ...d,
                                extraHeaders: Object.fromEntries(Object.entries(d.extraHeaders ?? {}).filter(([kk]) => kk !== k)),
                              }))}
                              className="ml-0.5 inline-flex h-3 w-3 items-center justify-center rounded-full bg-red-500/70 text-white text-[9px] hover:bg-red-500"
                            >×</button>
                          </span>
                        ))}
                        <input
                          value={newHeaderKey}
                          onChange={(e) => setNewHeaderKey(e.target.value)}
                          placeholder="Header"
                          className="w-24 rounded border border-border-dark bg-bg-dark px-1.5 py-0.5 text-[11px] text-text-dark outline-none focus:border-accent/50"
                        />
                        <input
                          value={newHeaderValue}
                          onChange={(e) => setNewHeaderValue(e.target.value)}
                          placeholder="value"
                          className="w-32 rounded border border-border-dark bg-bg-dark px-1.5 py-0.5 text-[11px] text-text-dark outline-none focus:border-accent/50"
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && newHeaderKey.trim()) {
                              setDraft((d) => ({
                                ...d,
                                extraHeaders: { ...(d.extraHeaders ?? {}), [newHeaderKey.trim()]: newHeaderValue },
                              }));
                              setNewHeaderKey('');
                              setNewHeaderValue('');
                            }
                          }}
                        />
                        <button
                          type="button"
                          onClick={() => {
                            if (!newHeaderKey.trim()) return;
                            setDraft((d) => ({
                              ...d,
                              extraHeaders: { ...(d.extraHeaders ?? {}), [newHeaderKey.trim()]: newHeaderValue },
                            }));
                            setNewHeaderKey('');
                            setNewHeaderValue('');
                          }}
                          className="rounded bg-accent/20 px-2 py-0.5 text-[11px] text-accent hover:bg-accent/30"
                        >+</button>
                      </div>
                    </div>
                    <label className="flex flex-col gap-1 col-span-2">
                      <span className="text-text-muted">
                        默认请求参数 JSON <span className="text-text-muted/60">（可选；会并入每次生图请求）</span>
                      </span>
                      <textarea
                        value={defaultParamsText}
                        onChange={(e) => {
                          setDefaultParamsText(e.target.value);
                          if (defaultParamsError) setDefaultParamsError('');
                        }}
                        placeholder='{ "quality": "high", "output_format": "png" }'
                        className="h-20 resize-none rounded-md border border-border-dark bg-bg-dark px-2 py-1 font-mono text-[11px] text-text-dark outline-none focus:border-accent/50"
                      />
                      {defaultParamsError && <span className="text-[10px] text-red-400">{defaultParamsError}</span>}
                    </label>
                  </div>
                </details>
                {importPlanPreview && (
                  <details className="col-span-2 rounded-lg border border-amber-500/25 bg-amber-500/5 p-3">
                    <summary className="cursor-pointer text-[11px] font-medium text-amber-200">
                      导入识别计划 <span className="ml-2 font-normal text-amber-200/70">保留 templateKey / requestPlan / compatibility / responsePlan，便于排查</span>
                    </summary>
                    <pre className="ui-scrollbar mt-3 max-h-48 overflow-auto rounded-md border border-amber-500/15 bg-black/25 p-2 text-[10px] leading-4 text-amber-50/80">
                      {importPlanPreview}
                    </pre>
                  </details>
                )}
                <label className="flex flex-col gap-1 col-span-2">
                  <span className="text-text-muted">备注</span>
                  <input
                    value={draft.note ?? ''}
                    onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
                    placeholder="（选填）服务商注意事项、限速、付费说明等"
                    className="rounded-md border border-border-dark bg-surface-dark px-2 py-1 text-text-dark outline-none focus:border-accent/50"
                  />
                </label>
              </div>
              <div className="flex justify-end items-center gap-2 pt-2 border-t border-border-dark">
                {saveFlash && <span className="text-[11px] text-emerald-400 flex items-center gap-1"><CheckCircle2 className="h-3 w-3" /> 已保存到「我的配置」</span>}
                {testResult && (
                  <span className={`text-[11px] flex items-center gap-1 ${testResult.ok ? 'text-emerald-400' : 'text-red-400'}`}>
                    {testResult.ok ? <CheckCircle2 className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
                    {testResult.ok ? '连通正常' : (testResult.errorMessage ?? '连通失败')}
                  </span>
                )}
                <button
                  type="button"
                  onClick={handleTestConnectivity}
                  className="inline-flex items-center gap-1 rounded-md border border-white/15 bg-white/5 px-3 py-1.5 text-xs text-text-dark hover:bg-white/10 disabled:opacity-40"
                  disabled={testing || !draft.apiKey.trim() || !draft.baseUrl.trim()}
                  title="用当前表单配置发一次最小请求，确认能连通 + 能解析出图"
                >
                  {testing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plug className="h-3 w-3" />}
                  {testing ? '测试中...' : '测试连通'}
                </button>
                <button
                  type="button"
                  onClick={handleSave}
                  className="inline-flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-xs text-black hover:bg-accent/90 disabled:opacity-40"
                  disabled={!draft.label.trim() && !draft.baseUrl.trim()}
                >
                  <Save className="h-3 w-3" /> 保存配置
                </button>
              </div>
            </div>

            {/* Right: tips / presets / tutorial (only for legacy `both` mode;
                in 'add' mode SettingsDialog's outer right column covers this). */}
            {mode === 'both' && (
            <div className="space-y-3">
              <div className="rounded-lg border border-border-dark bg-bg-dark p-3">
                <div className="flex items-center gap-1.5 text-xs font-medium text-text-dark">
                  <Lightbulb className="h-3.5 w-3.5 text-accent" /> 不知道怎么配？
                </div>
                <ol className="mt-2 space-y-1 text-[11px] text-text-muted leading-4 list-decimal pl-4">
                  <li>点下方「复制配置提示词」</li>
                  <li>在任意 AI 里粘贴</li>
                  <li>贴上你的服务商文档 / cURL</li>
                  <li>把 AI 返回的 JSON 贴到左上「一键导入」框</li>
                </ol>
                <button
                  type="button"
                  onClick={handleCopyTutorialPrompt}
                  className="mt-2 w-full inline-flex items-center justify-center gap-1 rounded-md bg-accent/20 px-2.5 py-1.5 text-[11px] text-accent hover:bg-accent/30"
                >
                  {promptCopied ? <CheckCircle2 className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  {promptCopied ? '已复制' : '复制配置提示词'}
                </button>
              </div>

              <div className="rounded-lg border border-border-dark bg-bg-dark p-3">
                <div className="text-xs font-medium text-text-dark mb-2">主流服务商预设</div>
                <div className="space-y-1">
                  {CUSTOM_PROVIDER_PRESETS.map((preset) => (
                    <button
                      key={preset.key}
                      type="button"
                      onClick={() => applyPreset(preset.key)}
                      className="group w-full text-left rounded-md border border-border-dark bg-surface-dark px-2.5 py-1.5 hover:border-accent/50"
                      title={preset.hint}
                    >
                      <div className="text-[11px] font-medium text-text-dark truncate">{preset.label}</div>
                      <div className="text-[10px] text-text-muted truncate">{preset.hint}</div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="rounded-lg border border-dashed border-border-dark bg-bg-dark/50 p-3">
                <div className="text-[10px] text-text-muted leading-5">
                  💡 apiStyle 选最接近的：OpenAI 兼容转发选 <code>openai-compatible</code>；Fal.ai 选 <code>fal</code>；Replicate 选 <code>replicate</code>；火山引擎选 <code>volcengine</code>；不匹配就选 <code>generic-json</code>。
                </div>
              </div>
            </div>
            )}
          </div>
        </>
      )}

      {showList && (
        <div className="space-y-3">
          {providers.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border-dark px-4 py-8 text-center">
              <div className="text-xs text-text-muted">还没有保存任何配置</div>
              <button
                type="button"
                onClick={() => onRequestAdd?.('new')}
                className="mt-3 inline-flex items-center gap-1 rounded-md bg-accent/20 px-3 py-1.5 text-xs text-accent hover:bg-accent/30"
              >
                <Plus className="h-3 w-3" /> 去「添加供应商」新建
              </button>
            </div>
          ) : (
            providers.map((p) => (
              <div key={p.id} className="rounded-lg border border-border-dark bg-bg-dark p-4">
                {(() => {
                  const savedTestResult = providerTestResults[p.id];
                  const isTestingThisProvider = testingProviderId === p.id;
                  const isVideo = isVideoCustomProvider(p);
                  const kind = providerKindLabel(p);
                  return (
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <div className="truncate text-sm font-medium text-text-dark">{p.label}</div>
                      <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] ${kind.className}`}>
                        {kind.label}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-text-muted truncate font-mono">{p.baseUrl || '(未填 baseUrl)'}</div>
                    <div className="mt-0.5 text-[10px] text-text-muted">
                      接口：{p.apiStyle} · 请求 {formatBodyModeLabel(resolveCustomProviderBodyMode(p))} · 模型 {p.models.length} 个 · {p.supportsWebSearch ? '支持联网' : '不支持联网'}
                    </div>
                    {p.note && <div className="mt-1 text-[10px] text-text-muted/70 italic truncate">ⓘ {p.note}</div>}
                    {savedTestResult && (
                      <div className={`mt-2 inline-flex items-center gap-1 rounded border px-2 py-1 text-[10px] ${
                        savedTestResult.ok
                          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                          : 'border-red-500/30 bg-red-500/10 text-red-300'
                      }`}>
                        {savedTestResult.ok ? <CheckCircle2 className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
                        {savedTestResult.ok ? '连通正常' : (savedTestResult.errorMessage ?? '连通失败')}
                      </div>
                    )}
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => { void handleTestSavedProvider(p); }}
                      disabled={isVideo || isTestingThisProvider || !p.apiKey.trim() || !p.baseUrl.trim()}
                      className="inline-flex items-center gap-1 rounded-md bg-white/5 px-2.5 py-1 text-[11px] text-text-dark hover:bg-white/10 disabled:opacity-40"
                      title={isVideo ? '视频配置暂不走图片连通测试' : '用这条已保存配置发一次测试请求'}
                    >
                      {isTestingThisProvider ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plug className="h-3 w-3" />}
                      {isTestingThisProvider ? '测试中' : '测试连通'}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleEdit(p.id)}
                      className="inline-flex items-center gap-1 rounded-md bg-white/5 px-2.5 py-1 text-[11px] text-text-dark hover:bg-white/10"
                      title="查看并编辑配置"
                    >
                      <Pencil className="h-3 w-3" /> 查看配置
                    </button>
                    <button
                      type="button"
                      onClick={() => setModelsDialogFor(p.id)}
                      className="inline-flex items-center gap-1 rounded-md bg-white/5 px-2.5 py-1 text-[11px] text-text-dark hover:bg-white/10"
                      title="查看包含的模型与支持能力"
                    >
                      <List className="h-3 w-3" /> 查看模型
                    </button>
                    <button
                      type="button"
                      onClick={() => removeProvider(p.id)}
                      className="flex items-center justify-center w-7 h-7 rounded-md text-text-muted hover:bg-red-500/20 hover:text-red-400"
                      title="删除"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>
                  );
                })()}
              </div>
            ))
          )}
        </div>
      )}

      {/* "查看模型" popup */}
      {modelsDialogProvider && (
        <div
          className="fixed inset-0 z-[500] flex items-center justify-center bg-black/60"
          onClick={() => setModelsDialogFor(null)}
        >
          <div
            className="w-[480px] max-w-[90vw] rounded-xl border border-border-dark bg-surface-dark p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <div className="text-sm font-semibold text-text-dark">{modelsDialogProvider.label} · 模型与能力</div>
              <button
                type="button"
                onClick={() => setModelsDialogFor(null)}
                className="text-text-muted hover:text-text-dark"
              >
                ×
              </button>
            </div>
            <div className="space-y-3 text-xs">
              <div>
                <div className="text-text-muted mb-1">模型列表 ({modelsDialogProvider.models.length})</div>
                {modelsDialogProvider.models.length === 0 ? (
                  <div className="text-text-muted/70">（该配置未列出模型）</div>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {modelsDialogProvider.models.map((m) => (
                      <span key={m} className="rounded bg-bg-dark px-2 py-0.5 text-[11px] text-text-dark font-mono">{m}</span>
                    ))}
                  </div>
                )}
              </div>
              <div>
                {isVideoCustomProvider(modelsDialogProvider) ? (
                  <>
                    <div className="text-text-muted mb-1">支持秒数</div>
                    <div className="flex flex-wrap gap-1">
                      {(((modelsDialogProvider.extraParams as { supportedDurations?: string[] })?.supportedDurations) ?? []).map((duration) => (
                        <span key={duration} className="rounded bg-bg-dark px-2 py-0.5 text-[11px] text-text-dark">{duration}s</span>
                      ))}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="text-text-muted mb-1">生图比例</div>
                    <div className="flex flex-wrap gap-1">
                      {(((modelsDialogProvider.extraParams as { supportedRatios?: string[] })?.supportedRatios) ?? []).map((r) => (
                        <span key={r} className="rounded bg-bg-dark px-2 py-0.5 text-[11px] text-text-dark">{r}</span>
                      ))}
                    </div>
                  </>
                )}
              </div>
              {isVideoCustomProvider(modelsDialogProvider) && (
                <div>
                  <div className="text-text-muted mb-1">支持分辨率</div>
                  <div className="flex flex-wrap gap-1">
                    {(modelsDialogProvider.supportedResolutions ?? []).map((resolution) => (
                      <span key={resolution} className="rounded bg-bg-dark px-2 py-0.5 text-[11px] text-text-dark">{resolution}</span>
                    ))}
                  </div>
                </div>
              )}
              <div>
                <div className="text-text-muted mb-1">联网搜索</div>
                <div className="text-text-dark">{modelsDialogProvider.supportsWebSearch ? '支持 ✓' : '不支持'}</div>
              </div>
              <div>
                <div className="text-text-muted mb-1">接口风格</div>
                <code className="rounded bg-bg-dark px-2 py-0.5 text-[11px] text-text-dark">{modelsDialogProvider.apiStyle}</code>
              </div>
              <div>
                <div className="text-text-muted mb-1">请求格式</div>
                <code className="rounded bg-bg-dark px-2 py-0.5 text-[11px] text-text-dark">{formatBodyModeLabel(resolveCustomProviderBodyMode(modelsDialogProvider))}</code>
              </div>
              {formatImportPlanPreview(modelsDialogProvider.extraParams) && (
                <details className="rounded-lg border border-border-dark bg-bg-dark p-3">
                  <summary className="cursor-pointer text-[11px] text-text-dark">导入识别计划</summary>
                  <pre className="ui-scrollbar mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-[10px] leading-4 text-text-muted">
                    {formatImportPlanPreview(modelsDialogProvider.extraParams)}
                  </pre>
                </details>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

CustomProvidersSection.displayName = 'CustomProvidersSection';
