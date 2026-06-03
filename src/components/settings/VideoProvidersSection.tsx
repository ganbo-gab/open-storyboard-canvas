import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Plus, Save, Trash2 } from 'lucide-react';

import {
  AGNES_PROVIDER_DEFAULTS,
  isVideoCustomProvider,
  useCustomProvidersStore,
  type CustomProviderConfig,
} from '@/stores/customProvidersStore';

interface VideoModelDraft {
  id: string;
  description: string;
}

interface VideoProviderTemplate {
  key: string;
  label: string;
  hint: string;
  labelValue: string;
  baseUrl: string;
  endpointPath: string;
  modelListEndpointPath: string;
  apiStyle: string;
  models: VideoModelDraft[];
  durations: string[];
  aspectRatios: string[];
  resolutions: string[];
  extraParams: Record<string, unknown>;
  note: string;
}

const DEFAULT_MODELS: VideoModelDraft[] = [
  { id: 'sora-2', description: 'OpenAI Videos API 默认探索模型' },
  { id: 'sora-2-pro', description: '更高质量的视频生成模型' },
];

const DEFAULT_DURATIONS = ['4', '8', '12'];
const DEFAULT_RESOLUTIONS = ['720x1280', '1280x720', '1024x1792', '1792x1024', '1024x1024'];
const DEFAULT_ASPECT_RATIOS = ['16:9', '9:16', '1:1'];
const DEFAULT_OPENAI_VIDEO_NOTE = 'OpenAI Videos API 兼容配置。multipart/form-data 提交 model/prompt/size/seconds/input_reference，轮询任务状态后下载视频。官方文档当前标注 Sora 2 Videos API 将在 2026-09-24 关闭，保留此预设用于兼容。';

const VIDEO_PROVIDER_TEMPLATES: VideoProviderTemplate[] = [
  {
    key: 'openai',
    label: 'OpenAI-compatible',
    hint: 'OpenAI Videos / Sora 兼容接口',
    labelValue: 'OpenAI Videos 兼容',
    baseUrl: 'https://api.openai.com',
    endpointPath: '/v1/videos',
    modelListEndpointPath: '/v1/models',
    apiStyle: 'openai-compatible',
    models: DEFAULT_MODELS,
    durations: DEFAULT_DURATIONS,
    aspectRatios: DEFAULT_ASPECT_RATIOS,
    resolutions: DEFAULT_RESOLUTIONS,
    extraParams: {
      providerKind: 'openai-videos',
      requestComposer: 'video-openai-compatible',
      requestBodyMode: 'multipart',
      videoStatusEndpointPath: '/v1/videos/{taskId}',
      videoContentEndpointPath: '/v1/videos/{taskId}/content',
      videoReferenceField: 'input_reference',
    },
    note: DEFAULT_OPENAI_VIDEO_NOTE,
  },
  {
    key: 'xai-grok',
    label: 'Grok / xAI Video',
    hint: 'xAI JSON 异步视频接口',
    labelValue: 'xAI / Grok Video',
    baseUrl: 'https://api.x.ai/v1',
    endpointPath: '/videos/generations',
    modelListEndpointPath: '/models',
    apiStyle: 'generic-json',
    models: [{ id: 'grok-imagine-video', description: 'xAI Grok Imagine 视频生成模型' }],
    durations: ['5', '10', '15'],
    aspectRatios: ['16:9', '9:16'],
    resolutions: ['720p', '480p'],
    extraParams: {
      providerKind: 'xai-grok-video',
      requestComposer: 'video-generic-json',
      videoRequestBodyMode: 'json',
      videoTaskIdPath: 'request_id',
      videoStatusEndpointPath: '/videos/{taskId}',
      responseVideoPath: 'video.url',
      videoStatusPath: 'status',
      videoPendingValues: ['queued', 'running', 'processing', 'pending'],
      videoSuccessValues: ['done'],
      videoFailedValues: ['failed', 'expired'],
      defaultRequestParams: {
        aspect_ratio: '16:9',
      },
    },
    note: 'xAI/Grok 视频不是 OpenAI Videos 格式：POST /videos/generations 返回 request_id，GET /videos/{request_id}，完成 status=done，视频在 video.url。',
  },
  {
    key: 'google-veo',
    label: 'Google Video / Veo',
    hint: 'Google AI / Vertex 路线，通常需要按项目/区域改路径',
    labelValue: 'Google Video / Veo',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    endpointPath: '/models/veo-3.1-generate-preview:predictLongRunning',
    modelListEndpointPath: '',
    apiStyle: 'generic-json',
    models: [
      { id: 'veo-3.1-generate-preview', description: 'Google Veo 3.1 preview' },
      { id: 'veo-3.1-lite-generate-preview', description: 'Google Veo 3.1 lite preview' },
    ],
    durations: ['4', '8'],
    aspectRatios: DEFAULT_ASPECT_RATIOS,
    resolutions: ['720p', '1080p', '4k'],
    extraParams: {
      providerKind: 'google-video',
      requestComposer: 'video-google-veo-long-running',
      videoRequestBodyMode: 'json',
      requiresDedicatedVideoGateway: true,
      videoTaskIdPath: 'name',
      videoReferenceField: 'reference_images',
      videoStatusPath: 'done',
      videoSuccessValues: ['true'],
      videoFailedValues: ['failed', 'error'],
      defaultRequestParams: {
        aspectRatio: '16:9',
      },
    },
    note: 'Google Veo 使用 Gemini long-running operation：POST /models/{model}:predictLongRunning 并轮询 operation name。当前模板保留真实字段元数据，但需要后续专用 gateway 组装 instances/config，不会伪装成 OpenAI Videos。',
  },
  {
    key: 'agnes',
    label: 'Agnes Video',
    hint: 'Agnes JSON 异步视频接口',
    labelValue: 'Agnes Video',
    baseUrl: AGNES_PROVIDER_DEFAULTS.baseUrl,
    endpointPath: AGNES_PROVIDER_DEFAULTS.videoEndpointPath,
    modelListEndpointPath: AGNES_PROVIDER_DEFAULTS.modelListEndpointPath,
    apiStyle: 'openai-compatible',
    models: [
      { id: AGNES_PROVIDER_DEFAULTS.models.video20, description: 'Agnes Video v2.0' },
      { id: AGNES_PROVIDER_DEFAULTS.models.video12, description: 'Agnes Video v1.2' },
    ],
    durations: DEFAULT_DURATIONS,
    aspectRatios: DEFAULT_ASPECT_RATIOS,
    resolutions: [...AGNES_PROVIDER_DEFAULTS.videoResolutions],
    extraParams: {
      providerKind: 'agnes-video',
      requestComposer: 'video-agnes-json',
      videoRequestBodyMode: 'json',
      videoTaskIdPath: 'task_id',
      videoStatusEndpointPath: AGNES_PROVIDER_DEFAULTS.videoStatusEndpointPath,
      responseVideoPath: 'video_url',
      videoStatusPath: 'status',
      videoPendingValues: ['queued', 'in_progress'],
      videoSuccessValues: ['completed'],
      videoFailedValues: ['failed'],
      videoReferenceField: 'image',
      videoPollTimeoutMs: 15 * 60 * 1000,
      defaultRequestParams: {
        frame_rate: 24,
        negative_prompt: '',
      },
    },
    note: 'Agnes 官方网关：POST /videos 返回 task_id，GET /videos/{task_id} 轮询 status，完成后读取 video_url。请求体使用 JSON，num_frames 会按 8n+1 约束自动归一化。',
  },
  {
    key: 'seedance',
    label: '即梦 / Seedance',
    hint: 'Volcengine Ark contents/generations/tasks 任务接口',
    labelValue: '即梦 / Seedance Video',
    baseUrl: 'https://ark.cn-beijing.volces.com',
    endpointPath: '/api/v3/contents/generations/tasks',
    modelListEndpointPath: '',
    apiStyle: 'generic-json',
    models: [
      { id: 'doubao-seedance-2-0-pro-260215', description: 'Seedance 2.0 Pro（示例，请以火山方舟控制台为准）' },
      { id: 'doubao-seedance-2-0-fast-260215', description: 'Seedance 2.0 Fast（示例，请以火山方舟控制台为准）' },
      { id: 'doubao-seedance-1-5-pro-251215', description: 'Seedance 1.5 Pro（示例，请以火山方舟控制台为准）' },
    ],
    durations: ['4', '5', '8', '10', '12', '15'],
    aspectRatios: ['16:9', '9:16', '1:1'],
    resolutions: ['480p', '720p', '1080p', '2K'],
    extraParams: {
      providerKind: 'seedance-video',
      requestComposer: 'video-volcengine-seedance-json',
      videoRequestBodyMode: 'json',
      videoTaskIdPath: 'id',
      videoStatusEndpointPath: '/api/v3/contents/generations/tasks/{taskId}',
      responseVideoPath: 'content[0].url',
      videoStatusPath: 'status',
      videoReferenceField: 'reference_images',
      videoPendingValues: ['queued', 'running', 'processing', 'pending', 'in_progress'],
      videoSuccessValues: ['succeeded', 'success', 'completed', 'done'],
      videoFailedValues: ['failed', 'error', 'canceled'],
      videoPollIntervalMs: 5000,
      videoPollTimeoutMs: 15 * 60 * 1000,
      defaultRequestParams: {
        generate_audio: false,
        watermark: false,
      },
    },
    note: 'Seedance / 火山方舟任务式视频模板：POST /api/v3/contents/generations/tasks 创建任务，GET /api/v3/contents/generations/tasks/{taskId} 查询结果。模型 ID、duration、ratio、resolution、generate_audio 等字段请按火山方舟控制台/文档调整；若你的账号走 AK/SK 签名或代理，请改为服务端代理后再保存。',
  },
];

function templateByKey(key: string): VideoProviderTemplate {
  return VIDEO_PROVIDER_TEMPLATES.find((template) => template.key === key) ?? VIDEO_PROVIDER_TEMPLATES[0];
}

function generateProviderId(): string {
  return `video-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  values.forEach((value) => {
    const text = value.trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    next.push(text);
  });
  return next;
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function normalizeEndpointPath(value: string): string {
  const text = value.trim();
  if (!text) return '';
  return text.startsWith('/') ? text : `/${text}`;
}

function parseJsonObject(text: string): { ok: boolean; value: Record<string, unknown>; error?: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, value: {} };
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, value: {}, error: '必须是 JSON 对象，例如 { "seed": 123 }' };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch (error) {
    return { ok: false, value: {}, error: error instanceof Error ? error.message : 'JSON 格式不正确' };
  }
}

function stringifyJsonObject(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '{}';
  return JSON.stringify(value, null, 2);
}

function modelDraftsFromProvider(provider: CustomProviderConfig): VideoModelDraft[] {
  const descriptions = provider.extraParams?.modelDescriptions;
  const descriptionMap = descriptions && typeof descriptions === 'object' && !Array.isArray(descriptions)
    ? descriptions as Record<string, unknown>
    : {};
  return (provider.models.length > 0 ? provider.models : DEFAULT_MODELS.map((item) => item.id)).map((id) => ({
    id,
    description: typeof descriptionMap[id] === 'string' ? descriptionMap[id] : '',
  }));
}

function arrayFromExtra(provider: CustomProviderConfig, key: string, fallback: string[]): string[] {
  const value = provider.extraParams?.[key];
  return Array.isArray(value) ? uniqueStrings(value.map(String)) : fallback;
}

export const VideoProvidersSection = memo(function VideoProvidersSection() {
  const providers = useCustomProvidersStore((state) => state.providers);
  const pendingEditId = useCustomProvidersStore((state) => state.pendingEditId);
  const addProvider = useCustomProvidersStore((state) => state.addProvider);
  const updateProvider = useCustomProvidersStore((state) => state.updateProvider);
  const setPendingEditId = useCustomProvidersStore((state) => state.setPendingEditId);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [label, setLabel] = useState('OpenAI Videos 兼容');
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com');
  const [endpointPath, setEndpointPath] = useState('/v1/videos');
  const [modelListEndpointPath, setModelListEndpointPath] = useState('/v1/models');
  const [apiStyle, setApiStyle] = useState('openai-compatible');
  const [templateExtraParams, setTemplateExtraParams] = useState<Record<string, unknown>>(VIDEO_PROVIDER_TEMPLATES[0].extraParams);
  const [providerNote, setProviderNote] = useState(DEFAULT_OPENAI_VIDEO_NOTE);
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<VideoModelDraft[]>(DEFAULT_MODELS);
  const [newModelId, setNewModelId] = useState('');
  const [newModelDescription, setNewModelDescription] = useState('');
  const [durations, setDurations] = useState<string[]>(DEFAULT_DURATIONS);
  const [aspectRatios, setAspectRatios] = useState<string[]>(DEFAULT_ASPECT_RATIOS);
  const [resolutions, setResolutions] = useState<string[]>(DEFAULT_RESOLUTIONS);
  const [customDuration, setCustomDuration] = useState('');
  const [customAspectRatio, setCustomAspectRatio] = useState('');
  const [customResolution, setCustomResolution] = useState('');
  const [defaultParamsText, setDefaultParamsText] = useState('{}');
  const [savedFlash, setSavedFlash] = useState(false);

  const parsedDefaultParams = useMemo(() => parseJsonObject(defaultParamsText), [defaultParamsText]);

  const resetForm = useCallback(() => {
    setEditingId(null);
    setLabel('OpenAI Videos 兼容');
    setBaseUrl('https://api.openai.com');
    setEndpointPath('/v1/videos');
    setModelListEndpointPath('/v1/models');
    setApiStyle('openai-compatible');
    setTemplateExtraParams(VIDEO_PROVIDER_TEMPLATES[0].extraParams);
    setProviderNote(DEFAULT_OPENAI_VIDEO_NOTE);
    setApiKey('');
    setModels(DEFAULT_MODELS);
    setNewModelId('');
    setNewModelDescription('');
    setDurations(DEFAULT_DURATIONS);
    setAspectRatios(DEFAULT_ASPECT_RATIOS);
    setResolutions(DEFAULT_RESOLUTIONS);
    setCustomDuration('');
    setCustomAspectRatio('');
    setCustomResolution('');
    setDefaultParamsText('{}');
  }, []);

  useEffect(() => {
    if (!pendingEditId) return;
    const provider = providers.find((item) => item.id === pendingEditId);
    if (!provider || !isVideoCustomProvider(provider)) return;
    setEditingId(provider.id);
    setLabel(provider.label);
    setBaseUrl(provider.baseUrl);
    setEndpointPath(provider.endpointPath ?? '/v1/videos');
    setModelListEndpointPath(provider.modelListEndpointPath ?? '');
    setApiStyle(provider.apiStyle || 'generic-json');
    setTemplateExtraParams({ ...(provider.extraParams ?? {}) });
    setProviderNote(provider.note ?? '');
    setApiKey(provider.apiKey);
    setModels(modelDraftsFromProvider(provider));
    setDurations(arrayFromExtra(provider, 'supportedDurations', DEFAULT_DURATIONS));
    setAspectRatios(arrayFromExtra(provider, 'supportedRatios', DEFAULT_ASPECT_RATIOS));
    setResolutions(provider.supportedResolutions && provider.supportedResolutions.length > 0
      ? provider.supportedResolutions
      : arrayFromExtra(provider, 'supportedResolutions', DEFAULT_RESOLUTIONS));
    setDefaultParamsText(stringifyJsonObject(provider.extraParams?.defaultRequestParams));
    setPendingEditId(null);
  }, [pendingEditId, providers, setPendingEditId]);

  const handleAddModel = useCallback(() => {
    const id = newModelId.trim();
    if (!id || models.some((model) => model.id === id)) return;
    setModels((current) => [...current, { id, description: newModelDescription.trim() }]);
    setNewModelId('');
    setNewModelDescription('');
  }, [models, newModelDescription, newModelId]);

  const handleAddDuration = useCallback(() => {
    const value = customDuration.trim();
    if (!value) return;
    setDurations((current) => uniqueStrings([...current, value]));
    setCustomDuration('');
  }, [customDuration]);

  const handleAddAspectRatio = useCallback(() => {
    const value = customAspectRatio.trim();
    if (!value) return;
    setAspectRatios((current) => uniqueStrings([...current, value]));
    setCustomAspectRatio('');
  }, [customAspectRatio]);

  const handleAddResolution = useCallback(() => {
    const value = customResolution.trim();
    if (!value) return;
    setResolutions((current) => uniqueStrings([...current, value]));
    setCustomResolution('');
  }, [customResolution]);

  const handleApplyTemplate = useCallback((key: string) => {
    const template = templateByKey(key);
    setEditingId(null);
    setLabel(template.labelValue);
    setBaseUrl(template.baseUrl);
    setEndpointPath(template.endpointPath);
    setModelListEndpointPath(template.modelListEndpointPath);
    setApiStyle(template.apiStyle);
    setModels(template.models);
    setDurations(template.durations);
    setAspectRatios(template.aspectRatios);
    setResolutions(template.resolutions);
    setTemplateExtraParams(template.extraParams);
    setProviderNote(template.note);
    setDefaultParamsText(stringifyJsonObject(template.extraParams.defaultRequestParams));
    setNewModelId('');
    setNewModelDescription('');
  }, []);

  const handleSave = useCallback(() => {
    const cleanModels = models.filter((model) => model.id.trim()).map((model) => ({
      id: model.id.trim(),
      description: model.description.trim(),
    }));
    if (!label.trim() || !baseUrl.trim() || cleanModels.length === 0 || !parsedDefaultParams.ok) return;
    const modelDescriptions = Object.fromEntries(
      cleanModels
        .filter((model) => model.description)
        .map((model) => [model.id, model.description])
    );
    const config: CustomProviderConfig = {
      id: editingId ?? generateProviderId(),
      label: label.trim(),
      mediaType: 'video',
      baseUrl: normalizeBaseUrl(baseUrl),
      endpointPath: normalizeEndpointPath(endpointPath),
      modelListEndpointPath: modelListEndpointPath.trim(),
      httpMethod: 'POST',
      apiKey,
      apiStyle,
      models: cleanModels.map((model) => model.id),
      supportsWebSearch: false,
      extraHeaders: {},
      queryParams: {},
      responseFormat: 'generic',
      supportedResolutions: resolutions,
      extraParams: {
        ...templateExtraParams,
        providerConfigVersion: 'video-v1',
        mediaType: 'video',
        supportedDurations: durations,
        supportedRatios: aspectRatios,
        supportedResolutions: resolutions,
        modelDescriptions,
        defaultRequestParams: parsedDefaultParams.value,
      },
      note: providerNote,
    };
    if (editingId) {
      updateProvider(editingId, config);
    } else {
      addProvider(config);
    }
    setEditingId(null);
    setSavedFlash(true);
    window.setTimeout(() => setSavedFlash(false), 1600);
  }, [
    addProvider,
    apiKey,
    apiStyle,
    aspectRatios,
    baseUrl,
    durations,
    editingId,
    endpointPath,
    label,
    modelListEndpointPath,
    models,
    parsedDefaultParams,
    providerNote,
    resolutions,
    templateExtraParams,
    updateProvider,
  ]);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold text-text-dark">视频生成供应商</h2>
        <p className="mt-1 text-xs leading-5 text-text-muted">
          选择一个视频接口格式作为起点，再按服务商文档补齐 endpoint、模型、轮询状态和结果路径。未知 endpoint 的模板会保持空白，避免误用默认路径。
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {VIDEO_PROVIDER_TEMPLATES.map((template) => (
          <button
            key={template.key}
            type="button"
            onClick={() => handleApplyTemplate(template.key)}
            className="rounded-lg border border-border-dark bg-bg-dark p-3 text-left transition-colors hover:border-accent/55 hover:bg-accent/5"
            title={template.hint}
          >
            <div className="text-xs font-medium text-text-dark">{template.label}</div>
            <div className="mt-1 text-[11px] leading-4 text-text-muted">{template.hint}</div>
          </button>
        ))}
      </div>

      <div className="rounded-lg border border-border-dark bg-bg-dark p-4">
        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-text-muted">显示名</span>
            <input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              className="h-9 w-full rounded-md border border-border-dark bg-surface-dark px-3 text-sm text-text-dark outline-none focus:border-accent"
              placeholder="例如：我的 Sora 代理"
            />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-text-muted">API Key</span>
            <input
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              className="h-9 w-full rounded-md border border-border-dark bg-surface-dark px-3 text-sm text-text-dark outline-none focus:border-accent"
              placeholder="sk-..."
              type="password"
            />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-text-muted">Base URL（只填基础地址）</span>
            <input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              className="h-9 w-full rounded-md border border-border-dark bg-surface-dark px-3 text-sm text-text-dark outline-none focus:border-accent"
              placeholder="https://api.openai.com"
            />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-text-muted">视频接口路径</span>
            <input
              value={endpointPath}
              onChange={(event) => setEndpointPath(event.target.value)}
              className="h-9 w-full rounded-md border border-border-dark bg-surface-dark px-3 font-mono text-sm text-text-dark outline-none focus:border-accent"
              placeholder="/v1/videos"
            />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-text-muted">模型列表路径（可留空）</span>
            <input
              value={modelListEndpointPath}
              onChange={(event) => setModelListEndpointPath(event.target.value)}
              className="h-9 w-full rounded-md border border-border-dark bg-surface-dark px-3 font-mono text-sm text-text-dark outline-none focus:border-accent"
              placeholder="/v1/models"
            />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-text-muted">请求格式</span>
            <input
              value={apiStyle}
              onChange={(event) => setApiStyle(event.target.value)}
              className="h-9 w-full rounded-md border border-border-dark bg-surface-dark px-3 font-mono text-sm text-text-dark outline-none focus:border-accent"
              placeholder="openai-compatible / generic-json"
            />
          </label>
        </div>

        <div className="mt-4 rounded-lg border border-border-dark bg-surface-dark p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="text-xs font-medium text-text-muted">模型列表（可自定义新增、删除、描述）</div>
            {editingId && (
              <button type="button" onClick={resetForm} className="text-[11px] text-text-muted hover:text-text-dark">
                改为新建
              </button>
            )}
          </div>
          <div className="space-y-2">
            {models.map((model) => (
              <div key={model.id} className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_auto] gap-2">
                <div className="rounded-md border border-border-dark bg-bg-dark px-2 py-1 font-mono text-[11px] text-text-dark">
                  {model.id}
                </div>
                <input
                  value={model.description}
                  onChange={(event) => setModels((current) => current.map((item) => (
                    item.id === model.id ? { ...item, description: event.target.value } : item
                  )))}
                  className="rounded-md border border-border-dark bg-bg-dark px-2 py-1 text-[11px] text-text-dark outline-none focus:border-accent"
                  placeholder="模型说明（选填）"
                />
                <button
                  type="button"
                  onClick={() => setModels((current) => current.filter((item) => item.id !== model.id))}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-red-500/20 hover:text-red-300"
                  title="删除模型"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            <div className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_auto] gap-2">
              <input
                value={newModelId}
                onChange={(event) => setNewModelId(event.target.value)}
                className="rounded-md border border-dashed border-border-dark bg-bg-dark px-2 py-1 font-mono text-[11px] text-text-dark outline-none focus:border-accent"
                placeholder="模型 ID，例如 sora-2"
              />
              <input
                value={newModelDescription}
                onChange={(event) => setNewModelDescription(event.target.value)}
                className="rounded-md border border-dashed border-border-dark bg-bg-dark px-2 py-1 text-[11px] text-text-dark outline-none focus:border-accent"
                placeholder="描述"
              />
              <button
                type="button"
                onClick={handleAddModel}
                disabled={!newModelId.trim()}
                className="inline-flex h-7 items-center justify-center gap-1 rounded-md bg-accent/20 px-2 text-[11px] text-accent hover:bg-accent/30 disabled:opacity-40"
              >
                <Plus className="h-3 w-3" /> 添加
              </button>
            </div>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-3">
          <div className="rounded-lg border border-border-dark bg-surface-dark p-3">
            <div className="text-xs font-medium text-text-muted">支持秒数</div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {durations.map((duration) => (
                <span key={duration} className="inline-flex h-7 items-center gap-1 rounded-md border border-accent/45 bg-accent/14 pl-2 pr-1 text-xs text-accent">
                  {duration}s
                  <button
                    type="button"
                    onClick={() => setDurations((current) => current.filter((item) => item !== duration))}
                    className="inline-flex h-5 w-5 items-center justify-center rounded hover:bg-red-500/12 hover:text-red-300"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </span>
              ))}
              <span className="inline-flex h-7 items-center gap-1 rounded-md border border-dashed border-border-dark bg-bg-dark px-2">
                <input
                  value={customDuration}
                  onChange={(event) => setCustomDuration(event.target.value)}
                  className="h-5 w-14 bg-transparent text-xs text-text-dark outline-none"
                  placeholder="秒数"
                />
                <button type="button" onClick={handleAddDuration} className="text-[10px] text-accent">添加</button>
              </span>
            </div>
          </div>
          <div className="rounded-lg border border-border-dark bg-surface-dark p-3">
            <div className="text-xs font-medium text-text-muted">支持画幅比例</div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {aspectRatios.map((aspectRatio) => (
                <span key={aspectRatio} className="inline-flex h-7 items-center gap-1 rounded-md border border-accent/45 bg-accent/14 pl-2 pr-1 text-xs text-accent">
                  {aspectRatio}
                  <button
                    type="button"
                    onClick={() => setAspectRatios((current) => current.filter((item) => item !== aspectRatio))}
                    className="inline-flex h-5 w-5 items-center justify-center rounded hover:bg-red-500/12 hover:text-red-300"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </span>
              ))}
              <span className="inline-flex h-7 items-center gap-1 rounded-md border border-dashed border-border-dark bg-bg-dark px-2">
                <input
                  value={customAspectRatio}
                  onChange={(event) => setCustomAspectRatio(event.target.value)}
                  className="h-5 w-16 bg-transparent text-xs text-text-dark outline-none"
                  placeholder="16:9"
                />
                <button type="button" onClick={handleAddAspectRatio} className="text-[10px] text-accent">添加</button>
              </span>
            </div>
          </div>
          <div className="rounded-lg border border-border-dark bg-surface-dark p-3">
            <div className="text-xs font-medium text-text-muted">支持分辨率</div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {resolutions.map((resolution) => (
                <span key={resolution} className="inline-flex h-7 items-center gap-1 rounded-md border border-accent/45 bg-accent/14 pl-2 pr-1 text-xs text-accent">
                  {resolution}
                  <button
                    type="button"
                    onClick={() => setResolutions((current) => current.filter((item) => item !== resolution))}
                    className="inline-flex h-5 w-5 items-center justify-center rounded hover:bg-red-500/12 hover:text-red-300"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </span>
              ))}
              <span className="inline-flex h-7 items-center gap-1 rounded-md border border-dashed border-border-dark bg-bg-dark px-2">
                <input
                  value={customResolution}
                  onChange={(event) => setCustomResolution(event.target.value)}
                  className="h-5 w-24 bg-transparent text-xs text-text-dark outline-none"
                  placeholder="例 1024x1024"
                />
                <button type="button" onClick={handleAddResolution} className="text-[10px] text-accent">添加</button>
              </span>
            </div>
          </div>
        </div>

        <details className="mt-4 rounded-lg border border-border-dark bg-surface-dark p-3">
          <summary className="cursor-pointer text-xs font-medium text-text-muted hover:text-text-dark">
            默认额外参数 JSON
          </summary>
          <div className="mt-2 flex items-start gap-2 text-[11px] leading-5 text-text-muted">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
            <span>仅填写供应商文档明确要求的额外字段。prompt、model、seconds、size、input_reference 会由后续视频调用层单独组装。</span>
          </div>
          <textarea
            value={defaultParamsText}
            onChange={(event) => setDefaultParamsText(event.target.value)}
            className="ui-scrollbar mt-2 h-[110px] w-full resize-none rounded-md border border-border-dark bg-bg-dark px-3 py-2 font-mono text-[11px] leading-5 text-text-dark outline-none focus:border-accent"
            spellCheck={false}
          />
          {!parsedDefaultParams.ok && (
            <div className="mt-1 text-[10px] text-red-300">{parsedDefaultParams.error}</div>
          )}
        </details>

        <details className="mt-4 rounded-lg border border-border-dark bg-surface-dark p-3">
          <summary className="cursor-pointer text-xs font-medium text-text-muted hover:text-text-dark">
            模板说明 / 轮询字段
          </summary>
          <p className="mt-2 text-[11px] leading-5 text-text-muted">{providerNote}</p>
          <textarea
            key={providerNote}
            defaultValue={stringifyJsonObject(templateExtraParams)}
            onBlur={(event) => {
              const parsed = parseJsonObject(event.target.value);
              if (parsed.ok) {
                setTemplateExtraParams(parsed.value);
              }
            }}
            className="ui-scrollbar mt-2 h-[120px] w-full resize-none rounded-md border border-border-dark bg-bg-dark px-3 py-2 font-mono text-[11px] leading-5 text-text-dark outline-none focus:border-accent"
            spellCheck={false}
          />
        </details>

        <div className="mt-4 flex justify-end gap-2 border-t border-border-dark pt-3">
          {savedFlash && (
            <span className="mr-auto inline-flex items-center gap-1 text-xs text-emerald-300">
              <CheckCircle2 className="h-3.5 w-3.5" /> 已保存到我的配置
            </span>
          )}
          <button
            type="button"
            onClick={handleSave}
            disabled={!label.trim() || !baseUrl.trim() || models.length === 0 || !parsedDefaultParams.ok}
            className="inline-flex h-9 items-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
          >
            <Save className="h-4 w-4" />
            {editingId ? '保存视频配置' : '保存新视频供应商'}
          </button>
        </div>
      </div>
    </div>
  );
});
