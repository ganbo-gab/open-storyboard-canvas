import {
  customHttpRequest,
  type CustomHttpMultipartBody,
  type GenerateRequest,
  type GenerationJobStatus,
} from '@/commands/ai';
import {
  prepareNodeImageSource,
  prepareNodeImageSourceWithHeaders,
  persistVideoSource,
} from '@/commands/image';
import {
  AGNES_PROVIDER_DEFAULTS,
  isVideoCustomProvider,
  useCustomProvidersStore,
  type CustomProviderConfig,
} from '@/stores/customProvidersStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { hasCustomProviderCredential } from '@/features/canvas/application/providerAvailability';
import {
  asPlainRecord,
  requiresMultipartReferenceImage,
  resolveCustomProviderBodyMode,
  resolveCustomProviderMultipartFileField,
  resolveRequestBodyHints,
  type CustomProviderBodyMode,
} from './customProviderTransport';

// Custom providers go through a native Tauri/reqwest bridge instead of the
// WebView's browser fetch. Many aggregators do not expose permissive CORS
// headers, and WebKit reports those failures as a vague "Load failed".

/**
 * Custom-provider HTTP gateway.
 *
 * Reads the user's saved `CustomProviderConfig` and issues a direct HTTP
 * call using Tauri's native HTTP bridge (which bypasses browser CORS).
 * Only the `openai-compatible` apiStyle is fully implemented here — other
 * apiStyles fall through to a best-effort generic-json call. The response
 * is parsed using `responseFormat` to extract the first image URL.
 *
 * Job id is synthetic (generation is blocking from the user's perspective);
 * the module-level cache mimics the polling interface so callers don't need
 * to branch.
 */

interface CachedJob extends GenerationJobStatus {}
const cache = new Map<string, CachedJob>();
const POLL_TIMEOUT_MS = 120000;
const VIDEO_POLL_TIMEOUT_MS = 15 * 60 * 1000;
const CONNECTIVITY_TEST_POLL_TIMEOUT_MS = 180000;
const GENERATION_REQUEST_TIMEOUT_MS = 180000;
const RESULT_POLL_INTERVAL_MS = 1000;
const RESULT_POLL_REQUEST_TIMEOUT_MS = 30000;
const RESULT_POLL_NETWORK_RETRY_ATTEMPTS = 3;
const RESULT_POLL_MAX_CONSECUTIVE_NETWORK_FAILURES = 8;
const RESULT_POLL_RETRY_HTTP_STATUSES = [408, 425, 429, 500, 502, 503, 504, 520, 522, 524];
const DEFAULT_OPENAI_VIDEO_ENDPOINT_PATH = '/v1/videos';

class NetworkRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkRequestError';
  }
}

class HttpStatusError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'HttpStatusError';
    this.status = status;
  }
}

class RetryableHttpStatusError extends HttpStatusError {
  constructor(message: string, status?: number) {
    super(message, status);
    this.name = 'RetryableHttpStatusError';
  }
}

interface AsyncTaskConfig {
  resultEndpointPath: string;
  resultMethod: 'GET' | 'POST';
  taskIdPath?: string;
  imagePath?: string;
  statusPath?: string;
  pendingValues: string[];
  successValues: string[];
  failedValues: string[];
  errorPath?: string;
  requestBody?: unknown;
  intervalMs: number;
  timeoutMs: number;
}

function buildAgnesProviderConfig(mediaType: 'image' | 'video', apiKey: string): CustomProviderConfig {
  if (mediaType === 'video') {
    return {
      id: 'agnes',
      label: 'Agnes Video',
      mediaType: 'video',
      baseUrl: AGNES_PROVIDER_DEFAULTS.baseUrl,
      endpointPath: AGNES_PROVIDER_DEFAULTS.videoEndpointPath,
      modelListEndpointPath: AGNES_PROVIDER_DEFAULTS.modelListEndpointPath,
      httpMethod: 'POST',
      apiKey,
      apiStyle: 'openai-compatible',
      models: [AGNES_PROVIDER_DEFAULTS.models.video20, AGNES_PROVIDER_DEFAULTS.models.video12],
      supportsWebSearch: false,
      supportedResolutions: [...AGNES_PROVIDER_DEFAULTS.videoResolutions],
      responseFormat: 'generic',
      extraParams: {
        providerConfigVersion: 'video-v1',
        mediaType: 'video',
        providerKind: 'agnes-video',
        requestComposer: 'video-agnes-json',
        videoRequestBodyMode: 'json',
        supportedDurations: ['4', '8', '12'],
        supportedRatios: ['16:9', '9:16', '1:1'],
        supportedResolutions: [...AGNES_PROVIDER_DEFAULTS.videoResolutions],
        videoPollTimeoutMs: VIDEO_POLL_TIMEOUT_MS,
        videoTaskIdPath: 'task_id',
        videoStatusEndpointPath: AGNES_PROVIDER_DEFAULTS.videoStatusEndpointPath,
        responseVideoPath: 'video_url',
        videoStatusPath: 'status',
        videoSuccessValues: ['completed'],
        videoFailedValues: ['failed'],
        videoReferenceField: 'image',
        defaultRequestParams: {
          frame_rate: 24,
          negative_prompt: '',
        },
      },
      note: 'Agnes settings key routed through the JSON async video gateway.',
    };
  }

  return {
    id: 'agnes',
    label: 'Agnes Image',
    mediaType: 'image',
    baseUrl: AGNES_PROVIDER_DEFAULTS.baseUrl,
    endpointPath: AGNES_PROVIDER_DEFAULTS.imageEndpointPath,
    modelListEndpointPath: AGNES_PROVIDER_DEFAULTS.modelListEndpointPath,
    httpMethod: 'POST',
    apiKey,
    apiStyle: 'openai-compatible',
    models: [AGNES_PROVIDER_DEFAULTS.models.image21Flash, AGNES_PROVIDER_DEFAULTS.models.image20Flash, AGNES_PROVIDER_DEFAULTS.models.image12],
    supportsWebSearch: false,
    supportedResolutions: [...AGNES_PROVIDER_DEFAULTS.imageResolutions],
    responseFormat: 'openai-images',
    extraParams: {
      providerConfigVersion: 'new-v1',
      providerKind: 'openai-images',
      supportedRatios: ['auto', '16:9', '9:16', '1:1', '4:3', '3:4'],
    },
    note: 'Agnes settings key routed through the OpenAI Images-compatible gateway.',
  };
}

export interface CustomProviderRequestDebugPreview {
  providerLabel: string;
  providerId: string;
  modelId: string;
  modelName: string;
  method: 'GET' | 'POST';
  bodyMode: CustomProviderBodyMode;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  multipart?: CustomHttpMultipartBody;
}

function resolveProviderAndModel(modelId: string): { cfg: CustomProviderConfig; model: string } | null {
  if (modelId.startsWith('agnes:image:') || modelId.startsWith('agnes:video:')) {
    const [, mediaType, ...modelParts] = modelId.split(':');
    const model = modelParts.join(':').trim();
    const apiKey = useSettingsStore.getState().agnesApiKey.trim();
    if (!model || !apiKey || (mediaType !== 'image' && mediaType !== 'video')) return null;
    return { cfg: buildAgnesProviderConfig(mediaType, apiKey), model };
  }

  // modelId shape: `custom:<providerId>:<modelId>`
  const parts = modelId.split(':');
  if (parts.length < 3 || parts[0] !== 'custom') return null;
  const providerId = parts[1];
  const modelName = parts.slice(2).join(':');
  const cfg = useCustomProvidersStore.getState().providers.find((p) => p.id === providerId);
  if (!cfg) return null;
  return { cfg, model: modelName };
}

function isModernProviderConfig(cfg: CustomProviderConfig): boolean {
  return cfg.extraParams?.providerConfigVersion === 'new-v1';
}

function modernProviderKind(cfg: CustomProviderConfig): string {
  return typeof cfg.extraParams?.providerKind === 'string' ? cfg.extraParams.providerKind : '';
}

function isOpenAiImagesLikeModernProvider(cfg: CustomProviderConfig): boolean {
  const kind = modernProviderKind(cfg);
  return kind === 'openai-images' || kind === 'midjourney';
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) =>
      value !== undefined
      && value !== null
      && value !== ''
      && !(Array.isArray(value) && value.length === 0)
    )
  );
}

function pickAllowedParams(
  source: Record<string, unknown>,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  const allowed = new Set(allowedKeys);
  return Object.fromEntries(
    Object.entries(source).filter(([key, value]) => allowed.has(key) && value !== undefined && value !== null && value !== '')
  );
}

const OPENAI_IMAGE_PARAM_KEYS = [
  'background',
  'moderation',
  'output_compression',
  'output_format',
  'quality',
  'response_format',
  'style',
  'user',
] as const;

function normalizeResolutionTier(value: unknown): '1k' | '2k' | '4k' | 'auto' | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'auto' || normalized === '智能' || normalized === '自动') return 'auto';
  if (/^(0\.5k|512)$/.test(normalized)) return '1k';
  if (/^(1k|1024|1024p)$/.test(normalized)) return '1k';
  if (/^(2k|2048|1080p|1440p)$/.test(normalized)) return '2k';
  if (/^(4k|4096|2160p|uhd)$/.test(normalized)) return '4k';
  return null;
}

function normalizeRatioKey(value: string | undefined): string {
  if (!value || value === 'auto') return '1:1';
  return value.trim();
}

const MODERN_SIZE_BY_TIER: Record<'1k' | '2k' | '4k', Record<string, string>> = {
  '1k': {
    '1:1': '1024x1024',
    '16:9': '1024x576',
    '9:16': '576x1024',
    '4:3': '1024x768',
    '3:4': '768x1024',
    '3:2': '1024x682',
    '2:3': '682x1024',
    '21:9': '1344x576',
    '2:1': '1024x512',
    '4:1': '1024x256',
  },
  '2k': {
    '1:1': '2048x2048',
    '16:9': '2048x1152',
    '9:16': '1152x2048',
    '4:3': '2048x1536',
    '3:4': '1536x2048',
    '3:2': '2048x1365',
    '2:3': '1365x2048',
    '21:9': '2560x1080',
    '2:1': '2048x1024',
    '4:1': '2048x512',
  },
  '4k': {
    '1:1': '2048x2048',
    '16:9': '3840x2160',
    '9:16': '2160x3840',
    '4:3': '3840x2880',
    '3:4': '2880x3840',
    '3:2': '3840x2560',
    '2:3': '2560x3840',
    '21:9': '5120x2160',
    '2:1': '4096x2048',
    '4:1': '4096x1024',
  },
};

function resolveModernOpenAiSize(cfg: CustomProviderConfig, request: GenerateRequest): string {
  const selectedResolution = request.extra_params?.resolutionType ?? request.size;
  if (isPixelSize(selectedResolution)) return selectedResolution.trim();
  const tier = normalizeResolutionTier(selectedResolution);
  if (tier === 'auto') return 'auto';
  if (tier) {
    const ratioKey = normalizeRatioKey(request.aspect_ratio);
    const byRatio = MODERN_SIZE_BY_TIER[tier][ratioKey];
    if (byRatio) return byRatio;
  }
  if (isPixelSize(request.size)) return request.size.trim();
  const configuredSizes = (cfg.supportedResolutions ?? []).filter(isPixelSize).map((size) => size.trim());
  return pickClosestPixelSize(configuredSizes, request.aspect_ratio)
    ?? fallbackPixelSizeForAspectRatio(request.aspect_ratio);
}

function referenceImageToGeminiPart(imageSource: string): Record<string, unknown> | null {
  const trimmed = imageSource.trim();
  if (!trimmed.startsWith('data:')) return null;
  const match = /^data:([^;,]+)(?:;[^,]*)?,(.+)$/s.exec(trimmed);
  if (!match) return null;
  return {
    inline_data: {
      mime_type: match[1] || 'image/png',
      data: match[2],
    },
  };
}

function resolveModernRatioForPrompt(request: GenerateRequest): string | undefined {
  const ratio = request.aspect_ratio?.trim();
  return ratio && ratio !== 'auto' ? ratio : undefined;
}

function resolveModernImageTier(request: GenerateRequest): '1K' | '2K' | '4K' | undefined {
  const tier = normalizeResolutionTier(request.extra_params?.resolutionType ?? request.size);
  if (tier === '1k') return '1K';
  if (tier === '2k') return '2K';
  if (tier === '4k') return '4K';
  return undefined;
}

function modelLooksLikeGeminiHighResImageModel(modelName: string): boolean {
  const normalized = modelName.toLowerCase();
  return normalized.includes('3.1')
    || normalized.includes('3-pro')
    || normalized.includes('pro-image')
    || normalized.includes('imagen-4');
}

function buildModernRequestBody(
  cfg: CustomProviderConfig,
  modelName: string,
  request: GenerateRequest,
): unknown {
  const kind = modernProviderKind(cfg);
  const defaultRequestParams = resolveDefaultRequestParams(cfg);
  const userExtra = { ...(request.extra_params ?? {}) } as Record<string, unknown>;
  delete userExtra.resolutionType;
  delete userExtra.aspect_ratio;
  delete userExtra.aspectRatio;
  delete userExtra.reference_images;
  delete userExtra.webSearch;
  delete userExtra.negativePrompt;
  delete userExtra.modelVersion;

  if (kind === 'openai-responses') {
    const size = resolveModernOpenAiSize(cfg, request);
    const imageModel = String(
      userExtra.image_generation_model
      ?? userExtra.imageGenerationModel
      ?? defaultRequestParams.image_generation_model
      ?? defaultRequestParams.imageGenerationModel
      ?? 'gpt-image-2'
    ).trim();
    delete userExtra.image_generation_model;
    delete userExtra.imageGenerationModel;
    const toolParams = compactRecord({
      type: 'image_generation',
      model: imageModel,
      size,
      ...pickAllowedParams(defaultRequestParams, OPENAI_IMAGE_PARAM_KEYS),
      ...pickAllowedParams(userExtra, OPENAI_IMAGE_PARAM_KEYS),
    });
    return compactRecord({
      model: modelName,
      input: request.prompt,
      tools: [toolParams],
      tool_choice: { type: 'image_generation' },
    });
  }

  if (kind === 'google-gemini') {
    const referenceParts = (request.reference_images ?? [])
      .map(referenceImageToGeminiPart)
      .filter((part): part is Record<string, unknown> => Boolean(part));
    const imageConfig = compactRecord({
      aspectRatio: resolveModernRatioForPrompt(request),
      imageSize: modelLooksLikeGeminiHighResImageModel(modelName)
        ? resolveModernImageTier(request)
        : undefined,
    });
    const responseFormat = Object.keys(imageConfig).length > 0
      ? { image: imageConfig }
      : undefined;
    return {
      contents: [
        {
          role: 'user',
          parts: [
            { text: request.prompt },
            ...referenceParts,
          ],
        },
      ],
      generationConfig: compactRecord({
        responseModalities: ['TEXT', 'IMAGE'],
        responseFormat,
      }),
    };
  }

  if (kind === 'openai-images' || kind === 'midjourney') {
    const size = resolveModernOpenAiSize(cfg, request);
    return compactRecord({
      model: modelName,
      prompt: request.prompt,
      size,
      n: 1,
      ...pickAllowedParams(defaultRequestParams, OPENAI_IMAGE_PARAM_KEYS),
      ...pickAllowedParams(userExtra, OPENAI_IMAGE_PARAM_KEYS),
    });
  }

  if (kind === 'fal') {
    return compactRecord({
      prompt: request.prompt,
      image_size: resolveModernOpenAiSize(cfg, request),
      num_images: 1,
      ...defaultRequestParams,
      ...userExtra,
      ...(request.reference_images?.[0] ? { image_url: request.reference_images[0] } : {}),
    });
  }

  if (kind === 'replicate') {
    return {
      ...defaultRequestParams,
      input: {
        prompt: request.prompt,
        aspect_ratio: request.aspect_ratio,
        ...(request.reference_images?.[0] ? { image: request.reference_images[0] } : {}),
        ...(asPlainRecord(defaultRequestParams.input) ?? {}),
        ...userExtra,
      },
    };
  }

  return compactRecord({
    model: modelName,
    prompt: request.prompt,
    size: resolveModernOpenAiSize(cfg, request),
    ...defaultRequestParams,
    ...userExtra,
  });
}

function buildRequestBody(
  cfg: CustomProviderConfig,
  modelName: string,
  request: GenerateRequest
): unknown {
  if (isModernProviderConfig(cfg)) {
    return buildModernRequestBody(cfg, modelName, request);
  }

  const ratio = request.aspect_ratio === 'auto' ? undefined : request.aspect_ratio;
  const defaultRequestParams = resolveDefaultRequestParams(cfg);

  // The ModelConfigPicker exposes `webSearch: true/false` when the provider
  // has `supportsWebSearch`. Upstream APIs use snake-case `web_search` at the
  // request body's top level, so we translate the key here and drop the
  // original camel-case version so providers don't see both. Same for
  // `negativePrompt` → `negative_prompt`.
  const userExtra = { ...(request.extra_params ?? {}) } as Record<string, unknown>;
  const webSearchRaw = userExtra.webSearch;
  delete userExtra.webSearch;
  const webSearchField: Record<string, unknown> = webSearchRaw === true ? { web_search: true } : {};

  const negativeRaw = userExtra.negativePrompt;
  delete userExtra.negativePrompt;
  const negativeField: Record<string, unknown> = typeof negativeRaw === 'string' && negativeRaw.trim()
    ? { negative_prompt: negativeRaw.trim() }
    : {};

  // `seed` / `modelVersion` pass through as-is when set. `resolutionType`
  // is a UI choice and must be normalized before OpenAI-compatible providers
  // see it, otherwise values like "2K" are rejected by /images/generations.
  const seedField: Record<string, unknown> = typeof userExtra.seed === 'number' ? { seed: userExtra.seed } : {};
  delete userExtra.seed;
  const resolvedSize = resolveOpenAiCompatibleSize(cfg, request, userExtra.resolutionType);
  delete userExtra.resolutionType;
  const normalizedDefaultRequestParams = normalizeImageGenerationToolSizes(defaultRequestParams, resolvedSize);

  switch (cfg.apiStyle) {
    case 'openai-compatible': {
      if (isResponsesEndpoint(cfg)) {
        return {
          model: modelName,
          input: request.prompt,
          tools: [{ type: 'image_generation' }],
          ...normalizedDefaultRequestParams,
          ...(ratio ? { aspect_ratio: ratio } : {}),
          ...webSearchField,
          ...negativeField,
          ...seedField,
          ...userExtra,
        };
      }
      if (isChatCompletionsEndpoint(cfg)) {
        const referenceImages = request.reference_images ?? [];
        const content = referenceImages.length > 0
          ? [
            { type: 'text', text: request.prompt },
            ...referenceImages.map((imageUrl) => ({
              type: 'image_url',
              image_url: { url: imageUrl },
            })),
          ]
          : request.prompt;
        return {
          model: modelName,
          messages: [{ role: 'user', content }],
          modalities: ['image', 'text'],
          ...normalizedDefaultRequestParams,
          ...(ratio ? { aspect_ratio: ratio } : {}),
          ...webSearchField,
          ...negativeField,
          ...seedField,
          ...userExtra,
        };
      }
      // OpenAI Images-ish: POST { model, prompt, size, n, ... }. We keep it
      // minimal so most aggregators accept it.
      return {
        model: modelName,
        prompt: request.prompt,
        size: resolvedSize,
        n: 1,
        ...normalizedDefaultRequestParams,
        ...(ratio ? { aspect_ratio: ratio } : {}),
        ...(request.reference_images && request.reference_images.length > 0
          ? { image: request.reference_images[0] }
          : {}),
        ...webSearchField,
        ...negativeField,
        ...seedField,
        ...userExtra,
      };
    }
    default:
      if (isGrsaiLikeProvider(cfg)) {
        const urls = (request.reference_images ?? [])
          .map((image) => stripDataUrlPrefix(image))
          .filter(Boolean);
        const normalizedDefaults = normalizeGrsaiParams(defaultRequestParams);
        return {
          model: modelName,
          prompt: request.prompt,
          aspectRatio: request.aspect_ratio,
          ...(urls.length > 0 ? { urls } : {}),
          webHook: '-1',
          shutProgress: false,
          ...normalizedDefaults,
          ...webSearchField,
          ...negativeField,
          ...seedField,
          ...normalizeGrsaiParams(userExtra),
        };
      }
      // generic-json: pass the whole request through; user-provided
      // extra_params / extra_headers decide the actual shape.
      return applyRequestBodyHints(cfg, {
        model: modelName,
        prompt: request.prompt,
        size: request.size,
        ...defaultRequestParams,
        ...(ratio ? { aspect_ratio: ratio } : {}),
        ...(request.reference_images && request.reference_images.length > 0
          ? { reference_images: request.reference_images }
          : {}),
        ...webSearchField,
        ...negativeField,
        ...seedField,
        ...userExtra,
      }, request, modelName);
  }
}

function isChatCompletionsEndpoint(cfg: CustomProviderConfig): boolean {
  return (cfg.endpointPath ?? '').toLowerCase().includes('/chat/completions');
}

function isResponsesEndpoint(cfg: CustomProviderConfig): boolean {
  return (cfg.endpointPath ?? '').toLowerCase().includes('/responses');
}

function isGrsaiLikeProvider(cfg: CustomProviderConfig): boolean {
  const haystack = `${cfg.label} ${cfg.baseUrl} ${cfg.endpointPath ?? ''}`.toLowerCase();
  return haystack.includes('grsai')
    || haystack.includes('grs ai')
    || haystack.includes('dakka.com.cn')
    || haystack.includes('/v1/draw/');
}

function isPixelSize(value: unknown): value is string {
  return typeof value === 'string' && /^\d{2,5}x\d{2,5}$/i.test(value.trim());
}

function parseAspectRatioValue(value: string | undefined): number {
  if (!value || value === 'auto') return 1;
  const [w, h] = value.split(':').map((part) => Number(part));
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? w / h : 1;
}

function parsePixelSizeRatio(value: string): number | null {
  const [w, h] = value.toLowerCase().split('x').map((part) => Number(part));
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? w / h : null;
}

function pickClosestPixelSize(candidates: string[], aspectRatio: string | undefined): string | null {
  const targetRatio = parseAspectRatioValue(aspectRatio);
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const ratio = parsePixelSizeRatio(candidate);
    if (!ratio) continue;
    const distance = Math.abs(Math.log(ratio / targetRatio));
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function fallbackPixelSizeForAspectRatio(aspectRatio: string | undefined): string {
  const ratio = parseAspectRatioValue(aspectRatio);
  if (ratio > 1.15) return '1536x1024';
  if (ratio < 0.87) return '1024x1536';
  return '1024x1024';
}

function resolveOpenAiCompatibleSize(
  cfg: CustomProviderConfig,
  request: GenerateRequest,
  selectedResolution: unknown,
): string {
  if (isPixelSize(selectedResolution)) return selectedResolution.trim();
  if (isPixelSize(request.size)) return request.size.trim();
  const configuredSizes = (cfg.supportedResolutions ?? []).filter(isPixelSize).map((size) => size.trim());
  return pickClosestPixelSize(configuredSizes, request.aspect_ratio)
    ?? fallbackPixelSizeForAspectRatio(request.aspect_ratio);
}

function normalizeImageGenerationToolSizes(
  params: Record<string, unknown>,
  resolvedSize: string,
): Record<string, unknown> {
  const tools = params.tools;
  if (!Array.isArray(tools)) return params;
  return {
    ...params,
    tools: tools.map((tool) => {
      if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return tool;
      const record = tool as Record<string, unknown>;
      if (record.type !== 'image_generation') return tool;
      const currentSize = record.size;
      if (currentSize === undefined || currentSize === null || currentSize === '' || isPixelSize(currentSize)) {
        return tool;
      }
      return { ...record, size: resolvedSize };
    }),
  };
}

function stripDataUrlPrefix(value: string): string {
  const trimmed = value.trim();
  const commaIndex = trimmed.indexOf(',');
  return trimmed.startsWith('data:') && commaIndex >= 0 ? trimmed.slice(commaIndex + 1) : trimmed;
}

function normalizeGrsaiParams(params: Record<string, unknown>): Record<string, unknown> {
  const next = { ...params };
  if (Object.prototype.hasOwnProperty.call(next, 'web_hook')) {
    next.webHook = next.web_hook;
    delete next.web_hook;
  }
  if (Object.prototype.hasOwnProperty.call(next, 'shut_progress')) {
    next.shutProgress = next.shut_progress;
    delete next.shut_progress;
  }
  delete next.size;
  delete next.image_size;
  delete next.resolutionType;
  return next;
}

const ARRAY_REFERENCE_IMAGE_FIELDS = new Set([
  'files',
  'image_urls',
  'images',
  'input_image_urls',
  'input_images',
  'reference_image_urls',
  'reference_images',
  'reference_urls',
  'references',
  'refs',
  'urls',
]);

const SINGULAR_REFERENCE_IMAGE_FIELDS = new Set([
  'file',
  'image',
  'image_url',
  'input_image',
  'input_image_url',
  'reference',
  'reference_image',
  'reference_image_url',
  'ref',
  'url',
]);

function normalizeReferenceImageFieldName(rawField: string): { token: string; hasArraySuffix: boolean } {
  const field = rawField.trim();
  const lastSegment = field.split('.').map((part) => part.trim()).filter(Boolean).pop() ?? field;
  const hasArraySuffix = /\[\s*\]$/.test(lastSegment);
  const token = lastSegment
    .replace(/\[\s*\]$/, '')
    .replace(/\[\d+\]$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();
  return { token, hasArraySuffix };
}

function referenceImageFieldUsesArray(rawField: string): boolean {
  const { token, hasArraySuffix } = normalizeReferenceImageFieldName(rawField);
  if (hasArraySuffix) return true;
  if (ARRAY_REFERENCE_IMAGE_FIELDS.has(token)) return true;
  if (SINGULAR_REFERENCE_IMAGE_FIELDS.has(token)) return false;
  return true;
}

function referenceImageFieldStripsDataUrlPrefix(rawField: string): boolean {
  return normalizeReferenceImageFieldName(rawField).token === 'urls';
}

function applyRequestBodyHints(
  cfg: CustomProviderConfig,
  body: Record<string, unknown>,
  request: GenerateRequest,
  modelName: string,
): Record<string, unknown> {
  const hints = cfg.extraParams?.requestBodyHints;
  if (!hints || typeof hints !== 'object' || Array.isArray(hints)) return body;
  const record = hints as Record<string, unknown>;
  const next = { ...body };

  const moveField = (fromKey: string, toRaw: unknown, value: unknown) => {
    const toKey = typeof toRaw === 'string' ? toRaw.trim() : '';
    if (!toKey) {
      delete next[fromKey];
      return;
    }
    if (toKey !== fromKey) delete next[fromKey];
    setBodyValue(next, toKey, value);
  };

  if (Object.prototype.hasOwnProperty.call(record, 'promptField')) {
    moveField('prompt', record.promptField, request.prompt);
  }
  if (Object.prototype.hasOwnProperty.call(record, 'modelField')) {
    moveField('model', record.modelField, modelName);
  }

  const ratioField = typeof record.ratioField === 'string' ? record.ratioField.trim() : '';
  if (ratioField) {
    delete next.aspect_ratio;
    setBodyValue(next, ratioField, request.aspect_ratio);
  }

  const sizeField = typeof record.sizeField === 'string' ? record.sizeField.trim() : '';
  if (sizeField) {
    delete next.size;
    setBodyValue(next, sizeField, resolveHintedSizeValue(cfg, request, request.extra_params?.resolutionType));
  } else if (Object.prototype.hasOwnProperty.call(record, 'sizeField') && record.sizeField === '') {
    delete next.size;
  }

  const referenceImageField = typeof record.referenceImageField === 'string' ? record.referenceImageField.trim() : '';
  if (referenceImageField) {
    delete next.reference_images;
    const images = request.reference_images ?? [];
    const mappedImages = referenceImageFieldStripsDataUrlPrefix(referenceImageField)
      ? images.map(stripDataUrlPrefix).filter(Boolean)
      : images;
    if (mappedImages.length === 0) {
      deleteBodyValue(next, referenceImageField);
    } else {
      setBodyValue(next, referenceImageField, referenceImageFieldUsesArray(referenceImageField)
        ? mappedImages
        : mappedImages[0]);
    }
  }

  return next;
}

function resolveHintedSizeValue(
  cfg: CustomProviderConfig,
  request: GenerateRequest,
  selectedResolution: unknown,
): string {
  if (typeof selectedResolution === 'string' && selectedResolution.trim()) return selectedResolution.trim();
  if (isPixelSize(request.size)) return request.size.trim();
  const configuredSizes = (cfg.supportedResolutions ?? []).filter(isPixelSize).map((size) => size.trim());
  return pickClosestPixelSize(configuredSizes, request.aspect_ratio) ?? request.size;
}

function parseBodyPath(rawPath: string): string[] {
  return rawPath
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map((part) => part.trim())
    .filter(Boolean);
}

function setBodyValue(target: Record<string, unknown>, rawPath: string, value: unknown): void {
  const path = parseBodyPath(rawPath);
  if (path.length === 0) return;
  let current: Record<string, unknown> = target;
  path.slice(0, -1).forEach((part) => {
    const existing = current[part];
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  });
  current[path[path.length - 1]] = value;
}

function deleteBodyValue(target: Record<string, unknown>, rawPath: string): void {
  const path = parseBodyPath(rawPath);
  if (path.length === 0) return;
  let current: Record<string, unknown> = target;
  for (const part of path.slice(0, -1)) {
    const next = current[part];
    if (!next || typeof next !== 'object' || Array.isArray(next)) return;
    current = next as Record<string, unknown>;
  }
  delete current[path[path.length - 1]];
}

function resolveDefaultRequestParams(cfg: CustomProviderConfig): Record<string, unknown> {
  const raw = cfg.extraParams?.defaultRequestParams;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  return raw as Record<string, unknown>;
}

function buildRequestHeaders(
  cfg: CustomProviderConfig,
  bodyMode: CustomProviderBodyMode,
  method: 'GET' | 'POST' = 'POST',
): Record<string, string> {
  const headers: Record<string, string> = {};
  if ((modernProviderKind(cfg) === 'google-gemini' || modernProviderKind(cfg) === 'google-video') && cfg.apiKey?.trim()) {
    headers['x-goog-api-key'] = cfg.apiKey.trim();
  } else if (cfg.apiKey?.trim()) {
    headers.Authorization = `Bearer ${cfg.apiKey.trim()}`;
  }
  if (method === 'POST' && bodyMode === 'json') {
    headers['Content-Type'] = 'application/json';
  } else if (method === 'POST' && bodyMode === 'form-urlencoded') {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }

  Object.entries(cfg.extraHeaders ?? {}).forEach(([key, value]) => {
    const normalizedKey = key.trim();
    if (!normalizedKey) return;
    if ((bodyMode === 'multipart' || bodyMode === 'form-urlencoded') && /^content-type$/i.test(normalizedKey)) return;
    headers[normalizedKey] = value;
  });

  return headers;
}

function bodyPathMatches(path: string, skipPaths: Set<string>): boolean {
  if (skipPaths.has(path)) return true;
  const normalized = path.replace(/\[(\d+)\]/g, '.$1');
  return skipPaths.has(normalized);
}

function appendMultipartField(
  fields: NonNullable<CustomHttpMultipartBody['fields']>,
  name: string,
  value: unknown,
): void {
  if (!name || value === undefined || value === null) return;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    fields.push({ name, value: String(value) });
    return;
  }
  try {
    fields.push({ name, value: JSON.stringify(value) });
  } catch {
    fields.push({ name, value: String(value) });
  }
}

function collectMultipartFields(
  value: unknown,
  path: string,
  skipPaths: Set<string>,
  fields: NonNullable<CustomHttpMultipartBody['fields']>,
): void {
  if (!path) {
    const record = asPlainRecord(value);
    if (!record) return;
    Object.entries(record).forEach(([key, item]) => {
      collectMultipartFields(item, key, skipPaths, fields);
    });
    return;
  }

  if (bodyPathMatches(path, skipPaths)) return;
  if (value === undefined || value === null) return;
  if (typeof value !== 'object' || Array.isArray(value)) {
    appendMultipartField(fields, path, value);
    return;
  }

  Object.entries(value as Record<string, unknown>).forEach(([key, item]) => {
    collectMultipartFields(item, `${path}.${key}`, skipPaths, fields);
  });
}

function isBase64LikeImage(value: string): boolean {
  return /^[A-Za-z0-9+/=]+$/.test(value.trim()) && value.trim().length > 300;
}

function buildMultipartFile(
  fieldName: string,
  imageSource: string,
  index: number,
): NonNullable<CustomHttpMultipartBody['files']>[number] {
  const trimmed = imageSource.trim();
  const fileName = index === 0 ? 'reference.png' : `reference-${index + 1}.png`;
  if (trimmed.startsWith('data:')) {
    return { name: fieldName, fileName, dataUrl: trimmed };
  }
  if (isBase64LikeImage(trimmed)) {
    return { name: fieldName, fileName, mimeType: 'image/png', base64: trimmed };
  }
  throw new Error('multipart 参考图必须是 data URL 或 base64。请确认图片已从画布资产转换为 data URL 后再发送。');
}

function buildMultipartBody(
  cfg: CustomProviderConfig,
  modelName: string,
  request: GenerateRequest,
): CustomHttpMultipartBody {
  const referenceImages = request.reference_images ?? [];
  const fileField = resolveCustomProviderMultipartFileField(cfg);
  if (referenceImages.length === 0 && requiresMultipartReferenceImage(cfg)) {
    throw new Error(
      `该配置需要 multipart/form-data 文件字段 "${fileField}"，但当前请求没有参考图。请从已有图片节点发起编辑，或改用不要求 image/file 的生图接口。`
    );
  }

  const jsonBody = buildRequestBody(cfg, modelName, request);
  const record = asPlainRecord(jsonBody);
  if (!record) {
    throw new Error('multipart 请求体必须是对象，请检查默认请求参数和 requestBodyHints。');
  }
  const hintedBody = applyRequestBodyHints(cfg, record, request, modelName);
  const hints = resolveRequestBodyHints(asPlainRecord(cfg.extraParams));
  const hintedReferenceField = typeof hints?.referenceImageField === 'string'
    ? hints.referenceImageField.trim()
    : '';
  const skipPaths = new Set<string>([
    'reference_images',
    fileField,
    hintedReferenceField,
    'image',
    'images',
  ].filter(Boolean));
  const fields: NonNullable<CustomHttpMultipartBody['fields']> = [];
  collectMultipartFields(hintedBody, '', skipPaths, fields);

  const files = referenceImages.map((imageSource, index) =>
    buildMultipartFile(fileField, imageSource, index)
  );

  return { fields, files };
}

function resolveModernProviderBodyMode(
  cfg: CustomProviderConfig,
  request: GenerateRequest,
): CustomProviderBodyMode | null {
  if (!isModernProviderConfig(cfg)) return null;
  if (
    isOpenAiImagesLikeModernProvider(cfg)
    && (request.reference_images?.length ?? 0) > 0
  ) {
    return 'multipart';
  }
  return null;
}

function resolveModelListUrl(cfg: CustomProviderConfig): string {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  const path = (cfg.modelListEndpointPath ?? '').trim() || '/models';
  return appendQueryParams(`${base}${path.startsWith('/') ? '' : '/'}${path}`, cfg.queryParams ?? {});
}

function resolveModernEndpointPath(cfg: CustomProviderConfig, request: GenerateRequest): string | null {
  if (!isModernProviderConfig(cfg)) return null;
  if (isOpenAiImagesLikeModernProvider(cfg) && (request.reference_images?.length ?? 0) > 0) {
    const editPath = cfg.extraParams?.imageEditEndpointPath;
    return typeof editPath === 'string' && editPath.trim()
      ? editPath.trim()
      : '/v1/images/edits';
  }
  const generationPath = cfg.extraParams?.imageGenerationEndpointPath;
  if (isOpenAiImagesLikeModernProvider(cfg) && typeof generationPath === 'string' && generationPath.trim()) {
    return generationPath.trim();
  }
  return null;
}

function resolveEndpointUrlForRequest(
  cfg: CustomProviderConfig,
  modelName: string,
  request: GenerateRequest,
  dynamicQueryParams?: Record<string, string>,
): string {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  const modernPath = resolveModernEndpointPath(cfg, request);
  const configuredPath = (modernPath ?? cfg.endpointPath ?? '').trim();
  const joined = configuredPath
    ? `${base}${configuredPath.startsWith('/') ? '' : '/'}${configuredPath}`
    : guessDefaultPath(cfg.apiStyle, base);
  const withModel = joined
    .replace(/\{model\}/g, encodeURIComponent(modelName))
    .replace(/\{modelId\}/g, encodeURIComponent(modelName));
  return appendQueryParams(withModel, {
    ...(cfg.queryParams ?? {}),
    ...(dynamicQueryParams ?? {}),
  });
}

function appendQueryParams(url: string, queryParams: Record<string, string>): string {
  const qs = Object.entries(queryParams)
    .filter(([k]) => k.trim())
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return qs ? `${url}${url.includes('?') ? '&' : '?'}${qs}` : url;
}

function queryParamValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value) && value.length === 0) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function buildQueryParamsFromRequestBody(body: unknown): Record<string, string> {
  const record = asPlainRecord(body);
  if (!record) return {};
  return Object.fromEntries(
    Object.entries(record)
      .map(([key, value]) => [key, queryParamValue(value)] as const)
      .filter((entry): entry is readonly [string, string] => Boolean(entry[0].trim()) && entry[1] !== null)
  );
}

function parseResponseText(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

function previewPayload(payload: unknown): string {
  if (typeof payload === 'string') return payload.slice(0, 300);
  try {
    return (JSON.stringify(payload) ?? String(payload)).slice(0, 300);
  } catch {
    return String(payload).slice(0, 300);
  }
}

function previewJsonPayload(payload: unknown, maxLength = 1000): string {
  let serialized: string;
  if (typeof payload === 'string') {
    serialized = payload;
  } else {
    try {
      serialized = JSON.stringify(payload, null, 2) ?? String(payload);
    } catch {
      serialized = String(payload);
    }
  }
  return serialized.length > maxLength ? `${serialized.slice(0, maxLength)}...` : serialized;
}

function normalizeAsyncStatusValue(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    return '';
  }
  return String(value).trim().toLowerCase();
}

function normalizeAsyncStatusValues(values: unknown, fallback: string[]): string[] {
  if (!Array.isArray(values)) return fallback;
  const normalized = values
    .map(normalizeAsyncStatusValue)
    .filter(Boolean);
  return normalized.length > 0 ? normalized : fallback;
}

function formatAsyncErrorValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'object') {
    return previewJsonPayload(value, 1000);
  }
  return null;
}

function pickFormattedErrorMessage(...values: unknown[]): string | null {
  for (const value of values) {
    const message = formatAsyncErrorValue(value);
    if (message) return message;
  }
  return null;
}

function buildImageNotFoundMessage(cfg: CustomProviderConfig, payload: unknown): string {
  const responseFormat = cfg.responseFormat ?? 'openai-images';
  const pathHint = cfg.extraParams?.responseImagePath
    ? `当前 responseImagePath=${String(cfg.extraParams.responseImagePath)}，请确认路径是否指向图片 URL/base64。`
    : '建议在高级参数里填写 extraParams.responseImagePath，例如 data[0].url、choices[0].message.content、results[0].url。';
  return `响应中未找到图片 URL（responseFormat=${responseFormat}）。${pathHint} 响应预览：${previewPayload(payload)}`;
}

function describeHttpError(status: number, payload: unknown, bodyMode: 'json' | 'multipart' | 'form-urlencoded' = 'json'): string {
  const preview = previewPayload(payload);
  if (status === 400) {
    if (bodyMode === 'multipart' && /content-type|multipart|form-data/i.test(preview)) {
      return `HTTP 400：上游仍认为 Content-Type 不正确。当前配置已识别为 multipart/form-data，实际 bodyMode=multipart，且请求未手动设置 Content-Type（由 reqwest 自动生成 boundary）。请检查 endpointPath、文件字段名 requestBodyHints.referenceImageField/multipart.fileField，以及上游是否还要求代理或预上传。上游返回：${preview}`;
    }
    if (bodyMode === 'form-urlencoded' && /content-type|urlencoded|url-encoded|x-www-form-urlencoded|form/i.test(preview)) {
      return `HTTP 400：上游仍认为 Content-Type 或表单字段不正确。当前配置已识别为 application/x-www-form-urlencoded，实际 bodyMode=form-urlencoded。请检查 endpointPath、requestBodyHints 字段映射和默认请求参数。上游返回：${preview}`;
    }
    return `HTTP 400：请求参数被上游拒绝。请检查 endpointPath、size/分辨率、requestBodyHints、默认请求参数。上游返回：${preview}`;
  }
  if (status === 401 || status === 403) {
    return `HTTP ${status}：鉴权失败。请检查 API Key、Authorization 方式、额外 Header、Referer/HTTP-Referer。上游返回：${preview}`;
  }
  if (status === 404) {
    return `HTTP 404：接口地址不存在。请检查 API 根地址和生图接口路径 endpointPath。上游返回：${preview}`;
  }
  if (status === 408 || status === 524) {
    return `HTTP ${status}：上游生成超时。请求已到达服务商，但同步接口未及时返回结果；建议确认是否有异步任务/轮询接口，或降低分辨率/换模型测试。上游返回：${preview}`;
  }
  if (status === 429) {
    return `HTTP 429：上游限流或额度不足。请稍后重试，或检查账号额度/并发限制。上游返回：${preview}`;
  }
  if (status >= 500) {
    return `HTTP ${status}：上游服务异常。请稍后重试或查看服务商状态。上游返回：${preview}`;
  }
  return `HTTP ${status}：${preview}`;
}

async function requestJson(
  url: string,
  options: {
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    bodyMode?: 'json' | 'multipart' | 'form-urlencoded';
    body?: unknown;
    multipart?: CustomHttpMultipartBody;
    timeoutMs?: number;
    errorPrefix?: string;
    networkRetryAttempts?: number;
    networkRetryDelayMs?: number;
    retryHttpStatuses?: number[];
  },
): Promise<{ status: number; parsed: unknown; text: string }> {
  const retryAttempts = Math.max(0, Math.floor(options.networkRetryAttempts ?? 0));
  const retryDelayMs = Math.max(200, Math.floor(options.networkRetryDelayMs ?? 800));
  const retryHttpStatuses = new Set(options.retryHttpStatuses ?? []);
  let lastNetworkError: unknown = null;
  let lastRetryableHttpError: HttpStatusError | null = null;
  for (let attempt = 0; attempt <= retryAttempts; attempt += 1) {
    try {
      const response = await customHttpRequest({
        url,
        method: options.method,
        headers: options.headers,
        bodyMode: options.bodyMode,
        body: options.body,
        multipart: options.multipart,
        timeoutMs: options.timeoutMs,
      });
      const parsed = parseResponseText(response.text);
      if (response.status < 200 || response.status >= 300) {
        const message = options.errorPrefix
          ? `${options.errorPrefix} ${response.status}：${previewPayload(parsed)}`
          : describeHttpError(response.status, parsed, options.bodyMode ?? 'json');
        if (retryHttpStatuses.has(response.status)) {
          lastRetryableHttpError = new RetryableHttpStatusError(message, response.status);
          if (attempt < retryAttempts) {
            await sleep(retryDelayMs * (attempt + 1));
            continue;
          }
          throw lastRetryableHttpError;
        }
        throw new HttpStatusError(message, response.status);
      }
      return { status: response.status, parsed, text: response.text };
    } catch (err) {
      if (err instanceof HttpStatusError) {
        throw err;
      }
      lastNetworkError = err;
      if (attempt < retryAttempts) {
        await sleep(retryDelayMs * (attempt + 1));
        continue;
      }
    }
  }
  if (lastRetryableHttpError) {
    throw lastRetryableHttpError;
  }
  const message = lastNetworkError instanceof Error ? lastNetworkError.message : String(lastNetworkError);
  throw new NetworkRequestError(
    `${options.errorPrefix ? `${options.errorPrefix} ` : ''}网络请求失败：${message}`
  );
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, delayMs));
}

function guessDefaultPath(apiStyle: string, base: string): string {
  switch (apiStyle) {
    case 'openai-compatible':
      return `${base}/images/generations`;
    case 'fal':
      return base;
    case 'stability':
      return `${base}/v2beta/stable-image/generate/core`;
    default:
      return base;
  }
}

function extractFirstImageUrl(cfg: CustomProviderConfig, payload: unknown): string | null {
  const hinted = extractByPath(cfg, payload, cfg.extraParams?.responseImagePath);
  if (hinted) return hinted;

  const format = cfg.responseFormat ?? 'openai-images';
  switch (format) {
    case 'openai-images': {
      const data = (payload as { data?: Array<{ url?: string; b64_json?: string } | string> }).data;
      const first = data?.[0];
      if (typeof first === 'string') return normalizeImageSourceForProvider(cfg, first);
      if (first?.url) return normalizeImageSourceForProvider(cfg, first.url);
      if (first?.b64_json) return normalizeImageSourceForProvider(cfg, first.b64_json);
      return scanForImageSource(cfg, payload);
    }
    case 'url-array': {
      if (Array.isArray(payload) && typeof payload[0] === 'string') {
        return normalizeImageSourceForProvider(cfg, payload[0]);
      }
      const maybe = (payload as { images?: unknown }).images;
      if (Array.isArray(maybe) && typeof maybe[0] === 'string') {
        return normalizeImageSourceForProvider(cfg, maybe[0] as string);
      }
      return null;
    }
    case 'data-url': {
      if (typeof payload === 'string') return normalizeImageSourceForProvider(cfg, payload);
      const maybe = (payload as { image?: string; data?: string }).image ?? (payload as { data?: string }).data;
      return typeof maybe === 'string' ? normalizeImageSourceForProvider(cfg, maybe) : null;
    }
    default: {
      return scanForImageSource(cfg, payload);
    }
  }
}

function scanForImageSource(cfg: CustomProviderConfig, payload: unknown): string | null {
  const stack: Array<{ value: unknown; keyPath: string; depth: number }> = [
    { value: payload, keyPath: '', depth: 0 },
  ];
  while (stack.length > 0) {
    const current = stack.pop();
    const v = current?.value;
    const keyPath = current?.keyPath?.toLowerCase() ?? '';
    const depth = current?.depth ?? 0;
    if (depth > 8) continue;
    if (typeof v === 'string') {
      const trimmed = v.trim();
      if (isProbablyImageSource(trimmed, keyPath)) return normalizeImageSourceForProvider(cfg, trimmed);
      const embedded = extractEmbeddedImageUrl(cfg, trimmed, keyPath);
      if (embedded) return embedded;
      const nested = parseNestedJsonString(trimmed);
      if (nested !== null) stack.push({ value: nested, keyPath, depth: depth + 1 });
    } else if (Array.isArray(v)) {
      v.forEach((item, index) => {
        const childPath = keyPath ? `${keyPath}.${index}` : String(index);
        stack.push({ value: item, keyPath: childPath, depth: depth + 1 });
      });
    } else if (v && typeof v === 'object') {
      Object.entries(v as Record<string, unknown>).forEach(([childKey, childValue]) => {
        const childPath = keyPath ? `${keyPath}.${childKey}` : childKey;
        stack.push({ value: childValue, keyPath: childPath, depth: depth + 1 });
      });
    }
  }
  return null;
}

function extractByPath(cfg: CustomProviderConfig, payload: unknown, rawPath: unknown): string | null {
  const current = getValueByPath(payload, rawPath);
  if (typeof current === 'string' && current.trim()) {
    const trimmed = current.trim();
    return isProbablyImageSource(trimmed, 'image')
      ? normalizeImageSourceForProvider(cfg, trimmed)
      : extractEmbeddedImageUrl(cfg, trimmed, 'image');
  }
  return scanForImageSource(cfg, current);
}

function getValueByPath(payload: unknown, rawPath: unknown): unknown {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return null;
  const path = rawPath
    .trim()
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map((part) => part.trim())
    .filter(Boolean);
  let current = payload;
  for (const part of path) {
    if (Array.isArray(current)) {
      current = current[Number(part)];
    } else if (current && typeof current === 'object') {
      current = (current as Record<string, unknown>)[part];
    } else {
      return null;
    }
  }
  return current;
}

function parseNestedJsonString(value: string): unknown | null {
  if (!value || value.length > 50000) return null;
  const first = value[0];
  if (first !== '{' && first !== '[') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeImageSource(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('data:image/')) return trimmed;
  const base64Like = /^[A-Za-z0-9+/=]+$/.test(trimmed) && trimmed.length > 300;
  return base64Like ? `data:image/png;base64,${trimmed}` : trimmed;
}

function normalizeImageSourceForProvider(cfg: CustomProviderConfig, value: string): string {
  const normalized = normalizeImageSource(value);
  if (
    normalized.startsWith('data:image/')
    || /^https?:\/\//i.test(normalized)
  ) {
    return normalized;
  }
  if (normalized.startsWith('//')) {
    const protocol = resolveProviderProtocol(cfg) ?? 'https:';
    return `${protocol}${normalized}`;
  }
  if (isRelativeImageSource(normalized, 'image')) {
    return absolutizeProviderUrl(cfg, normalized);
  }
  return normalized;
}

function resolveProviderProtocol(cfg: CustomProviderConfig): string | null {
  try {
    return new URL(cfg.baseUrl).protocol;
  } catch {
    return null;
  }
}

function absolutizeProviderUrl(cfg: CustomProviderConfig, value: string): string {
  try {
    const baseUrl = ensureBaseUrlDirectory(cfg.baseUrl);
    if (!baseUrl) return value;
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
}

function ensureBaseUrlDirectory(baseUrl: string): string | null {
  const trimmed = baseUrl.trim();
  if (!trimmed) return null;
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

function extractEmbeddedImageUrl(cfg: CustomProviderConfig, value: string, key: string): string | null {
  if (!value || value.length > 20000) return null;
  if (isDefinitelyNonImageUrlPath(key)) return null;
  const markdownImage = /!\[[^\]]*]\((https?:\/\/[^)\s]+)\)/i.exec(value);
  if (markdownImage?.[1]) return normalizeImageSourceForProvider(cfg, markdownImage[1]);

  if (!/(content|message|text|output|result|image|url)/i.test(key)) return null;
  const urls = value.match(/https?:\/\/[^\s"'<>）)]+/gi) ?? [];
  for (const raw of urls) {
    const candidate = raw.replace(/[.,;:!?，。；：！？]+$/g, '');
    if (isProbablyImageSource(candidate, 'image_url')) {
      return normalizeImageSourceForProvider(cfg, candidate);
    }
  }
  return null;
}

function isProbablyImageSource(value: string, key: string): boolean {
  if (!value) return false;
  if (isDefinitelyNonImageUrlPath(key)) return false;
  if (value.startsWith('data:image/')) return true;
  if (/^https?:\/\//i.test(value)) {
    if (/\.(png|jpg|jpeg|webp|gif|avif)(\?|$)/i.test(value)) return true;
    return /(image|images|img|output|result|asset|file|media|thumbnail|cover)/i.test(key);
  }
  if (isRelativeImageSource(value, key)) return true;
  return /^[A-Za-z0-9+/=]+$/.test(value)
    && value.length > 300
    && /(b64|base64|image|img|data|result|output)/i.test(key);
}

function isDefinitelyNonImageUrlPath(keyPath: string): boolean {
  if (!keyPath) return false;
  const normalized = keyPath.toLowerCase();
  return /(^|[._-])(status|poll|callback|webhook|request|submit|queue|endpoint|response)[._-]?url($|[._-])/.test(normalized)
    || /(^|[._-])url[._-]?(status|poll|callback|webhook|request|submit|queue|endpoint|response)($|[._-])/.test(normalized)
    || /(^|[._-])(status|polling|callback|webhook|request|submit|queue|endpoint)($|[._-])/.test(normalized);
}

function isRelativeImageSource(value: string, key: string): boolean {
  if (!value || /^[a-z][a-z0-9+.-]*:/i.test(value)) return false;
  if (/\s/.test(value)) return false;
  const hasImageExtension = /\.(png|jpg|jpeg|webp|gif|avif)(\?|$)/i.test(value);
  const pathLike = value.startsWith('/') || value.startsWith('./') || value.startsWith('../');
  const knownImagePath = /(^|\/)(images?|imgs?|assets?|files?|media|outputs?|results?|downloads?)(\/|$)/i.test(value);
  return (hasImageExtension || pathLike || knownImagePath)
    && /(image|img|url|output|result|asset|file)/i.test(key);
}

export async function submitCustomProviderJob(request: GenerateRequest): Promise<string> {
  const resolved = resolveProviderAndModel(request.model);
  const jobId = `custom-local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (!resolved) {
    cache.set(jobId, { job_id: jobId, status: 'failed', result: null, error: '未找到对应的自定义服务商配置' });
    return jobId;
  }
  const { cfg, model } = resolved;
  if (!hasCustomProviderCredential(cfg)) {
    cache.set(jobId, { job_id: jobId, status: 'failed', result: null, error: `${cfg.label} 未填写 API Key` });
    return jobId;
  }
  cache.set(jobId, { job_id: jobId, status: 'running', result: null, error: null });
  void runCustomProviderJob(jobId, cfg, model, request);
  return jobId;
}

async function runCustomProviderJob(
  jobId: string,
  cfg: CustomProviderConfig,
  model: string,
  request: GenerateRequest,
): Promise<void> {
  try {
    const parsed = await sendGenerationRequest(cfg, model, request);
    const imageUrl = await resolveGeneratedImageUrl(cfg, parsed, POLL_TIMEOUT_MS);
    if (!imageUrl) {
      cache.set(jobId, {
        job_id: jobId,
        status: 'failed',
        result: null,
        error: buildImageNotFoundMessage(cfg, parsed),
      });
      return;
    }
    let preparedImageSource: string;
    try {
      preparedImageSource = await materializeGeneratedImageSource(cfg, imageUrl);
    } catch (materializeError) {
      cache.set(jobId, {
        job_id: jobId,
        status: 'failed',
        result: asLightweightRetryResultSource(imageUrl),
        error: formatUnknownError(materializeError),
      });
      return;
    }
    cache.set(jobId, { job_id: jobId, status: 'succeeded', result: preparedImageSource, error: null });
  } catch (err) {
    cache.set(jobId, {
      job_id: jobId,
      status: 'failed',
      result: null,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function isRemoteHttpImageSource(source: string): boolean {
  return /^https?:\/\//i.test(source.trim());
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function asLightweightRetryResultSource(source: string): string | null {
  const trimmed = source.trim();
  if (!trimmed) return null;
  const normalizedPrefix = trimmed.slice(0, 16).toLowerCase();
  return normalizedPrefix.startsWith('data:') || normalizedPrefix.startsWith('blob:')
    ? null
    : trimmed;
}

function buildAuthenticatedImageFetchHeaders(cfg: CustomProviderConfig): Record<string, string> {
  const headers: Record<string, string> = {};
  if ((modernProviderKind(cfg) === 'google-gemini' || modernProviderKind(cfg) === 'google-video') && cfg.apiKey?.trim()) {
    headers['x-goog-api-key'] = cfg.apiKey.trim();
  } else if (cfg.apiKey?.trim()) {
    headers.Authorization = `Bearer ${cfg.apiKey.trim()}`;
  }
  Object.entries(cfg.extraHeaders ?? {}).forEach(([key, value]) => {
    const normalizedKey = key.trim();
    if (!normalizedKey || /^content-type$/i.test(normalizedKey)) {
      return;
    }
    headers[normalizedKey] = value;
  });
  return headers;
}

async function materializeGeneratedImageSource(
  cfg: CustomProviderConfig,
  imageSource: string,
): Promise<string> {
  if (!isRemoteHttpImageSource(imageSource)) {
    return imageSource;
  }

  try {
    const prepared = await prepareNodeImageSource(imageSource);
    return prepared.imagePath;
  } catch (publicError) {
    const authHeaders = buildAuthenticatedImageFetchHeaders(cfg);
    if (Object.keys(authHeaders).length === 0) {
      throw new Error(
        `已获取到生成结果地址，但图片下载或解析失败：${formatUnknownError(publicError)}`
      );
    }

    try {
      const prepared = await prepareNodeImageSourceWithHeaders(imageSource, authHeaders);
      return prepared.imagePath;
    } catch (authenticatedError) {
      throw new Error(
        [
          '已获取到生成结果地址，但图片下载或解析失败。',
          `无鉴权下载：${formatUnknownError(publicError)}`,
          `带服务商鉴权下载：${formatUnknownError(authenticatedError)}`,
        ].join('\n')
      );
    }
  }
}

function isRemoteHttpSource(source: string): boolean {
  return /^https?:\/\//i.test(source.trim());
}

function valueHasVideoExtension(value: string): boolean {
  return /\.(mp4|webm|mov|m4v|avi|mkv|mpeg|mpg)(\?|#|$)/i.test(value.trim());
}

function isProbablyVideoSource(value: string, key: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('data:video/')) return true;
  if (/^https?:\/\//i.test(trimmed)) {
    if (valueHasVideoExtension(trimmed)) return true;
    return /(video|videos|download|content|file|media|output|result|url)/i.test(key);
  }
  if (/^[A-Za-z0-9+/=]+$/.test(trimmed) && trimmed.length > 1000) {
    return /(video|mp4|webm|data|result|output|content)/i.test(key);
  }
  return false;
}

function normalizeVideoSource(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('data:video/')) return trimmed;
  const base64Like = /^[A-Za-z0-9+/=]+$/.test(trimmed) && trimmed.length > 1000;
  return base64Like ? `data:video/mp4;base64,${trimmed}` : trimmed;
}

function normalizeVideoSourceForProvider(cfg: CustomProviderConfig, value: string): string {
  const normalized = normalizeVideoSource(value);
  if (normalized.startsWith('data:video/') || /^https?:\/\//i.test(normalized)) {
    return normalized;
  }
  if (normalized.startsWith('//')) {
    const protocol = resolveProviderProtocol(cfg) ?? 'https:';
    return `${protocol}${normalized}`;
  }
  if (normalized.startsWith('/') || normalized.startsWith('./') || normalized.startsWith('../')) {
    return absolutizeProviderUrl(cfg, normalized);
  }
  return normalized;
}

function extractEmbeddedVideoUrl(cfg: CustomProviderConfig, value: string, key: string): string | null {
  if (!value || value.length > 30000) return null;
  if (!/(content|message|text|output|result|video|url|download)/i.test(key)) return null;
  const markdownVideo = /!?\[[^\]]*]\((https?:\/\/[^)\s]+)\)/i.exec(value);
  if (markdownVideo?.[1] && isProbablyVideoSource(markdownVideo[1], 'video_url')) {
    return normalizeVideoSourceForProvider(cfg, markdownVideo[1]);
  }
  const urls = value.match(/https?:\/\/[^\s"'<>）)]+/gi) ?? [];
  for (const raw of urls) {
    const candidate = raw.replace(/[.,;:!?，。；：！？]+$/g, '');
    if (isProbablyVideoSource(candidate, 'video_url')) {
      return normalizeVideoSourceForProvider(cfg, candidate);
    }
  }
  return null;
}

function scanFirstVideoSource(cfg: CustomProviderConfig, payload: unknown): string | null {
  const stack: Array<{ value: unknown; keyPath: string; depth: number }> = [
    { value: payload, keyPath: '', depth: 0 },
  ];
  while (stack.length > 0) {
    const current = stack.pop();
    const value = current?.value;
    const keyPath = current?.keyPath ?? '';
    const depth = current?.depth ?? 0;
    if (depth > 8) continue;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (isProbablyVideoSource(trimmed, keyPath)) {
        return normalizeVideoSourceForProvider(cfg, trimmed);
      }
      const embedded = extractEmbeddedVideoUrl(cfg, trimmed, keyPath);
      if (embedded) return embedded;
      const nested = parseNestedJsonString(trimmed);
      if (nested !== null) stack.push({ value: nested, keyPath, depth: depth + 1 });
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => {
        stack.push({ value: item, keyPath: keyPath ? `${keyPath}.${index}` : String(index), depth: depth + 1 });
      });
    } else if (value && typeof value === 'object') {
      Object.entries(value as Record<string, unknown>).forEach(([childKey, childValue]) => {
        stack.push({ value: childValue, keyPath: keyPath ? `${keyPath}.${childKey}` : childKey, depth: depth + 1 });
      });
    }
  }
  return null;
}

function extractFirstVideoSource(cfg: CustomProviderConfig, payload: unknown): string | null {
  const hintedPath =
    cfg.extraParams?.responseVideoPath
    ?? cfg.extraParams?.responseVideoUrlPath
    ?? cfg.extraParams?.videoPath
    ?? cfg.extraParams?.videoUrlPath;
  const hinted = extractVideoByPath(cfg, payload, hintedPath);
  if (hinted) return hinted;
  return scanFirstVideoSource(cfg, payload);
}

function extractVideoByPath(cfg: CustomProviderConfig, payload: unknown, rawPath: unknown): string | null {
  const current = getValueByPath(payload, rawPath);
  if (current === undefined || current === null) return null;
  if (typeof current === 'string' && current.trim()) {
    const trimmed = current.trim();
    return isProbablyVideoSource(trimmed, 'video')
      ? normalizeVideoSourceForProvider(cfg, trimmed)
      : extractEmbeddedVideoUrl(cfg, trimmed, 'video');
  }
  return scanFirstVideoSource(cfg, current);
}

function buildOpenAiVideoContentUrl(cfg: CustomProviderConfig, taskId: string): string {
  const configuredPath = typeof cfg.extraParams?.videoContentEndpointPath === 'string'
    ? cfg.extraParams.videoContentEndpointPath.trim()
    : '';
  const pathTemplate = configuredPath || `${resolveDefaultOpenAiVideoEndpointPath(cfg)}/{taskId}/content`;
  return resolveAsyncTaskUrl(cfg, pathTemplate, taskId);
}

function resolveDefaultOpenAiVideoEndpointPath(cfg: CustomProviderConfig): string {
  try {
    const path = new URL(cfg.baseUrl).pathname.replace(/\/+$/, '');
    return path.endsWith('/v1') ? '/videos' : DEFAULT_OPENAI_VIDEO_ENDPOINT_PATH;
  } catch {
    return DEFAULT_OPENAI_VIDEO_ENDPOINT_PATH;
  }
}

function buildVideoRequestFields(
  cfg: CustomProviderConfig,
  modelName: string,
  request: GenerateRequest,
): Record<string, unknown> {
  const defaultRequestParams = resolveDefaultRequestParams(cfg);
  const userExtra = { ...(request.extra_params ?? {}) } as Record<string, unknown>;
  const seconds =
    userExtra.seconds
    ?? userExtra.duration
    ?? defaultRequestParams.seconds
    ?? defaultRequestParams.duration;
  delete userExtra.seconds;
  delete userExtra.duration;
  delete userExtra.resolutionType;
  delete userExtra.aspect_ratio;
  delete userExtra.aspectRatio;
  delete userExtra.reference_images;
  delete userExtra.input_reference;
  delete userExtra.inputReference;

  return compactRecord({
    model: modelName,
    prompt: request.prompt,
    size: request.extra_params?.resolutionType ?? request.extra_params?.size ?? request.size,
    seconds,
    ...defaultRequestParams,
    ...userExtra,
  });
}

function resolveVideoSeconds(
  request: GenerateRequest,
  defaultRequestParams: Record<string, unknown>,
): number | undefined {
  const raw =
    request.extra_params?.seconds
    ?? request.extra_params?.duration
    ?? defaultRequestParams.seconds
    ?? defaultRequestParams.duration;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

function parseVideoPixelSize(value: unknown): { width: number; height: number } | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{2,5})x(\d{2,5})$/i.exec(value.trim());
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? { width, height }
    : null;
}

function normalizeVideoResolutionTier(value: unknown): '1k' | '2k' | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (/^(1k|720p|1280)$/.test(normalized)) return '1k';
  if (/^(2k|1080p|1920)$/.test(normalized)) return '2k';
  return null;
}

function normalizeVideoAspectRatio(value: unknown): '16:9' | '9:16' | '1:1' {
  if (typeof value !== 'string') return '16:9';
  const normalized = value.trim();
  return normalized === '9:16' || normalized === '1:1' ? normalized : '16:9';
}

const AGNES_VIDEO_SIZE_BY_TIER: Record<'1k' | '2k', Record<'16:9' | '9:16' | '1:1', { width: number; height: number }>> = {
  '1k': {
    '16:9': { width: 1280, height: 720 },
    '9:16': { width: 720, height: 1280 },
    '1:1': { width: 1024, height: 1024 },
  },
  '2k': {
    '16:9': { width: 1920, height: 1080 },
    '9:16': { width: 1080, height: 1920 },
    '1:1': { width: 1536, height: 1536 },
  },
};

function resolveAgnesVideoPixelSize(request: GenerateRequest, userExtra: Record<string, unknown>): { width: number; height: number } {
  const directSize =
    parseVideoPixelSize(request.size)
    ?? parseVideoPixelSize(userExtra.size)
    ?? parseVideoPixelSize(userExtra.resolutionType);
  if (directSize) return directSize;

  const tier = normalizeVideoResolutionTier(userExtra.resolutionType ?? userExtra.size ?? request.size);
  if (tier) {
    const aspectRatio = normalizeVideoAspectRatio(userExtra.aspectRatio ?? userExtra.aspect_ratio ?? request.aspect_ratio);
    return AGNES_VIDEO_SIZE_BY_TIER[tier][aspectRatio];
  }

  return AGNES_VIDEO_SIZE_BY_TIER['1k']['16:9'];
}

function normalizeAgnesFrameCount(seconds: number, frameRate: number): number {
  const requestedFrames = Math.max(1, Math.round(seconds * frameRate));
  const maxFrames = 441;
  const constrainedFrames = Math.min(requestedFrames, maxFrames);
  return Math.max(1, Math.floor((constrainedFrames - 1) / 8) * 8 + 1);
}

function buildAgnesVideoJsonBody(
  cfg: CustomProviderConfig,
  modelName: string,
  request: GenerateRequest,
): Record<string, unknown> {
  const defaultRequestParams = resolveDefaultRequestParams(cfg);
  const userExtra = { ...(request.extra_params ?? {}) } as Record<string, unknown>;
  const frameRateRaw = userExtra.frame_rate ?? userExtra.frameRate ?? defaultRequestParams.frame_rate ?? 24;
  const frameRate = Number(frameRateRaw);
  const normalizedFrameRate = Number.isFinite(frameRate) && frameRate > 0 ? frameRate : 24;
  const seconds = resolveVideoSeconds(request, defaultRequestParams) ?? 4;
  const pixelSize = resolveAgnesVideoPixelSize(request, userExtra);
  const referenceImage = request.reference_images?.[0];
  delete userExtra.seconds;
  delete userExtra.duration;
  delete userExtra.size;
  delete userExtra.resolutionType;
  delete userExtra.aspect_ratio;
  delete userExtra.aspectRatio;
  delete userExtra.reference_images;
  delete userExtra.input_reference;
  delete userExtra.inputReference;
  delete userExtra.image;
  delete userExtra.frameRate;

  return compactRecord({
    model: modelName,
    prompt: request.prompt,
    width: pixelSize.width,
    height: pixelSize.height,
    num_frames: normalizeAgnesFrameCount(seconds, normalizedFrameRate),
    frame_rate: normalizedFrameRate,
    ...defaultRequestParams,
    ...userExtra,
    ...(referenceImage ? {
      image: referenceImage,
      extra_body: {
        ...(asPlainRecord(defaultRequestParams.extra_body) ?? {}),
        ...(asPlainRecord(userExtra.extra_body) ?? {}),
        image: referenceImage,
      },
    } : {}),
  });
}

function buildXaiVideoJsonBody(
  cfg: CustomProviderConfig,
  modelName: string,
  request: GenerateRequest,
): Record<string, unknown> {
  const defaultRequestParams = resolveDefaultRequestParams(cfg);
  const userExtra = { ...(request.extra_params ?? {}) } as Record<string, unknown>;
  const seconds = resolveVideoSeconds(request, defaultRequestParams);
  const referenceImage = request.reference_images?.[0];
  delete userExtra.seconds;
  delete userExtra.duration;
  delete userExtra.size;
  delete userExtra.resolutionType;
  delete userExtra.aspect_ratio;
  delete userExtra.aspectRatio;
  delete userExtra.reference_images;
  delete userExtra.input_reference;
  delete userExtra.inputReference;
  delete userExtra.image;

  return compactRecord({
    model: modelName,
    prompt: request.prompt,
    duration: seconds,
    aspect_ratio: defaultRequestParams.aspect_ratio ?? '16:9',
    resolution: request.size,
    ...defaultRequestParams,
    ...userExtra,
    ...(referenceImage ? { image: { url: referenceImage } } : {}),
  });
}

function buildVolcengineSeedanceVideoJsonBody(
  cfg: CustomProviderConfig,
  modelName: string,
  request: GenerateRequest,
): Record<string, unknown> {
  const defaultRequestParams = resolveDefaultRequestParams(cfg);
  const userExtra = { ...(request.extra_params ?? {}) } as Record<string, unknown>;
  const seconds = resolveVideoSeconds(request, defaultRequestParams);
  const aspectRatio = userExtra.aspectRatio ?? userExtra.aspect_ratio ?? request.aspect_ratio;
  const resolution = userExtra.resolutionType ?? userExtra.size ?? request.size;
  const referenceImages = request.reference_images ?? [];
  delete userExtra.seconds;
  delete userExtra.duration;
  delete userExtra.size;
  delete userExtra.resolutionType;
  delete userExtra.aspect_ratio;
  delete userExtra.aspectRatio;
  delete userExtra.reference_images;
  delete userExtra.input_reference;
  delete userExtra.inputReference;

  const content = [
    ...referenceImages.map((url) => ({
      type: 'image_url',
      image_url: { url },
    })),
    {
      type: 'text',
      text: request.prompt,
    },
  ];

  return compactRecord({
    model: modelName,
    content,
    duration: seconds,
    ratio: aspectRatio && aspectRatio !== 'auto' ? aspectRatio : undefined,
    resolution,
    ...defaultRequestParams,
    ...userExtra,
  });
}

function buildVideoMultipartBody(
  cfg: CustomProviderConfig,
  modelName: string,
  request: GenerateRequest,
): CustomHttpMultipartBody {
  const fields: NonNullable<CustomHttpMultipartBody['fields']> = [];
  Object.entries(buildVideoRequestFields(cfg, modelName, request)).forEach(([key, value]) => {
    appendMultipartField(fields, key, value);
  });

  const rawReference =
    request.reference_images?.[0]
    ?? (typeof request.extra_params?.input_reference === 'string' ? request.extra_params.input_reference : undefined)
    ?? (typeof request.extra_params?.inputReference === 'string' ? request.extra_params.inputReference : undefined);
  const files: NonNullable<CustomHttpMultipartBody['files']> = [];
  if (typeof rawReference === 'string' && rawReference.trim()) {
    const fieldName = typeof cfg.extraParams?.videoReferenceField === 'string' && cfg.extraParams.videoReferenceField.trim()
      ? cfg.extraParams.videoReferenceField.trim()
      : 'input_reference';
    files.push(buildMultipartFile(fieldName, rawReference, 0));
  }
  return { fields, files };
}

function resolveVideoRequestBodyMode(cfg: CustomProviderConfig): 'json' | 'multipart' {
  const rawMode = cfg.extraParams?.videoRequestBodyMode ?? cfg.extraParams?.requestBodyMode;
  return rawMode === 'json' ? 'json' : 'multipart';
}

function buildVideoJsonBody(
  cfg: CustomProviderConfig,
  modelName: string,
  request: GenerateRequest,
): Record<string, unknown> {
  const providerKind = modernProviderKind(cfg);
  if (providerKind === 'agnes-video') {
    return buildAgnesVideoJsonBody(cfg, modelName, request);
  }
  if (providerKind === 'xai-grok-video') {
    return buildXaiVideoJsonBody(cfg, modelName, request);
  }
  if (providerKind === 'seedance-video') {
    return buildVolcengineSeedanceVideoJsonBody(cfg, modelName, request);
  }

  const body = buildVideoRequestFields(cfg, modelName, request);
  const references = request.reference_images ?? [];
  if (references.length > 0) {
    const fieldName = typeof cfg.extraParams?.videoReferenceField === 'string' && cfg.extraParams.videoReferenceField.trim()
      ? cfg.extraParams.videoReferenceField.trim()
      : 'reference_images';
    body[fieldName] = references.length === 1 ? references[0] : references;
  }
  return body;
}

function resolveVideoSubmitUrl(cfg: CustomProviderConfig, modelName: string, request: GenerateRequest): string {
  const configuredEndpointPath =
    typeof cfg.endpointPath === 'string' && cfg.endpointPath.trim()
      ? cfg.endpointPath.trim()
      : '';
  if (!configuredEndpointPath && cfg.extraParams?.requiresExplicitVideoEndpoint === true) {
    throw new Error(`${cfg.label} 需要先按服务商文档填写视频接口路径，不能使用默认 /v1/videos。`);
  }
  const endpointPath = configuredEndpointPath || resolveDefaultOpenAiVideoEndpointPath(cfg);
  return resolveEndpointUrlForRequest(
    { ...cfg, endpointPath },
    modelName,
    request,
  );
}

async function sendVideoGenerationRequest(
  cfg: CustomProviderConfig,
  model: string,
  request: GenerateRequest,
): Promise<unknown> {
  const method = cfg.httpMethod ?? 'POST';
  if (method !== 'POST') {
    throw new Error('视频生成接口当前仅支持 POST 提交任务。请将 httpMethod 设置为 POST。');
  }
  if (cfg.extraParams?.requiresDedicatedVideoGateway === true) {
    throw new Error(`${cfg.label} 的视频格式需要专用 gateway 组装请求体，当前模板仅保存官方字段元数据，不能直接提交。`);
  }
  const url = resolveVideoSubmitUrl(cfg, model, request);
  const bodyMode = resolveVideoRequestBodyMode(cfg);
  const headers = buildRequestHeaders(cfg, bodyMode, method);
  const multipart = bodyMode === 'multipart' ? buildVideoMultipartBody(cfg, model, request) : undefined;
  const body = bodyMode === 'json' ? buildVideoJsonBody(cfg, model, request) : undefined;
  const { parsed } = await requestJson(url, {
    method,
    headers,
    bodyMode,
    body,
    multipart,
    timeoutMs: GENERATION_REQUEST_TIMEOUT_MS,
  });
  return parsed;
}

function resolveVideoStatusEndpointPath(cfg: CustomProviderConfig): string {
  const configured = typeof cfg.extraParams?.videoStatusEndpointPath === 'string'
    ? cfg.extraParams.videoStatusEndpointPath.trim()
    : '';
  if (configured) return configured;
  const submitPath = (cfg.endpointPath ?? resolveDefaultOpenAiVideoEndpointPath(cfg)).trim()
    || resolveDefaultOpenAiVideoEndpointPath(cfg);
  return `${submitPath.replace(/\/+$/, '')}/{taskId}`;
}

async function resolveGeneratedVideoSource(
  cfg: CustomProviderConfig,
  parsed: unknown,
): Promise<string | null> {
  const unwrappedParsed = unwrapProviderPayload(parsed);
  const direct =
    extractFirstVideoSource(cfg, parsed)
    ?? (Object.is(unwrappedParsed, parsed) ? null : extractFirstVideoSource(cfg, unwrappedParsed));
  if (direct) return direct;

  const configuredTaskIdPath = typeof cfg.extraParams?.videoTaskIdPath === 'string' ? cfg.extraParams.videoTaskIdPath : '';
  const taskIdRaw = configuredTaskIdPath
    ? getValueByPath(parsed, configuredTaskIdPath)
    : extractTaskId(parsed);
  const taskId = typeof taskIdRaw === 'string' && taskIdRaw.trim()
    ? taskIdRaw.trim()
    : (typeof taskIdRaw === 'number' && Number.isFinite(taskIdRaw) ? String(taskIdRaw) : null);
  if (!taskId) return null;
  const statusPath = typeof cfg.extraParams?.videoStatusPath === 'string' ? cfg.extraParams.videoStatusPath : 'status';
  const errorPath = typeof cfg.extraParams?.videoErrorPath === 'string' ? cfg.extraParams.videoErrorPath : 'error';
  const pendingValues = normalizeAsyncStatusValues(
    cfg.extraParams?.videoPendingValues,
    ['queued', 'running', 'processing', 'pending', 'in_progress'],
  );
  const successValues = normalizeAsyncStatusValues(
    cfg.extraParams?.videoSuccessValues,
    ['succeeded', 'success', 'completed', 'complete', 'done', 'finished'],
  );
  const failedValues = normalizeAsyncStatusValues(
    cfg.extraParams?.videoFailedValues,
    ['failed', 'error', 'canceled', 'cancelled'],
  );
  const intervalMs = Number.isFinite(Number(cfg.extraParams?.videoPollIntervalMs))
    ? Math.max(500, Number(cfg.extraParams?.videoPollIntervalMs))
    : RESULT_POLL_INTERVAL_MS;
  const timeoutMs = Number.isFinite(Number(cfg.extraParams?.videoPollTimeoutMs))
    ? Math.max(5000, Number(cfg.extraParams?.videoPollTimeoutMs))
    : VIDEO_POLL_TIMEOUT_MS;
  const statusEndpointPath = resolveVideoStatusEndpointPath(cfg);
  const startedAt = Date.now();
  let pollCount = 0;
  let consecutiveNetworkFailures = 0;

  while (Date.now() - startedAt < timeoutMs) {
    if (pollCount > 0) {
      await sleep(intervalMs);
    }
    pollCount += 1;

    let payload: unknown;
    try {
      const response = await requestJson(resolveAsyncTaskUrl(cfg, statusEndpointPath, taskId), {
        method: 'GET',
        headers: buildRequestHeaders(cfg, 'json', 'GET'),
        timeoutMs: RESULT_POLL_REQUEST_TIMEOUT_MS,
        errorPrefix: '视频状态轮询失败 HTTP',
        networkRetryAttempts: RESULT_POLL_NETWORK_RETRY_ATTEMPTS,
        networkRetryDelayMs: 700,
        retryHttpStatuses: RESULT_POLL_RETRY_HTTP_STATUSES,
      });
      payload = response.parsed;
      consecutiveNetworkFailures = 0;
    } catch (err) {
      if (err instanceof NetworkRequestError || err instanceof RetryableHttpStatusError) {
        consecutiveNetworkFailures += 1;
        if (consecutiveNetworkFailures < RESULT_POLL_MAX_CONSECUTIVE_NETWORK_FAILURES) {
          continue;
        }
        throw new Error(`视频状态接口连续临时请求失败 ${consecutiveNetworkFailures} 次，已停止轮询。最后错误：${err.message}`);
      }
      throw err;
    }

    const unwrapped = unwrapProviderPayload(payload);
    const videoSource =
      extractFirstVideoSource(cfg, payload)
      ?? (Object.is(unwrapped, payload) ? null : extractFirstVideoSource(cfg, unwrapped));
    if (videoSource) return videoSource;

    const statusRaw =
      getValueByPath(payload, statusPath)
      ?? getValueByPath(unwrapped, statusPath);
    const status = normalizeAsyncStatusValue(statusRaw);
    if (status && failedValues.includes(status)) {
      const messageRaw =
        getValueByPath(payload, errorPath)
        ?? getValueByPath(unwrapped, errorPath);
      throw new Error(formatAsyncErrorValue(messageRaw) ?? `视频任务失败：${status}`);
    }
    if (status && successValues.includes(status)) {
      const providerKind = modernProviderKind(cfg);
      if (providerKind === 'openai-videos' || providerKind === 'openai-video-compatible') {
        return buildOpenAiVideoContentUrl(cfg, taskId);
      }
      throw new Error(`视频任务状态为 ${status}，但未按 responseVideoPath/videoUrlPath 找到视频 URL。请检查响应路径配置。`);
    }
    if (status && !pendingValues.includes(status)) {
      console.warn('[CustomProvider] unrecognized video status, keep polling', { status, taskId });
    }
  }

  throw new Error('视频任务轮询超时，未获取到结果');
}

async function materializeGeneratedVideoSource(
  cfg: CustomProviderConfig,
  videoSource: string,
): Promise<string> {
  const authHeaders = buildAuthenticatedImageFetchHeaders(cfg);
  if (!isRemoteHttpSource(videoSource)) {
    return await persistVideoSource(videoSource, Object.keys(authHeaders).length > 0 ? authHeaders : undefined);
  }

  try {
    return await persistVideoSource(videoSource);
  } catch (publicError) {
    if (Object.keys(authHeaders).length === 0) {
      throw new Error(
        `已获取到生成视频地址，但视频下载或解析失败：${formatUnknownError(publicError)}`
      );
    }
    try {
      return await persistVideoSource(videoSource, authHeaders);
    } catch (authenticatedError) {
      throw new Error(
        [
          '已获取到生成视频地址，但视频下载或解析失败。',
          `无鉴权下载：${formatUnknownError(publicError)}`,
          `带服务商鉴权下载：${formatUnknownError(authenticatedError)}`,
        ].join('\n')
      );
    }
  }
}

export async function submitCustomVideoJob(request: GenerateRequest): Promise<string> {
  const resolved = resolveProviderAndModel(request.model);
  const jobId = `custom-local-video-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (!resolved) {
    cache.set(jobId, { job_id: jobId, status: 'failed', result: null, error: '未找到对应的视频服务商配置' });
    return jobId;
  }
  const { cfg, model } = resolved;
  if (!hasCustomProviderCredential(cfg)) {
    cache.set(jobId, { job_id: jobId, status: 'failed', result: null, error: `${cfg.label} 未填写 API Key` });
    return jobId;
  }
  cache.set(jobId, { job_id: jobId, status: 'running', result: null, error: null });
  void runCustomVideoJob(jobId, cfg, model, request);
  return jobId;
}

async function runCustomVideoJob(
  jobId: string,
  cfg: CustomProviderConfig,
  model: string,
  request: GenerateRequest,
): Promise<void> {
  try {
    const parsed = await sendVideoGenerationRequest(cfg, model, request);
    const videoSource = await resolveGeneratedVideoSource(cfg, parsed);
    if (!videoSource) {
      cache.set(jobId, {
        job_id: jobId,
        status: 'failed',
        result: null,
        error: `响应中未找到视频任务或视频 URL。响应预览：${previewPayload(parsed)}`,
      });
      return;
    }
    let preparedVideoSource: string;
    try {
      preparedVideoSource = await materializeGeneratedVideoSource(cfg, videoSource);
    } catch (materializeError) {
      cache.set(jobId, {
        job_id: jobId,
        status: 'failed',
        result: asLightweightRetryResultSource(videoSource),
        error: formatUnknownError(materializeError),
      });
      return;
    }
    cache.set(jobId, { job_id: jobId, status: 'succeeded', result: preparedVideoSource, error: null });
  } catch (err) {
    cache.set(jobId, {
      job_id: jobId,
      status: 'failed',
      result: null,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function sendGenerationRequest(
  cfg: CustomProviderConfig,
  model: string,
  request: GenerateRequest,
  timeoutMs?: number,
): Promise<unknown> {
  const method = cfg.httpMethod ?? 'POST';
  const bodyMode = resolveModernProviderBodyMode(cfg, request)
    ?? resolveCustomProviderBodyMode(cfg, request.extra_params);
  if (bodyMode === 'signed') {
    throw new Error(
      '该配置被识别为签名鉴权/代理路线（signed_proxy_required）。当前通用直连不会生成 AK/SK、时间戳或 Action 签名；请改为后端代理后的普通 JSON/multipart 接口，或重新导入为可直连预设。'
    );
  }
  const body = bodyMode === 'json' || bodyMode === 'form-urlencoded'
    ? buildRequestBody(cfg, model, request)
    : undefined;
  const multipart = bodyMode === 'multipart' ? buildMultipartBody(cfg, model, request) : undefined;
  const url = resolveEndpointUrlForRequest(
    cfg,
    model,
    request,
    method === 'GET' && body ? buildQueryParamsFromRequestBody(body) : undefined,
  );
  const headers = buildRequestHeaders(cfg, bodyMode, method);
  const { parsed } = await requestJson(url, {
    method,
    headers,
    bodyMode,
    body: method === 'POST' && (bodyMode === 'json' || bodyMode === 'form-urlencoded') ? body : undefined,
    multipart: method === 'POST' && bodyMode === 'multipart' ? multipart : undefined,
    timeoutMs: timeoutMs ?? GENERATION_REQUEST_TIMEOUT_MS,
  });
  return parsed;
}

function maskAuthorizationHeaderValue(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^(\S+)\s+(.+)$/);
  if (!match) {
    if (trimmed.length <= 10) return '***';
    return `${trimmed.slice(0, 4)}***${trimmed.slice(-4)}`;
  }
  const [, scheme, token] = match;
  if (token.length <= 10) {
    return `${scheme} ***`;
  }
  return `${scheme} ${token.slice(0, 4)}***${token.slice(-4)}`;
}

function summarizePreviewPayload(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.startsWith('data:')) {
      const [meta, payload = ''] = value.split(',', 2);
      if (payload.length <= 140) {
        return value;
      }
      return `${meta},${payload.slice(0, 96)}...${payload.slice(-24)}(${payload.length} chars)`;
    }
    if (value.length > 600) {
      return `${value.slice(0, 300)}...${value.slice(-80)}(${value.length} chars)`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => summarizePreviewPayload(item));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(record).map(([key, entryValue]) => [key, summarizePreviewPayload(entryValue)])
  );
}

export function buildCustomProviderRequestDebugPreview(
  request: GenerateRequest
): CustomProviderRequestDebugPreview | null {
  const resolved = resolveProviderAndModel(request.model);
  if (!resolved) return null;
  const { cfg, model } = resolved;
  const method = cfg.httpMethod ?? 'POST';
  const bodyMode = resolveCustomProviderBodyMode(cfg, request.extra_params);
  const body = bodyMode === 'json' || bodyMode === 'form-urlencoded'
    ? buildRequestBody(cfg, model, request)
    : undefined;
  const multipart = bodyMode === 'multipart' ? buildMultipartBody(cfg, model, request) : undefined;
  const url = resolveEndpointUrlForRequest(
    cfg,
    model,
    request,
    method === 'GET' && body ? buildQueryParamsFromRequestBody(body) : undefined,
  );
  const rawHeaders = buildRequestHeaders(cfg, bodyMode, method);
  const headers = Object.fromEntries(
    Object.entries(rawHeaders).map(([key, value]) => [
      key,
      /^authorization$/i.test(key) ? maskAuthorizationHeaderValue(value) : value,
    ])
  );

  return {
    providerLabel: cfg.label,
    providerId: cfg.id,
    modelId: request.model,
    modelName: model,
    method,
    bodyMode,
    url,
    headers,
    body: summarizePreviewPayload(body),
    multipart: summarizePreviewPayload(multipart) as CustomHttpMultipartBody | undefined,
  };
}

function unwrapProviderPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const record = payload as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, 'code') && !isSuccessApiCode(record.code)) {
    const message = pickFormattedErrorMessage(record.msg, record.message, record.detail, record.error)
      ?? 'unknown error';
    throw new Error(`API code ${record.code}：${message}`);
  }
  return Object.prototype.hasOwnProperty.call(record, 'data') ? record.data : payload;
}

function isSuccessApiCode(code: unknown): boolean {
  if (typeof code === 'number') {
    return code === 0 || code === 200;
  }
  if (typeof code === 'string') {
    const normalized = code.trim().toLowerCase();
    if (!normalized) return true;
    const numeric = Number(normalized);
    if (Number.isFinite(numeric)) {
      return numeric === 0 || numeric === 200;
    }
    return normalized === 'ok' || normalized === 'success' || normalized === 'succeeded';
  }
  return true;
}

function extractTaskId(payload: unknown): string | null {
  const unwrapped = unwrapProviderPayload(payload);
  if (!unwrapped || typeof unwrapped !== 'object' || Array.isArray(unwrapped)) return null;
  const record = unwrapped as Record<string, unknown>;
  const candidates = [record.id, record.task_id, record.taskId, record.job_id, record.jobId, record.request_id, record.requestId, record.name];
  const found = candidates.find((value) => typeof value === 'string' && value.trim());
  return typeof found === 'string' ? found.trim() : null;
}

function resolveAsyncTaskConfig(cfg: CustomProviderConfig): AsyncTaskConfig | null {
  const raw = cfg.extraParams?.asyncTask;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record.enabled === false) return null;
  const resultEndpointPath = typeof record.resultEndpointPath === 'string' ? record.resultEndpointPath.trim() : '';
  if (!resultEndpointPath) return null;
  const resultMethod = String(record.resultMethod ?? 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET';
  const configuredIntervalMs = Number.isFinite(Number(record.intervalMs)) ? Math.max(500, Number(record.intervalMs)) : RESULT_POLL_INTERVAL_MS;
  const configuredTimeoutMs = Number.isFinite(Number(record.timeoutMs)) ? Math.max(5000, Number(record.timeoutMs)) : POLL_TIMEOUT_MS;
  const grsaiLike = isGrsaiLikeProvider(cfg);
  return {
    resultEndpointPath,
    resultMethod,
    taskIdPath: typeof record.taskIdPath === 'string' ? record.taskIdPath : undefined,
    imagePath: typeof record.imagePath === 'string' ? record.imagePath : undefined,
    statusPath: typeof record.statusPath === 'string' ? record.statusPath : undefined,
    pendingValues: normalizeAsyncStatusValues(
      record.pendingValues,
      ['queued', 'running', 'processing', 'starting', 'pending'],
    ),
    successValues: normalizeAsyncStatusValues(
      record.successValues,
      ['succeeded', 'success', 'completed', 'complete', 'done', 'finished'],
    ),
    failedValues: normalizeAsyncStatusValues(
      record.failedValues,
      ['failed', 'error', 'canceled', 'cancelled'],
    ),
    errorPath: typeof record.errorPath === 'string' ? record.errorPath : undefined,
    requestBody: record.requestBody,
    intervalMs: grsaiLike ? Math.min(configuredIntervalMs, RESULT_POLL_INTERVAL_MS) : configuredIntervalMs,
    timeoutMs: grsaiLike ? Math.max(configuredTimeoutMs, 180000) : configuredTimeoutMs,
  };
}

function resolveAsyncTaskUrl(cfg: CustomProviderConfig, pathTemplate: string, taskId: string): string {
  const filled = pathTemplate.replace(/\{taskId\}/g, encodeURIComponent(taskId));
  if (/^https?:\/\//i.test(filled)) return appendQueryParams(filled, cfg.queryParams ?? {});
  const base = cfg.baseUrl.replace(/\/+$/, '');
  return appendQueryParams(`${base}${filled.startsWith('/') ? '' : '/'}${filled}`, cfg.queryParams ?? {});
}

function fillTaskTemplate(value: unknown, taskId: string): unknown {
  if (typeof value === 'string') return value.replace(/\{taskId\}/g, taskId);
  if (Array.isArray(value)) return value.map((item) => fillTaskTemplate(item, taskId));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, fillTaskTemplate(item, taskId)]));
  }
  return value;
}

async function pollAsyncTaskResult(
  cfg: CustomProviderConfig,
  submitPayload: unknown,
  config: AsyncTaskConfig,
): Promise<string | null> {
  const payloadAtSubmit = unwrapProviderPayload(submitPayload);
  const immediate = config.imagePath
    ? extractByPath(cfg, submitPayload, config.imagePath) ?? extractByPath(cfg, payloadAtSubmit, config.imagePath)
    : extractFirstImageUrl(cfg, payloadAtSubmit);
  if (immediate) return immediate;

  const unwrappedSubmitPayload = unwrapProviderPayload(submitPayload);
  const taskIdRaw = config.taskIdPath
    ? (getValueByPath(submitPayload, config.taskIdPath) ?? getValueByPath(unwrappedSubmitPayload, config.taskIdPath))
    : extractTaskId(submitPayload);
  const taskId = typeof taskIdRaw === 'string' && taskIdRaw.trim()
    ? taskIdRaw.trim()
    : (typeof taskIdRaw === 'number' && Number.isFinite(taskIdRaw) ? String(taskIdRaw) : null);
  if (!taskId) return null;

  const startedAt = Date.now();
  let pollCount = 0;
  let consecutiveNetworkFailures = 0;
  while (Date.now() - startedAt < config.timeoutMs) {
    if (pollCount > 0) {
      await sleep(config.intervalMs);
    }
    pollCount += 1;
    const url = resolveAsyncTaskUrl(cfg, config.resultEndpointPath, taskId);
    let parsed: unknown;
    try {
      const response = await requestJson(url, {
        method: config.resultMethod,
        headers: buildRequestHeaders(cfg, 'json', config.resultMethod),
        body: config.resultMethod === 'POST'
          ? fillTaskTemplate(config.requestBody ?? { id: '{taskId}' }, taskId)
          : undefined,
        timeoutMs: RESULT_POLL_REQUEST_TIMEOUT_MS,
        errorPrefix: '轮询失败 HTTP',
        networkRetryAttempts: RESULT_POLL_NETWORK_RETRY_ATTEMPTS,
        networkRetryDelayMs: 700,
        retryHttpStatuses: RESULT_POLL_RETRY_HTTP_STATUSES,
      });
      parsed = response.parsed;
      consecutiveNetworkFailures = 0;
    } catch (err) {
      if (err instanceof NetworkRequestError || err instanceof RetryableHttpStatusError) {
        consecutiveNetworkFailures += 1;
        if (consecutiveNetworkFailures < RESULT_POLL_MAX_CONSECUTIVE_NETWORK_FAILURES) {
          continue;
        }
        throw new Error(`结果接口连续临时请求失败 ${consecutiveNetworkFailures} 次，已停止轮询。最后错误：${err.message}`);
      }
      throw err;
    }

    const payload = unwrapProviderPayload(parsed);
    const imageUrl = config.imagePath
      ? extractByPath(cfg, parsed, config.imagePath) ?? extractByPath(cfg, payload, config.imagePath)
      : extractFirstImageUrl(cfg, payload);
    if (imageUrl) return imageUrl;

    const statusRaw = config.statusPath
      ? (getValueByPath(parsed, config.statusPath) ?? getValueByPath(payload, config.statusPath))
      : null;
    const status = normalizeAsyncStatusValue(statusRaw);
    if (status && config.failedValues.includes(status)) {
      const messageRaw = config.errorPath
        ? (getValueByPath(parsed, config.errorPath) ?? getValueByPath(payload, config.errorPath))
        : null;
      throw new Error(formatAsyncErrorValue(messageRaw) ?? `任务失败：${status}`);
    }
    if (status && config.successValues.includes(status)) {
      throw new Error(`任务状态为 ${status}，但未按 imagePath/responseImagePath 找到图片 URL。请检查响应路径配置。`);
    }
  }
  throw new Error('任务轮询超时，未获取到图片');
}

function resolveGrsaiResultUrl(cfg: CustomProviderConfig): string {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  return appendQueryParams(`${base}/v1/draw/result`, cfg.queryParams ?? {});
}

async function pollGrsaiLikeResult(
  cfg: CustomProviderConfig,
  submitPayload: unknown,
  timeoutMs: number,
): Promise<string | null> {
  const unwrappedSubmitPayload = unwrapProviderPayload(submitPayload);
  const immediate =
    extractFirstImageUrl(cfg, submitPayload)
    ?? (Object.is(unwrappedSubmitPayload, submitPayload)
      ? null
      : extractFirstImageUrl(cfg, unwrappedSubmitPayload));
  if (immediate) return immediate;
  const taskId = extractTaskId(submitPayload);
  if (!taskId) return null;

  const startedAt = Date.now();
  let pollCount = 0;
  let consecutiveNetworkFailures = 0;
  while (Date.now() - startedAt < timeoutMs) {
    if (pollCount > 0) {
      await sleep(RESULT_POLL_INTERVAL_MS);
    }
    pollCount += 1;
    let parsed: unknown;
    try {
      const response = await requestJson(resolveGrsaiResultUrl(cfg), {
        method: 'POST',
        headers: buildRequestHeaders(cfg, 'json', 'POST'),
        body: { id: taskId },
        timeoutMs: RESULT_POLL_REQUEST_TIMEOUT_MS,
        errorPrefix: '轮询失败 HTTP',
        networkRetryAttempts: RESULT_POLL_NETWORK_RETRY_ATTEMPTS,
        networkRetryDelayMs: 700,
        retryHttpStatuses: RESULT_POLL_RETRY_HTTP_STATUSES,
      });
      parsed = response.parsed;
      consecutiveNetworkFailures = 0;
    } catch (err) {
      if (err instanceof NetworkRequestError || err instanceof RetryableHttpStatusError) {
        consecutiveNetworkFailures += 1;
        if (consecutiveNetworkFailures < RESULT_POLL_MAX_CONSECUTIVE_NETWORK_FAILURES) {
          continue;
        }
        throw new Error(`GRSAI 结果接口连续临时请求失败 ${consecutiveNetworkFailures} 次，已停止轮询。最后错误：${err.message}`);
      }
      throw err;
    }
    const payload = unwrapProviderPayload(parsed);
    const imageUrl =
      extractFirstImageUrl(cfg, parsed)
      ?? (Object.is(payload, parsed) ? null : extractFirstImageUrl(cfg, payload));
    if (imageUrl) return imageUrl;
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const rawRecord =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : null;
      const payloadRecord = payload as Record<string, unknown>;
      const status = normalizeAsyncStatusValue(rawRecord?.status ?? payloadRecord.status ?? '');
      if (status === 'failed' || status === 'error') {
        throw new Error(pickFormattedErrorMessage(
          rawRecord?.error,
          rawRecord?.message,
          rawRecord?.detail,
          rawRecord?.failure_reason,
          payloadRecord.error,
          payloadRecord.message,
          payloadRecord.detail,
          payloadRecord.failure_reason,
        ) ?? '任务失败');
      }
    }
  }
  throw new Error('任务轮询超时，未获取到图片');
}

async function resolveGeneratedImageUrl(
  cfg: CustomProviderConfig,
  parsed: unknown,
  fallbackTimeoutMs: number,
): Promise<string | null> {
  const unwrappedParsed = unwrapProviderPayload(parsed);
  const direct =
    extractFirstImageUrl(cfg, parsed)
    ?? (Object.is(unwrappedParsed, parsed) ? null : extractFirstImageUrl(cfg, unwrappedParsed));
  if (direct) return direct;

  const asyncTask = resolveAsyncTaskConfig(cfg);
  let asyncTaskError: unknown = null;
  if (asyncTask) {
    try {
      const imageUrl = await pollAsyncTaskResult(cfg, parsed, {
        ...asyncTask,
        timeoutMs: Math.max(asyncTask.timeoutMs, fallbackTimeoutMs),
      });
      if (imageUrl) return imageUrl;
    } catch (err) {
      asyncTaskError = err;
    }
  }

  if (isGrsaiLikeProvider(cfg)) {
    const imageUrl = await pollGrsaiLikeResult(cfg, parsed, fallbackTimeoutMs);
    if (imageUrl) return imageUrl;
  }

  if (asyncTaskError) {
    throw asyncTaskError;
  }
  return null;
}

export function getCustomProviderJob(jobId: string): GenerationJobStatus {
  const cached = cache.get(jobId);
  if (!cached) return { job_id: jobId, status: 'not_found', result: null, error: 'job id not found' };
  return cached;
}

/**
 * One-shot connectivity test for a draft custom provider. Meant to be wired
 * up to the 添加服务商 / 我的配置 form's 「测试连通」 button so the user can
 * verify their config before saving.
 *
 * Sends a minimal generation request (prompt = "a small red square") to the
 * configured endpoint and tries to extract an image URL from the response.
 *
 * Returns a rich result so the UI can show both success (image URL, HTTP
 * status) and specific failures (CORS, 4xx, parse-miss).
 */
export interface CustomProviderTestResult {
  ok: boolean;
  status?: number;
  imageUrl?: string;
  errorMessage?: string;
  rawPreview?: string;
}

export interface CustomProviderModelListResult {
  ok: boolean;
  models: string[];
  status?: number;
  errorMessage?: string;
  rawPreview?: string;
}

function extractModelIds(payload: unknown): string[] {
  const ids = new Set<string>();
  const pushString = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) {
      ids.add(value.trim());
    }
  };

  if (Array.isArray(payload)) {
    payload.forEach((item) => {
      if (typeof item === 'string') {
        pushString(item);
      } else if (item && typeof item === 'object') {
        pushString((item as { id?: unknown }).id);
        pushString((item as { name?: unknown }).name);
        pushString((item as { model?: unknown }).model);
      }
    });
  }

  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    const candidates = [record.data, record.models, record.items, record.result];
    candidates.forEach((candidate) => {
      if (Array.isArray(candidate)) {
        candidate.forEach((item) => {
          if (typeof item === 'string') {
            pushString(item);
          } else if (item && typeof item === 'object') {
            pushString((item as { id?: unknown }).id);
            pushString((item as { name?: unknown }).name);
            pushString((item as { model?: unknown }).model);
          }
        });
      }
    });
  }

  return Array.from(ids).sort((a, b) => a.localeCompare(b));
}

export async function fetchCustomProviderModels(
  cfg: CustomProviderConfig,
): Promise<CustomProviderModelListResult> {
  if (!hasCustomProviderCredential(cfg)) {
    return { ok: false, models: [], errorMessage: '未填写 API Key，无法获取模型列表' };
  }
  if (!cfg.baseUrl?.trim()) {
    return { ok: false, models: [], errorMessage: '未填写 API 根地址' };
  }

  const url = resolveModelListUrl(cfg);
  const headers = buildRequestHeaders(cfg, 'json', 'GET');

  try {
    const { status, parsed, text } = await requestJson(url, {
      method: 'GET',
      headers,
      timeoutMs: 20000,
    });
    const rawPreview = text.slice(0, 300);
    const models = extractModelIds(parsed);
    if (models.length === 0) {
      return { ok: false, models: [], status, errorMessage: '响应中没有识别到模型 id', rawPreview };
    }
    return { ok: true, models, status, rawPreview };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, models: [], errorMessage: `请求失败：${msg}` };
  }
}

export async function testCustomProviderConnectivity(
  cfg: CustomProviderConfig,
  testModelId?: string,
): Promise<CustomProviderTestResult> {
  if (!hasCustomProviderCredential(cfg)) {
    return { ok: false, errorMessage: '未填写 API Key，无法发起测试请求' };
  }
  if (!cfg.baseUrl?.trim()) {
    return { ok: false, errorMessage: '未填写 API 根地址' };
  }
  const modelName = testModelId ?? cfg.models?.[0] ?? 'default';
  const request = {
    prompt: 'a small red square, test pattern',
    model: `custom:${cfg.id}:${modelName}`,
    size: isVideoCustomProvider(cfg) ? (cfg.supportedResolutions?.[0] ?? '1280x720') : '1K',
    aspect_ratio: '1:1',
    reference_images: [],
    extra_params: isVideoCustomProvider(cfg) ? { seconds: 1 } : {},
  } as GenerateRequest;
  try {
    if (isVideoCustomProvider(cfg)) {
      const parsed = await sendVideoGenerationRequest(cfg, modelName, request);
      const rawPreview = JSON.stringify(parsed).slice(0, 300);
      const videoSource =
        extractFirstVideoSource(cfg, parsed)
        ?? (extractTaskId(parsed) ? 'pending-video-task' : null);
      if (videoSource) {
        return { ok: true, status: 200, imageUrl: videoSource, rawPreview };
      }
      return {
        ok: false,
        status: 200,
        errorMessage: `响应中未找到视频任务或视频 URL。响应预览：${previewPayload(parsed)}`,
        rawPreview,
      };
    }
    const parsed = await sendGenerationRequest(cfg, modelName, request, 30000);
    const rawPreview = JSON.stringify(parsed).slice(0, 300);
    const imageUrl = await resolveGeneratedImageUrl(cfg, parsed, CONNECTIVITY_TEST_POLL_TIMEOUT_MS);
    if (imageUrl) {
      const preparedImageSource = await materializeGeneratedImageSource(cfg, imageUrl);
      return { ok: true, status: 200, imageUrl: preparedImageSource, rawPreview };
    }
    return { ok: false, status: 200, errorMessage: buildImageNotFoundMessage(cfg, parsed), rawPreview };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, errorMessage: `请求失败：${msg}` };
  }
}
