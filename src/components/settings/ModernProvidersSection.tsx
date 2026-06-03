import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Image,
  Loader2,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
} from 'lucide-react';

import {
  useCustomProvidersStore,
  type CustomProviderConfig,
} from '@/stores/customProvidersStore';
import {
  fetchCustomProviderModels,
  type CustomProviderModelListResult,
} from '@/features/canvas/infrastructure/customProviderGateway';

type ModernProviderKind =
  | 'openai-images'
  | 'openai-responses'
  | 'google-gemini'
  | 'stability'
  | 'midjourney'
  | 'fal'
  | 'replicate';

interface ModernProviderTemplate {
  kind: ModernProviderKind;
  title: string;
  subtitle: string;
  defaultLabel: string;
  defaultBaseUrl: string;
  endpointPath: string;
  modelListEndpointPath: string;
  apiStyle: string;
  responseFormat: CustomProviderConfig['responseFormat'];
  models: string[];
  modelDescriptions?: Record<string, string>;
  supportedRatios: string[];
  supportedResolutions: string[];
  supportedModelVersions?: string[];
  supportsWebSearch?: boolean;
  note: string;
  defaultRequestParams?: Record<string, unknown>;
  responseImagePath?: string;
}

const COMMON_RATIOS = [
  'auto',
  '1:1',
  '16:9',
  '9:16',
  '4:3',
  '3:4',
  '3:2',
  '2:3',
  '21:9',
  '2:1',
  '4:1',
];

const TIER_RESOLUTIONS = ['1k', '2k', '4k'];

const GEMINI_RATIOS = [
  'auto',
  '1:1',
  '16:9',
  '9:16',
  '4:3',
  '3:4',
  '3:2',
  '2:3',
  '4:5',
  '5:4',
  '21:9',
  '2:1',
  '4:1',
  '1:4',
  '8:1',
];

const OPENAI_PIXEL_SIZES = [
  'auto',
  ...TIER_RESOLUTIONS,
  '1024x1024',
  '1536x1024',
  '1024x1536',
  '2048x2048',
  '2048x1152',
  '1152x2048',
  '3840x2160',
  '2160x3840',
  '4096x1024',
  '1024x4096',
];

const MODERN_PROVIDER_TEMPLATES: ModernProviderTemplate[] = [
  {
    kind: 'openai-images',
    title: 'OpenAI Images 兼容',
    subtitle: '官方 Images API 与大多数中转站，推荐优先使用',
    defaultLabel: 'OpenAI Images 兼容',
    defaultBaseUrl: 'https://api.example.com',
    endpointPath: '/v1/images/generations',
    modelListEndpointPath: '/v1/models',
    apiStyle: 'openai-compatible',
    responseFormat: 'openai-images',
    models: [
      'gpt-image-2',
      'codex-gpt-image-2',
      'gpt-image-1.5',
      'chatgpt-image-latest',
      'gpt-image-1',
      'gpt-image-1-mini',
      'openai/gpt-image-2',
      'openai/gpt-image-1.5',
      'openai/gpt-image-1',
      'dall-e-3',
      'dall-e-2',
      'google/gemini-3-pro-image-preview',
      'google/gemini-2.5-flash-image',
      'google/gemini-3.1-flash-image',
      'gemini-2.5-flash-image-preview',
      'gemini-3.1-flash-image',
      'nano-banana-pro',
      'nano-banana-2',
      'nano-banana',
      'midjourney-v7',
      'midjourney-v6.1',
      'flux-pro/kontext-max',
    ],
    modelDescriptions: {
      'gpt-image-2': '推荐默认：新一代 GPT 图像生成/编辑模型；中转站常见别名',
      'codex-gpt-image-2': '部分中转站常见 GPT 图像别名',
      'gpt-image-1.5': 'OpenAI Images 常见新模型别名',
      'chatgpt-image-latest': 'ChatGPT 图像模型兼容别名',
      'gpt-image-1': 'OpenAI Images 旧一代稳定模型',
      'nano-banana-pro': 'Google 高质量图像模型常见别名',
      'nano-banana-2': 'Google 新一代图像模型常见别名',
      'midjourney-v7': 'Midjourney 兼容代理常见模型名',
    },
    supportedRatios: COMMON_RATIOS,
    supportedResolutions: OPENAI_PIXEL_SIZES,
    defaultRequestParams: {
      quality: 'auto',
      output_format: 'png',
    },
    note: '新接入会按 Images API 发送 model、prompt、size、n、quality、output_format；不会把 aspect_ratio、resolutionType 等内部字段发给上游。Base URL 只填基础域名即可，/v1 已写在路径里；gpt-image-2 / codex-gpt-image-2 等以你的供应商实际支持为准。',
  },
  {
    kind: 'openai-responses',
    title: 'OpenAI Responses 图像工具',
    subtitle: 'Responses API + image_generation 工具，适合支持工具调用的模型',
    defaultLabel: 'OpenAI Responses 图像工具',
    defaultBaseUrl: 'https://api.example.com',
    endpointPath: '/v1/responses',
    modelListEndpointPath: '/v1/models',
    apiStyle: 'openai-compatible',
    responseFormat: 'generic',
    models: [
      'gpt-5.1',
      'gpt-5',
      'gpt-4.1',
      'gpt-4.1-mini',
      'gpt-4o',
    ],
    modelDescriptions: {
      'gpt-5.1': '推荐默认文本控制模型；用于调用 image_generation 工具',
      'gpt-5': '高能力文本控制模型',
      'gpt-4.1': '稳定的 Responses 工具调用模型',
      'gpt-4.1-mini': '轻量工具调用模型',
    },
    supportedRatios: COMMON_RATIOS,
    supportedResolutions: OPENAI_PIXEL_SIZES,
    defaultRequestParams: {
      image_generation_model: 'gpt-image-2',
      output_format: 'png',
      quality: 'auto',
    },
    responseImagePath: 'output[0].result',
    note: '用于 /responses 路线；文本模型负责调用 image_generation 工具，图片模型默认可在高级参数里调整。',
  },
  {
    kind: 'google-gemini',
    title: 'Google Gemini / Nano Banana',
    subtitle: 'Gemini generateContent 直连，适合官方 Gemini API 或兼容代理',
    defaultLabel: 'Google Gemini 图像',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    endpointPath: '/v1beta/models/{model}:generateContent',
    modelListEndpointPath: '/v1beta/models',
    apiStyle: 'google-gemini',
    responseFormat: 'generic',
    models: [
      'nano-banana-pro',
      'nano-banana-2',
      'nano-banana',
      'gemini-3-pro-image-preview',
      'gemini-3-pro-image',
      'gemini-3.1-flash-image',
      'gemini-3.1-flash-image-preview',
      'gemini-2.5-flash-image-preview',
      'gemini-2.5-flash-image',
      'imagen-4.0-ultra-generate-001',
      'imagen-4.0-generate-001',
      'imagen-4.0-fast-generate-001',
      'imagen-3.0-generate-002',
    ],
    modelDescriptions: {
      'nano-banana-pro': '推荐默认：高质量 Gemini 图像模型常见别名',
      'nano-banana-2': '新一代 Gemini 图像模型常见别名',
      'nano-banana': 'Gemini 图像生成/编辑常见别名',
      'gemini-3-pro-image-preview': 'Gemini Pro 图像预览模型常见别名',
      'gemini-3.1-flash-image': 'Gemini Flash 图像模型常见别名',
      'gemini-2.5-flash-image-preview': 'Gemini 2.5 Flash 图像预览模型',
      'imagen-4.0-ultra-generate-001': 'Imagen 4 高质量生成模型',
      'imagen-4.0-fast-generate-001': 'Imagen 4 快速生成模型',
    },
    supportedRatios: GEMINI_RATIOS,
    supportedResolutions: ['auto', '512', ...TIER_RESOLUTIONS, '1024x1024', '1536x1024', '1024x1536', '2048x2048'],
    responseImagePath: 'candidates[0].content.parts[0].inline_data.data',
    note: '直连 Gemini 时会使用 x-goog-api-key，并按 generateContent 组装 contents；如果你的站点已做 OpenAI 兼容，建议选 OpenAI Images 兼容。',
  },
  {
    kind: 'stability',
    title: 'Stability AI',
    subtitle: 'Stable Image / SD3 常见 multipart 路线',
    defaultLabel: 'Stability AI',
    defaultBaseUrl: 'https://api.stability.ai',
    endpointPath: '/v2beta/stable-image/generate/core',
    modelListEndpointPath: '',
    apiStyle: 'stability',
    responseFormat: 'data-url',
    models: [
      'stable-image-ultra',
      'stable-image-core',
      'sd3.5-large',
      'sd3.5-large-turbo',
      'sd3-large',
      'sd3-medium',
      'sdxl',
    ],
    modelDescriptions: {
      'stable-image-ultra': '推荐默认：Stability 高质量图像生成路线',
      'stable-image-core': 'Stability 常用核心图像生成路线',
      'sd3.5-large': 'Stable Diffusion 3.5 Large',
      'sd3.5-large-turbo': 'Stable Diffusion 3.5 快速版本',
      'sd3-large': 'Stable Diffusion 3 Large',
    },
    supportedRatios: ['auto', '1:1', '16:9', '9:16', '3:2', '2:3', '4:5', '5:4'],
    supportedResolutions: ['auto', ...TIER_RESOLUTIONS],
    note: '适合 Stability 官方常见接口；如遇签名或二进制返回限制，建议走代理后再用 OpenAI 兼容路线。',
  },
  {
    kind: 'midjourney',
    title: 'Midjourney / 兼容代理',
    subtitle: '适合把 Midjourney 包装成 OpenAI Images 风格的中转站',
    defaultLabel: 'Midjourney 兼容代理',
    defaultBaseUrl: 'https://api.example.com',
    endpointPath: '/v1/images/generations',
    modelListEndpointPath: '/v1/models',
    apiStyle: 'openai-compatible',
    responseFormat: 'openai-images',
    models: [
      'midjourney-v7',
      'midjourney-v6.1',
      'midjourney-v6',
      'midjourney-niji-6',
      'mj-v7',
      'mj-v6.1',
      'niji-6',
    ],
    modelDescriptions: {
      'midjourney-v7': '推荐默认：Midjourney 兼容代理常见最新别名',
      'midjourney-v6.1': 'Midjourney 兼容代理常见稳定别名',
      'midjourney-niji-6': 'Niji 风格兼容代理常见别名',
    },
    supportedRatios: COMMON_RATIOS,
    supportedResolutions: ['auto', ...TIER_RESOLUTIONS, '1024x1024', '1344x768', '768x1344', '2048x2048'],
    defaultRequestParams: {
      quality: 'auto',
      output_format: 'png',
    },
    note: 'Midjourney 没有统一的公开官方 Images API；这里按中转站/代理常见的 OpenAI Images 兼容方式接入。若你的代理文档要求 task/imagine/upscale 等特殊路由，请改用老供应商。',
  },
  {
    kind: 'fal',
    title: 'Fal.ai / 模型端点',
    subtitle: '每个模型一个 endpoint，适合 Flux、Qwen Image 等',
    defaultLabel: 'Fal.ai 图像',
    defaultBaseUrl: 'https://fal.run',
    endpointPath: '',
    modelListEndpointPath: '',
    apiStyle: 'fal',
    responseFormat: 'generic',
    models: [
      'fal-ai/flux-pro/kontext/max',
      'fal-ai/flux-pro/kontext',
      'fal-ai/flux-kontext-pro',
      'fal-ai/qwen-image',
      'fal-ai/qwen-image-edit',
      'fal-ai/imagen4/preview',
      'fal-ai/flux/dev',
      'fal-ai/flux/schnell',
      'fal-ai/flux-pro/v1.1',
      'fal-ai/recraft/v3',
      'fal-ai/nano-banana/edit',
    ],
    modelDescriptions: {
      'fal-ai/flux-pro/kontext/max': '推荐默认：Flux Kontext 高质量图像编辑/生成',
      'fal-ai/flux-pro/kontext': 'Flux Kontext 常用版本',
      'fal-ai/qwen-image': 'Qwen Image 文生图',
      'fal-ai/qwen-image-edit': 'Qwen Image 图像编辑',
      'fal-ai/imagen4/preview': 'Imagen 4 预览路线',
    },
    supportedRatios: COMMON_RATIOS,
    supportedResolutions: ['auto', ...TIER_RESOLUTIONS, '1024x1024', '1536x1024', '1024x1536', '2048x2048'],
    note: 'Fal 模型差异较大；常规模型可直接用，复杂队列模型建议复制到老配置里精修轮询字段。',
  },
  {
    kind: 'replicate',
    title: 'Replicate / Prediction',
    subtitle: 'Prediction 创建与轮询路线，适合社区模型',
    defaultLabel: 'Replicate 图像',
    defaultBaseUrl: 'https://api.replicate.com/v1',
    endpointPath: '/predictions',
    modelListEndpointPath: '',
    apiStyle: 'generic-json',
    responseFormat: 'generic',
    models: [
      'black-forest-labs/flux-kontext-pro',
      'black-forest-labs/flux-1.1-pro',
      'black-forest-labs/flux-dev',
      'black-forest-labs/flux-schnell',
      'google/imagen-4',
      'stability-ai/stable-diffusion-3.5-large',
      'stability-ai/stable-diffusion-3.5-large-turbo',
      'bytedance/sdxl-lightning-4step',
    ],
    modelDescriptions: {
      'black-forest-labs/flux-kontext-pro': '推荐默认：Flux Kontext Pro',
      'black-forest-labs/flux-1.1-pro': 'Flux 1.1 Pro',
      'google/imagen-4': 'Imagen 4 Replicate 路线',
      'stability-ai/stable-diffusion-3.5-large': 'SD 3.5 Large Replicate 路线',
    },
    supportedRatios: COMMON_RATIOS,
    supportedResolutions: ['auto', ...TIER_RESOLUTIONS, '1024x1024', '1536x1024', '1024x1536'],
    defaultRequestParams: {
      input: {},
    },
    note: 'Replicate 模型字段和版本差异很大，新配置只记录常见模型；复杂版本号/轮询建议用老配置精修。',
  },
];

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  values.forEach((value) => {
    const text = value.trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    result.push(text);
  });
  return result;
}

function generateProviderId(): string {
  return `cp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function isModernProvider(provider: CustomProviderConfig | null | undefined): boolean {
  return provider?.extraParams?.providerConfigVersion === 'new-v1';
}

function templateForKind(kind: ModernProviderKind): ModernProviderTemplate {
  return MODERN_PROVIDER_TEMPLATES.find((item) => item.kind === kind) ?? MODERN_PROVIDER_TEMPLATES[0];
}

function normalizeModelInput(value: string): string[] {
  return uniqueStrings(value.split(/[\n,，\s]+/).map((item) => item.trim()));
}

function normalizeEndpointPath(value: string): string {
  const text = value.trim();
  if (!text) return '';
  return text.startsWith('/') ? text : `/${text}`;
}

function normalizeBaseUrlInput(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function stripDuplicateApiVersion(baseUrl: string, paths: string[]): string {
  const match = baseUrl.match(/\/(v\d+(?:beta\d*)?|v\d+beta|v1beta)$/i);
  if (!match) return baseUrl;
  const versionSegment = match[1].toLowerCase();
  const hasDuplicatePath = paths.some((path) => {
    const normalizedPath = normalizeEndpointPath(path).toLowerCase();
    return normalizedPath === `/${versionSegment}`
      || normalizedPath.startsWith(`/${versionSegment}/`);
  });
  if (!hasDuplicatePath) return baseUrl;
  return baseUrl.slice(0, -(match[1].length + 1));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function formatJsonObject(value: Record<string, unknown> | undefined): string {
  return JSON.stringify(value ?? {}, null, 2);
}

function parseJsonObject(text: string): {
  ok: boolean;
  value: Record<string, unknown>;
  error?: string;
} {
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: true, value: {} };
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isPlainRecord(parsed)) {
      return { ok: false, value: {}, error: '默认请求参数必须是 JSON 对象，例如 { "quality": "auto" }' };
    }
    return { ok: true, value: parsed };
  } catch (error) {
    return {
      ok: false,
      value: {},
      error: error instanceof Error ? error.message : 'JSON 格式不正确',
    };
  }
}

function parseParameterValue(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    return '';
  }
  if (/^(true|false|null)$/i.test(trimmed) || /^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    return JSON.parse(trimmed.toLowerCase());
  }
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function displayChoiceLabel(value: string): string {
  if (value === 'auto') return '智能';
  return value;
}

function displayResolutionLabel(value: string): string {
  if (value === 'auto') return '自动';
  return value;
}

export const ModernProvidersSection = memo(function ModernProvidersSection() {
  const providers = useCustomProvidersStore((state) => state.providers);
  const pendingEditId = useCustomProvidersStore((state) => state.pendingEditId);
  const addProvider = useCustomProvidersStore((state) => state.addProvider);
  const updateProvider = useCustomProvidersStore((state) => state.updateProvider);
  const setPendingEditId = useCustomProvidersStore((state) => state.setPendingEditId);

  const [kind, setKind] = useState<ModernProviderKind>('openai-images');
  const template = useMemo(() => templateForKind(kind), [kind]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [label, setLabel] = useState(template.defaultLabel);
  const [baseUrl, setBaseUrl] = useState(template.defaultBaseUrl);
  const [apiKey, setApiKey] = useState('');
  const [modelListEndpointPath, setModelListEndpointPath] = useState(template.modelListEndpointPath);
  const [endpointPath, setEndpointPath] = useState(template.endpointPath);
  const [modelInput, setModelInput] = useState(template.models.join('\n'));
  const [selectedModels, setSelectedModels] = useState<string[]>(template.models.slice(0, 4));
  const [customModelName, setCustomModelName] = useState('');
  const [customModelDescription, setCustomModelDescription] = useState('');
  const [modelDescriptions, setModelDescriptions] = useState<Record<string, string>>(template.modelDescriptions ?? {});
  const [hiddenModelOptions, setHiddenModelOptions] = useState<string[]>([]);
  const [selectedRatios, setSelectedRatios] = useState<string[]>(template.supportedRatios);
  const [selectedResolutions, setSelectedResolutions] = useState<string[]>(template.supportedResolutions);
  const [customRatio, setCustomRatio] = useState('');
  const [customResolution, setCustomResolution] = useState('');
  const [defaultRequestParamsText, setDefaultRequestParamsText] = useState(
    formatJsonObject(template.defaultRequestParams)
  );
  const [customParamKey, setCustomParamKey] = useState('');
  const [customParamValue, setCustomParamValue] = useState('');
  const [fetchResult, setFetchResult] = useState<CustomProviderModelListResult | null>(null);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const parsedDefaultRequestParams = useMemo(
    () => parseJsonObject(defaultRequestParamsText),
    [defaultRequestParamsText]
  );

  useEffect(() => {
    if (editingId) return;
    setLabel(template.defaultLabel);
    setBaseUrl(template.defaultBaseUrl);
    setEndpointPath(template.endpointPath);
    setModelListEndpointPath(template.modelListEndpointPath);
    setModelInput(template.models.join('\n'));
    setSelectedModels(template.models.slice(0, 4));
    setCustomModelName('');
    setCustomModelDescription('');
    setModelDescriptions(template.modelDescriptions ?? {});
    setHiddenModelOptions([]);
    setSelectedRatios(template.supportedRatios);
    setSelectedResolutions(template.supportedResolutions);
    setCustomRatio('');
    setCustomResolution('');
    setDefaultRequestParamsText(formatJsonObject(template.defaultRequestParams));
    setCustomParamKey('');
    setCustomParamValue('');
    setFetchResult(null);
  }, [editingId, template]);

  useEffect(() => {
    if (!pendingEditId) return;
    const provider = providers.find((item) => item.id === pendingEditId);
    if (!provider || !isModernProvider(provider)) return;
    const nextKind = String(provider.extraParams?.providerKind ?? 'openai-images') as ModernProviderKind;
    const nextTemplate = templateForKind(nextKind);
    setKind(nextTemplate.kind);
    setEditingId(provider.id);
    setLabel(provider.label);
    setBaseUrl(provider.baseUrl);
    setApiKey(provider.apiKey);
    setEndpointPath(provider.endpointPath ?? nextTemplate.endpointPath);
    setModelListEndpointPath(provider.modelListEndpointPath ?? nextTemplate.modelListEndpointPath);
    setModelInput(provider.models.join('\n'));
    setSelectedModels(provider.models);
    const storedDescriptions = provider.extraParams?.modelDescriptions;
    setModelDescriptions(
      storedDescriptions && typeof storedDescriptions === 'object' && !Array.isArray(storedDescriptions)
        ? { ...(nextTemplate.modelDescriptions ?? {}), ...(storedDescriptions as Record<string, string>) }
        : nextTemplate.modelDescriptions ?? {}
    );
    const storedHiddenModels = provider.extraParams?.hiddenModelOptions;
    setHiddenModelOptions(
      Array.isArray(storedHiddenModels)
        ? storedHiddenModels.filter((item): item is string => typeof item === 'string')
        : []
    );
    const storedRatios = provider.extraParams?.supportedRatios;
    setSelectedRatios(
      Array.isArray(storedRatios)
        ? uniqueStrings(storedRatios.map((item) => String(item)))
        : nextTemplate.supportedRatios
    );
    setSelectedResolutions(
      provider.supportedResolutions && provider.supportedResolutions.length > 0
        ? uniqueStrings(provider.supportedResolutions.map((item) => String(item)))
        : nextTemplate.supportedResolutions
    );
    const storedDefaultRequestParams = provider.extraParams?.defaultRequestParams;
    setDefaultRequestParamsText(formatJsonObject(
      isPlainRecord(storedDefaultRequestParams)
        ? storedDefaultRequestParams
        : nextTemplate.defaultRequestParams
    ));
    setCustomModelName('');
    setCustomModelDescription('');
    setCustomRatio('');
    setCustomResolution('');
    setCustomParamKey('');
    setCustomParamValue('');
    setFetchResult(null);
    setPendingEditId(null);
  }, [pendingEditId, providers, setPendingEditId]);

  const modelOptions = useMemo(() => {
    return uniqueStrings([
      ...normalizeModelInput(modelInput),
      ...template.models,
      ...selectedModels,
      ...(fetchResult?.models ?? []),
    ]).filter((model) => !hiddenModelOptions.includes(model));
  }, [fetchResult?.models, hiddenModelOptions, modelInput, selectedModels, template.models]);

  const buildConfig = useCallback((models: string[]): CustomProviderConfig => {
    const cleanModels = uniqueStrings(models);
    const normalizedEndpointPath = normalizeEndpointPath(endpointPath);
    const normalizedModelListEndpointPath = normalizeEndpointPath(modelListEndpointPath);
    const normalizedBaseUrl = stripDuplicateApiVersion(
      normalizeBaseUrlInput(baseUrl),
      [normalizedEndpointPath, normalizedModelListEndpointPath]
    );
    const isOpenAiImagesLike = template.kind === 'openai-images' || template.kind === 'midjourney';
    const inferredImageEditPath = normalizedEndpointPath
      ? normalizedEndpointPath.replace(/\/images\/generations\b/i, '/images/edits')
      : '';
    return {
      id: editingId ?? generateProviderId(),
      label: label.trim() || template.defaultLabel,
      mediaType: 'image',
      baseUrl: normalizedBaseUrl,
      endpointPath: normalizedEndpointPath,
      modelListEndpointPath: normalizedModelListEndpointPath,
      httpMethod: 'POST',
      apiKey,
      apiStyle: template.apiStyle,
      models: cleanModels.length > 0 ? cleanModels : template.models,
      supportsWebSearch: Boolean(template.supportsWebSearch),
      extraHeaders: {},
      queryParams: {},
      responseFormat: template.responseFormat,
      supportedResolutions: selectedResolutions,
      supportedModelVersions: template.supportedModelVersions,
      extraParams: {
        providerConfigVersion: 'new-v1',
        mediaType: 'image',
        providerKind: template.kind,
        requestComposer: 'modern',
        supportedRatios: selectedRatios,
        imageGenerationEndpointPath: isOpenAiImagesLike
          ? normalizedEndpointPath
          : undefined,
        imageEditEndpointPath: isOpenAiImagesLike
          ? inferredImageEditPath
          : undefined,
        defaultRequestParams: parsedDefaultRequestParams.ok
          ? parsedDefaultRequestParams.value
          : (template.defaultRequestParams ?? {}),
        modelDescriptions,
        hiddenModelOptions,
        responseImagePath: template.responseImagePath,
      },
      note: template.note,
    };
  }, [
    apiKey,
    baseUrl,
    editingId,
    endpointPath,
    label,
    modelListEndpointPath,
    modelDescriptions,
    hiddenModelOptions,
    parsedDefaultRequestParams,
    selectedRatios,
    selectedResolutions,
    template,
  ]);

  const handleFetchModels = useCallback(async () => {
    setFetchingModels(true);
    setFetchResult(null);
    try {
      const result = await fetchCustomProviderModels(buildConfig(selectedModels));
      setFetchResult(result);
      if (result.ok && result.models.length > 0) {
        const nextModels = uniqueStrings([...selectedModels, ...result.models]);
        setSelectedModels(nextModels.slice(0, 12));
        setModelInput(uniqueStrings([...normalizeModelInput(modelInput), ...result.models]).join('\n'));
        setHiddenModelOptions((current) => current.filter((model) => !result.models.includes(model)));
      }
    } finally {
      setFetchingModels(false);
    }
  }, [buildConfig, modelInput, selectedModels]);

  const handleToggleModel = useCallback((model: string) => {
    setSelectedModels((current) => current.includes(model)
      ? current.filter((item) => item !== model)
      : [...current, model]);
  }, []);

  const handleAddCustomModel = useCallback(() => {
    const nextModel = customModelName.trim();
    if (!nextModel) return;
    const nextDescription = customModelDescription.trim();
    setModelInput((current) => uniqueStrings([...normalizeModelInput(current), nextModel]).join('\n'));
    setSelectedModels((current) => current.includes(nextModel) ? current : [...current, nextModel]);
    setHiddenModelOptions((current) => current.filter((model) => model !== nextModel));
    if (nextDescription) {
      setModelDescriptions((current) => ({ ...current, [nextModel]: nextDescription }));
    }
    setCustomModelName('');
    setCustomModelDescription('');
  }, [customModelDescription, customModelName]);

  const handleHideModelOption = useCallback((model: string) => {
    setSelectedModels((current) => current.filter((item) => item !== model));
    setHiddenModelOptions((current) => current.includes(model) ? current : [...current, model]);
  }, []);

  const handleToggleRatio = useCallback((ratio: string) => {
    setSelectedRatios((current) => current.includes(ratio)
      ? current.filter((item) => item !== ratio)
      : [...current, ratio]);
  }, []);

  const handleAddCustomRatio = useCallback(() => {
    const ratio = customRatio.trim();
    if (!/^\d+:\d+$/.test(ratio)) return;
    setSelectedRatios((current) => current.includes(ratio) ? current : [...current, ratio]);
    setCustomRatio('');
  }, [customRatio]);

  const handleRemoveRatio = useCallback((ratio: string) => {
    setSelectedRatios((current) => current.filter((item) => item !== ratio));
  }, []);

  const handleToggleResolution = useCallback((resolution: string) => {
    setSelectedResolutions((current) => current.includes(resolution)
      ? current.filter((item) => item !== resolution)
      : [...current, resolution]);
  }, []);

  const handleAddCustomResolution = useCallback(() => {
    const resolution = customResolution.trim();
    if (!resolution) return;
    setSelectedResolutions((current) => current.includes(resolution) ? current : [...current, resolution]);
    setCustomResolution('');
  }, [customResolution]);

  const handleRemoveResolution = useCallback((resolution: string) => {
    setSelectedResolutions((current) => current.filter((item) => item !== resolution));
  }, []);

  const handleAddCustomParam = useCallback(() => {
    const key = customParamKey.trim();
    if (!key) return;
    const base = parsedDefaultRequestParams.ok
      ? parsedDefaultRequestParams.value
      : (template.defaultRequestParams ?? {});
    setDefaultRequestParamsText(formatJsonObject({
      ...base,
      [key]: parseParameterValue(customParamValue),
    }));
    setCustomParamKey('');
    setCustomParamValue('');
  }, [customParamKey, customParamValue, parsedDefaultRequestParams, template.defaultRequestParams]);

  const handleSave = useCallback(() => {
    const manualModels = normalizeModelInput(modelInput);
    const models = selectedModels.length > 0 ? selectedModels : manualModels;
    if (!baseUrl.trim() || models.length === 0 || !parsedDefaultRequestParams.ok) return;
    const config = buildConfig(models);
    if (editingId) {
      updateProvider(editingId, config);
    } else {
      addProvider(config);
    }
    setEditingId(null);
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1600);
  }, [addProvider, baseUrl, buildConfig, editingId, modelInput, parsedDefaultRequestParams.ok, selectedModels, updateProvider]);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold text-text-dark">图片生成（新）</h2>
        <p className="mt-1 text-xs leading-5 text-text-muted">
          推荐使用这个入口：选择接口类型，填写 Base URL 和 API Key，再同步或勾选模型。应用会根据模型类型自动组装请求，不再让主流接口手写整段 JSON。
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {MODERN_PROVIDER_TEMPLATES.map((item) => (
          <button
            key={item.kind}
            type="button"
            onClick={() => {
              setEditingId(null);
              setKind(item.kind);
            }}
            className={`rounded-lg border p-3 text-left transition-colors ${
              kind === item.kind
                ? 'border-accent bg-accent/12'
                : 'border-border-dark bg-bg-dark hover:border-accent/45'
            }`}
          >
            <div className="flex items-center gap-2">
              {item.kind === 'openai-images' ? <Sparkles className="h-4 w-4 text-accent" /> : <Image className="h-4 w-4 text-text-muted" />}
              <span className="text-sm font-medium text-text-dark">{item.title}</span>
            </div>
            <div className="mt-1 text-[11px] leading-4 text-text-muted">{item.subtitle}</div>
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
              placeholder="例如：我的 OpenAI 兼容站"
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
              placeholder={template.defaultBaseUrl}
            />
            <span className="block text-[10px] leading-4 text-text-muted">
              例如 https://api.example.com，/v1 由下面的接口路径负责；误填 /v1 也会自动去重。
            </span>
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-text-muted">模型列表路径</span>
            <input
              value={modelListEndpointPath}
              onChange={(event) => setModelListEndpointPath(event.target.value)}
              className="h-9 w-full rounded-md border border-border-dark bg-surface-dark px-3 text-sm text-text-dark outline-none focus:border-accent"
              placeholder={template.modelListEndpointPath || '/v1/models'}
            />
          </label>
          <label className="col-span-2 space-y-1.5">
            <span className="text-xs font-medium text-text-muted">生图接口路径</span>
            <input
              value={endpointPath}
              onChange={(event) => setEndpointPath(event.target.value)}
              className="h-9 w-full rounded-md border border-border-dark bg-surface-dark px-3 text-sm text-text-dark outline-none focus:border-accent"
              placeholder={template.endpointPath || '留空表示使用 Base URL 本身'}
            />
          </label>
        </div>

        <div className="mt-4 grid grid-cols-[1fr_220px] gap-3">
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-text-muted">模型记录</span>
            <textarea
              value={modelInput}
              onChange={(event) => setModelInput(event.target.value)}
              className="ui-scrollbar h-[150px] w-full resize-none rounded-md border border-border-dark bg-surface-dark px-3 py-2 text-xs leading-5 text-text-dark outline-none focus:border-accent"
              placeholder="每行一个模型 ID"
            />
          </label>
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => { void handleFetchModels(); }}
              disabled={fetchingModels || !baseUrl.trim() || !apiKey.trim()}
              className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-md border border-border-dark bg-surface-dark px-3 text-xs text-text-dark hover:border-accent/50 disabled:opacity-50"
            >
              {fetchingModels ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              同步模型
            </button>
            <div className="rounded-md border border-border-dark bg-surface-dark p-2 text-[11px] leading-5 text-text-muted">
              <div className="font-medium text-text-dark">当前请求形态</div>
              <div>类型：{template.title}</div>
              <div>接口：{endpointPath || '(Base URL)'}</div>
              <div>解析：{template.responseFormat}</div>
            </div>
            {fetchResult && (
              <div className={`rounded-md border p-2 text-[11px] leading-5 ${
                fetchResult.ok
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
                  : 'border-red-500/30 bg-red-500/10 text-red-200'
              }`}>
                {fetchResult.ok ? `同步到 ${fetchResult.models.length} 个模型` : fetchResult.errorMessage}
              </div>
            )}
          </div>
        </div>

        <div className="mt-4 rounded-lg border border-border-dark bg-surface-dark p-3">
          <div className="mb-2 text-xs font-medium text-text-muted">新增 / 编辑自定义模型</div>
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_auto] gap-2">
            <input
              value={customModelName}
              onChange={(event) => setCustomModelName(event.target.value)}
              className="h-9 rounded-md border border-border-dark bg-bg-dark px-3 text-xs font-mono text-text-dark outline-none focus:border-accent"
              placeholder="模型 ID，例如 gpt-image-2"
            />
            <input
              value={customModelDescription}
              onChange={(event) => setCustomModelDescription(event.target.value)}
              className="h-9 rounded-md border border-border-dark bg-bg-dark px-3 text-xs text-text-dark outline-none focus:border-accent"
              placeholder="描述，例如 默认生图模型 / 适合图生图"
            />
            <button
              type="button"
              onClick={handleAddCustomModel}
              disabled={!customModelName.trim()}
              className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-accent px-3 text-xs font-medium text-white hover:bg-accent/90 disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" />
              添加模型
            </button>
          </div>
          <div className="mt-2 text-[11px] leading-5 text-text-muted">
            不同中转站的模型名可能不同，直接把供应商文档里的 model ID 加到这里即可。
          </div>
        </div>

        <div className="mt-4">
          <div className="mb-2 text-xs font-medium text-text-muted">勾选要显示到画布里的模型</div>
          <div className="ui-scrollbar max-h-[190px] overflow-y-auto rounded-lg border border-border-dark bg-surface-dark p-2">
            <div className="grid grid-cols-2 gap-1.5">
              {modelOptions.map((model) => {
                const checked = selectedModels.includes(model);
                const description = modelDescriptions[model] ?? '';
                return (
                  <div
                    key={model}
                    className={`group flex min-w-0 items-stretch overflow-hidden rounded-md border text-left text-[11px] transition-colors ${
                      checked
                        ? 'border-accent bg-accent/18 text-text-dark'
                        : 'border-border-dark bg-bg-dark text-text-muted hover:border-accent/40 hover:text-text-dark'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => handleToggleModel(model)}
                      className="flex min-w-0 flex-1 items-start gap-2 px-2 py-1.5 text-left"
                      title={description ? `${model}\n${description}` : model}
                    >
                      <span className={`mt-0.5 h-3 w-3 shrink-0 rounded border ${checked ? 'border-accent bg-accent' : 'border-border-dark'}`} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-mono">{model}</span>
                        {description && (
                          <span className="mt-0.5 block truncate text-[10px] text-text-muted">
                            {description}
                          </span>
                        )}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleHideModelOption(model)}
                      className="flex w-8 shrink-0 items-center justify-center border-l border-border-dark text-text-muted opacity-0 transition-opacity hover:bg-red-500/10 hover:text-red-300 group-hover:opacity-100"
                      title="隐藏这个模型"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="mt-4 rounded-lg border border-border-dark bg-surface-dark p-3">
          <div className="space-y-1">
            <div className="text-xs font-medium text-text-muted">
              支持的生图比例（多选。含「智能」= 服务端自动决定，可用 + 增加自定义比例）
            </div>
            <div className="flex flex-wrap gap-1.5">
              {template.supportedRatios.map((ratio) => {
                const checked = selectedRatios.includes(ratio);
                return (
                  <button
                    key={ratio}
                    type="button"
                    onClick={() => handleToggleRatio(ratio)}
                    className={`inline-flex h-8 items-center rounded-md border px-3 text-xs transition-colors ${
                      checked
                        ? 'border-accent bg-accent/18 text-accent'
                        : 'border-border-dark bg-bg-dark text-text-muted hover:border-accent/45 hover:text-text-dark'
                    }`}
                  >
                    {displayChoiceLabel(ratio)}
                  </button>
                );
              })}
              {selectedRatios
                .filter((ratio) => !template.supportedRatios.includes(ratio))
                .map((ratio) => (
                  <span
                    key={ratio}
                    className="inline-flex h-8 items-center gap-1 rounded-md border border-accent/45 bg-accent/14 pl-3 pr-1 text-xs text-accent"
                  >
                    {ratio}
                    <button
                      type="button"
                      onClick={() => handleRemoveRatio(ratio)}
                      className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-red-500/12 hover:text-red-300"
                      title="删除自定义比例"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              <span className="inline-flex h-8 items-center gap-1 rounded-md border border-dashed border-border-dark bg-bg-dark px-2">
                <Plus className="h-3.5 w-3.5 text-text-muted" />
                <input
                  value={customRatio}
                  onChange={(event) => setCustomRatio(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      handleAddCustomRatio();
                    }
                  }}
                  className="h-6 w-16 bg-transparent text-xs text-text-dark outline-none placeholder:text-text-muted"
                  placeholder="自定义"
                />
                <button
                  type="button"
                  onClick={handleAddCustomRatio}
                  disabled={!/^\d+:\d+$/.test(customRatio.trim())}
                  className="text-[10px] text-accent disabled:text-text-muted"
                >
                  添加
                </button>
              </span>
            </div>
          </div>

          <div className="mt-4 space-y-1">
            <div className="text-xs font-medium text-text-muted">
              支持的分辨率（可选。保存后会出现在 AI 图片「参数」里）
            </div>
            <div className="flex flex-wrap gap-1.5">
              {template.supportedResolutions.map((resolution) => {
                const checked = selectedResolutions.includes(resolution);
                return (
                  <button
                    key={resolution}
                    type="button"
                    onClick={() => handleToggleResolution(resolution)}
                    className={`inline-flex h-8 items-center rounded-md border px-3 text-xs transition-colors ${
                      checked
                        ? 'border-accent bg-accent/18 text-accent'
                        : 'border-border-dark bg-bg-dark text-text-muted hover:border-accent/45 hover:text-text-dark'
                    }`}
                  >
                    {displayResolutionLabel(resolution)}
                  </button>
                );
              })}
              {selectedResolutions
                .filter((resolution) => !template.supportedResolutions.includes(resolution))
                .map((resolution) => (
                  <span
                    key={resolution}
                    className="inline-flex h-8 items-center gap-1 rounded-md border border-accent/45 bg-accent/14 pl-3 pr-1 text-xs text-accent"
                  >
                    {resolution}
                    <button
                      type="button"
                      onClick={() => handleRemoveResolution(resolution)}
                      className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-red-500/12 hover:text-red-300"
                      title="删除自定义分辨率"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              <span className="inline-flex h-8 items-center gap-1 rounded-md border border-dashed border-border-dark bg-bg-dark px-2">
                <Plus className="h-3.5 w-3.5 text-text-muted" />
                <input
                  value={customResolution}
                  onChange={(event) => setCustomResolution(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      handleAddCustomResolution();
                    }
                  }}
                  className="h-6 w-24 bg-transparent text-xs text-text-dark outline-none placeholder:text-text-muted"
                  placeholder="自定义"
                />
                <button
                  type="button"
                  onClick={handleAddCustomResolution}
                  disabled={!customResolution.trim()}
                  className="text-[10px] text-accent disabled:text-text-muted"
                >
                  添加
                </button>
              </span>
            </div>
          </div>
        </div>

        <details className="mt-3 rounded-lg border border-border-dark bg-surface-dark p-3">
          <summary className="cursor-pointer text-xs font-medium text-text-muted hover:text-text-dark">
            高级默认请求参数（可选）
          </summary>
          <div className="mt-3 flex items-start justify-between gap-3">
            <div className="text-[11px] leading-5 text-text-muted">
              只有供应商文档明确要求 quality、output_format、style、cfg_scale、safety_tolerance 等字段时再改这里。
            </div>
            {parsedDefaultRequestParams.ok ? (
              <span className="shrink-0 text-[10px] text-emerald-300">JSON 有效</span>
            ) : (
              <span className="max-w-[260px] shrink-0 text-right text-[10px] leading-4 text-red-300">
                {parsedDefaultRequestParams.error}
              </span>
            )}
          </div>
          <div className="my-2 grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_auto] gap-2">
            <input
              value={customParamKey}
              onChange={(event) => setCustomParamKey(event.target.value)}
              className="h-8 rounded-md border border-border-dark bg-bg-dark px-2 text-xs font-mono text-text-dark outline-none focus:border-accent"
              placeholder="参数名，例如 quality"
            />
            <input
              value={customParamValue}
              onChange={(event) => setCustomParamValue(event.target.value)}
              className="h-8 rounded-md border border-border-dark bg-bg-dark px-2 text-xs text-text-dark outline-none focus:border-accent"
              placeholder='参数值，例如 auto / false / {"mode":"fast"}'
            />
            <button
              type="button"
              onClick={handleAddCustomParam}
              disabled={!customParamKey.trim()}
              className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-border-dark bg-bg-dark px-3 text-xs text-text-dark hover:border-accent/50 disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" />
              添加参数
            </button>
          </div>
          <textarea
            value={defaultRequestParamsText}
            onChange={(event) => setDefaultRequestParamsText(event.target.value)}
            className="ui-scrollbar h-[110px] w-full resize-none rounded-md border border-border-dark bg-bg-dark px-3 py-2 font-mono text-[11px] leading-5 text-text-dark outline-none focus:border-accent"
            spellCheck={false}
          />
        </details>

        <div className="mt-4 flex items-start gap-2 rounded-lg border border-accent/25 bg-accent/10 px-3 py-2 text-[11px] leading-5 text-text-muted">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
          <span>{template.note}</span>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          {savedFlash && (
            <span className="mr-auto inline-flex items-center gap-1 text-xs text-emerald-300">
              <CheckCircle2 className="h-3.5 w-3.5" /> 已保存到我的配置
            </span>
          )}
          <button
            type="button"
            onClick={handleSave}
            disabled={!baseUrl.trim() || selectedModels.length === 0 || !parsedDefaultRequestParams.ok}
            className="inline-flex h-9 items-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
          >
            <CheckCircle2 className="h-4 w-4" />
            {editingId ? '保存修改' : '保存新供应商'}
          </button>
        </div>
      </div>
    </div>
  );
});
