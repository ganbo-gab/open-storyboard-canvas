import {
  customHttpRequest,
  customHttpStreamRequest,
  createGenerationJob,
  getGenerationJobRecord,
  updateGenerationJob,
  type CustomHttpMultipartBody,
  type CustomHttpStreamResponse,
  type GenerateRequest,
  type GenerationJobStatus,
} from '@/commands/ai';
import { isTauri } from '@tauri-apps/api/core';
import {
  prepareNodeImageSourceWithHeaders,
  persistVideoSource,
  type MediaNetworkRoute,
} from '@/commands/image';
import {
  AGNES_PROVIDER_DEFAULTS,
  isChatCustomProvider,
  isVideoCustomProvider,
  useCustomProvidersStore,
  type CustomProviderConfig,
} from '@/stores/customProvidersStore';
import {
  useSettingsStore,
  type GenerationNetworkSettings,
} from '@/stores/settingsStore';
import { hasCustomProviderCredential } from '@/features/canvas/application/providerAvailability';
import {
  isLightweightGenerationRetryResultUrl,
  isLocalFilesystemResultSource,
} from '@/features/canvas/application/generationRetry';
import {
  loadImageElement,
  reduceAspectRatio,
} from '@/features/canvas/application/imageData';
import {
  MODERN_OPENAI_IMAGE_OUTPUT_LIMITS,
  normalizeImageOutputLimits,
  normalizeImageResolutionTier,
  requireImageOutputGeometry,
  type ImageOutputGeometryDiagnostic,
  type ResolvedImageOutputGeometry,
} from '@/features/canvas/application/imageOutputGeometry';
import {
  applyCustomImageRatioMapping,
  CUSTOM_IMAGE_REQUEST_LEGACY_FALLBACK_KEY,
  diagnoseImageAspectMismatch,
  interpolateImageRequestTemplate,
  normalizeCustomImageRequestContract,
  selectImageRequestVariant,
  setValueAtSafePath,
  type CustomImageRequestContractV1,
  type ImageFieldDescriptorV1,
  type ImageRequestTemplateContext,
  type ImageRequestVariantV1,
  type JsonTemplateValue,
} from '@/features/canvas/application/customImageProviderContract';
import {
  parseCustomProviderModelId,
  redactSensitiveUrl,
  resolveGenerationSubmissionRetryAttempts,
  selectImageResultCandidate,
  shouldForwardProviderCredentials,
} from '@/features/canvas/application/imageProviderContracts';
import {
  buildProviderUrl,
  ensureProviderBaseUrlDirectory,
  normalizeProviderBaseUrl,
} from '@/features/canvas/application/providerUrl';
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

interface VideoPollRetryContext {
  cfg: CustomProviderConfig;
  taskId: string;
  network: Readonly<GenerationNetworkSettings>;
}

interface CachedJob extends GenerationJobStatus {
  videoPollRetry?: VideoPollRetryContext;
  warning?: string | null;
  networkSnapshot?: Readonly<GenerationNetworkSettings>;
}

class VideoPollTimeoutError extends Error {
  constructor(
    message: string,
    readonly retryContext: VideoPollRetryContext,
  ) {
    super(message);
    this.name = 'VideoPollTimeoutError';
  }
}

class RemoteGenerationFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteGenerationFailedError';
  }
}

const cache = new Map<string, CachedJob>();
const persistenceQueues = new Map<string, Promise<void>>();
const recoveryJobs = new Map<string, Promise<GenerationJobStatus>>();
const recoveryLoads = new Map<string, Promise<GenerationJobStatus>>();
const POLL_TIMEOUT_MS = 120000;
const VIDEO_POLL_TIMEOUT_MS = 15 * 60 * 1000;
const CONNECTIVITY_TEST_POLL_TIMEOUT_MS = 180000;
const GENERATION_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const MODERN_IMAGE_GENERATION_REQUEST_TIMEOUT_MS = 9 * 60 * 1000;
const MAX_IMAGE_GENERATION_REQUEST_TIMEOUT_MS = 9 * 60 * 1000;
const CHAT_COMPLETION_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;
// A generation POST is non-idempotent. If the response is ambiguous, the
// coordinator must surface `unknown` instead of charging the user twice.
const VIDEO_SUBMIT_NETWORK_RETRY_ATTEMPTS = 0;
const VIDEO_SUBMIT_NETWORK_RETRY_DELAY_MS = 700;
const GENERATION_SUBMIT_NETWORK_ERROR_PREFIX = '提交结果未知，上游可能已接受请求；为避免重复计费未自动重试';
const RESULT_POLL_INTERVAL_MS = 1000;
const RESULT_POLL_REQUEST_TIMEOUT_MS = 30000;
const RESULT_POLL_NETWORK_RETRY_ATTEMPTS = 3;
const RESULT_POLL_MAX_CONSECUTIVE_NETWORK_FAILURES = 8;
const RESULT_POLL_RETRY_HTTP_STATUSES = [408, 425, 429, 500, 502, 503, 504, 520, 522, 524];
const DEFAULT_OPENAI_VIDEO_ENDPOINT_PATH = '/v1/videos';
const DEFAULT_ANTHROPIC_CHAT_MAX_TOKENS = 8192;
const DEFAULT_AGNES_CHAT_MAX_COMPLETION_TOKENS = 65500;
const IMAGE_EDIT_COMPATIBILITY_STORAGE_KEY = 'custom-provider-image-edit-compatibility:v1';

function updateCachedJob(
  jobId: string,
  patch: Partial<Omit<CachedJob, 'job_id'>>,
): CachedJob {
  const now = Date.now();
  const next: CachedJob = {
    job_id: jobId,
    status: 'queued',
    result: null,
    error: null,
    created_at: now,
    ...cache.get(jobId),
    ...patch,
    updated_at: now,
  };
  cache.set(jobId, next);
  return next;
}

function cachedJobContext(
  cfg: CustomProviderConfig,
  model: string,
  mediaType: 'image' | 'video',
  network: Readonly<GenerationNetworkSettings> = useSettingsStore.getState().generationNetworkSettings,
): Partial<CachedJob> {
  return {
    media_type: mediaType,
    provider_id: cfg.id,
    model_id: model,
    config_fingerprint: generationConfigFingerprint(cfg, model),
    phase: 'submit',
    network_route: network.route,
    networkSnapshot: { ...network },
    resumable: false,
  };
}

function generationConfigFingerprint(cfg: CustomProviderConfig, model: string): string {
  const basis = [cfg.id, model, cfg.baseUrl, cfg.endpointPath ?? '', cfg.apiStyle].join('|');
  let hash = 2166136261;
  for (let index = 0; index < basis.length; index += 1) {
    hash ^= basis.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function isAmbiguousSubmissionError(error: unknown): boolean {
  const message = formatUnknownError(error);
  return message.includes(GENERATION_SUBMIT_NETWORK_ERROR_PREFIX)
    || error instanceof NetworkRequestError
    || /(?:timeout|timed out|connection reset|network|load failed|body read|response read)/i.test(message);
}

export function classifyGenerationError(error: unknown): string {
  const message = formatUnknownError(error).toLowerCase();
  if (/proxy|代理/.test(message)) return 'proxy';
  if (/dns|resolve|name or service|域名|解析/.test(message)) return 'dns';
  if (/tls|ssl|certificate|证书/.test(message)) return 'tls';
  if (/timeout|timed out|超时/.test(message)) return 'timeout';
  if (/http\s*\d{3}|status code|状态码/.test(message)) return 'http';
  if (/parse|json|response shape|响应.*(?:格式|解析)/.test(message)) return 'response-parse';
  if (/download|materializ|下载|落盘/.test(message)) return 'download';
  if (/network|connect|connection|load failed|网络|连接/.test(message)) return 'network';
  if (/config|配置|尺寸|分辨率|比例/.test(message)) return 'configuration';
  return 'provider';
}

async function persistCustomJobCreate(
  jobId: string,
  cfg: CustomProviderConfig,
  model: string,
  mediaType: 'image' | 'video',
  network: Readonly<GenerationNetworkSettings> = useSettingsStore.getState().generationNetworkSettings,
): Promise<void> {
  if (!isTauri()) return;
  await createGenerationJob({
    jobId,
    mediaType,
    providerId: cfg.id,
    modelId: model,
    configFingerprint: generationConfigFingerprint(cfg, model),
    status: 'queued',
    phase: 'submit',
    networkRoute: network.route,
    resumable: false,
  });
}

function enqueueCustomJobUpdate(
  jobId: string,
  update: Omit<Parameters<typeof updateGenerationJob>[0], 'jobId'>,
): Promise<void> {
  const previous = persistenceQueues.get(jobId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      await updateGenerationJob({ ...update, jobId });
    });
  persistenceQueues.set(jobId, next);
  void next.finally(() => {
    if (persistenceQueues.get(jobId) === next) persistenceQueues.delete(jobId);
  });
  return next;
}

function persistCustomJobUpdate(
  jobId: string,
  update: Omit<Parameters<typeof updateGenerationJob>[0], 'jobId'>,
): void {
  if (!isTauri()) return;
  void enqueueCustomJobUpdate(jobId, update).catch(() => undefined);
}

async function persistCustomJobUpdateRequired(
  jobId: string,
  update: Omit<Parameters<typeof updateGenerationJob>[0], 'jobId'>,
): Promise<void> {
  if (!isTauri()) return;
  await enqueueCustomJobUpdate(jobId, update);
}

async function persistRecoveryJobUpdate(
  jobId: string,
  update: Omit<Parameters<typeof updateGenerationJob>[0], 'jobId'>,
): Promise<boolean> {
  try {
    await persistCustomJobUpdateRequired(jobId, update);
    return true;
  } catch (error) {
    const detail = formatUnknownError(error);
    updateCachedJob(jobId, {
      status: 'recoverable_wait',
      phase: update.phase ?? 'storage',
      error: `本机任务状态保存失败，未继续恢复流程：${detail}`,
      error_category: 'storage',
    });
    return false;
  }
}

type ImageEditCompatibilityProfileId = 'configured' | 'openai-array' | 'legacy-minimal';

interface ImageEditCompatibilityAttempt {
  profileId: ImageEditCompatibilityProfileId;
  reason: 'initial' | 'same-profile-retry' | 'alternate-profile';
}

interface ResolvedCustomImageContract {
  contract: CustomImageRequestContractV1;
  variant: ImageRequestVariantV1 | null;
  context: ImageRequestTemplateContext;
}

interface ImageRequestExecutionPlan {
  method: 'GET' | 'POST';
  bodyMode: CustomProviderBodyMode;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  multipart?: CustomHttpMultipartBody;
  explicitContract: ResolvedCustomImageContract | null;
  imageOutputDiagnostic?: ImageOutputGeometryDiagnostic;
}

function explicitContractOwnsRequestShape(
  resolved: ResolvedCustomImageContract | null,
): boolean {
  const variant = resolved?.variant;
  return Boolean(
    variant?.bodyTemplate !== undefined
      || (variant?.imageFields?.length ?? 0) > 0,
  );
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
  timeoutMs?: number;
  body?: unknown;
  multipart?: unknown;
  imageOutputDiagnostic?: ImageOutputGeometryDiagnostic;
  error?: string;
}

export interface CustomChatCompletionResult {
  text: string;
  status?: number;
  raw: unknown;
  finishReason?: string | null;
  requestDebug?: CustomProviderRequestDebugPreview | null;
  usage?: unknown;
}

export interface CustomChatCompletionStreamResult {
  text: string;
  status?: number;
  finishReason?: string | null;
  requestDebug?: CustomProviderRequestDebugPreview | null;
  rawStreamTail?: string | null;
  streamDiagnostics?: CustomChatCompletionStreamDiagnostics;
  usage?: unknown;
}

export interface CustomChatCompletionStreamOptions {
  onTextDelta?: (delta: string, fullText: string) => void;
  onRawChunk?: (chunk: string) => void;
}

export class CustomChatCompletionStreamError extends Error {
  status?: number;
  requestDebug?: CustomProviderRequestDebugPreview | null;
  rawStreamTail?: string | null;
  streamDiagnostics?: CustomChatCompletionStreamDiagnostics;

  constructor(
    message: string,
    details: {
      status?: number;
      requestDebug?: CustomProviderRequestDebugPreview | null;
      rawStreamTail?: string | null;
      streamDiagnostics?: CustomChatCompletionStreamDiagnostics;
    },
  ) {
    super(message);
    this.name = 'CustomChatCompletionStreamError';
    this.status = details.status;
    this.requestDebug = details.requestDebug;
    this.rawStreamTail = details.rawStreamTail;
    this.streamDiagnostics = details.streamDiagnostics;
  }
}

export interface CustomChatCompletionStreamDiagnostics {
  chunkCount: number;
  dataLineCount: number;
  parsedDataLineCount: number;
  parseFailureCount: number;
  deltaCount: number;
  doneMarkerSeen: boolean;
  completionEventSeen: boolean;
  bridgeDoneSeen: boolean;
  bridgeErrorMessage: string | null;
  bridgeErrorStatus: number | null;
  lastEventType: string | null;
  lastDataLinePreview: string | null;
  remainingBufferCharacters: number;
  elapsedMs: number;
  eventRawCharacters?: number;
  eventTextCharacters?: number;
  bridgeReturnedCharacters?: number;
  bridgeReturnedByteLength?: number;
  bridgeReturnedChunkCount?: number;
  replayTextCharacters?: number;
  replayDataLineCount?: number;
  replayParsedDataLineCount?: number;
  replayDeltaCount?: number;
  replayParseFailureCount?: number;
  replayDoneMarkerSeen?: boolean;
  bridgeReplayUsed?: boolean;
  finalTextSource?: 'event-stream' | 'bridge-response';
  usage?: unknown;
}

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

function buildAgnesProviderConfig(mediaType: 'image' | 'video' | 'chat', apiKey: string): CustomProviderConfig {
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
      models: [AGNES_PROVIDER_DEFAULTS.models.video20],
      supportsWebSearch: false,
      supportedResolutions: [...AGNES_PROVIDER_DEFAULTS.videoResolutions],
      responseFormat: 'generic',
      extraParams: {
        providerConfigVersion: 'video-v1',
        mediaType: 'video',
        providerKind: 'agnes-video',
        requestComposer: 'video-agnes-json',
        videoRequestBodyMode: 'json',
        supportedDurations: Array.from({ length: 18 }, (_, index) => String(index + 1)),
        supportedRatios: ['16:9', '9:16', '1:1'],
        supportedResolutions: [...AGNES_PROVIDER_DEFAULTS.videoResolutions],
        videoPollTimeoutMs: VIDEO_POLL_TIMEOUT_MS,
        videoTaskIdPath: 'task_id',
        videoStatusEndpointPath: AGNES_PROVIDER_DEFAULTS.videoStatusEndpointPath,
        responseVideoPath: 'video_url',
        responseVideoUrlPath: 'remixed_from_video_id',
        videoStatusPath: 'status',
        videoPendingValues: ['queued', 'in_progress'],
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

  if (mediaType === 'chat') {
    return {
      id: 'agnes',
      label: 'Agnes Chat',
      mediaType: 'chat',
      baseUrl: AGNES_PROVIDER_DEFAULTS.baseUrl,
      endpointPath: AGNES_PROVIDER_DEFAULTS.chatEndpointPath,
      modelListEndpointPath: AGNES_PROVIDER_DEFAULTS.modelListEndpointPath,
      httpMethod: 'POST',
      apiKey,
      apiStyle: 'openai-compatible',
      models: [
        AGNES_PROVIDER_DEFAULTS.models.chat25Flash,
        AGNES_PROVIDER_DEFAULTS.models.chat20Flash,
        AGNES_PROVIDER_DEFAULTS.models.chat15Flash,
      ],
      supportsWebSearch: false,
      responseFormat: 'generic',
      modelMetadata: {
        [AGNES_PROVIDER_DEFAULTS.models.chat25Flash]: {
          supportsMultimodal: true,
          contextWindow: 256000,
          maxOutputTokens: 65500,
          description: 'Agnes 2.5 Flash multimodal chat model',
        },
        [AGNES_PROVIDER_DEFAULTS.models.chat20Flash]: {
          supportsMultimodal: true,
          contextWindow: 256000,
          maxOutputTokens: 65500,
          description: 'Agnes 2.0 Flash multimodal chat model; streaming/tools/thinking are documented, but this gateway currently submits non-streaming JSON.',
        },
        [AGNES_PROVIDER_DEFAULTS.models.chat15Flash]: {
          supportsMultimodal: true,
          contextWindow: 256000,
          maxOutputTokens: 65500,
          description: 'Agnes 1.5 Flash multimodal chat model',
        },
      },
      extraParams: {
        providerConfigVersion: 'chat-v1',
        mediaType: 'chat',
        providerKind: 'agnes-chat',
        requestComposer: 'chat-openai-compatible',
      },
      note: 'Agnes settings key routed through the OpenAI-compatible chat-completions gateway.',
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
    models: [AGNES_PROVIDER_DEFAULTS.models.image21Flash, AGNES_PROVIDER_DEFAULTS.models.image20Flash],
    supportsWebSearch: false,
    supportedResolutions: [...AGNES_PROVIDER_DEFAULTS.imageResolutions],
    responseFormat: 'openai-images',
    extraParams: {
      providerConfigVersion: 'new-v1',
      providerKind: 'agnes-images',
      supportedRatios: ['auto', '16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '21:9'],
    },
    note: 'Agnes settings key routed through the OpenAI Images-compatible gateway.',
  };
}

export function resolveProviderAndModel(modelId: string): { cfg: CustomProviderConfig; model: string } | null {
  if (modelId.startsWith('agnes:image:') || modelId.startsWith('agnes:video:') || modelId.startsWith('agnes:chat:')) {
    const [, mediaType, ...modelParts] = modelId.split(':');
    const model = modelParts.join(':').trim();
    const apiKey = useSettingsStore.getState().agnesApiKey.trim();
    if (!model || !apiKey || (mediaType !== 'image' && mediaType !== 'video' && mediaType !== 'chat')) return null;
    return { cfg: buildAgnesProviderConfig(mediaType, apiKey), model };
  }

  const parsed = parseCustomProviderModelId(modelId);
  if (!parsed) return null;
  const cfg = useCustomProvidersStore.getState().providers.find((p) => p.id === parsed.providerId);
  if (!cfg) return null;
  return { cfg, model: parsed.upstreamModel };
}

function resolveGenerationRequestTimeoutMs(cfg: CustomProviderConfig): number {
  const raw = cfg.extraParams?.generationTimeoutMs ?? cfg.extraParams?.timeoutMs;
  const configured = Number(raw);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.min(MAX_IMAGE_GENERATION_REQUEST_TIMEOUT_MS, Math.max(30_000, Math.floor(configured)));
  }
  return isModernProviderConfig(cfg)
    ? MODERN_IMAGE_GENERATION_REQUEST_TIMEOUT_MS
    : GENERATION_REQUEST_TIMEOUT_MS;
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

function compactJsonLike<T>(value: T): T {
  if (Array.isArray(value)) {
    return value
      .map((item) => compactJsonLike(item))
      .filter((item) =>
        item !== undefined
        && item !== null
        && item !== ''
        && !(Array.isArray(item) && item.length === 0)
      ) as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, item]) => [key, compactJsonLike(item)] as const)
        .filter(([, item]) =>
          item !== undefined
          && item !== null
          && item !== ''
          && !(Array.isArray(item) && item.length === 0)
        )
    ) as T;
  }
  return value;
}

function cloneJsonLike<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneJsonLike(item)) as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        cloneJsonLike(item),
      ])
    ) as T;
  }
  return value;
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
  return normalizeImageResolutionTier(value);
}

function normalizeRatioKey(value: string | undefined): string {
  if (!value || value === 'auto') return '1:1';
  return value.trim();
}

function modernProviderUsesOpenAiPixelGeometry(cfg: CustomProviderConfig): boolean {
  if (!isModernProviderConfig(cfg)) return false;
  const kind = modernProviderKind(cfg);
  return kind === 'openai-responses'
    || kind === 'openai-chat-image'
    || kind === 'openai-images'
    || kind === 'midjourney'
    || (!kind && cfg.apiStyle === 'openai-compatible');
}

function configuredImageOutputLimits(
  cfg: CustomProviderConfig,
  includeModernDefaults = false,
) {
  return normalizeImageOutputLimits(
    cfg.extraParams?.imageOutputLimits,
    includeModernDefaults && modernProviderUsesOpenAiPixelGeometry(cfg)
      ? MODERN_OPENAI_IMAGE_OUTPUT_LIMITS
      : {},
  );
}

function resolveModernOpenAiGeometry(
  cfg: CustomProviderConfig,
  request: GenerateRequest,
): ResolvedImageOutputGeometry {
  const selectedResolution = request.extra_params?.resolutionType ?? request.size;
  const explicitOrSelected = isPixelSize(selectedResolution)
    ? selectedResolution
    : isPixelSize(request.size)
      ? request.size
      : selectedResolution;
  return requireImageOutputGeometry({
    aspectRatio: request.aspect_ratio,
    selectedSize: explicitOrSelected,
    supportedPixelSizes: cfg.supportedResolutions,
    limits: configuredImageOutputLimits(cfg, true),
    defaultTier: '1k',
  });
}

function resolveModernOpenAiSize(cfg: CustomProviderConfig, request: GenerateRequest): string {
  return resolveModernOpenAiGeometry(cfg, request).size;
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

function resolveModernGeminiImageSize(request: GenerateRequest): '512' | '1K' | '2K' | '4K' | undefined {
  const selected = request.extra_params?.resolutionType ?? request.size;
  if (typeof selected === 'string') {
    const normalized = selected.trim().toLowerCase();
    if (/^(0\.5k|512|512px)$/.test(normalized)) return '512';
  }
  return resolveModernImageTier(request);
}

function endpointLooksLikeChatCompletions(cfg: CustomProviderConfig): boolean {
  try {
    const path = new URL(resolveEndpointUrlForRequest(cfg, 'model', {
      prompt: '',
      model: 'model',
      size: '2K',
      aspect_ratio: '1:1',
    })).pathname;
    return path.toLowerCase().includes('/chat/completions');
  } catch {
    return (cfg.endpointPath ?? '').toLowerCase().includes('/chat/completions');
  }
}

function buildChatImageContent(request: GenerateRequest): string | Array<Record<string, unknown>> {
  const referenceImages = request.reference_images ?? [];
  if (referenceImages.length === 0) return request.prompt;
  return [
    { type: 'text', text: request.prompt },
    ...referenceImages.map((imageUrl) => ({
      type: 'image_url',
      image_url: { url: imageUrl },
    })),
  ];
}

function buildOpenAiCompatibleChatImageBody(
  modelName: string,
  request: GenerateRequest,
  options: {
    defaultRequestParams: Record<string, unknown>;
    userExtra: Record<string, unknown>;
    size?: string;
    ratio?: string;
  },
): Record<string, unknown> {
  return compactRecord({
    ...options.defaultRequestParams,
    ...(options.ratio ? { aspect_ratio: options.ratio } : {}),
    ...options.userExtra,
    model: modelName,
    messages: [{ role: 'user', content: buildChatImageContent(request) }],
    modalities: ['image', 'text'],
    ...(options.size ? { size: options.size } : {}),
    n: 1,
  });
}

function sanitizeAgnesImageTopLevelParams(params: Record<string, unknown>): Record<string, unknown> {
  const sanitized = { ...params };
  delete sanitized.model;
  delete sanitized.prompt;
  delete sanitized.size;
  delete sanitized.n;
  delete sanitized.image;
  delete sanitized.images;
  delete sanitized.reference_images;
  delete sanitized.response_format;
  delete sanitized.responseFormat;
  delete sanitized.resolutionType;
  delete sanitized.aspect_ratio;
  delete sanitized.aspectRatio;
  return sanitized;
}

function resolveAgnesImageResponseFormat(
  defaultRequestParams: Record<string, unknown>,
  userExtra: Record<string, unknown>,
): string | undefined {
  const raw =
    userExtra.response_format
    ?? userExtra.responseFormat
    ?? defaultRequestParams.response_format
    ?? defaultRequestParams.responseFormat;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

const AGNES_IMAGE_SIZE_BY_TIER: Record<'1k' | '2k' | '4k', Record<string, string>> = {
  '1k': {
    '1:1': '1024x1024',
    '16:9': '1024x576',
    '9:16': '576x1024',
    '4:3': '1024x768',
    '3:4': '768x1024',
    '3:2': '1024x682',
    '2:3': '682x1024',
    '21:9': '1344x576',
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
  },
  '4k': {
    '1:1': '4096x4096',
    '16:9': '3840x2160',
    '9:16': '2160x3840',
    '4:3': '4096x3072',
    '3:4': '3072x4096',
    '3:2': '3840x2560',
    '2:3': '2560x3840',
    '21:9': '5120x2160',
  },
};

function resolveAgnesImageSize(cfg: CustomProviderConfig, request: GenerateRequest): string {
  const selectedResolution = request.extra_params?.resolutionType ?? request.size;
  if (isPixelSize(selectedResolution)) return selectedResolution.trim();
  const selectedToken = typeof selectedResolution === 'string' ? selectedResolution.trim().toLowerCase() : '';
  if (request.model.endsWith(`:${AGNES_PROVIDER_DEFAULTS.models.image21Flash}`)) {
    if (selectedToken === 'auto') return '1K';
    if (/^[1234]k$/.test(selectedToken)) return selectedToken.toUpperCase();
  }
  const tier = normalizeResolutionTier(selectedResolution);
  if (tier === 'auto') {
    return AGNES_IMAGE_SIZE_BY_TIER['1k'][normalizeRatioKey(request.aspect_ratio)]
      ?? fallbackPixelSizeForAspectRatio(request.aspect_ratio);
  }
  if (tier) {
    const byRatio = AGNES_IMAGE_SIZE_BY_TIER[tier][normalizeRatioKey(request.aspect_ratio)];
    if (byRatio) return byRatio;
  }
  if (isPixelSize(request.size)) return request.size.trim();
  const configuredSizes = (cfg.supportedResolutions ?? []).filter(isPixelSize).map((size) => size.trim());
  return pickClosestPixelSize(configuredSizes, request.aspect_ratio)
    ?? fallbackPixelSizeForAspectRatio(request.aspect_ratio);
}

function resolveFalImageSize(cfg: CustomProviderConfig, request: GenerateRequest): string | { width: number; height: number } {
  const explicit = request.extra_params?.image_size ?? request.extra_params?.imageSize;
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  if (explicit && typeof explicit === 'object' && !Array.isArray(explicit)) {
    return explicit as { width: number; height: number };
  }

  const directPixelSize =
    parsePixelSizeDimensions(request.extra_params?.resolutionType)
    ?? parsePixelSizeDimensions(request.size);
  if (directPixelSize) return directPixelSize;

  switch (normalizeRatioKey(request.aspect_ratio)) {
    case '16:9':
      return 'landscape_16_9';
    case '9:16':
      return 'portrait_16_9';
    case '4:3':
      return 'landscape_4_3';
    case '3:4':
      return 'portrait_4_3';
    case '1:1':
      return 'square_hd';
    default: {
      const fallback = resolveModernOpenAiSize(cfg, request);
      return parsePixelSizeDimensions(fallback) ?? 'square_hd';
    }
  }
}

function buildAgnesImageRequestBody(
  cfg: CustomProviderConfig,
  modelName: string,
  request: GenerateRequest,
  userExtra: Record<string, unknown>,
): Record<string, unknown> {
  const defaultRequestParams = resolveDefaultRequestParams(cfg);
  const size = resolveAgnesImageSize(cfg, request);
  const referenceImages = (request.reference_images ?? [])
    .map((image) => image.trim())
    .filter(Boolean);
  const defaultExtraBody = asPlainRecord(defaultRequestParams.extra_body) ?? {};
  const userExtraBody = asPlainRecord(userExtra.extra_body) ?? {};
  const explicitResponseFormat = resolveAgnesImageResponseFormat(defaultRequestParams, userExtra);
  const topLevelDefaults = sanitizeAgnesImageTopLevelParams(defaultRequestParams);
  const topLevelUserExtra = sanitizeAgnesImageTopLevelParams(userExtra);
  const returnBase64Raw = topLevelUserExtra.return_base64 ?? topLevelDefaults.return_base64;
  delete topLevelDefaults.extra_body;
  delete topLevelUserExtra.extra_body;
  delete topLevelDefaults.return_base64;
  delete topLevelUserExtra.return_base64;
  const explicitTags = topLevelUserExtra.tags ?? topLevelDefaults.tags;

  return compactRecord({
    ...(referenceImages.length > 0 && explicitTags === undefined ? { tags: ['img2img'] } : {}),
    ...topLevelDefaults,
    ...topLevelUserExtra,
    ...(referenceImages.length > 0
      ? {
        extra_body: compactRecord({
          ...defaultExtraBody,
          ...userExtraBody,
          image: referenceImages,
          response_format: explicitResponseFormat ?? 'b64_json',
        }),
      }
      : {
        return_base64: typeof returnBase64Raw === 'boolean' ? returnBase64Raw : true,
        ...(Object.keys(defaultExtraBody).length > 0 || Object.keys(userExtraBody).length > 0
          ? { extra_body: compactRecord({ ...defaultExtraBody, ...userExtraBody }) }
          : {}),
      }),
    model: modelName,
    prompt: request.prompt,
    size,
    ...(modelName === AGNES_PROVIDER_DEFAULTS.models.image21Flash
      && request.aspect_ratio?.trim()
      && request.aspect_ratio !== 'auto'
      ? { ratio: request.aspect_ratio.trim() }
      : {}),
    n: 1,
  });
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
      imageSize: resolveModernGeminiImageSize(request),
    });
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
        imageConfig: Object.keys(imageConfig).length > 0 ? imageConfig : undefined,
      }),
    };
  }

  if (kind === 'openai-chat-image') {
    return buildOpenAiCompatibleChatImageBody(modelName, request, {
      defaultRequestParams,
      userExtra,
      size: resolveModernOpenAiSize(cfg, request),
      ratio: resolveModernRatioForPrompt(request),
    });
  }

  if (kind === 'openai-images' || kind === 'midjourney') {
    const size = resolveModernOpenAiSize(cfg, request);
    if (endpointLooksLikeChatCompletions(cfg)) {
      return buildOpenAiCompatibleChatImageBody(modelName, request, {
        defaultRequestParams,
        userExtra,
        size,
        ratio: resolveModernRatioForPrompt(request),
      });
    }
    return compactRecord({
      model: modelName,
      prompt: request.prompt,
      size,
      n: 1,
      ...pickAllowedParams(defaultRequestParams, OPENAI_IMAGE_PARAM_KEYS),
      ...pickAllowedParams(userExtra, OPENAI_IMAGE_PARAM_KEYS),
    });
  }

  if (kind === 'stability') {
    return compactRecord({
      prompt: request.prompt,
      aspect_ratio: resolveModernRatioForPrompt(request),
      output_format: 'png',
      ...defaultRequestParams,
      ...userExtra,
    });
  }

  if (kind === 'agnes-images') {
    return buildAgnesImageRequestBody(cfg, modelName, request, userExtra);
  }

  if (kind === 'fal') {
    return compactRecord({
      prompt: request.prompt,
      image_size: resolveFalImageSize(cfg, request),
      num_images: 1,
      ...defaultRequestParams,
      ...userExtra,
      ...(request.reference_images?.[0] ? { image_url: request.reference_images[0] } : {}),
    });
  }

  if (kind === 'replicate') {
    const topLevelDefaults = { ...defaultRequestParams };
    const defaultInput = asPlainRecord(topLevelDefaults.input) ?? {};
    const version =
      userExtra.version
      ?? userExtra.model
      ?? topLevelDefaults.version
      ?? topLevelDefaults.model
      ?? modelName;
    delete userExtra.version;
    delete userExtra.model;
    delete topLevelDefaults.version;
    delete topLevelDefaults.model;
    delete topLevelDefaults.input;
    return {
      ...topLevelDefaults,
      version,
      input: {
        prompt: request.prompt,
        aspect_ratio: request.aspect_ratio,
        ...(request.reference_images?.[0] ? { image: request.reference_images[0] } : {}),
        ...defaultInput,
        ...userExtra,
      },
    };
  }

  return compactRecord({
    ...defaultRequestParams,
    ...userExtra,
    model: modelName,
    prompt: request.prompt,
    size: resolveModernOpenAiSize(cfg, request),
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
          ...normalizedDefaultRequestParams,
          ...webSearchField,
          ...negativeField,
          ...seedField,
          ...userExtra,
          model: modelName,
          input: request.prompt,
          tools: [{ type: 'image_generation' }],
          ...(ratio ? { aspect_ratio: ratio } : {}),
        };
      }
      if (isChatCompletionsEndpoint(cfg)) {
        return buildOpenAiCompatibleChatImageBody(modelName, request, {
          defaultRequestParams: {
            ...normalizedDefaultRequestParams,
            ...webSearchField,
            ...negativeField,
            ...seedField,
          },
          userExtra,
          size: resolvedSize,
          ratio,
        });
      }
      // OpenAI Images-ish: POST { model, prompt, size, n, ... }. We keep it
      // minimal so most aggregators accept it.
      return {
        ...normalizedDefaultRequestParams,
        ...webSearchField,
        ...negativeField,
        ...seedField,
        ...userExtra,
        model: modelName,
        prompt: request.prompt,
        size: resolvedSize,
        n: 1,
        ...(ratio ? { aspect_ratio: ratio } : {}),
        ...(request.reference_images && request.reference_images.length > 0
          ? { image: request.reference_images[0] }
          : {}),
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

function resolveExplicitCustomImageContract(
  cfg: CustomProviderConfig,
  modelName: string,
  request: GenerateRequest,
): ResolvedCustomImageContract | null {
  const rawContract = cfg.extraParams?.imageRequestContract;
  if (rawContract === undefined || rawContract === null) return null;
  const normalized = normalizeCustomImageRequestContract(rawContract);
  if (!normalized.value || normalized.issues.length > 0) {
    const details = normalized.issues
      .slice(0, 6)
      .map((entry) => `${entry.path}: ${entry.message}`)
      .join('；');
    throw new Error(`图片模型全自定义配置无效${details ? `：${details}` : ''}`);
  }
  const context: ImageRequestTemplateContext = {
    model: modelName,
    prompt: request.prompt,
    size: request.size,
    aspectRatio: request.aspect_ratio,
    images: [...(request.reference_images ?? [])],
    extra: { ...(request.extra_params ?? {}) },
  };
  return {
    contract: normalized.value,
    variant: selectImageRequestVariant(
      normalized.value,
      (request.reference_images?.length ?? 0) > 0,
    ),
    context,
  };
}

function recordFromTemplateValue(value: unknown, label: string): Record<string, unknown> {
  const record = asPlainRecord(value);
  if (!record) {
    throw new Error(`${label} 必须生成 JSON 对象`);
  }
  return record;
}

function applyMappedCanonicalGeometry(
  body: Record<string, unknown>,
  mappedAspectRatio: string,
  mappedSize: string,
): void {
  if (Object.prototype.hasOwnProperty.call(body, 'aspect_ratio')) {
    body.aspect_ratio = mappedAspectRatio;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'aspectRatio')) {
    body.aspectRatio = mappedAspectRatio;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'size')) {
    body.size = mappedSize;
  }
}

function normalizeContractImageSource(source: string, encoding: ImageFieldDescriptorV1['encoding']): string {
  const trimmed = source.trim();
  if (encoding === 'base64') {
    if (/^https?:\/\//i.test(trimmed)) {
      throw new Error('图片字段 encoding=base64 时，参考图必须先转换为 data URL/base64，不能直接填写远程 URL。');
    }
    return stripDataUrlPrefix(trimmed);
  }
  if (encoding === 'data-url') {
    if (trimmed.startsWith('data:')) return trimmed;
    if (/^https?:\/\//i.test(trimmed)) {
      throw new Error('图片字段 encoding=data-url 时，参考图必须先下载并转换，不能直接填写远程 URL。');
    }
    return `data:image/png;base64,${trimmed}`;
  }
  if (encoding === 'url' && !/^https?:\/\//i.test(trimmed)) {
    throw new Error('图片字段 encoding=url 时，参考图必须是 http(s) URL。');
  }
  return trimmed;
}

function setContractBodyField(
  body: Record<string, unknown>,
  fieldName: string,
  value: unknown,
): void {
  const trimmed = fieldName.trim();
  if (/^[A-Za-z0-9_$-]+\[\]$/.test(trimmed)) {
    body[trimmed] = value;
    return;
  }
  setValueAtSafePath(body, trimmed, value);
}

function applyContractImageFieldsToBody(
  body: Record<string, unknown>,
  descriptors: ImageFieldDescriptorV1[] | undefined,
  images: string[],
): void {
  if (!descriptors || descriptors.length === 0) return;
  delete body.reference_images;
  delete body.image;
  delete body.images;
  descriptors.forEach((descriptor) => {
    const encoded = images.map((source) => normalizeContractImageSource(source, descriptor.encoding));
    if (encoded.length === 0) return;
    setContractBodyField(
      body,
      descriptor.name,
      descriptor.mode === 'single' ? encoded[0] : encoded,
    );
  });
}

function resolveExplicitContractOutputGeometry(
  cfg: CustomProviderConfig,
  request: GenerateRequest,
  resolved: ResolvedCustomImageContract,
): ResolvedImageOutputGeometry | null {
  const ratioSelection = applyCustomImageRatioMapping(
    resolved.contract,
    request.aspect_ratio,
    resolved.context,
  );
  const mappedSize = ratioSelection.mapping?.size;
  if (mappedSize === undefined && !isPixelSize(ratioSelection.size)) return null;
  return requireImageOutputGeometry({
    aspectRatio: request.aspect_ratio,
    selectedSize: mappedSize === undefined ? ratioSelection.size : undefined,
    mappedSize,
    limits: configuredImageOutputLimits(cfg, true),
  });
}

function buildExplicitContractRequestBody(
  cfg: CustomProviderConfig,
  modelName: string,
  request: GenerateRequest,
  resolved: ResolvedCustomImageContract,
): Record<string, unknown> {
  resolveExplicitContractOutputGeometry(cfg, request, resolved);
  const ratioSelection = applyCustomImageRatioMapping(
    resolved.contract,
    request.aspect_ratio,
    resolved.context,
  );
  const mappedContext: ImageRequestTemplateContext = {
    ...resolved.context,
    aspectRatio: ratioSelection.aspectRatio,
    size: ratioSelection.size,
  };
  const template = resolved.variant?.bodyTemplate;
  let initialBody = template === undefined
    ? recordFromTemplateValue(buildRequestBody(cfg, modelName, request), '默认请求体')
    : recordFromTemplateValue(
      interpolateImageRequestTemplate(template, mappedContext),
      'imageRequestContract.bodyTemplate',
    );
  // A versioned contract can be created by opening and saving a legacy
  // provider. In that migration shape there is no bodyTemplate yet, so the
  // legacy requestBodyHints remain the source of truth for nested model,
  // prompt, ratio, size, and reference-image fields. Apply them before any
  // explicit ratio mapping; a declared mapping then wins over the fallback.
  if (
    template === undefined
      && cfg.extraParams?.[CUSTOM_IMAGE_REQUEST_LEGACY_FALLBACK_KEY] === true
  ) {
    initialBody = applyRequestBodyHints(cfg, initialBody, request, modelName);
  }
  const ratioResult = applyCustomImageRatioMapping(
    resolved.contract,
    request.aspect_ratio,
    resolved.context,
    initialBody,
  );
  const body = ratioResult.body;
  applyMappedCanonicalGeometry(body, ratioResult.aspectRatio, ratioResult.size);
  applyContractImageFieldsToBody(
    body,
    resolved.variant?.imageFields,
    mappedContext.images,
  );
  return body;
}

function interpolateContractStringRecord(
  template: Record<string, unknown> | undefined,
  context: ImageRequestTemplateContext,
): Record<string, string> {
  if (!template) return {};
  const interpolated = interpolateImageRequestTemplate(
    template as unknown as JsonTemplateValue,
    context,
  );
  const record = asPlainRecord(interpolated);
  if (!record) return {};
  return Object.fromEntries(
    Object.entries(record)
      .map(([key, value]) => [key.trim(), queryParamValue(value)] as const)
      .filter((entry): entry is readonly [string, string] => Boolean(entry[0]) && entry[1] !== null),
  );
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

function parsePixelSizeDimensions(value: unknown): { width: number; height: number } | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{2,5})x(\d{2,5})$/i.exec(value.trim());
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? { width, height }
    : null;
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
  const validate = (size: string) => {
    const limits = configuredImageOutputLimits(cfg);
    if (Object.keys(limits).length === 0) return size.trim();
    return requireImageOutputGeometry({
      aspectRatio: request.aspect_ratio,
      selectedSize: size,
      limits,
    }).size;
  };
  if (isPixelSize(selectedResolution)) return validate(selectedResolution);
  if (isPixelSize(request.size)) return validate(request.size);
  const configuredSizes = (cfg.supportedResolutions ?? []).filter(isPixelSize).map((size) => size.trim());
  return validate(
    pickClosestPixelSize(configuredSizes, request.aspect_ratio)
      ?? fallbackPixelSizeForAspectRatio(request.aspect_ratio),
  );
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
  'audio_urls',
  'audios',
  'audiourls',
  'media_urls',
  'video_urls',
  'videos',
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

function ensureOpenAiImageModelBinding(
  cfg: CustomProviderConfig,
  body: Record<string, unknown>,
  modelName: string,
): Record<string, unknown> {
  if (cfg.apiStyle !== 'openai-compatible') return body;
  const hints = asPlainRecord(cfg.extraParams?.requestBodyHints);
  const configuredField = typeof hints?.modelField === 'string' ? hints.modelField.trim() : '';
  const boundValue = configuredField ? getValueByPath(body, configuredField) : body.model;
  if (typeof boundValue === 'string' && boundValue.trim()) return body;
  const next = { ...body };
  setBodyValue(next, configuredField || 'model', modelName);
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
  const path = rawPath
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map((part) => part.trim())
    .filter(Boolean);
  const unsafePart = path.find((part) => part === '__proto__' || part === 'prototype' || part === 'constructor');
  if (unsafePart) {
    throw new Error(`请求字段路径包含不安全片段：${unsafePart}`);
  }
  return path;
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

function setBodyValueIfPresent(target: Record<string, unknown>, rawPath: string, value: unknown): void {
  const field = rawPath.trim();
  if (!field) return;
  if (value === undefined || value === null || value === '') {
    deleteBodyValue(target, field);
    return;
  }
  if (Array.isArray(value) && value.length === 0) {
    deleteBodyValue(target, field);
    return;
  }
  setBodyValue(target, field, value);
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

type CustomProviderAuthMode = 'bearer' | 'header' | 'query' | 'none';

function resolveCustomProviderAuth(cfg: CustomProviderConfig): {
  mode: CustomProviderAuthMode;
  name: string;
  prefix: string;
} {
  const auth = asPlainRecord(cfg.extraParams?.auth);
  const rawMode = String(auth?.mode ?? auth?.type ?? cfg.extraParams?.authMode ?? 'bearer')
    .trim()
    .toLowerCase();
  const mode: CustomProviderAuthMode = rawMode === 'header' || rawMode === 'query' || rawMode === 'none'
    ? rawMode
    : 'bearer';
  const defaultName = mode === 'query' ? 'key' : 'x-api-key';
  return {
    mode,
    name: String(auth?.name ?? cfg.extraParams?.authName ?? defaultName).trim() || defaultName,
    prefix: String(auth?.prefix ?? cfg.extraParams?.authPrefix ?? '').trim(),
  };
}

function configuredApiKeyValue(cfg: CustomProviderConfig, prefix: string): string {
  const key = cfg.apiKey.trim();
  return prefix ? `${prefix}${prefix.endsWith(' ') ? '' : ' '}${key}` : key;
}

function appendConfiguredAuthQuery(
  cfg: CustomProviderConfig,
  queryParams: Record<string, string>,
): Record<string, string> {
  const auth = resolveCustomProviderAuth(cfg);
  if (auth.mode !== 'query' || !cfg.apiKey.trim()) return queryParams;
  return {
    ...queryParams,
    [auth.name]: configuredApiKeyValue(cfg, auth.prefix),
  };
}

function buildRequestHeaders(
  cfg: CustomProviderConfig,
  bodyMode: CustomProviderBodyMode,
  method: 'GET' | 'POST' = 'POST',
): Record<string, string> {
  const headers: Record<string, string> = {};
  const auth = resolveCustomProviderAuth(cfg);
  if ((modernProviderKind(cfg) === 'google-gemini' || modernProviderKind(cfg) === 'google-video') && cfg.apiKey?.trim()) {
    headers['x-goog-api-key'] = cfg.apiKey.trim();
  } else if (auth.mode === 'header' && cfg.apiKey?.trim()) {
    headers[auth.name] = configuredApiKeyValue(cfg, auth.prefix);
  } else if (auth.mode === 'bearer' && cfg.apiKey?.trim()) {
    headers.Authorization = `Bearer ${cfg.apiKey.trim()}`;
  }
  if (method === 'POST' && bodyMode === 'json') {
    headers['Content-Type'] = 'application/json';
  } else if (method === 'POST' && bodyMode === 'form-urlencoded') {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  if (method === 'POST' && cfg.apiStyle === 'stability') {
    headers.Accept = 'application/json';
  }

  Object.entries(cfg.extraHeaders ?? {}).forEach(([key, value]) => {
    const normalizedKey = key.trim();
    if (!normalizedKey) return;
    if (
      (bodyMode === 'multipart' || bodyMode === 'form-urlencoded')
      && /^(content-type|content-length)$/i.test(normalizedKey)
    ) return;
    headers[normalizedKey] = value;
  });

  return headers;
}

function chatProviderKind(cfg: CustomProviderConfig): string {
  return typeof cfg.extraParams?.providerKind === 'string' ? cfg.extraParams.providerKind : '';
}

export function resolveChatRequestTimeoutMs(cfg: CustomProviderConfig): number {
  const raw =
    cfg.extraParams?.chatTimeoutMs
    ?? cfg.extraParams?.textTimeoutMs
    ?? cfg.extraParams?.timeoutMs;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.max(CHAT_COMPLETION_REQUEST_TIMEOUT_MS, parsed)
    : CHAT_COMPLETION_REQUEST_TIMEOUT_MS;
}

function isAnthropicChatProvider(cfg: CustomProviderConfig): boolean {
  return isChatCustomProvider(cfg) && chatProviderKind(cfg) === 'anthropic-messages';
}

function isGoogleChatProvider(cfg: CustomProviderConfig): boolean {
  return isChatCustomProvider(cfg) && chatProviderKind(cfg) === 'google-gemini';
}

export function buildChatRequestHeaders(
  cfg: CustomProviderConfig,
  method: 'GET' | 'POST' = 'POST',
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (isAnthropicChatProvider(cfg)) {
    if (cfg.apiKey?.trim()) {
      headers['x-api-key'] = cfg.apiKey.trim();
    }
    headers['anthropic-version'] = '2023-06-01';
  } else if (!isGoogleChatProvider(cfg) && cfg.apiKey?.trim()) {
    headers.Authorization = `Bearer ${cfg.apiKey.trim()}`;
  }
  if (method === 'POST') {
    headers['Content-Type'] = 'application/json';
  }
  Object.entries(cfg.extraHeaders ?? {}).forEach(([key, value]) => {
    const normalizedKey = key.trim();
    if (!normalizedKey || /^content-type$/i.test(normalizedKey)) return;
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
  options: {
    fileField?: string;
    minimal?: boolean;
    singleFile?: boolean;
  } = {},
): CustomHttpMultipartBody {
  const referenceImages = request.reference_images ?? [];
  const configuredFileField = resolveCustomProviderMultipartFileField(cfg);
  const fileField = options.fileField?.trim() || configuredFileField;
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
  const hintedBody = ensureOpenAiImageModelBinding(
    cfg,
    applyRequestBodyHints(cfg, record, request, modelName),
    modelName,
  );
  const hints = resolveRequestBodyHints(asPlainRecord(cfg.extraParams));
  const hintedReferenceField = typeof hints?.referenceImageField === 'string'
    ? hints.referenceImageField.trim()
    : '';
  if (options.minimal) {
    const canonicalBody = ensureOpenAiImageModelBinding(cfg, record, modelName);
    const fields: NonNullable<CustomHttpMultipartBody['fields']> = [];
    ['model', 'prompt', 'size', 'n'].forEach((fieldName) => {
      appendMultipartField(fields, fieldName, canonicalBody[fieldName]);
    });
    const selectedImages = options.singleFile ? referenceImages.slice(0, 1) : referenceImages;
    return {
      fields,
      files: selectedImages.map((imageSource, index) => buildMultipartFile(fileField, imageSource, index)),
    };
  }
  const skipPaths = new Set<string>([
    'reference_images',
    configuredFileField,
    fileField,
    hintedReferenceField,
    'image',
    'images',
  ].filter(Boolean));
  const fields: NonNullable<CustomHttpMultipartBody['fields']> = [];
  collectMultipartFields(hintedBody, '', skipPaths, fields);

  const selectedImages = options.singleFile ? referenceImages.slice(0, 1) : referenceImages;
  const files = selectedImages.map((imageSource, index) =>
    buildMultipartFile(fileField, imageSource, index)
  );

  return { fields, files };
}

function contractMultipartFile(
  fieldName: string,
  source: string,
  index: number,
  encoding: ImageFieldDescriptorV1['encoding'],
): NonNullable<CustomHttpMultipartBody['files']>[number] {
  if (encoding === 'base64') {
    return {
      name: fieldName,
      fileName: index === 0 ? 'reference.png' : `reference-${index + 1}.png`,
      mimeType: 'image/png',
      base64: normalizeContractImageSource(source, 'base64'),
    };
  }
  if (encoding === 'data-url') {
    return {
      name: fieldName,
      fileName: index === 0 ? 'reference.png' : `reference-${index + 1}.png`,
      dataUrl: normalizeContractImageSource(source, 'data-url'),
    };
  }
  return buildMultipartFile(fieldName, source, index);
}

function buildExplicitContractMultipartBody(
  cfg: CustomProviderConfig,
  modelName: string,
  request: GenerateRequest,
  resolved: ResolvedCustomImageContract,
): CustomHttpMultipartBody {
  const body = buildExplicitContractRequestBody(cfg, modelName, request, resolved);
  const descriptors = resolved.variant?.imageFields ?? [];
  const skipPaths = new Set<string>([
    'reference_images',
    'image',
    'images',
    ...descriptors.map((descriptor) => descriptor.name),
    ...descriptors.map((descriptor) => descriptor.name.replace(/\[\]$/, '')),
  ]);
  const fields: NonNullable<CustomHttpMultipartBody['fields']> = [];
  collectMultipartFields(body, '', skipPaths, fields);
  const files: NonNullable<CustomHttpMultipartBody['files']> = [];
  const images = request.reference_images ?? [];

  if (descriptors.length === 0) {
    const fallbackField = resolveCustomProviderMultipartFileField(cfg);
    images.forEach((source, index) => {
      files.push(buildMultipartFile(fallbackField, source, index));
    });
    return { fields, files };
  }

  descriptors.forEach((descriptor) => {
    const selected = descriptor.mode === 'single' ? images.slice(0, 1) : images;
    const multipartFieldName = descriptor.mode === 'array' && !descriptor.name.endsWith('[]')
      ? `${descriptor.name}[]`
      : descriptor.name;
    if (descriptor.encoding === 'url') {
      selected.forEach((source) => {
        appendMultipartField(
          fields,
          multipartFieldName,
          normalizeContractImageSource(source, 'url'),
        );
      });
      return;
    }
    selected.forEach((source, index) => {
      files.push(contractMultipartFile(
        multipartFieldName,
        source,
        index,
        descriptor.encoding,
      ));
    });
  });

  return { fields, files };
}

function buildImageEditCompatibilityMultipart(
  cfg: CustomProviderConfig,
  modelName: string,
  request: GenerateRequest,
  profileId: ImageEditCompatibilityProfileId,
): CustomHttpMultipartBody {
  if (profileId === 'openai-array') {
    return buildMultipartBody(cfg, modelName, request, { fileField: 'image[]' });
  }
  if (profileId === 'legacy-minimal') {
    return buildMultipartBody(cfg, modelName, request, {
      fileField: 'image',
      minimal: true,
      singleFile: true,
    });
  }
  return buildMultipartBody(cfg, modelName, request);
}

function multipartWireSignature(multipart: CustomHttpMultipartBody): string {
  const fieldNames = (multipart.fields ?? []).map((field) => field.name).sort();
  const fileNames = (multipart.files ?? []).map((file) => file.name);
  return JSON.stringify({ fieldNames, fileNames });
}

function selectAlternateImageEditProfile(
  cfg: CustomProviderConfig,
  modelName: string,
  request: GenerateRequest,
  currentProfileId: ImageEditCompatibilityProfileId,
  currentMultipart: CustomHttpMultipartBody,
): ImageEditCompatibilityProfileId | null {
  const currentSignature = multipartWireSignature(currentMultipart);
  const candidates: ImageEditCompatibilityProfileId[] = [
    'configured',
    'openai-array',
    'legacy-minimal',
  ];
  for (const candidate of candidates) {
    if (candidate === currentProfileId) continue;
    const candidateMultipart = buildImageEditCompatibilityMultipart(cfg, modelName, request, candidate);
    if (multipartWireSignature(candidateMultipart) !== currentSignature) {
      return candidate;
    }
  }
  return null;
}

function resolveModernProviderBodyMode(
  cfg: CustomProviderConfig,
  request: GenerateRequest,
): CustomProviderBodyMode | null {
  if (!isModernProviderConfig(cfg)) return null;
  if (isOpenAiImagesLikeModernProvider(cfg) && endpointLooksLikeChatCompletions(cfg)) {
    return 'json';
  }
  if (
    isOpenAiImagesLikeModernProvider(cfg)
    && (request.reference_images?.length ?? 0) > 0
  ) {
    return 'multipart';
  }
  return null;
}

function resolveModelListUrl(cfg: CustomProviderConfig): string {
  const path = (cfg.modelListEndpointPath ?? '').trim() || '/models';
  return buildProviderUrl(cfg.baseUrl, path, appendConfiguredAuthQuery(cfg, {
    ...(cfg.queryParams ?? {}),
    ...(isGoogleChatProvider(cfg) && cfg.apiKey.trim() ? { key: cfg.apiKey.trim() } : {}),
  }));
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
  endpointPathOverride?: string,
): string {
  const base = normalizeProviderBaseUrl(cfg.baseUrl);
  const modernPath = resolveModernEndpointPath(cfg, request);
  const configuredPath = (endpointPathOverride ?? modernPath ?? cfg.endpointPath ?? '').trim();
  const joined = configuredPath
    ? buildProviderUrl(base, configuredPath)
    : (
      shouldAppendFalModelEndpoint(cfg, base)
        ? buildProviderUrl(base, `/${modelName}`)
        : guessDefaultPath(cfg.apiStyle, base)
    );
  const withModel = joined
    .replace(/\{model\}/g, encodeURIComponent(modelName))
    .replace(/\{modelId\}/g, encodeURIComponent(modelName));
  return appendQueryParams(withModel, {
    ...appendConfiguredAuthQuery(cfg, cfg.queryParams ?? {}),
    ...(dynamicQueryParams ?? {}),
  });
}

function shouldAppendFalModelEndpoint(cfg: CustomProviderConfig, normalizedBaseUrl: string): boolean {
  if (cfg.apiStyle !== 'fal') return false;
  try {
    const parsed = new URL(normalizedBaseUrl);
    const path = parsed.pathname.replace(/\/+$/, '');
    return path === '' || path === '/';
  } catch {
    return false;
  }
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

function isSensitiveFieldName(name: string): boolean {
  return /(authorization|proxy[-_ ]?authorization|cookie|set[-_ ]?cookie|(?:x[-_ ]?(?:goog[-_ ]?)?)?api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|client[-_ ]?secret|secret|signature|credential|password|passphrase|bearer|token)/i.test(name);
}

function maskDebugHeaderValue(key: string, value: string): string {
  if (isSensitiveFieldName(key)) {
    return value ? '[masked]' : '';
  }
  return summarizeDebugString(value);
}

function maskDebugUrl(rawUrl: string): string {
  return redactSensitiveUrl(rawUrl);
}

function summarizeDebugString(value: string, maxLength = 500): string {
  const trimmed = value.trim();
  const commaIndex = trimmed.indexOf(',');
  if (/^data:[^,]+;base64,/i.test(trimmed) && commaIndex >= 0) {
    const meta = trimmed.slice(0, commaIndex);
    const base64 = trimmed.slice(commaIndex + 1);
    return `${meta},[base64 ${base64.length} chars]`;
  }
  if (isBase64LikeImage(trimmed)) {
    return `[base64 ${trimmed.length} chars]`;
  }
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}...(${trimmed.length} chars)` : value;
}

function summarizeDebugValue(value: unknown, key = '', depth = 0): unknown {
  if (value === undefined || value === null) return value;
  if (typeof value === 'string') {
    return isSensitiveFieldName(key) ? '[masked]' : summarizeDebugString(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return depth >= 5
      ? `[array ${value.length}]`
      : value.map((item, index) => summarizeDebugValue(item, `${key}[${index}]`, depth + 1));
  }
  if (typeof value === 'object') {
    if (depth >= 5) return '[object]';
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
        entryKey,
        summarizeDebugValue(entryValue, entryKey, depth + 1),
      ])
    );
  }
  return String(value);
}

function summarizeDebugHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, maskDebugHeaderValue(key, value)])
  );
}

function summarizeDebugMultipart(multipart: CustomHttpMultipartBody): unknown {
  return {
    fields: (multipart.fields ?? []).map((field) => ({
      name: field.name,
      value: summarizeDebugValue(field.value, field.name),
    })),
    files: (multipart.files ?? []).map((file) => ({
      name: file.name,
      fileName: file.fileName,
      mimeType: file.mimeType,
      dataUrl: file.dataUrl ? summarizeDebugString(file.dataUrl) : undefined,
      base64: file.base64 ? summarizeDebugString(file.base64) : undefined,
    })),
  };
}

function providerLogContext(cfg: CustomProviderConfig, model: string): Record<string, unknown> {
  return {
    providerId: cfg.id,
    providerLabel: cfg.label,
    providerKind: modernProviderKind(cfg) || cfg.apiStyle,
    mediaType: cfg.mediaType ?? 'image',
    model,
  };
}

function logCustomProviderPhase(
  level: 'info' | 'warn',
  phase: string,
  details: Record<string, unknown>,
): void {
  const log = level === 'warn' ? console.warn : console.info;
  log('[CustomProviderGeneration]', { phase, ...details });
}

function resolvePlanImageOutputGeometry(
  cfg: CustomProviderConfig,
  request: GenerateRequest,
  explicitContract: ResolvedCustomImageContract | null,
): ResolvedImageOutputGeometry | null {
  if (explicitContract) {
    return resolveExplicitContractOutputGeometry(cfg, request, explicitContract);
  }
  if (modernProviderUsesOpenAiPixelGeometry(cfg)) {
    return resolveModernOpenAiGeometry(cfg, request);
  }
  const limits = configuredImageOutputLimits(cfg);
  const selected = request.extra_params?.resolutionType ?? request.size;
  const explicitSize = isPixelSize(selected)
    ? selected
    : isPixelSize(request.size)
      ? request.size
      : null;
  if (!explicitSize || Object.keys(limits).length === 0) return null;
  return requireImageOutputGeometry({
    aspectRatio: request.aspect_ratio,
    selectedSize: explicitSize,
    limits,
  });
}

function buildImageRequestExecutionPlan(
  cfg: CustomProviderConfig,
  model: string,
  request: GenerateRequest,
): ImageRequestExecutionPlan {
  const explicitContract = resolveExplicitCustomImageContract(cfg, model, request);
  const imageOutputGeometry = resolvePlanImageOutputGeometry(cfg, request, explicitContract);
  const configuredBodyMode = resolveCustomProviderBodyMode(cfg, request.extra_params);
  const method = explicitContract?.variant?.method ?? cfg.httpMethod ?? 'POST';
  // Signed/proxy-only markers are a security boundary, not a fallback body
  // preference. A declarative JSON variant must never bypass this block.
  const bodyMode = configuredBodyMode === 'signed'
    ? 'signed'
    : explicitContract?.variant?.bodyMode
      ?? resolveModernProviderBodyMode(cfg, request)
      ?? configuredBodyMode;
  if (bodyMode === 'signed') {
    return {
      method,
      bodyMode,
      url: resolveEndpointUrlForRequest(
        cfg,
        model,
        request,
        undefined,
        explicitContract?.variant?.endpointPath,
      ),
      headers: {},
      explicitContract,
      imageOutputDiagnostic: imageOutputGeometry?.diagnostic,
    };
  }
  if (method === 'GET' && bodyMode === 'multipart') {
    throw new Error('GET 请求不支持 multipart；请改为 POST 或使用 query 参数。');
  }

  const body = bodyMode === 'json' || bodyMode === 'form-urlencoded'
    ? (explicitContract
      ? buildExplicitContractRequestBody(cfg, model, request, explicitContract)
      : buildRequestBody(cfg, model, request))
    : undefined;
  const multipart = bodyMode === 'multipart'
    ? (explicitContract
      ? buildExplicitContractMultipartBody(cfg, model, request, explicitContract)
      : buildMultipartBody(cfg, model, request))
    : undefined;

  let contractContext = explicitContract?.context;
  if (explicitContract) {
    const mapped = applyCustomImageRatioMapping(
      explicitContract.contract,
      request.aspect_ratio,
      explicitContract.context,
    );
    contractContext = {
      ...explicitContract.context,
      aspectRatio: mapped.aspectRatio,
      size: mapped.size,
    };
  }
  const contractQuery = explicitContract && contractContext
    ? interpolateContractStringRecord(explicitContract.variant?.query, contractContext)
    : {};
  const dynamicQuery = {
    ...contractQuery,
    ...(method === 'GET' && body ? buildQueryParamsFromRequestBody(body) : {}),
  };
  const url = resolveEndpointUrlForRequest(
    cfg,
    model,
    request,
    dynamicQuery,
    explicitContract?.variant?.endpointPath,
  );
  const headers = buildRequestHeaders(cfg, bodyMode, method);
  if (explicitContract && contractContext) {
    const contractHeaders = interpolateContractStringRecord(
      explicitContract.variant?.headers,
      contractContext,
    );
    Object.entries(contractHeaders).forEach(([key, value]) => {
      if (
        (bodyMode === 'multipart' || bodyMode === 'form-urlencoded')
        && /^(content-type|content-length)$/i.test(key)
      ) {
        return;
      }
      headers[key] = value;
    });
  }
  return {
    method,
    bodyMode,
    url,
    headers,
    body,
    multipart,
    explicitContract,
    imageOutputDiagnostic: imageOutputGeometry?.diagnostic,
  };
}

export function buildCustomProviderRequestDebugPreview(
  request: GenerateRequest,
): CustomProviderRequestDebugPreview {
  const resolved = resolveProviderAndModel(request.model);
  if (!resolved) {
    throw new Error('未找到对应的自定义服务商配置');
  }

  const { cfg, model } = resolved;
  const plan = buildImageRequestExecutionPlan(cfg, model, request);
  const { method, bodyMode, url, headers, body, multipart, imageOutputDiagnostic } = plan;

  if (bodyMode === 'signed') {
    return {
      providerLabel: cfg.label,
      providerId: cfg.id,
      modelId: request.model,
      modelName: model,
      method,
      bodyMode,
      url: maskDebugUrl(url),
      headers: {},
      imageOutputDiagnostic,
      error:
        '该配置被识别为签名鉴权/代理路线（signed_proxy_required）。预览不会伪造 AK/SK、时间戳或 Action 签名，请改为后端代理后的普通接口。',
    };
  }

  return {
    providerLabel: cfg.label,
    providerId: cfg.id,
    modelId: request.model,
    modelName: model,
    method,
    bodyMode,
    url: maskDebugUrl(url),
    headers: summarizeDebugHeaders(headers),
    body: method === 'POST' && body ? summarizeDebugValue(body) : undefined,
    multipart: method === 'POST' && multipart ? summarizeDebugMultipart(multipart) : undefined,
    imageOutputDiagnostic,
  };
}

export function buildCustomVideoProviderRequestDebugPreview(
  request: GenerateRequest,
): CustomProviderRequestDebugPreview {
  const resolved = resolveProviderAndModel(request.model);
  if (!resolved) {
    throw new Error('未找到对应的视频服务商配置');
  }

  const { cfg, model } = resolved;
  const method = cfg.httpMethod ?? 'POST';
  const bodyMode = resolveVideoRequestBodyMode(cfg);
  const headers = buildRequestHeaders(cfg, bodyMode, method);
  const body = bodyMode === 'json' ? buildVideoJsonBody(cfg, model, request) : undefined;
  const multipart = bodyMode === 'multipart' ? buildVideoMultipartBody(cfg, model, request) : undefined;
  const url = method === 'GET' && body
    ? appendQueryParams(resolveVideoSubmitUrl(cfg, model, request), buildQueryParamsFromRequestBody(body))
    : resolveVideoSubmitUrl(cfg, model, request);

  return {
    providerLabel: cfg.label,
    providerId: cfg.id,
    modelId: request.model,
    modelName: model,
    method,
    bodyMode,
    url: maskDebugUrl(url),
    headers: summarizeDebugHeaders(headers),
    body: method === 'POST' && body ? summarizeDebugValue(body) : undefined,
    multipart: method === 'POST' && multipart ? summarizeDebugMultipart(multipart) : undefined,
  };
}

function parseResponseText(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

function previewPayload(payload: unknown): string {
  if (typeof payload === 'string') return redactSensitiveText(payload).slice(0, 300);
  try {
    return redactSensitiveText(JSON.stringify(payload) ?? String(payload)).slice(0, 300);
  } catch {
    return redactSensitiveText(String(payload)).slice(0, 300);
  }
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/data:[^;\s,]+(?:;[^,\s]+)*;base64,[A-Za-z0-9+/_=-]+/gi, '[data-url omitted]')
    .replace(/\b[A-Za-z0-9+/_-]{160,}={0,2}\b/g, '[base64 omitted]')
    .replace(/\b(Bearer|Basic|Token)\s+[^\s,;]+/gi, '$1 [redacted]')
    .replace(
      /((?:["']?(?:authorization|proxy-authorization|cookie|set-cookie|(?:x-)?api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|secret(?:[-_ ]?key)?|signature|credential|password)["']?\s*[:=]\s*["']?))([^\s,"'}]+)(["']?)/gi,
      '$1[redacted]$3',
    )
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => redactSensitiveUrl(url));
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
  const redacted = redactSensitiveText(serialized);
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}...` : redacted;
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
    const trimmed = redactSensitiveText(value.trim());
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

function buildImageNotFoundMessage(
  cfg: CustomProviderConfig,
  payload: unknown,
  explicitPaths: string[] = [],
): string {
  const responseFormat = cfg.responseFormat ?? 'openai-images';
  const configuredPaths = explicitPaths.length > 0
    ? explicitPaths.join(', ')
    : (cfg.extraParams?.responseImagePath ? String(cfg.extraParams.responseImagePath) : '');
  const pathHint = configuredPaths
    ? `当前响应图片路径=${configuredPaths}，请确认路径是否指向图片 URL/base64。`
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
    networkErrorPrefix?: string;
    networkRetryAttempts?: number;
    networkRetryDelayMs?: number;
    retryHttpStatuses?: number[];
    network?: Readonly<GenerationNetworkSettings>;
  },
): Promise<{ status: number; parsed: unknown; text: string }> {
  const retryAttempts = Math.max(0, Math.floor(options.networkRetryAttempts ?? 0));
  const retryDelayMs = Math.max(200, Math.floor(options.networkRetryDelayMs ?? 800));
  const retryHttpStatuses = new Set(options.retryHttpStatuses ?? []);
  let lastNetworkError: unknown = null;
  let lastRetryableHttpError: HttpStatusError | null = null;
  for (let attempt = 0; attempt <= retryAttempts; attempt += 1) {
    try {
      const network = options.network ?? useSettingsStore.getState().generationNetworkSettings;
      const response = await customHttpRequest({
        url,
        method: options.method,
        headers: options.headers,
        bodyMode: options.bodyMode,
        body: options.body,
        multipart: options.multipart,
        timeoutMs: options.timeoutMs,
        networkRoute: network.route,
        customProxyUrl: network.route === 'custom-proxy' ? network.customProxyUrl : undefined,
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
  const networkErrorPrefix = options.networkErrorPrefix
    ?? (options.errorPrefix ? `${options.errorPrefix} 网络请求失败` : '网络请求失败');
  const retrySummary = options.networkErrorPrefix && retryAttempts > 0
    ? `（已重试 ${retryAttempts} 次）`
    : '';
  throw new NetworkRequestError(
    `${networkErrorPrefix}${retrySummary}：${message}`
  );
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, delayMs));
}

function guessDefaultPath(apiStyle: string, base: string): string {
  switch (apiStyle) {
    case 'openai-compatible': {
      try {
        const pathname = new URL(base).pathname.replace(/\/+$/, '');
        if (/(?:^|\/)(?:images\/generations|images\/edits|responses|chat\/completions|videos)$/.test(pathname)) {
          return base;
        }
        if (!pathname) {
          return `${base}/v1/images/generations`;
        }
      } catch {
        // Fall through to the historical default path.
      }
      return `${base}/images/generations`;
    }
    case 'fal':
      return base;
    case 'stability':
      return `${base}/v2beta/stable-image/generate/core`;
    default:
      return base;
  }
}

function extractFirstImageUrl(
  cfg: CustomProviderConfig,
  payload: unknown,
  explicitPaths: string[] = [],
): string | null {
  if (typeof payload === 'string') {
    const nested = parseNestedJsonString(payload.trim());
    if (nested !== null) {
      const nestedImage = extractFirstImageUrl(cfg, nested, explicitPaths);
      if (nestedImage) return nestedImage;
    }
  }

  const unwrappedPayload = unwrapProviderPayload(payload);
  if (!Object.is(unwrappedPayload, payload)) {
    const unwrapped = extractFirstImageUrl(cfg, unwrappedPayload, explicitPaths);
    if (unwrapped) return unwrapped;
  }

  for (const path of explicitPaths) {
    const explicit = extractByPath(cfg, payload, path);
    if (explicit) return explicit;
  }

  const candidate = selectImageResultCandidate(
    payload,
    explicitPaths[0] ?? (typeof cfg.extraParams?.responseImagePath === 'string'
      ? cfg.extraParams.responseImagePath
      : undefined),
  );
  if (candidate) {
    const normalized = normalizeImageSourceForProvider(cfg, candidate.source);
    console.info('[CustomProviderGeneration]', {
      phase: 'parse:candidate-selected',
      path: candidate.path,
      confidence: candidate.confidence,
      source: /^https?:\/\//i.test(normalized) ? redactSensitiveUrl(normalized) : resolveSourceKind(normalized),
    });
    return normalized;
  }

  const hinted = extractByPath(cfg, payload, cfg.extraParams?.responseImagePath);
  if (hinted) return hinted;

  const format = cfg.responseFormat ?? 'openai-images';
  switch (format) {
    case 'openai-images': {
      const data = (payload as { data?: Array<{ url?: string; b64_json?: string } | string> }).data;
      if (Array.isArray(data)) {
        for (const item of data) {
          if (typeof item === 'string') return normalizeImageSourceForProvider(cfg, item);
          if (item?.url) return normalizeImageSourceForProvider(cfg, item.url);
          if (item?.b64_json) return normalizeImageSourceForProvider(cfg, item.b64_json);
          const nested = scanForImageSource(cfg, item);
          if (nested) return nested;
        }
      }
      const responsesOutput = extractOpenAiResponsesImageResult(cfg, payload);
      if (responsesOutput) return responsesOutput;
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
      return scanForImageSource(cfg, payload);
    }
    case 'data-url': {
      if (typeof payload === 'string') return normalizeImageSourceForProvider(cfg, payload);
      const maybe = (payload as { image?: string; data?: string }).image ?? (payload as { data?: string }).data;
      return typeof maybe === 'string' ? normalizeImageSourceForProvider(cfg, maybe) : scanForImageSource(cfg, payload);
    }
    default: {
      return scanForImageSource(cfg, payload);
    }
  }
}

function extractOpenAiResponsesImageResult(cfg: CustomProviderConfig, payload: unknown): string | null {
  const output = (payload as { output?: unknown }).output;
  if (!Array.isArray(output)) return null;
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const type = typeof record.type === 'string' ? record.type : '';
    if (type !== 'image_generation_call') continue;
    const directResult = extractByPath(cfg, record, 'result');
    if (directResult) return directResult;
    const nestedResult = scanForImageSource(cfg, record.result);
    if (nestedResult) return nestedResult;
  }
  return null;
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
  if (current !== null && current !== undefined) {
    const scanned = scanForImageSource(cfg, current);
    if (scanned) return scanned;
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

function valueAtPath(payload: unknown, rawPath: string): unknown {
  const direct = getValueByPath(payload, rawPath);
  return direct === null ? undefined : direct;
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
  const compact = trimmed.replace(/\s+/g, '');
  const base64Like = /^[A-Za-z0-9+/_=-]+$/.test(compact) && compact.length > 300;
  if (!base64Like) return trimmed;
  const standardBase64Raw = compact.replace(/-/g, '+').replace(/_/g, '/');
  const missingPadding = standardBase64Raw.length % 4;
  const standardBase64 = missingPadding === 0
    ? standardBase64Raw
    : `${standardBase64Raw}${'='.repeat(4 - missingPadding)}`;
  return `data:image/png;base64,${standardBase64}`;
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
    return new URL(normalizeProviderBaseUrl(cfg.baseUrl)).protocol;
  } catch {
    return null;
  }
}

function absolutizeProviderUrl(cfg: CustomProviderConfig, value: string): string {
  try {
    const baseUrl = ensureProviderBaseUrlDirectory(cfg.baseUrl);
    if (!baseUrl) return value;
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
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
  return /^[A-Za-z0-9+/_=\s-]+$/.test(value)
    && value.length > 300
    && /(b64|base64|image|img|data|result|output)/i.test(key);
}

function isDefinitelyNonImageUrlPath(keyPath: string): boolean {
  if (!keyPath) return false;
  const normalized = keyPath.toLowerCase();
  return /(^|[._-])(page|web|status|poll|callback|webhook|request|submit|queue|endpoint|response)[._-]?url($|[._-])/.test(normalized)
    || /(^|[._-])url[._-]?(page|web|status|poll|callback|webhook|request|submit|queue|endpoint|response)($|[._-])/.test(normalized)
    || /(^|[._-])(page|web|status|polling|callback|webhook|request|submit|queue|endpoint)($|[._-])/.test(normalized);
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
  const network = { ...useSettingsStore.getState().generationNetworkSettings };
  if (!hasCustomProviderCredential(cfg)) {
    cache.set(jobId, { job_id: jobId, status: 'failed', result: null, error: `${cfg.label} 未填写 API Key` });
    return jobId;
  }
  updateCachedJob(jobId, {
    ...cachedJobContext(cfg, model, 'image', network),
    status: 'queued',
    result: null,
    error: null,
  });
  void runCustomProviderJob(jobId, cfg, model, request, network);
  return jobId;
}

async function runCustomProviderJob(
  jobId: string,
  cfg: CustomProviderConfig,
  model: string,
  request: GenerateRequest,
  network: Readonly<GenerationNetworkSettings>,
): Promise<void> {
  const jobStartedAt = Date.now();
  try {
    await persistCustomJobCreate(jobId, cfg, model, 'image', network);
  } catch (error) {
    updateCachedJob(jobId, {
      ...cachedJobContext(cfg, model, 'image', network),
      status: 'failed',
      phase: 'persistence',
      result: null,
      resumable: false,
      error: `无法创建本机任务记录，生成请求未发送：${formatUnknownError(error)}`,
      error_category: 'storage',
    });
    return;
  }
  try {
    updateCachedJob(jobId, {
      ...cachedJobContext(cfg, model, 'image', network),
      status: 'submitting',
      phase: 'submit',
      result: null,
      error: null,
    });
    await persistCustomJobUpdateRequired(jobId, { status: 'submitting', phase: 'submit' });
    logCustomProviderPhase('info', 'submit:start', {
      jobId,
      ...providerLogContext(cfg, model),
      referenceImageCount: request.reference_images?.length ?? 0,
    });
    const explicitContract = resolveExplicitCustomImageContract(cfg, model, request);
    const responseImagePaths = explicitContract?.variant?.responseImagePaths ?? [];
    const parsed = await sendGenerationRequest(cfg, model, request, undefined, network);
    const asyncConfig = resolveAsyncTaskConfig(
      cfg,
      explicitContract?.variant?.asyncTask,
      Boolean(explicitContract),
    );
    const externalTaskId = extractTaskId(parsed);
    updateCachedJob(jobId, {
      status: externalTaskId ? 'running' : 'materializing',
      phase: externalTaskId ? 'polling' : 'materialize',
      external_task_id: externalTaskId || null,
      resumable: Boolean(externalTaskId),
    });
    await persistCustomJobUpdateRequired(jobId, {
      status: externalTaskId ? 'running' : 'materializing',
      phase: externalTaskId ? 'polling' : 'materialize',
      resumable: Boolean(externalTaskId),
      ...(externalTaskId
        ? {
            externalTaskId,
            pollDescriptor: {
              method: asyncConfig?.resultMethod ?? (isGrsaiLikeProvider(cfg) ? 'POST' : 'GET'),
              pathTemplate: asyncConfig?.resultEndpointPath ?? (isGrsaiLikeProvider(cfg) ? '/v1/draw/result' : ''),
            },
          }
        : {}),
    });
    logCustomProviderPhase('info', 'submit:success', {
      jobId,
      ...providerLogContext(cfg, model),
      elapsedMs: Date.now() - jobStartedAt,
      responseShape: summarizeResponseShape(parsed),
    });
    const parseStartedAt = Date.now();
    const imageUrl = await resolveGeneratedImageUrl(
      cfg,
      parsed,
      POLL_TIMEOUT_MS,
      responseImagePaths,
      explicitContract?.variant?.asyncTask,
      Boolean(explicitContract),
      network,
    );
    if (!imageUrl) {
      logCustomProviderPhase('warn', 'parse:no-image', {
        jobId,
        ...providerLogContext(cfg, model),
        elapsedMs: Date.now() - parseStartedAt,
        responseShape: summarizeResponseShape(parsed),
      });
      updateCachedJob(jobId, {
        status: 'failed',
        phase: 'polling',
        result: null,
        error: buildImageNotFoundMessage(cfg, parsed, responseImagePaths),
        error_category: 'response-parse',
      });
      persistCustomJobUpdate(jobId, {
        status: 'failed',
        phase: 'polling',
        error: buildImageNotFoundMessage(cfg, parsed, responseImagePaths),
        errorCategory: 'response-parse',
      });
      return;
    }
    logCustomProviderPhase('info', 'parse:image-found', {
      jobId,
      ...providerLogContext(cfg, model),
      elapsedMs: Date.now() - parseStartedAt,
      sourceKind: resolveSourceKind(imageUrl),
    });
    let preparedImageSource: string;
    let aspectWarning: string | null = null;
    try {
      const materializeStartedAt = Date.now();
      const materialized = await materializeGeneratedImageSourceDetails(cfg, imageUrl, network);
      preparedImageSource = materialized.imageSource;
      aspectWarning = formatImageAspectDiagnostic(
        request.aspect_ratio === 'auto' ? request.size : request.aspect_ratio,
        materialized.aspectRatio,
      );
      logCustomProviderPhase('info', 'materialize:success', {
        jobId,
        ...providerLogContext(cfg, model),
        elapsedMs: Date.now() - materializeStartedAt,
        sourceKind: resolveSourceKind(imageUrl),
        localPathBasename: summarizeMaterializedSourceForLog(preparedImageSource),
      });
      if (aspectWarning) {
        logCustomProviderPhase('warn', 'materialize:aspect-mismatch', {
          jobId,
          ...providerLogContext(cfg, model),
          requestedRatio: request.aspect_ratio,
          requestedSize: request.size,
          actualRatio: materialized.aspectRatio,
          warning: aspectWarning,
        });
      }
    } catch (materializeError) {
      const retrySource = asLightweightRetryResultSource(imageUrl);
      logCustomProviderPhase('warn', 'materialize:failed', {
        jobId,
        ...providerLogContext(cfg, model),
        sourceKind: resolveSourceKind(imageUrl),
        error: formatUnknownError(materializeError),
      });
      updateCachedJob(jobId, {
        status: retrySource ? 'recoverable_wait' : 'failed',
        phase: 'materialize',
        result: retrySource,
        result_url: retrySource,
        resumable: Boolean(retrySource),
        error: formatUnknownError(materializeError),
        error_category: 'download',
      });
      persistCustomJobUpdate(jobId, {
        status: retrySource ? 'recoverable_wait' : 'failed',
        phase: 'materialize',
        resultUrl: retrySource ?? undefined,
        resumable: Boolean(retrySource),
        error: formatUnknownError(materializeError),
        errorCategory: 'download',
      });
      return;
    }
    updateCachedJob(jobId, {
      status: 'succeeded',
      phase: 'materialize',
      result: preparedImageSource,
      error: null,
      warning: aspectWarning,
    });
    persistCustomJobUpdate(jobId, {
      status: 'succeeded',
      phase: 'materialize',
      result: preparedImageSource,
      resultUrl: asLightweightRetryResultSource(imageUrl) ?? undefined,
    });
  } catch (err) {
    logCustomProviderPhase('warn', 'submit:failed', {
      jobId,
      ...providerLogContext(cfg, model),
      elapsedMs: Date.now() - jobStartedAt,
      error: formatUnknownError(err),
    });
    const cachedExternalTaskId = cache.get(jobId)?.external_task_id;
    const safeHandle = Boolean(cachedExternalTaskId);
    const upstreamTerminal = err instanceof RemoteGenerationFailedError;
    const ambiguous = isAmbiguousSubmissionError(err);
    const error = formatUnknownError(err);
    const status = upstreamTerminal
      ? 'failed'
      : safeHandle
        ? 'recoverable_wait'
        : ambiguous
          ? 'unknown'
          : 'failed';
    const errorCategory = upstreamTerminal
      ? 'provider'
      : safeHandle
        ? 'poll-timeout'
        : ambiguous
          ? 'submission-unknown'
          : classifyGenerationError(err);
    updateCachedJob(jobId, {
      status,
      phase: 'submit',
      result: null,
      error,
      error_category: errorCategory,
      resumable: safeHandle && !upstreamTerminal,
    });
    persistCustomJobUpdate(jobId, {
      status,
      phase: 'submit',
      error,
      errorCategory,
      resumable: safeHandle && !upstreamTerminal,
    });
  }
}

function summarizeResponseShape(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') {
    return { type: typeof payload };
  }
  if (Array.isArray(payload)) {
    return { type: 'array', length: payload.length };
  }
  const record = payload as Record<string, unknown>;
  return {
    type: 'object',
    keys: Object.keys(record).slice(0, 12),
    hasData: Object.prototype.hasOwnProperty.call(record, 'data'),
    hasResult: Object.prototype.hasOwnProperty.call(record, 'result'),
    hasUrl: Object.keys(record).some((key) => /(url|image|output|result)/i.test(key)),
  };
}

function resolveSourceKind(source: string): string {
  const trimmed = source.trim();
  if (/^data:/i.test(trimmed)) return 'data-url';
  if (/^https?:\/\//i.test(trimmed)) return 'remote-url';
  if (isLocalFilesystemResultSource(trimmed)) return 'local-path';
  if (/^[A-Za-z0-9+/=]+$/.test(trimmed) && trimmed.length > 300) return 'base64';
  return 'text';
}

export function summarizeMaterializedSourceForLog(path: string): string {
  const trimmed = path.trim();
  if (/^data:/i.test(trimmed)) {
    const commaIndex = trimmed.indexOf(',');
    const payloadLength = commaIndex >= 0 ? trimmed.length - commaIndex - 1 : 0;
    return `[data-url omitted${payloadLength > 0 ? ` (${payloadLength} chars)` : ''}]`;
  }
  if (isBase64LikeImage(trimmed)) {
    return `[base64 omitted (${trimmed.length} chars)]`;
  }
  if (/^https?:\/\//i.test(trimmed)) return '[remote-url omitted]';
  if (isLocalFilesystemResultSource(trimmed)) return '[local-file omitted]';
  return `[${resolveSourceKind(trimmed)}]`;
}

function isRemoteHttpImageSource(source: string): boolean {
  return /^https?:\/\//i.test(source.trim());
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) return redactSensitiveText(error.message);
  return redactSensitiveText(String(error));
}

function asLightweightRetryResultSource(source: string): string | null {
  const trimmed = source.trim();
  if (!trimmed) return null;
  const normalizedPrefix = trimmed.slice(0, 16).toLowerCase();
  return normalizedPrefix.startsWith('data:')
    || normalizedPrefix.startsWith('blob:')
    || isLocalFilesystemResultSource(trimmed)
    ? null
    : trimmed;
}

function buildAuthenticatedImageFetchHeaders(cfg: CustomProviderConfig): Record<string, string> {
  return buildRequestHeaders(cfg, 'json', 'GET');
}

interface MaterializedGeneratedImageSource {
  imageSource: string;
  aspectRatio?: string;
}

export async function detectInlineImageAspectRatio(source: string): Promise<string | undefined> {
  const trimmed = source.trim();
  if (!/^data:image\//i.test(trimmed) && !/^blob:/i.test(trimmed)) {
    return undefined;
  }
  // The native materializer reports dimensions for remote URLs. Inline data
  // URLs bypass that path, so decode them once in the WebView as well. If the
  // browser cannot decode the source, keep the image and omit only the
  // optional diagnostic rather than failing generation.
  if (typeof Image === 'undefined') return undefined;
  try {
    const image = await loadImageElement(trimmed);
    const width = Number(image.naturalWidth);
    const height = Number(image.naturalHeight);
    if (width > 0 && height > 0) return reduceAspectRatio(width, height);
  } catch {
    // Aspect diagnostics are best effort and must not block a valid result.
  }
  return undefined;
}

async function materializeGeneratedImageSourceDetails(
  cfg: CustomProviderConfig,
  imageSource: string,
  network?: Readonly<GenerationNetworkSettings>,
): Promise<MaterializedGeneratedImageSource> {
  if (!isRemoteHttpImageSource(imageSource)) {
    return {
      imageSource,
      aspectRatio: await detectInlineImageAspectRatio(imageSource),
    };
  }

  const authHeaders = buildAuthenticatedImageFetchHeaders(cfg);
  const route = buildMediaNetworkRoute(cfg, network);
  const mayForwardCredentials = shouldForwardProviderCredentials(cfg.baseUrl, imageSource);
  const safeHeaders = mayForwardCredentials ? authHeaders : {};
  const auth = resolveCustomProviderAuth(cfg);
  const authenticatedImageSource = auth.mode === 'query' && cfg.apiKey.trim() && mayForwardCredentials
    ? appendQueryParams(imageSource, {
      [auth.name]: configuredApiKeyValue(cfg, auth.prefix),
    })
    : imageSource;
  try {
    const prepared = await prepareNodeImageSourceWithHeaders(
      authenticatedImageSource,
      safeHeaders,
      512,
      route,
    );
    return { imageSource: prepared.imagePath, aspectRatio: prepared.aspectRatio };
  } catch (materializeError) {
    throw new Error([
      '已获取到生成结果地址，但图片下载或解析失败。',
      formatUnknownError(materializeError),
      !mayForwardCredentials ? '结果地址与服务商不同源，未转发 Authorization/Cookie。' : '',
    ].filter(Boolean).join('\n'));
  }
}

function buildMediaNetworkRoute(
  cfg: CustomProviderConfig,
  network?: Readonly<GenerationNetworkSettings>,
): MediaNetworkRoute {
  const selected = network ?? useSettingsStore.getState().generationNetworkSettings;
  let configuredProviderOrigin: string | undefined;
  try {
    configuredProviderOrigin = new URL(normalizeProviderBaseUrl(cfg.baseUrl)).origin;
  } catch {
    configuredProviderOrigin = undefined;
  }
  return {
    route: selected.route,
    ...(selected.route === 'custom-proxy' ? { customProxyUrl: selected.customProxyUrl } : {}),
    ...(configuredProviderOrigin ? { configuredProviderOrigin } : {}),
  };
}

async function materializeGeneratedImageSource(
  cfg: CustomProviderConfig,
  imageSource: string,
  network?: Readonly<GenerationNetworkSettings>,
): Promise<string> {
  return (await materializeGeneratedImageSourceDetails(cfg, imageSource, network)).imageSource;
}

function aspectRatioParts(value: string | undefined): { width: number; height: number } | null {
  if (!value) return null;
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(value.trim());
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}

function formatImageAspectDiagnostic(
  requestedRatio: string,
  actualRatio: string | undefined,
): string | null {
  const actual = aspectRatioParts(actualRatio);
  if (!actual) return null;
  const diagnostic = diagnoseImageAspectMismatch({
    requestedRatio,
    actualWidth: actual.width,
    actualHeight: actual.height,
  });
  if (!diagnostic) return null;
  return diagnostic.orientation === 'reversed'
    ? `上游返回比例方向与请求相反：请求 ${requestedRatio}，实际 ${actualRatio}。请在“图片模型全自定义配置”的比例映射中调整上游字段或 size。`
    : `上游返回比例与请求不一致：请求 ${requestedRatio}，实际 ${actualRatio}。请检查上游是否忽略比例/分辨率字段。`;
}

export async function materializeCustomProviderImageResult(
  providerId: string,
  imageSource: string,
): Promise<string> {
  const cfg = useCustomProvidersStore.getState().providers.find((provider) => provider.id === providerId);
  return cfg ? materializeGeneratedImageSource(cfg, imageSource) : imageSource;
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
  const configuredVideoPaths = Array.isArray(cfg.extraParams?.responseVideoPaths)
    ? cfg.extraParams.responseVideoPaths
    : [];
  const hintedPaths = [
    ...configuredVideoPaths,
    cfg.extraParams?.responseVideoPath,
    cfg.extraParams?.responseVideoUrlPath,
    cfg.extraParams?.videoPath,
    cfg.extraParams?.videoUrlPath,
    modernProviderKind(cfg) === 'agnes-video' ? 'remixed_from_video_id' : undefined,
  ];
  for (const hintedPath of hintedPaths) {
    const hinted = extractVideoByPath(cfg, payload, hintedPath);
    if (hinted) return hinted;
  }
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
    const path = new URL(normalizeProviderBaseUrl(cfg.baseUrl)).pathname.replace(/\/+$/, '');
    if (path.endsWith('/videos')) return '';
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
  const defaultRequestParams = cloneJsonLike(resolveDefaultRequestParams(cfg));
  const userExtra = cloneJsonLike({ ...(request.extra_params ?? {}) } as Record<string, unknown>);
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
  delete userExtra.videoInputSchema;
  delete userExtra.reference_videos;
  delete userExtra.referenceVideos;
  delete userExtra.video_references;
  delete userExtra.reference_audios;
  delete userExtra.referenceAudios;
  delete userExtra.audio_references;

  return compactRecord({
    model: modelName,
    prompt: request.prompt,
    size: request.extra_params?.resolutionType ?? request.extra_params?.size ?? request.size,
    seconds,
    ...defaultRequestParams,
    ...userExtra,
  });
}

function buildVideoTemplateContext(
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
  const size = request.extra_params?.resolutionType ?? request.extra_params?.size ?? request.size;
  const images = request.reference_images ?? [];
  const videos = request.reference_videos ?? [];
  const audios = request.reference_audios ?? [];
  return {
    model: modelName,
    modelName,
    prompt: request.prompt,
    size,
    resolution: size,
    seconds,
    duration: seconds,
    aspect_ratio: request.aspect_ratio,
    aspectRatio: request.aspect_ratio,
    images,
    reference_images: images,
    referenceImages: images,
    firstImage: images[0],
    firstFrame: images[0],
    lastFrame: images.length > 1 ? images[images.length - 1] : undefined,
    videos,
    reference_videos: videos,
    referenceVideos: videos,
    firstVideo: videos[0],
    audios,
    audio: audios,
    reference_audios: audios,
    referenceAudios: audios,
    firstAudio: audios[0],
    defaultRequestParams,
    extra: userExtra,
    extra_params: userExtra,
  };
}

function resolveTemplateVariable(context: Record<string, unknown>, rawPath: string): unknown {
  const path = rawPath.trim();
  if (!path) return undefined;
  return valueAtPath(context, path);
}

function applyTemplateVariables(value: unknown, context: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    const exactMatch = /^\{([^{}]+)\}$/.exec(value.trim());
    if (exactMatch) {
      const resolved = resolveTemplateVariable(context, exactMatch[1]);
      return resolved === undefined ? '' : resolved;
    }
    return value.replace(/\{([^{}]+)\}/g, (match, rawPath: string) => {
      const resolved = resolveTemplateVariable(context, rawPath);
      if (resolved === undefined || resolved === null) return '';
      if (typeof resolved === 'string' || typeof resolved === 'number' || typeof resolved === 'boolean') {
        return String(resolved);
      }
      try {
        return JSON.stringify(resolved);
      } catch {
        return match;
      }
    });
  }
  if (Array.isArray(value)) {
    return value.map((item) => applyTemplateVariables(item, context));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        applyTemplateVariables(item, context),
      ])
    );
  }
  return value;
}

function buildConfiguredVideoRequestBody(
  cfg: CustomProviderConfig,
  modelName: string,
  request: GenerateRequest,
): Record<string, unknown> | null {
  const template = cfg.extraParams?.videoRequestBodyTemplate ?? cfg.extraParams?.requestBodyTemplate;
  if (!template || typeof template !== 'object' || Array.isArray(template)) {
    return null;
  }
  const context = buildVideoTemplateContext(cfg, modelName, request);
  const body = applyTemplateVariables(cloneJsonLike(template), context);
  const record = asPlainRecord(body);
  return record ? compactJsonLike(record) : null;
}

function stringHint(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value.trim() : '';
}

function booleanHint(record: Record<string, unknown>, key: string): boolean {
  return record[key] === true;
}

function pathValueEquals(value: unknown, expected: string): boolean {
  return typeof value === 'string'
    && value.trim().toLowerCase() === expected.trim().toLowerCase();
}

function resolveVideoBodyHints(cfg: CustomProviderConfig): Record<string, unknown> | null {
  return asPlainRecord(cfg.extraParams?.videoRequestBodyHints);
}

function mediaFieldUsesArray(rawField: string): boolean {
  return referenceImageFieldUsesArray(rawField);
}

function applyVideoScalarBodyHints(
  cfg: CustomProviderConfig,
  body: Record<string, unknown>,
  modelName: string,
  request: GenerateRequest,
  hints: Record<string, unknown>,
): void {
  const moveScalar = (fromKey: string, fieldKey: string, value: unknown) => {
    if (!Object.prototype.hasOwnProperty.call(hints, fieldKey)) return;
    const targetField = stringHint(hints, fieldKey);
    delete body[fromKey];
    if (targetField) {
      setBodyValueIfPresent(body, targetField, value);
    }
  };

  moveScalar('model', 'modelField', modelName);
  moveScalar('prompt', 'promptField', request.prompt);

  const sizeValue = request.extra_params?.resolutionType ?? request.extra_params?.size ?? request.size;
  moveScalar('size', 'sizeField', sizeValue);
  moveScalar('aspect_ratio', 'aspectRatioField', request.aspect_ratio);

  if (Object.prototype.hasOwnProperty.call(hints, 'secondsField')) {
    const secondsField = stringHint(hints, 'secondsField');
    const rawSeconds = body.seconds ?? request.extra_params?.seconds ?? request.extra_params?.duration;
    delete body.seconds;
    delete body.duration;
    if (secondsField) {
      const secondsValue = booleanHint(hints, 'secondsAsString') && rawSeconds !== undefined && rawSeconds !== null
        ? String(rawSeconds)
        : rawSeconds;
      setBodyValueIfPresent(body, secondsField, secondsValue);
    }
  } else if (booleanHint(hints, 'secondsAsString') && body.seconds !== undefined && body.seconds !== null) {
    body.seconds = String(body.seconds);
  }

  const resolutionField = stringHint(hints, 'resolutionField');
  if (resolutionField) {
    delete body.resolution;
    setBodyValueIfPresent(body, resolutionField, sizeValue);
  }

  const ratioField = stringHint(hints, 'ratioField');
  if (ratioField) {
    delete body.ratio;
    setBodyValueIfPresent(body, ratioField, request.aspect_ratio);
  }

  const selectedSizeField = stringHint(hints, 'selectedSizeField');
  if (selectedSizeField) {
    setBodyValueIfPresent(body, selectedSizeField, resolveHintedSizeValue(cfg, request, sizeValue));
  }
}

function applyMediaArrayField(
  body: Record<string, unknown>,
  field: string,
  values: readonly string[],
): void {
  if (!field) return;
  if (values.length === 0) {
    deleteBodyValue(body, field);
    return;
  }
  setBodyValue(body, field, mediaFieldUsesArray(field) ? [...values] : values[0]);
}

function applyVideoReferenceBodyHints(
  body: Record<string, unknown>,
  request: GenerateRequest,
  hints: Record<string, unknown>,
): void {
  const images = request.reference_images ?? [];
  const videos = request.reference_videos ?? [];
  const audios = request.reference_audios ?? [];
  const hasImageFieldHint = Object.prototype.hasOwnProperty.call(hints, 'imagesField')
    || Object.prototype.hasOwnProperty.call(hints, 'referenceImageField');
  const imagesField = hasImageFieldHint
    ? (stringHint(hints, 'imagesField') || stringHint(hints, 'referenceImageField'))
    : 'reference_images';
  const videosField = stringHint(hints, 'videosField') || stringHint(hints, 'videoField');
  const audioField = stringHint(hints, 'audioField') || stringHint(hints, 'audiosField');
  const firstFrameField = stringHint(hints, 'firstFrameField');
  const lastFrameField = stringHint(hints, 'lastFrameField');
  const modeField = stringHint(hints, 'modeField');
  const framesModeValue = stringHint(hints, 'framesModeValue') || 'frames';
  const modeValue = modeField ? getValueByPath(body, modeField) : null;
  const usesFrameMode =
    booleanHint(hints, 'useFrameFields')
    || (modeField && pathValueEquals(modeValue, framesModeValue));

  if (imagesField || firstFrameField || lastFrameField) delete body.reference_images;
  if (videosField) delete body.reference_videos;
  if (audioField) delete body.reference_audios;

  if (usesFrameMode && (firstFrameField || lastFrameField)) {
    if (imagesField) deleteBodyValue(body, imagesField);
    if (videosField) deleteBodyValue(body, videosField);
    if (audioField) deleteBodyValue(body, audioField);
    setBodyValueIfPresent(body, firstFrameField, images[0]);
    setBodyValueIfPresent(body, lastFrameField, images[1]);
    return;
  }

  if (firstFrameField) deleteBodyValue(body, firstFrameField);
  if (lastFrameField) deleteBodyValue(body, lastFrameField);
  applyMediaArrayField(body, imagesField, images);
  applyMediaArrayField(body, videosField, videos);
  applyMediaArrayField(body, audioField, audios);
}

function applyVideoRequestBodyHints(
  cfg: CustomProviderConfig,
  body: Record<string, unknown>,
  modelName: string,
  request: GenerateRequest,
): Record<string, unknown> {
  const hints = resolveVideoBodyHints(cfg);
  if (!hints) return body;
  const next = cloneJsonLike(body);
  applyVideoScalarBodyHints(cfg, next, modelName, request, hints);
  applyVideoReferenceBodyHints(next, request, hints);
  return compactRecord(next);
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
  if (frameRate === 24 && seconds >= 17.75) {
    return 441;
  }
  const requestedFrames = Math.max(1, seconds * frameRate);
  const maxFrames = 441;
  const nearest = Math.round((requestedFrames - 1) / 8) * 8 + 1;
  const constrainedFrames = Math.min(nearest, maxFrames);
  return Math.max(1, Math.floor((constrainedFrames - 1) / 8) * 8 + 1);
}

function normalizeAgnesBase64Payload(payload: string, errorPrefix: string): string {
  let compact = payload.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  compact = compact.replace(/=+$/g, '');
  const remainder = compact.length % 4;
  if (remainder === 1) {
    throw new Error(`${errorPrefix} base64 长度无法补齐，请重新连接或上传参考图后再生成。`);
  }
  if (remainder > 0) {
    compact = compact.padEnd(compact.length + (4 - remainder), '=');
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    throw new Error(`${errorPrefix} 不是有效 base64，请重新连接或上传参考图后再生成。`);
  }
  return compact;
}

function normalizeAgnesVideoImageBase64(source: string): string {
  const trimmed = source.trim();
  if (!trimmed) {
    throw new Error('Agnes 视频参考图为空，无法组装 image 字段。');
  }

  const commaIndex = trimmed.indexOf(',');
  if (/^data:[^,]+;base64,/i.test(trimmed) && commaIndex >= 0) {
    return normalizeAgnesBase64Payload(trimmed.slice(commaIndex + 1), 'Agnes 视频参考图');
  }
  if (/^https?:\/\//i.test(trimmed) || /^(file):/i.test(trimmed) || /^\/|^[A-Za-z]:[\\/]/.test(trimmed)) {
    throw new Error('Agnes 视频 image 字段必须是干净 base64；当前收到路径或 URL，请确认画布参考图已先转换为 data URL。');
  }
  if (/^[A-Za-z0-9+/_=-]+$/i.test(trimmed) && trimmed.length > 64) {
    return normalizeAgnesBase64Payload(trimmed, 'Agnes 视频参考图');
  }
  throw new Error('Agnes 视频 image 字段仅支持 data URL 或裸 base64，请重新连接或上传参考图后再生成。');
}

function normalizeAgnesVideoMode(value: unknown): 'text' | 'image' | 'multi' | 'keyframes' | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (/^(text|txt2vid|t2v|text-to-video)$/.test(normalized)) return 'text';
  if (/^(image|ti2vid|i2v|img2vid|image-to-video)$/.test(normalized)) return 'image';
  if (/^(multi|multi-image|references?|multi_reference|multi-reference)$/.test(normalized)) return 'multi';
  if (/^(keyframes?|keyframe)$/.test(normalized)) return 'keyframes';
  return null;
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
  const referenceImages = (request.reference_images ?? [])
    .map(normalizeAgnesVideoImageBase64)
    .filter(Boolean);
  const explicitMode = normalizeAgnesVideoMode(userExtra.agnesVideoMode ?? userExtra.videoMode ?? userExtra.mode);
  const derivedMode = explicitMode
    ?? (referenceImages.length === 0 ? 'text' : referenceImages.length === 1 ? 'image' : 'multi');
  const defaultExtraBody = asPlainRecord(defaultRequestParams.extra_body) ?? {};
  const userExtraBody = asPlainRecord(userExtra.extra_body) ?? {};
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
  delete userExtra.images;
  delete userExtra.videoInputSchema;
  delete userExtra.mode;
  delete userExtra.videoMode;
  delete userExtra.agnesVideoMode;
  delete userExtra.frameRate;
  delete userExtra.extra_body;

  const shouldUseTopLevelImage = referenceImages.length === 1
    && derivedMode !== 'keyframes'
    && derivedMode !== 'text';
  const shouldUseExtraBodyImages = referenceImages.length > 0
    && derivedMode !== 'text'
    && (derivedMode === 'keyframes' || derivedMode === 'multi' || referenceImages.length > 1);
  const extraBody = compactRecord({
    ...defaultExtraBody,
    ...userExtraBody,
    ...(shouldUseExtraBodyImages
      ? { image: referenceImages }
      : {}),
    ...(derivedMode === 'keyframes' ? { mode: 'keyframes' } : {}),
  });

  return compactRecord({
    model: modelName,
    prompt: request.prompt,
    width: pixelSize.width,
    height: pixelSize.height,
    num_frames: normalizeAgnesFrameCount(seconds, normalizedFrameRate),
    frame_rate: normalizedFrameRate,
    ...defaultRequestParams,
    ...userExtra,
    ...(shouldUseTopLevelImage ? {
      image: referenceImages[0],
      mode: 'ti2vid',
    } : {}),
    ...(Object.keys(extraBody).length > 0 ? {
      extra_body: extraBody,
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
  delete userExtra.videoInputSchema;

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
  delete userExtra.videoInputSchema;

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
  if (modernProviderKind(cfg) === 'agnes-video') {
    return 'json';
  }
  const rawMode = cfg.extraParams?.videoRequestBodyMode ?? cfg.extraParams?.requestBodyMode;
  return rawMode === 'json' ? 'json' : 'multipart';
}

function buildVideoJsonBody(
  cfg: CustomProviderConfig,
  modelName: string,
  request: GenerateRequest,
): Record<string, unknown> {
  const providerKind = modernProviderKind(cfg);
  const configuredBody = buildConfiguredVideoRequestBody(cfg, modelName, request);
  if (configuredBody) {
    return configuredBody;
  }
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
  if (resolveVideoBodyHints(cfg)) {
    return applyVideoRequestBodyHints(cfg, body, modelName, request);
  }
  if (references.length > 0) {
    const fieldName = typeof cfg.extraParams?.videoReferenceField === 'string' && cfg.extraParams.videoReferenceField.trim()
      ? cfg.extraParams.videoReferenceField.trim()
      : 'reference_images';
    body[fieldName] = references.length === 1 ? references[0] : references;
  }
  const videos = request.reference_videos ?? [];
  if (videos.length > 0) {
    const fieldName = typeof cfg.extraParams?.videoInputSchema === 'object'
      ? String((cfg.extraParams.videoInputSchema as { video?: { field?: unknown } }).video?.field ?? '').trim()
      : '';
    if (fieldName) {
      setBodyValue(body, fieldName, videos.length === 1 ? videos[0] : videos);
    }
  }
  const audios = request.reference_audios ?? [];
  if (audios.length > 0) {
    const fieldName = typeof cfg.extraParams?.videoInputSchema === 'object'
      ? String((cfg.extraParams.videoInputSchema as { audio?: { field?: unknown } }).audio?.field ?? '').trim()
      : '';
    if (fieldName) {
      setBodyValue(body, fieldName, audios.length === 1 ? audios[0] : audios);
    }
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
  network?: Readonly<GenerationNetworkSettings>,
): Promise<unknown> {
  const method = cfg.httpMethod ?? 'POST';
  if (cfg.extraParams?.requiresDedicatedVideoGateway === true) {
    throw new Error(`${cfg.label} 的视频格式需要专用 gateway 组装请求体，当前模板仅保存官方字段元数据，不能直接提交。`);
  }
  const bodyMode = resolveVideoRequestBodyMode(cfg);
  if (method === 'GET' && bodyMode === 'multipart') {
    throw new Error('视频生成 GET 接口不能使用 multipart/form-data，请将请求格式改为 JSON 查询参数。');
  }
  const headers = buildRequestHeaders(cfg, bodyMode, method);
  const multipart = bodyMode === 'multipart' ? buildVideoMultipartBody(cfg, model, request) : undefined;
  const body = bodyMode === 'json' ? buildVideoJsonBody(cfg, model, request) : undefined;
  const url = method === 'GET' && body
    ? appendQueryParams(resolveVideoSubmitUrl(cfg, model, request), buildQueryParamsFromRequestBody(body))
    : resolveVideoSubmitUrl(cfg, model, request);
  const { parsed } = await requestJson(url, {
    method,
    headers,
    bodyMode,
    body: method === 'POST' ? body : undefined,
    multipart: method === 'POST' ? multipart : undefined,
    timeoutMs: GENERATION_REQUEST_TIMEOUT_MS,
    networkErrorPrefix: GENERATION_SUBMIT_NETWORK_ERROR_PREFIX,
    networkRetryAttempts: method === 'POST' ? VIDEO_SUBMIT_NETWORK_RETRY_ATTEMPTS : 2,
    networkRetryDelayMs: VIDEO_SUBMIT_NETWORK_RETRY_DELAY_MS,
    network,
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

function resolveVideoStatusMethod(cfg: CustomProviderConfig): 'GET' | 'POST' {
  const raw = String(cfg.extraParams?.videoStatusMethod ?? cfg.extraParams?.videoPollMethod ?? 'GET').toUpperCase();
  return raw === 'POST' ? 'POST' : 'GET';
}

function resolveVideoStatusRequestBody(cfg: CustomProviderConfig, taskId: string): unknown {
  const template = cfg.extraParams?.videoStatusRequestBody ?? cfg.extraParams?.videoPollRequestBody;
  return template === undefined ? undefined : fillTaskTemplate(template, taskId);
}

function resolveVideoStatusQueryParams(cfg: CustomProviderConfig, taskId: string): Record<string, string> {
  const template = cfg.extraParams?.videoStatusQueryParams ?? cfg.extraParams?.videoPollQueryParams;
  const filled = template === undefined ? undefined : fillTaskTemplate(template, taskId);
  const record = asPlainRecord(filled);
  if (!record) return {};
  return Object.fromEntries(
    Object.entries(record)
      .map(([key, value]) => [key, queryParamValue(value)] as const)
      .filter((entry): entry is readonly [string, string] => Boolean(entry[0].trim()) && entry[1] !== null)
  );
}

async function resolveGeneratedVideoSource(
  cfg: CustomProviderConfig,
  parsed: unknown,
  network?: Readonly<GenerationNetworkSettings>,
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

  return await pollGeneratedVideoTask(cfg, taskId, network);
}

async function pollGeneratedVideoTask(
  cfg: CustomProviderConfig,
  taskId: string,
  network?: Readonly<GenerationNetworkSettings>,
): Promise<string> {
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
  const statusMethod = resolveVideoStatusMethod(cfg);
  const statusRequestBody = resolveVideoStatusRequestBody(cfg, taskId);
  const statusQueryParams = resolveVideoStatusQueryParams(cfg, taskId);
  const startedAt = Date.now();
  let pollCount = 0;
  let consecutiveNetworkFailures = 0;
  let lastSuccessWithoutVideo: string | null = null;

  while (Date.now() - startedAt < timeoutMs) {
    if (pollCount > 0) {
      await sleep(intervalMs);
    }
    pollCount += 1;

    let payload: unknown;
    try {
      const response = await requestJson(
        appendQueryParams(resolveAsyncTaskUrl(cfg, statusEndpointPath, taskId), statusQueryParams),
        {
        method: statusMethod,
        bodyMode: 'json',
        body: statusMethod === 'POST' ? statusRequestBody : undefined,
        headers: buildRequestHeaders(cfg, 'json', statusMethod),
        timeoutMs: RESULT_POLL_REQUEST_TIMEOUT_MS,
        errorPrefix: '视频状态轮询失败 HTTP',
        networkRetryAttempts: RESULT_POLL_NETWORK_RETRY_ATTEMPTS,
        networkRetryDelayMs: 700,
        retryHttpStatuses: RESULT_POLL_RETRY_HTTP_STATUSES,
        network,
        }
      );
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
      throw new RemoteGenerationFailedError(
        formatAsyncErrorValue(messageRaw) ?? `视频任务失败：${status}`,
      );
    }
    if (status && successValues.includes(status)) {
      const providerKind = modernProviderKind(cfg);
      if (providerKind === 'openai-videos' || providerKind === 'openai-video-compatible') {
        return buildOpenAiVideoContentUrl(cfg, taskId);
      }
      lastSuccessWithoutVideo = status;
      continue;
    }
    if (status && !pendingValues.includes(status)) {
      console.warn('[CustomProvider] unrecognized video status, keep polling', { status, taskId });
    }
  }

  throw new VideoPollTimeoutError(
    lastSuccessWithoutVideo
      ? `视频任务状态为 ${lastSuccessWithoutVideo}，但超时前仍未按 responseVideoPath/videoUrlPath 找到视频 URL。请检查响应路径配置，或把轮询超时调大。`
      : '视频任务轮询超时，未获取到结果',
    { cfg, taskId, network: network ?? { ...useSettingsStore.getState().generationNetworkSettings } },
  );
}

async function materializeGeneratedVideoSource(
  cfg: CustomProviderConfig,
  videoSource: string,
  network?: Readonly<GenerationNetworkSettings>,
): Promise<string> {
  const authHeaders = buildAuthenticatedImageFetchHeaders(cfg);
  const route = buildMediaNetworkRoute(cfg, network);
  if (!isRemoteHttpSource(videoSource)) {
    return await persistVideoSource(videoSource, Object.keys(authHeaders).length > 0 ? authHeaders : undefined, route);
  }

  const mayForwardCredentials = shouldForwardProviderCredentials(cfg.baseUrl, videoSource);
  const auth = resolveCustomProviderAuth(cfg);
  const authenticatedVideoSource = auth.mode === 'query' && cfg.apiKey.trim() && mayForwardCredentials
    ? appendQueryParams(videoSource, {
      [auth.name]: configuredApiKeyValue(cfg, auth.prefix),
    })
    : videoSource;
  try {
    return await persistVideoSource(
      authenticatedVideoSource,
      mayForwardCredentials ? authHeaders : undefined,
      route,
    );
  } catch (materializeError) {
    throw new Error([
      '已获取到生成视频地址，但视频下载或解析失败。',
      formatUnknownError(materializeError),
      !mayForwardCredentials ? '结果地址与服务商不同源，未转发 Authorization/Cookie。' : '',
    ].filter(Boolean).join('\n'));
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
  const network = { ...useSettingsStore.getState().generationNetworkSettings };
  if (!hasCustomProviderCredential(cfg)) {
    cache.set(jobId, { job_id: jobId, status: 'failed', result: null, error: `${cfg.label} 未填写 API Key` });
    return jobId;
  }
  updateCachedJob(jobId, {
    ...cachedJobContext(cfg, model, 'video', network),
    status: 'queued',
    result: null,
    error: null,
  });
  void runCustomVideoJob(jobId, cfg, model, request, network);
  return jobId;
}

async function runCustomVideoJob(
  jobId: string,
  cfg: CustomProviderConfig,
  model: string,
  request: GenerateRequest,
  network: Readonly<GenerationNetworkSettings>,
): Promise<void> {
  try {
    await persistCustomJobCreate(jobId, cfg, model, 'video', network);
  } catch (error) {
    updateCachedJob(jobId, {
      ...cachedJobContext(cfg, model, 'video', network),
      status: 'failed',
      phase: 'persistence',
      result: null,
      resumable: false,
      error: `无法创建本机任务记录，生成请求未发送：${formatUnknownError(error)}`,
      error_category: 'storage',
    });
    return;
  }
  try {
    updateCachedJob(jobId, {
      ...cachedJobContext(cfg, model, 'video', network),
      status: 'submitting',
      phase: 'submit',
      result: null,
      error: null,
    });
    await persistCustomJobUpdateRequired(jobId, { status: 'submitting', phase: 'submit' });
    const parsed = await sendVideoGenerationRequest(cfg, model, request, network);
    const externalTaskId = extractTaskId(parsed);
    updateCachedJob(jobId, {
      status: externalTaskId ? 'running' : 'materializing',
      phase: externalTaskId ? 'polling' : 'materialize',
      external_task_id: externalTaskId || null,
      resumable: Boolean(externalTaskId),
    });
    await persistCustomJobUpdateRequired(jobId, {
      status: externalTaskId ? 'running' : 'materializing',
      phase: externalTaskId ? 'polling' : 'materialize',
      resumable: Boolean(externalTaskId),
      ...(externalTaskId
        ? {
            externalTaskId,
            pollDescriptor: {
              method: resolveVideoStatusMethod(cfg),
              pathTemplate: resolveVideoStatusEndpointPath(cfg),
            },
          }
        : {}),
    });
    const videoSource = await resolveGeneratedVideoSource(cfg, parsed, network);
    if (!videoSource) {
      updateCachedJob(jobId, {
        status: 'failed',
        phase: externalTaskId ? 'polling' : 'submit',
        result: null,
        error: `响应中未找到视频任务或视频 URL。响应预览：${previewPayload(parsed)}`,
        error_category: 'response-parse',
      });
      persistCustomJobUpdate(jobId, {
        status: 'failed',
        phase: externalTaskId ? 'polling' : 'submit',
        error: `响应中未找到视频任务或视频 URL。响应预览：${previewPayload(parsed)}`,
        errorCategory: 'response-parse',
      });
      return;
    }
    let preparedVideoSource: string;
    try {
      preparedVideoSource = await materializeGeneratedVideoSource(cfg, videoSource, network);
    } catch (materializeError) {
      const retrySource = asLightweightRetryResultSource(videoSource);
      updateCachedJob(jobId, {
        status: retrySource ? 'recoverable_wait' : 'failed',
        phase: 'materialize',
        result: retrySource,
        result_url: retrySource,
        resumable: Boolean(retrySource),
        error: formatUnknownError(materializeError),
        error_category: 'download',
      });
      persistCustomJobUpdate(jobId, {
        status: retrySource ? 'recoverable_wait' : 'failed',
        phase: 'materialize',
        resultUrl: retrySource ?? undefined,
        resumable: Boolean(retrySource),
        error: formatUnknownError(materializeError),
        errorCategory: 'download',
      });
      return;
    }
    updateCachedJob(jobId, {
      status: 'succeeded',
      phase: 'materialize',
      result: preparedVideoSource,
      error: null,
    });
    persistCustomJobUpdate(jobId, {
      status: 'succeeded',
      phase: 'materialize',
      result: preparedVideoSource,
      resultUrl: asLightweightRetryResultSource(videoSource) ?? undefined,
    });
  } catch (err) {
    if (err instanceof VideoPollTimeoutError) {
      updateCachedJob(jobId, {
        status: 'recoverable_wait',
        phase: 'polling',
        result: null,
        error: formatUnknownError(err),
        error_category: 'poll-timeout',
        external_task_id: err.retryContext.taskId,
        resumable: true,
        videoPollRetry: err.retryContext,
      });
      persistCustomJobUpdate(jobId, {
        status: 'recoverable_wait',
        phase: 'polling',
        error: formatUnknownError(err),
        errorCategory: 'poll-timeout',
        resumable: true,
      });
      return;
    }
    const cachedExternalTaskId = cache.get(jobId)?.external_task_id;
    const safeHandle = Boolean(cachedExternalTaskId);
    const upstreamTerminal = err instanceof RemoteGenerationFailedError;
    const ambiguous = isAmbiguousSubmissionError(err);
    const error = formatUnknownError(err);
    const status = upstreamTerminal
      ? 'failed'
      : safeHandle
        ? 'recoverable_wait'
        : ambiguous
          ? 'unknown'
          : 'failed';
    const errorCategory = upstreamTerminal
      ? 'provider'
      : safeHandle
        ? 'poll-timeout'
        : ambiguous
          ? 'submission-unknown'
          : classifyGenerationError(err);
    updateCachedJob(jobId, {
      status,
      phase: 'submit',
      result: null,
      error,
      error_category: errorCategory,
      resumable: safeHandle && !upstreamTerminal,
    });
    persistCustomJobUpdate(jobId, {
      status,
      phase: 'submit',
      error,
      errorCategory,
      resumable: safeHandle && !upstreamTerminal,
    });
  }
}

async function retryCustomVideoPoll(jobId: string, retryContext: VideoPollRetryContext): Promise<void> {
  try {
    const videoSource = await pollGeneratedVideoTask(
      retryContext.cfg,
      retryContext.taskId,
      retryContext.network,
    );
    let preparedVideoSource: string;
    try {
      preparedVideoSource = await materializeGeneratedVideoSource(
        retryContext.cfg,
        videoSource,
        retryContext.network,
      );
    } catch (materializeError) {
      const retrySource = asLightweightRetryResultSource(videoSource);
      updateCachedJob(jobId, {
        status: retrySource ? 'recoverable_wait' : 'failed',
        phase: 'materialize',
        result: retrySource,
        result_url: retrySource,
        error: formatUnknownError(materializeError),
        error_category: 'download',
        resumable: Boolean(retrySource),
        videoPollRetry: retryContext,
      });
      persistCustomJobUpdate(jobId, {
        status: retrySource ? 'recoverable_wait' : 'failed',
        phase: 'materialize',
        resultUrl: retrySource ?? undefined,
        error: formatUnknownError(materializeError),
        errorCategory: 'download',
        resumable: Boolean(retrySource),
      });
      return;
    }
    updateCachedJob(jobId, {
      status: 'succeeded',
      phase: 'materialize',
      result: preparedVideoSource,
      result_url: asLightweightRetryResultSource(videoSource),
      error: null,
    });
    persistCustomJobUpdate(jobId, {
      status: 'succeeded',
      phase: 'materialize',
      result: preparedVideoSource,
      resultUrl: asLightweightRetryResultSource(videoSource) ?? undefined,
    });
  } catch (err) {
    if (err instanceof VideoPollTimeoutError) {
      updateCachedJob(jobId, {
        status: 'recoverable_wait',
        phase: 'polling',
        result: null,
        error: formatUnknownError(err),
        error_category: 'poll-timeout',
        external_task_id: retryContext.taskId,
        resumable: true,
        videoPollRetry: err.retryContext,
      });
      persistCustomJobUpdate(jobId, {
        status: 'recoverable_wait',
        phase: 'polling',
        error: formatUnknownError(err),
        errorCategory: 'poll-timeout',
        resumable: true,
      });
      return;
    }
    if (err instanceof RemoteGenerationFailedError) {
      updateCachedJob(jobId, {
        status: 'failed',
        phase: 'polling',
        result: null,
        error: formatUnknownError(err),
        error_category: 'provider',
        resumable: false,
      });
      persistCustomJobUpdate(jobId, {
        status: 'failed',
        phase: 'polling',
        error: formatUnknownError(err),
        errorCategory: 'provider',
        resumable: false,
      });
      return;
    }
    updateCachedJob(jobId, {
      status: 'recoverable_wait',
      phase: 'polling',
      result: null,
      error: formatUnknownError(err),
      error_category: classifyGenerationError(err),
      external_task_id: retryContext.taskId,
      resumable: true,
      videoPollRetry: retryContext,
    });
    persistCustomJobUpdate(jobId, {
      status: 'recoverable_wait',
      phase: 'polling',
      error: formatUnknownError(err),
      errorCategory: classifyGenerationError(err),
      resumable: true,
    });
  }
}

function isRecognizedImageEditValidationError(error: unknown): error is HttpStatusError {
  if (!(error instanceof HttpStatusError) || error.status !== 400) return false;
  const message = error.message;
  return isEmptyModelValidationError(error)
    || /(?:missing|required|not specified|cannot be empty|must provide)\b[^\n]{0,100}\b(?:image|file)\b/i.test(message)
    || /\b(?:image|file)\b[^\n]{0,100}\b(?:missing|required|not specified|cannot be empty)\b/i.test(message)
    || /(?:request|request body|body|payload|form)[^\n]{0,100}(?:content-type|multipart\/form-data|form-data)[^\n]{0,100}(?:missing|required|expected|must be|invalid|unsupported|not supported|incorrect|wrong)/i.test(message)
    || /(?:content-type|multipart\/form-data|form-data)[^\n]{0,100}(?:missing|required|expected|must be|invalid|unsupported|not supported|incorrect|wrong)[^\n]{0,100}(?:request|request body|body|payload|form|multipart)/i.test(message)
    || /(?:failed|unable|cannot|could not)[^\n]{0,40}(?:parse|decode|read)[^\n]{0,60}(?:multipart|form-data|request body|form)/i.test(message)
    || /(?:multipart|form-data)[^\n]{0,60}(?:boundary)[^\n]{0,60}(?:missing|required|not found|invalid)/i.test(message)
    || /\b(?:unknown|unsupported|unrecognized|unexpected|invalid)\b[^\n]{0,60}\b(?:parameter|param|field)\b/i.test(message)
    || /(?:缺少|未提供|必填|不能为空)[^\n]{0,60}(?:图片|图像|文件)/i.test(message)
    || /(?:不支持|未知|无效)[^\n]{0,60}(?:参数|字段)/i.test(message);
}

function isEmptyModelValidationError(error: unknown): error is HttpStatusError {
  if (!(error instanceof HttpStatusError) || error.status !== 400) return false;
  const message = error.message;
  return /\bmodel(?:\s+name)?\b[^\n]{0,100}\b(?:not specified|cannot be empty|must not be empty|is required|missing|empty)\b/i.test(message)
    || /\b(?:not specified|missing|empty)\b[^\n]{0,100}\bmodel(?:\s+name)?\b/i.test(message)
    || /(?:未指定|缺少)[^\n]{0,40}模型|模型[^\n]{0,40}(?:为空|不能为空|必填)/i.test(message);
}

function stableSerialize(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashCompatibilityValue(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function sanitizeCompatibilityFingerprintValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeCompatibilityFingerprintValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    /(?:api[-_]?key|authorization|password|secret|signature|token)/i.test(key)
      ? '[sensitive]'
      : sanitizeCompatibilityFingerprintValue(item),
  ]));
}

function normalizeCompatibilityEndpoint(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    return url.split(/[?#]/, 1)[0].replace(/\/+$/, '');
  }
}

function imageEditCompatibilityLookupKey(
  cfg: CustomProviderConfig,
  modelName: string,
  endpointUrl: string,
): string {
  const extraParams = asPlainRecord(cfg.extraParams);
  const multipart = asPlainRecord(extraParams?.multipart);
  const hints = asPlainRecord(extraParams?.requestBodyHints);
  const configFingerprint = hashCompatibilityValue(stableSerialize({
    providerConfigVersion: extraParams?.providerConfigVersion ?? null,
    providerKind: extraParams?.providerKind ?? null,
    requestBodyMode: extraParams?.requestBodyMode ?? null,
    multipart: {
      enabled: multipart?.enabled ?? null,
      fileField: multipart?.fileField ?? null,
    },
    requestBodyHints: hints ?? null,
    defaultRequestParams: sanitizeCompatibilityFingerprintValue(resolveDefaultRequestParams(cfg)),
    queryParams: sanitizeCompatibilityFingerprintValue(cfg.queryParams ?? {}),
  }));
  return hashCompatibilityValue(stableSerialize({
    providerId: cfg.id,
    baseUrl: normalizeProviderBaseUrl(cfg.baseUrl),
    endpoint: normalizeCompatibilityEndpoint(endpointUrl),
    modelFamily: modelName.trim().toLowerCase(),
    configFingerprint,
  }));
}

function readLearnedImageEditProfiles(): Record<string, ImageEditCompatibilityProfileId> {
  try {
    const raw = globalThis.localStorage?.getItem(IMAGE_EDIT_COMPATIBILITY_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as { version?: unknown; profiles?: unknown };
    if (parsed.version !== 1 || !parsed.profiles || typeof parsed.profiles !== 'object' || Array.isArray(parsed.profiles)) {
      return {};
    }
    return Object.fromEntries(Object.entries(parsed.profiles as Record<string, unknown>).filter(
      (entry): entry is [string, ImageEditCompatibilityProfileId] =>
        entry[1] === 'configured' || entry[1] === 'openai-array' || entry[1] === 'legacy-minimal'
    ));
  } catch {
    return {};
  }
}

function writeLearnedImageEditProfile(
  lookupKey: string,
  profileId: ImageEditCompatibilityProfileId,
): void {
  try {
    const profiles = readLearnedImageEditProfiles();
    profiles[lookupKey] = profileId;
    globalThis.localStorage?.setItem(IMAGE_EDIT_COMPATIBILITY_STORAGE_KEY, JSON.stringify({
      version: 1,
      profiles,
    }));
  } catch {
    // Compatibility learning is best-effort and must never block generation.
  }
}

function formatImageEditCompatibilityAttempts(attempts: ImageEditCompatibilityAttempt[]): string {
  return attempts.map((attempt) => attempt.reason === 'same-profile-retry'
    ? `${attempt.profileId}(同格式重试)`
    : attempt.profileId).join(' -> ');
}

function appendCompatibilityAttemptsToError(
  error: unknown,
  attempts: ImageEditCompatibilityAttempt[],
): Error {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = `${rawMessage}\n图生图兼容协商已尝试：${formatImageEditCompatibilityAttempts(attempts)}`;
  if (error instanceof HttpStatusError) return new HttpStatusError(message, error.status);
  if (error instanceof NetworkRequestError) return new NetworkRequestError(message);
  return new Error(message);
}

function isImageEditCompatibilityEligible(
  cfg: CustomProviderConfig,
  method: 'GET' | 'POST',
  bodyMode: CustomProviderBodyMode,
  endpointUrl: string,
  request: GenerateRequest,
): boolean {
  if (
    cfg.apiStyle !== 'openai-compatible'
    || method !== 'POST'
    || bodyMode !== 'multipart'
    || (request.reference_images?.length ?? 0) === 0
  ) {
    return false;
  }
  try {
    return /\/images\/edits(?:\/|$)/i.test(new URL(endpointUrl).pathname);
  } catch {
    return /\/images\/edits(?:\/|$)/i.test(endpointUrl.split(/[?#]/, 1)[0]);
  }
}

async function sendGenerationRequest(
  cfg: CustomProviderConfig,
  model: string,
  request: GenerateRequest,
  timeoutMs?: number,
  network?: Readonly<GenerationNetworkSettings>,
): Promise<unknown> {
  const plan = buildImageRequestExecutionPlan(cfg, model, request);
  const { method, bodyMode, body, multipart: configuredMultipart, url, headers, explicitContract } = plan;
  if (bodyMode === 'signed') {
    throw new Error(
      '该配置被识别为签名鉴权/代理路线（signed_proxy_required）。当前通用直连不会生成 AK/SK、时间戳或 Action 签名；请改为后端代理后的普通 JSON/multipart 接口，或重新导入为可直连预设。'
    );
  }
  const resolvedTimeoutMs = timeoutMs ?? resolveGenerationRequestTimeoutMs(cfg);
  const submit = async (
    multipart?: CustomHttpMultipartBody,
    compatibilityAttempt?: ImageEditCompatibilityAttempt,
  ): Promise<unknown> => {
    if (compatibilityAttempt) {
      logCustomProviderPhase('info', 'submit:compatibility-attempt', {
        ...providerLogContext(cfg, model),
        profileId: compatibilityAttempt.profileId,
        reason: compatibilityAttempt.reason,
        fileFields: (multipart?.files ?? []).map((file) => file.name),
        textFields: (multipart?.fields ?? []).map((field) => field.name),
      });
    }
    logCustomProviderPhase('info', 'submit:request-built', {
      ...providerLogContext(cfg, model),
      method,
      bodyMode,
      url: maskDebugUrl(url),
      compatibilityProfile: compatibilityAttempt?.profileId,
      referenceImageCount: request.reference_images?.length ?? 0,
      timeoutMs: resolvedTimeoutMs,
    });
    const { parsed } = await requestJson(url, {
      method,
      headers,
      bodyMode,
      body: method === 'POST' && (bodyMode === 'json' || bodyMode === 'form-urlencoded') ? body : undefined,
      multipart: method === 'POST' && bodyMode === 'multipart' ? multipart : undefined,
      timeoutMs: resolvedTimeoutMs,
      networkErrorPrefix: GENERATION_SUBMIT_NETWORK_ERROR_PREFIX,
      networkRetryAttempts: resolveGenerationSubmissionRetryAttempts(method),
      network,
    });
    return parsed;
  };

  if (
    explicitContractOwnsRequestShape(explicitContract)
    || !isImageEditCompatibilityEligible(cfg, method, bodyMode, url, request)
  ) {
    return submit(configuredMultipart);
  }

  const lookupKey = imageEditCompatibilityLookupKey(cfg, model, url);
  const learnedProfile = readLearnedImageEditProfiles()[lookupKey];
  const initialProfile: ImageEditCompatibilityProfileId = learnedProfile ?? 'configured';
  const initialMultipart = buildImageEditCompatibilityMultipart(cfg, model, request, initialProfile);
  const attempts: ImageEditCompatibilityAttempt[] = [];
  const attemptProfile = async (
    profileId: ImageEditCompatibilityProfileId,
    reason: ImageEditCompatibilityAttempt['reason'],
    multipart: CustomHttpMultipartBody,
  ): Promise<unknown> => {
    const attempt = { profileId, reason } satisfies ImageEditCompatibilityAttempt;
    attempts.push(attempt);
    return submit(multipart, attempt);
  };

  let validationError: unknown;
  try {
    return await attemptProfile(initialProfile, 'initial', initialMultipart);
  } catch (error) {
    validationError = error;
  }

  if (!isRecognizedImageEditValidationError(validationError)) {
    throw appendCompatibilityAttemptsToError(validationError, attempts);
  }

  if (isEmptyModelValidationError(validationError)) {
    try {
      return await attemptProfile(initialProfile, 'same-profile-retry', initialMultipart);
    } catch (error) {
      validationError = error;
    }
    if (!isRecognizedImageEditValidationError(validationError)) {
      throw appendCompatibilityAttemptsToError(validationError, attempts);
    }
  }

  const alternateProfile = selectAlternateImageEditProfile(
    cfg,
    model,
    request,
    initialProfile,
    initialMultipart,
  );
  if (!alternateProfile) {
    throw appendCompatibilityAttemptsToError(validationError, attempts);
  }

  const alternateMultipart = buildImageEditCompatibilityMultipart(cfg, model, request, alternateProfile);
  try {
    const parsed = await attemptProfile(alternateProfile, 'alternate-profile', alternateMultipart);
    // Some compatible gateways report application-level failures in an HTTP 200 body.
    // Do not learn a profile until the same success-code validation used by the
    // production response flow accepts the payload.
    unwrapProviderPayload(parsed);
    writeLearnedImageEditProfile(lookupKey, alternateProfile);
    logCustomProviderPhase('info', 'submit:compatibility-learned', {
      ...providerLogContext(cfg, model),
      profileId: alternateProfile,
      attemptCount: attempts.length,
    });
    return parsed;
  } catch (error) {
    throw appendCompatibilityAttemptsToError(error, attempts);
  }
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

function resolveAsyncTaskConfig(
  cfg: CustomProviderConfig,
  rawOverride?: unknown,
  hasExplicitContract = false,
): AsyncTaskConfig | null {
  const raw = hasExplicitContract ? rawOverride : (rawOverride ?? cfg.extraParams?.asyncTask);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    if (isModernProviderConfig(cfg) && modernProviderKind(cfg) === 'replicate') {
      return {
        resultEndpointPath: '/predictions/{taskId}',
        resultMethod: 'GET',
        taskIdPath: 'id',
        imagePath: 'output[0]',
        statusPath: 'status',
        pendingValues: ['starting', 'processing', 'queued'],
        successValues: ['succeeded', 'successful', 'success', 'completed'],
        failedValues: ['failed', 'canceled', 'cancelled', 'error'],
        errorPath: 'error',
        requestBody: undefined,
        intervalMs: 2000,
        timeoutMs: 180000,
      };
    }
    return null;
  }
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
  return buildProviderUrl(cfg.baseUrl, filled, appendConfiguredAuthQuery(cfg, cfg.queryParams ?? {}));
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
  explicitPaths: string[] = [],
  knownTaskId?: string,
  network?: Readonly<GenerationNetworkSettings>,
): Promise<string | null> {
  const payloadAtSubmit = unwrapProviderPayload(submitPayload);
  const immediate = explicitPaths.length > 0
    ? extractFirstImageUrl(cfg, submitPayload, explicitPaths)
      ?? extractFirstImageUrl(cfg, payloadAtSubmit, explicitPaths)
    : config.imagePath
    ? extractByPath(cfg, submitPayload, config.imagePath) ?? extractByPath(cfg, payloadAtSubmit, config.imagePath)
    : extractFirstImageUrl(cfg, payloadAtSubmit);
  if (immediate) return immediate;

  const unwrappedSubmitPayload = unwrapProviderPayload(submitPayload);
  const taskIdRaw = config.taskIdPath
    ? (getValueByPath(submitPayload, config.taskIdPath) ?? getValueByPath(unwrappedSubmitPayload, config.taskIdPath))
    : extractTaskId(submitPayload);
  const taskId = knownTaskId?.trim()
    || (typeof taskIdRaw === 'string' && taskIdRaw.trim()
      ? taskIdRaw.trim()
      : (typeof taskIdRaw === 'number' && Number.isFinite(taskIdRaw) ? String(taskIdRaw) : null));
  if (!taskId) return null;

  const startedAt = Date.now();
  let pollCount = 0;
  let consecutiveNetworkFailures = 0;
  let lastSuccessWithoutImage: string | null = null;
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
        network,
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
    const statusRaw = config.statusPath
      ? (getValueByPath(parsed, config.statusPath) ?? getValueByPath(payload, config.statusPath))
      : null;
    const status = normalizeAsyncStatusValue(statusRaw);
    if (status && config.failedValues.includes(status)) {
      const messageRaw = config.errorPath
        ? (getValueByPath(parsed, config.errorPath) ?? getValueByPath(payload, config.errorPath))
        : null;
      throw new RemoteGenerationFailedError(
        formatAsyncErrorValue(messageRaw) ?? `任务失败：${status}`,
      );
    }

    const imageUrl = explicitPaths.length > 0
      ? extractFirstImageUrl(cfg, parsed, explicitPaths)
        ?? extractFirstImageUrl(cfg, payload, explicitPaths)
      : config.imagePath
      ? extractByPath(cfg, parsed, config.imagePath) ?? extractByPath(cfg, payload, config.imagePath)
      : extractFirstImageUrl(cfg, payload);
    if (imageUrl) return imageUrl;

    if (status && config.successValues.includes(status)) {
      lastSuccessWithoutImage = status;
      continue;
    }
  }
  if (lastSuccessWithoutImage) {
    throw new Error(`任务状态为 ${lastSuccessWithoutImage}，但超时前仍未按 imagePath/responseImagePath 找到图片 URL。请检查响应路径配置，或把轮询超时调大。`);
  }
  throw new Error('任务轮询超时，未获取到图片');
}

function resolveGrsaiResultUrl(cfg: CustomProviderConfig): string {
  return buildProviderUrl(cfg.baseUrl, '/v1/draw/result', cfg.queryParams ?? {});
}

async function pollGrsaiLikeResult(
  cfg: CustomProviderConfig,
  submitPayload: unknown,
  timeoutMs: number,
  network?: Readonly<GenerationNetworkSettings>,
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
        network,
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
        throw new RemoteGenerationFailedError(pickFormattedErrorMessage(
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
  responseImagePaths: string[] = [],
  asyncTaskOverride?: unknown,
  hasExplicitContract = false,
  network?: Readonly<GenerationNetworkSettings>,
): Promise<string | null> {
  const unwrappedParsed = unwrapProviderPayload(parsed);
  const direct =
    extractFirstImageUrl(cfg, parsed, responseImagePaths)
    ?? (Object.is(unwrappedParsed, parsed)
      ? null
      : extractFirstImageUrl(cfg, unwrappedParsed, responseImagePaths));
  if (direct) return direct;

  const asyncTask = resolveAsyncTaskConfig(cfg, asyncTaskOverride, hasExplicitContract);
  let asyncTaskError: unknown = null;
  if (asyncTask) {
    try {
      const imageUrl = await pollAsyncTaskResult(cfg, parsed, {
        ...asyncTask,
        timeoutMs: Math.max(asyncTask.timeoutMs, fallbackTimeoutMs),
      }, responseImagePaths, undefined, network);
      if (imageUrl) return imageUrl;
    } catch (err) {
      asyncTaskError = err;
    }
  }

  if (isGrsaiLikeProvider(cfg)) {
    const imageUrl = await pollGrsaiLikeResult(cfg, parsed, fallbackTimeoutMs, network);
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
  // Keep retry context (which contains the provider config and API key) inside
  // the gateway. Never expose it through the public polling DTO.
  return {
    job_id: cached.job_id,
    status: cached.status,
    result: cached.result ?? null,
    error: cached.error ?? null,
    ...(cached.warning ? { warning: cached.warning } : {}),
    ...(cached.media_type ? { media_type: cached.media_type } : {}),
    ...(cached.provider_id ? { provider_id: cached.provider_id } : {}),
    ...(cached.model_id ? { model_id: cached.model_id } : {}),
    ...(cached.external_task_id ? { external_task_id: cached.external_task_id } : {}),
    ...(cached.result_url ? { result_url: cached.result_url } : {}),
    ...(cached.error_category ? { error_category: cached.error_category } : {}),
    ...(cached.phase ? { phase: cached.phase } : {}),
    ...(cached.network_route ? { network_route: cached.network_route } : {}),
    resumable: Boolean(cached.external_task_id || cached.result_url),
    ...(cached.created_at ? { created_at: cached.created_at } : {}),
    ...(cached.updated_at ? { updated_at: cached.updated_at } : {}),
  };
}

async function recoverPersistedCustomJob(job: GenerationJobStatus): Promise<GenerationJobStatus> {
  try {
    if (job.status === 'submitting' && !job.external_task_id && !job.result_url) {
      const message = '应用在提交响应确认前关闭；上游可能已经接受请求。为避免重复计费，系统不会自动重新提交。';
      const persisted = await persistRecoveryJobUpdate(job.job_id, {
        status: 'unknown',
        phase: 'submit',
        error: message,
        errorCategory: 'submission-unknown',
      });
      if (persisted) {
        cache.set(job.job_id, { ...job, status: 'unknown', error: message });
      }
      return getCustomProviderJob(job.job_id);
    }
    const savedProvider = useCustomProvidersStore.getState().providers.find(
      (provider) => provider.id === job.provider_id
    );
    const model = job.model_id?.trim() ?? '';
    const agnesKey = useSettingsStore.getState().agnesApiKey.trim();
    const cfg = savedProvider ?? (
      job.provider_id === 'agnes'
      && agnesKey
      && (job.media_type === 'image' || job.media_type === 'video')
        ? buildAgnesProviderConfig(job.media_type, agnesKey)
        : undefined
    );
    if (!cfg || !model) {
      throw new Error('恢复任务需要原供应商配置和模型；当前配置已删除或模型标识缺失。');
    }
    if (
      job.config_fingerprint
      && job.config_fingerprint !== generationConfigFingerprint(cfg, model)
    ) {
      throw new Error('供应商配置已变化。为避免使用错误账户或接口继续任务，请确认配置后手动恢复。');
    }
    const network = useSettingsStore.getState().generationNetworkSettings;
    if (job.network_route && job.network_route !== network.route) {
      throw new Error(`任务创建时使用 ${job.network_route} 路线，当前为 ${network.route}。请切回原路线后恢复。`);
    }

    let remoteSource = job.result_url?.trim() || '';
    if (remoteSource && !isLightweightGenerationRetryResultUrl(remoteSource)) {
      throw new Error('任务保存的结果地址不是安全的轻量来源，未执行下载。');
    }
    const taskId = job.external_task_id?.trim() || '';
    if (!remoteSource && !taskId) {
      throw new Error('任务没有可恢复的上游 task id 或结果地址，不能安全重发生成请求。');
    }

    if (!remoteSource) {
      if (job.media_type === 'video') {
        remoteSource = await pollGeneratedVideoTask(cfg, taskId, network);
      } else {
        const asyncConfig = resolveAsyncTaskConfig(cfg);
        if (asyncConfig) {
          remoteSource = await pollAsyncTaskResult(cfg, {}, asyncConfig, [], taskId, network) ?? '';
        } else if (isGrsaiLikeProvider(cfg)) {
          remoteSource = await pollGrsaiLikeResult(cfg, { id: taskId }, POLL_TIMEOUT_MS, network) ?? '';
        } else {
          throw new Error('当前供应商配置缺少安全轮询契约，不能在重启后自动查询任务。');
        }
      }
    }
    if (!remoteSource) throw new Error('安全恢复完成轮询，但响应中没有结果地址。');

    if (!(await persistRecoveryJobUpdate(job.job_id, {
      status: 'materializing',
      phase: 'materialize',
      resultUrl: asLightweightRetryResultSource(remoteSource) ?? undefined,
    }))) return getCustomProviderJob(job.job_id);
    cache.set(job.job_id, {
      ...job,
      status: 'materializing',
      result: null,
      error: null,
    });

    const result = job.media_type === 'video'
      ? await materializeGeneratedVideoSource(cfg, remoteSource, network)
      : (await materializeGeneratedImageSourceDetails(cfg, remoteSource, network)).imageSource;
    if (!(await persistRecoveryJobUpdate(job.job_id, {
      status: 'succeeded',
      phase: 'materialize',
      result,
      resultUrl: asLightweightRetryResultSource(remoteSource) ?? undefined,
    }))) return getCustomProviderJob(job.job_id);
    cache.set(job.job_id, {
      ...job,
      status: 'succeeded',
      result,
      error: null,
    });
    return getCustomProviderJob(job.job_id);
  } catch (error) {
    const message = formatUnknownError(error);
    cache.set(job.job_id, {
      ...job,
      status: 'recoverable_wait',
      result: job.result ?? null,
      error: message,
    });
    await persistRecoveryJobUpdate(job.job_id, {
      status: 'recoverable_wait',
      phase: job.result_url ? 'materialize' : 'polling',
      error: message,
      errorCategory: classifyGenerationError(error),
    });
    return getCustomProviderJob(job.job_id);
  }
}

export async function recoverCustomProviderJob(jobId: string): Promise<GenerationJobStatus> {
  const normalizedJobId = jobId.trim();
  if (!normalizedJobId) throw new Error('恢复任务需要有效的 jobId。');
  const active = recoveryJobs.get(normalizedJobId);
  if (active) return await active;
  const loading = recoveryLoads.get(normalizedJobId);
  if (loading) return await loading;
  const pending = (async () => {
    const persisted = await getGenerationJobRecord(normalizedJobId);
    if (persisted.status === 'succeeded' && persisted.result) {
      cache.set(normalizedJobId, { ...persisted });
      return getCustomProviderJob(normalizedJobId);
    }
    const resumableStatus = persisted.status === 'recoverable_wait'
      || persisted.status === 'unknown'
      || persisted.status === 'queued'
      || persisted.status === 'running'
      || persisted.status === 'materializing';
    if (!resumableStatus) {
      throw new Error(`任务状态 ${persisted.status} 不允许安全取回；不会重新提交生成请求。`);
    }
    // Older persisted rows did not carry the flag; a durable safe handle is
    // the migration evidence for those rows. Explicit false remains blocked.
    if (persisted.resumable === false || (!persisted.external_task_id && !persisted.result_url)) {
      throw new Error('任务没有可安全恢复的上游 task id 或结果地址；不会重新提交生成请求。');
    }
    return await startPersistedRecovery(persisted);
  })();
  recoveryLoads.set(normalizedJobId, pending);
  try {
    return await pending;
  } finally {
    if (recoveryLoads.get(normalizedJobId) === pending) recoveryLoads.delete(normalizedJobId);
  }
}

function startPersistedRecovery(persisted: GenerationJobStatus): Promise<GenerationJobStatus> {
  const jobId = persisted.job_id;
  const active = recoveryJobs.get(jobId);
  if (active) return active;
  cache.set(jobId, { ...persisted });
  const pending = recoverPersistedCustomJob(persisted);
  recoveryJobs.set(jobId, pending);
  void pending.then(() => undefined, () => undefined).finally(() => {
    if (recoveryJobs.get(jobId) === pending) recoveryJobs.delete(jobId);
  });
  return pending;
}

export async function getCustomProviderJobAsync(jobId: string): Promise<GenerationJobStatus> {
  const cached = cache.get(jobId);
  if (cached?.provider_id && cached.network_route) return getCustomProviderJob(jobId);
  try {
    const persisted = await getGenerationJobRecord(jobId);
    cache.set(jobId, cached ? { ...persisted, ...cached } : { ...persisted });
    if (!cached && (
      persisted.status === 'queued'
      || persisted.status === 'submitting'
      || persisted.status === 'running'
      || persisted.status === 'materializing'
    )) {
      if (
        persisted.resumable === true
        || Boolean(persisted.external_task_id || persisted.result_url)
        || persisted.status === 'submitting'
      ) {
        void startPersistedRecovery(persisted).catch(() => undefined);
      }
    }
    return getCustomProviderJob(jobId);
  } catch {
    return getCustomProviderJob(jobId);
  }
}

export function retryCustomProviderJob(jobId: string): boolean {
  const cached = cache.get(jobId);
  if (
    (cached?.status === 'recoverable_wait' || cached?.status === 'unknown')
    && (cached.external_task_id || cached.result_url)
  ) {
    updateCachedJob(jobId, {
      status: cached.result_url ? 'materializing' : 'running',
      phase: cached.result_url ? 'materialize' : 'polling',
      error: null,
    });
    void recoverCustomProviderJob(jobId);
    return true;
  }
  if (cached?.status === 'failed' && cached.videoPollRetry) {
    const retryContext = cached.videoPollRetry;
    updateCachedJob(jobId, {
      status: 'running',
      phase: 'polling',
      result: null,
      error: null,
      external_task_id: retryContext.taskId,
      resumable: true,
    });
    void retryCustomVideoPoll(jobId, retryContext);
    return true;
  }
  return false;
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
  text?: string;
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

export interface AgnesKeyVerificationResult {
  ok: boolean;
  status?: number;
  modelCount?: number;
  category?: 'authentication' | 'authorization' | 'rate-limit' | 'network' | 'response-shape';
  errorMessage?: string;
}

function extractModelIds(payload: unknown): string[] {
  const ids = new Set<string>();
  const pushString = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) {
      ids.add(value.trim().replace(/^models\//, ''));
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
        pushString((item as { baseModelId?: unknown }).baseModelId);
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
            pushString((item as { baseModelId?: unknown }).baseModelId);
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
  const headers = isChatCustomProvider(cfg)
    ? buildChatRequestHeaders(cfg, 'GET')
    : buildRequestHeaders(cfg, 'json', 'GET');

  try {
    const { status, parsed, text } = await requestJson(url, {
      method: 'GET',
      headers,
      timeoutMs: 20000,
    });
    const rawPreview = previewPayload(text);
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

export async function verifyAgnesKey(
  apiKey: string,
  network: Readonly<GenerationNetworkSettings> = useSettingsStore.getState().generationNetworkSettings,
): Promise<AgnesKeyVerificationResult> {
  const trimmedKey = apiKey.trim();
  if (!trimmedKey) {
    return { ok: false, category: 'authentication', errorMessage: '请先输入 Agnes Key。' };
  }
  const cfg = buildAgnesProviderConfig('chat', trimmedKey);
  try {
    const { status, parsed } = await requestJson(resolveModelListUrl(cfg), {
      method: 'GET',
      headers: buildChatRequestHeaders(cfg, 'GET'),
      timeoutMs: 20000,
      network,
    });
    const models = extractModelIds(parsed);
    if (models.length === 0) {
      return {
        ok: false,
        status,
        category: 'response-shape',
        errorMessage: 'Agnes 已响应，但模型列表格式无法识别。',
      };
    }
    return { ok: true, status, modelCount: models.length };
  } catch (error) {
    if (error instanceof HttpStatusError) {
      if (error.status === 401) {
        return { ok: false, status: 401, category: 'authentication', errorMessage: 'Agnes Key 无效或已过期。' };
      }
      if (error.status === 403) {
        return { ok: false, status: 403, category: 'authorization', errorMessage: 'Agnes 账号或当前套餐无权访问模型列表。' };
      }
      if (error.status === 429) {
        return { ok: false, status: 429, category: 'rate-limit', errorMessage: 'Agnes 请求受限，请稍后再验证。' };
      }
    }
    return {
      ok: false,
      category: 'network',
      errorMessage: formatUnknownError(error),
    };
  }
}

export function resolveChatEndpointUrl(cfg: CustomProviderConfig, modelName: string): string {
  const kind = chatProviderKind(cfg);
  const fallbackPath =
    kind === 'openai-responses'
      ? '/v1/responses'
      : kind === 'anthropic-messages'
        ? '/v1/messages'
        : kind === 'google-gemini'
          ? '/v1beta/models/{model}:generateContent'
          : '/v1/chat/completions';
  const path = (cfg.endpointPath ?? '').trim() || fallbackPath;
  const withModel = buildProviderUrl(normalizeProviderBaseUrl(cfg.baseUrl), path)
    .replace(/\{model\}/g, encodeURIComponent(modelName))
    .replace(/\{modelId\}/g, encodeURIComponent(modelName));
  return appendQueryParams(withModel, {
    ...(cfg.queryParams ?? {}),
    ...(isGoogleChatProvider(cfg) && cfg.apiKey.trim() ? { key: cfg.apiKey.trim() } : {}),
  });
}

function buildChatConnectivityBody(cfg: CustomProviderConfig, modelName: string): unknown {
  const prompt = 'Storyboard Copilot connection test. Reply with ok.';
  const defaultParams = resolveDefaultRequestParams(cfg);
  const kind = chatProviderKind(cfg);
  if (kind === 'openai-responses') {
    return {
      ...defaultParams,
      model: modelName,
      input: prompt,
    };
  }
  if (kind === 'anthropic-messages') {
    return {
      ...defaultParams,
      model: modelName,
      max_tokens: 32,
      messages: [{ role: 'user', content: prompt }],
    };
  }
  if (kind === 'google-gemini') {
    return {
      ...defaultParams,
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }],
        },
      ],
    };
  }
  return {
    ...defaultParams,
    model: modelName,
    messages: [{ role: 'user', content: prompt }],
  };
}

function extractOpenAiChatUserText(payload: unknown): string {
  const messages = getValueByPath(payload, 'messages');
  if (!Array.isArray(messages)) {
    return '';
  }
  return messages
    .map((message) => {
      const content = (message as { content?: unknown } | null)?.content;
      return textFromUnknown(content);
    })
    .filter((item): item is string => Boolean(item))
    .join('\n\n')
    .trim();
}

function resolveChatCompletionBody(
  cfg: CustomProviderConfig,
  modelName: string,
  openAiPayload: unknown,
): unknown {
  const defaultParams = resolveDefaultRequestParams(cfg);
  const payloadRecord = openAiPayload && typeof openAiPayload === 'object' && !Array.isArray(openAiPayload)
    ? openAiPayload as Record<string, unknown>
    : {};
  const kind = chatProviderKind(cfg);

  if (kind === 'openai-responses') {
    return {
      ...defaultParams,
      model: modelName,
      input: extractOpenAiChatUserText(openAiPayload),
    };
  }
  if (kind === 'anthropic-messages') {
    const messages = Array.isArray(payloadRecord.messages) ? payloadRecord.messages : [];
    const systemMessage = messages.find((message) =>
      (message as { role?: unknown } | null)?.role === 'system'
    ) as { content?: unknown } | undefined;
    const userMessages = messages.filter((message) =>
      (message as { role?: unknown } | null)?.role !== 'system'
    );
    return {
      ...defaultParams,
      model: modelName,
      system: textFromUnknown(systemMessage?.content) ?? undefined,
      max_tokens: defaultParams.max_tokens ?? DEFAULT_ANTHROPIC_CHAT_MAX_TOKENS,
      messages: userMessages.map((message) => ({
        role: (message as { role?: unknown }).role === 'assistant' ? 'assistant' : 'user',
        content: textFromUnknown((message as { content?: unknown }).content) ?? '',
      })),
    };
  }
  if (kind === 'google-gemini') {
    return {
      ...defaultParams,
      contents: [
        {
          role: 'user',
          parts: [{ text: extractOpenAiChatUserText(openAiPayload) }],
        },
      ],
    };
  }

  if (kind === 'agnes-chat') {
    const normalizedPayload = { ...payloadRecord };
    delete normalizedPayload.stream;
    return {
      max_completion_tokens: DEFAULT_AGNES_CHAT_MAX_COMPLETION_TOKENS,
      ...defaultParams,
      ...normalizedPayload,
      model: modelName,
    };
  }

  return {
    ...defaultParams,
    ...payloadRecord,
    model: modelName,
  };
}

export function buildCustomChatCompletionRequestDebugPreview(
  catalogModelId: string,
  openAiPayload: unknown,
  stream = false,
): CustomProviderRequestDebugPreview {
  const resolved = resolveProviderAndModel(catalogModelId);
  if (!resolved) {
    throw new Error('未找到可用的文本模型配置');
  }
  const { cfg, model } = resolved;
  if (!isChatCustomProvider(cfg)) {
    throw new Error('所选模型不是文本对话模型');
  }
  const url = resolveChatEndpointUrl(cfg, model);
  const headers = stream
    ? {
      ...buildChatRequestHeaders(cfg, 'POST'),
      Accept: 'text/event-stream',
    }
    : buildChatRequestHeaders(cfg, 'POST');
  const body = resolveChatCompletionBody(cfg, model, openAiPayload);
  const finalBody = stream && body && typeof body === 'object' && !Array.isArray(body)
    ? { ...(body as Record<string, unknown>), stream: true }
    : body;

  return {
    providerLabel: cfg.label,
    providerId: cfg.id,
    modelId: catalogModelId,
    modelName: model,
    method: 'POST',
    bodyMode: 'json',
    url: maskDebugUrl(url),
    headers: summarizeDebugHeaders(headers),
    timeoutMs: resolveChatRequestTimeoutMs(cfg),
    body: summarizeDebugValue(finalBody),
  };
}

function textFromUnknown(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const joined = value
      .map((item) => textFromUnknown(item))
      .filter((item): item is string => Boolean(item))
      .join('');
    return joined.trim() || null;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return textFromUnknown(record.text)
      ?? textFromUnknown(record.content)
      ?? textFromUnknown(record.output_text)
      ?? textFromUnknown(record.message)
      ?? textFromUnknown(record.answer)
      ?? textFromUnknown(record.output)
      ?? textFromUnknown(record.result);
  }
  return null;
}

function streamTextFromUnknown(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const joined = value
      .map((item) => streamTextFromUnknown(item))
      .filter((item): item is string => item !== null)
      .join('');
    return joined || null;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return streamTextFromUnknown(record.text)
      ?? streamTextFromUnknown(record.content)
      ?? streamTextFromUnknown(record.output_text)
      ?? streamTextFromUnknown(record.message)
      ?? streamTextFromUnknown(record.answer)
      ?? streamTextFromUnknown(record.output)
      ?? streamTextFromUnknown(record.result);
  }
  return null;
}

function eventTypeFromUnknown(value: unknown): string | null {
  const text = streamTextFromUnknown(value);
  return text?.trim() || null;
}

interface ChatStreamParserState {
  buffer: string;
  isDone: boolean;
  finishReason: string | null;
  usage: unknown | null;
  chunkCount: number;
  dataLineCount: number;
  parsedDataLineCount: number;
  parseFailureCount: number;
  deltaCount: number;
  doneMarkerSeen: boolean;
  completionEventSeen: boolean;
  bridgeDoneSeen: boolean;
  bridgeErrorMessage: string | null;
  bridgeErrorStatus: number | null;
  lastEventType: string | null;
  lastDataLinePreview: string | null;
}

function createChatStreamParserState(): ChatStreamParserState {
  return {
    buffer: '',
    isDone: false,
    finishReason: null,
    usage: null,
    chunkCount: 0,
    dataLineCount: 0,
    parsedDataLineCount: 0,
    parseFailureCount: 0,
    deltaCount: 0,
    doneMarkerSeen: false,
    completionEventSeen: false,
    bridgeDoneSeen: false,
    bridgeErrorMessage: null,
    bridgeErrorStatus: null,
    lastEventType: null,
    lastDataLinePreview: null,
  };
}

function markChatStreamEventType(state: ChatStreamParserState, eventType: string | null): boolean {
  if (!eventType) {
    return false;
  }
  state.lastEventType = eventType;
  if (
    eventType === 'response.completed'
    || eventType === 'message_stop'
    || eventType === 'done'
    || eventType === 'finish'
    || eventType === 'completed'
  ) {
    state.completionEventSeen = true;
    return true;
  }
  return false;
}

function extractOpenAiResponsesText(payload: unknown): string | null {
  const direct = textFromUnknown(getValueByPath(payload, 'output_text'));
  if (direct) return direct;
  const output = getValueByPath(payload, 'output');
  if (!Array.isArray(output)) return null;
  for (const item of output) {
    const content = textFromUnknown(getValueByPath(item, 'content'));
    if (content) return content;
  }
  return null;
}

function extractChatText(payload: unknown): string | null {
  return extractOpenAiResponsesText(payload)
    ?? textFromUnknown(getValueByPath(payload, 'choices[0].message.content'))
    ?? textFromUnknown(getValueByPath(payload, 'choices[0].text'))
    ?? textFromUnknown(getValueByPath(payload, 'content'))
    ?? textFromUnknown(getValueByPath(payload, 'candidates[0].content.parts'))
    ?? textFromUnknown(getValueByPath(payload, 'candidates[0].content.parts[0].text'))
    ?? textFromUnknown(getValueByPath(payload, 'text'))
    ?? textFromUnknown(payload);
}

function normalizeFinishReason(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    return null;
  }
  const text = String(value).trim();
  return text || null;
}

function extractChatFinishReason(payload: unknown): string | null {
  const direct =
    normalizeFinishReason(getValueByPath(payload, 'choices[0].finish_reason'))
    ?? normalizeFinishReason(getValueByPath(payload, 'choices[0].finishReason'))
    ?? normalizeFinishReason(getValueByPath(payload, 'finish_reason'))
    ?? normalizeFinishReason(getValueByPath(payload, 'finishReason'))
    ?? normalizeFinishReason(getValueByPath(payload, 'stop_reason'))
    ?? normalizeFinishReason(getValueByPath(payload, 'delta.stop_reason'))
    ?? normalizeFinishReason(getValueByPath(payload, 'message.stop_reason'))
    ?? normalizeFinishReason(getValueByPath(payload, 'candidates[0].finishReason'))
    ?? normalizeFinishReason(getValueByPath(payload, 'candidates[0].finish_reason'))
    ?? normalizeFinishReason(getValueByPath(payload, 'response.incomplete_details.reason'))
    ?? normalizeFinishReason(getValueByPath(payload, 'incomplete_details.reason'));
  if (direct) {
    return direct;
  }

  const eventType = normalizeFinishReason(getValueByPath(payload, 'type'))
    ?? normalizeFinishReason(getValueByPath(payload, 'event'));
  if (eventType && /incomplete|length|max[_-]?tokens?/i.test(eventType)) {
    return eventType;
  }

  const status = normalizeFinishReason(getValueByPath(payload, 'response.status'))
    ?? normalizeFinishReason(getValueByPath(payload, 'status'));
  if (status && /incomplete|length|max[_-]?tokens?/i.test(status)) {
    return status;
  }

  return null;
}

function extractChatUsage(payload: unknown): unknown | null {
  return getValueByPath(payload, 'usage')
    ?? getValueByPath(payload, 'response.usage')
    ?? null;
}

function extractChatStreamTextDelta(payload: unknown): string {
  return streamTextFromUnknown(getValueByPath(payload, 'choices[0].delta.content'))
    ?? streamTextFromUnknown(getValueByPath(payload, 'choices[0].message.content'))
    ?? streamTextFromUnknown(getValueByPath(payload, 'choices[0].text'))
    ?? streamTextFromUnknown(getValueByPath(payload, 'delta'))
    ?? streamTextFromUnknown(getValueByPath(payload, 'content_block_delta.delta.text'))
    ?? streamTextFromUnknown(getValueByPath(payload, 'delta.text'))
    ?? streamTextFromUnknown(getValueByPath(payload, 'output_text_delta'))
    ?? streamTextFromUnknown(getValueByPath(payload, 'response.output_text.delta'))
    ?? streamTextFromUnknown(getValueByPath(payload, 'message.content'))
    ?? streamTextFromUnknown(getValueByPath(payload, 'content'))
    ?? streamTextFromUnknown(getValueByPath(payload, 'text'))
    ?? '';
}

function handleChatStreamDataLine(
  state: ChatStreamParserState,
  line: string,
  onDelta: (delta: string) => void,
): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }
  state.dataLineCount += 1;
  state.lastDataLinePreview = trimmed.slice(-500);
  if (trimmed === '[DONE]') {
    state.doneMarkerSeen = true;
    return true;
  }
  const parsed = parseResponseText(trimmed);
  if (typeof parsed === 'string') {
    state.parseFailureCount += 1;
    return false;
  }
  state.parsedDataLineCount += 1;
  const finishReason = extractChatFinishReason(parsed);
  if (finishReason) {
    state.finishReason = finishReason;
  }
  const usage = extractChatUsage(parsed);
  if (usage) {
    state.usage = usage;
  }
  const eventType = eventTypeFromUnknown(getValueByPath(parsed, 'type'))
    ?? eventTypeFromUnknown(getValueByPath(parsed, 'event'));
  if (markChatStreamEventType(state, eventType)) {
    return true;
  }
  const delta = extractChatStreamTextDelta(parsed);
  if (delta) {
    state.deltaCount += 1;
    onDelta(delta);
  }
  return false;
}

function consumeChatStreamChunk(
  state: ChatStreamParserState,
  chunk: string,
  onDelta: (delta: string) => void,
) {
  state.chunkCount += 1;
  state.buffer += chunk;
  if (!/\r?\n\r?\n/.test(state.buffer)) {
    const lines = state.buffer.split(/\r?\n/);
    state.buffer = lines.pop() ?? '';
    lines
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !line.startsWith(':') && !line.startsWith('event:') && !line.startsWith('id:'))
      .forEach((line) => {
        const dataLine = line.startsWith('data:') ? line.slice(5).trim() : line;
        if (handleChatStreamDataLine(state, dataLine, onDelta)) {
          state.isDone = true;
        }
      });
    return;
  }

  const blocks = state.buffer.split(/\r?\n\r?\n/);
  state.buffer = blocks.pop() ?? '';

  blocks.forEach((block) => {
    const lines = block
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !line.startsWith(':') && !line.startsWith('event:') && !line.startsWith('id:'));
    const dataLines = lines
      .map((line) => line.startsWith('data:') ? line.slice(5).trim() : line);

    if (dataLines.length === 0) {
      return;
    }

    dataLines.forEach((dataLine) => {
      if (handleChatStreamDataLine(state, dataLine, onDelta)) {
        state.isDone = true;
      }
    });
  });
}

function flushChatStreamBuffer(
  state: ChatStreamParserState,
  onDelta: (delta: string) => void,
) {
  const remaining = state.buffer.trim();
  state.buffer = '';
  if (!remaining) {
    return;
  }
  remaining
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      const dataLine = line.startsWith('data:') ? line.slice(5).trim() : line;
      if (handleChatStreamDataLine(state, dataLine, onDelta)) {
        state.isDone = true;
      }
    });
}

function parseChatStreamText(rawStream: string): {
  text: string;
  state: ChatStreamParserState;
} {
  const state = createChatStreamParserState();
  let text = '';
  consumeChatStreamChunk(state, rawStream, (delta) => {
    text += delta;
  });
  flushChatStreamBuffer(state, (delta) => {
    text += delta;
  });
  return { text, state };
}

function extractChatTextFromRawStream(rawStream: string): string | null {
  const trimmed = rawStream.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = parseResponseText(trimmed);
  if (typeof parsed !== 'string') {
    return extractChatText(parsed);
  }

  const dataLines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== '[DONE]');

  if (dataLines.length === 0) {
    return null;
  }

  const text = dataLines
    .map((line) => {
      const payload = parseResponseText(line);
      return typeof payload === 'string'
        ? null
        : extractChatText(payload) ?? extractChatStreamTextDelta(payload);
    })
    .filter((item): item is string => Boolean(item))
    .join('');

  return text.trim() || null;
}

function buildChatStreamDiagnostics(
  state: ChatStreamParserState,
  elapsedMs: number,
  extra: Partial<CustomChatCompletionStreamDiagnostics> = {},
): CustomChatCompletionStreamDiagnostics {
  return {
    chunkCount: state.chunkCount,
    dataLineCount: state.dataLineCount,
    parsedDataLineCount: state.parsedDataLineCount,
    parseFailureCount: state.parseFailureCount,
    deltaCount: state.deltaCount,
    doneMarkerSeen: state.doneMarkerSeen,
    completionEventSeen: state.completionEventSeen,
    bridgeDoneSeen: state.bridgeDoneSeen,
    bridgeErrorMessage: state.bridgeErrorMessage,
    bridgeErrorStatus: state.bridgeErrorStatus,
    lastEventType: state.lastEventType,
    lastDataLinePreview: state.lastDataLinePreview,
    remainingBufferCharacters: state.buffer.length,
    elapsedMs,
    usage: state.usage ?? undefined,
    ...extra,
  };
}

export async function testCustomChatProviderConnectivity(
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
  const url = resolveChatEndpointUrl(cfg, modelName);
  const headers = buildChatRequestHeaders(cfg, 'POST');
  const body = buildChatConnectivityBody(cfg, modelName);
  try {
    const { status, parsed, text } = await requestJson(url, {
      method: 'POST',
      headers,
      bodyMode: 'json',
      body,
      timeoutMs: 30000,
    });
    const rawPreview = previewPayload(text);
    const extractedText = extractChatText(parsed);
    if (extractedText) {
      return { ok: true, status, text: extractedText, rawPreview };
    }
    return {
      ok: false,
      status,
      errorMessage: `响应中未找到文本内容。响应预览：${previewPayload(parsed)}`,
      rawPreview,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, errorMessage: `请求失败：${msg}` };
  }
}

export async function submitCustomChatCompletion(
  catalogModelId: string,
  openAiPayload: unknown,
): Promise<CustomChatCompletionResult> {
  const resolved = resolveProviderAndModel(catalogModelId);
  if (!resolved) {
    throw new Error('未找到可用的文本模型配置');
  }
  const { cfg, model } = resolved;
  if (!isChatCustomProvider(cfg)) {
    throw new Error('所选模型不是文本对话模型');
  }
  if (!hasCustomProviderCredential(cfg)) {
    throw new Error('未填写 API Key，无法发起文本生成');
  }
  if (!cfg.baseUrl?.trim()) {
    throw new Error('未填写 API 根地址，无法发起文本生成');
  }

  const url = resolveChatEndpointUrl(cfg, model);
  const headers = buildChatRequestHeaders(cfg, 'POST');
  const body = resolveChatCompletionBody(cfg, model, openAiPayload);
  const requestDebug = buildCustomChatCompletionRequestDebugPreview(catalogModelId, openAiPayload, false);
  const { status, parsed } = await requestJson(url, {
    method: 'POST',
    headers,
    bodyMode: 'json',
    body,
    timeoutMs: resolveChatRequestTimeoutMs(cfg),
  });
  const extractedText = extractChatText(parsed);
  if (!extractedText) {
    throw new Error(`响应中未找到文本内容。响应预览：${previewPayload(parsed)}`);
  }
  return {
    text: extractedText,
    status,
    raw: parsed,
    finishReason: extractChatFinishReason(parsed),
    requestDebug,
    usage: extractChatUsage(parsed) ?? undefined,
  };
}

export async function streamCustomChatCompletion(
  catalogModelId: string,
  openAiPayload: unknown,
  options: CustomChatCompletionStreamOptions = {},
): Promise<CustomChatCompletionStreamResult> {
  const resolved = resolveProviderAndModel(catalogModelId);
  if (!resolved) {
    throw new Error('未找到可用的文本模型配置');
  }
  const { cfg, model } = resolved;
  if (!isChatCustomProvider(cfg)) {
    throw new Error('所选模型不是文本对话模型');
  }
  if (!hasCustomProviderCredential(cfg)) {
    throw new Error('未填写 API Key，无法发起文本生成');
  }
  if (!cfg.baseUrl?.trim()) {
    throw new Error('未填写 API 根地址，无法发起文本生成');
  }

  const url = resolveChatEndpointUrl(cfg, model);
  const headers = {
    ...buildChatRequestHeaders(cfg, 'POST'),
    Accept: 'text/event-stream',
  };
  const body = resolveChatCompletionBody(cfg, model, openAiPayload);
  const streamBody = body && typeof body === 'object' && !Array.isArray(body)
    ? { ...(body as Record<string, unknown>), stream: true }
    : body;
  const requestDebug = buildCustomChatCompletionRequestDebugPreview(catalogModelId, openAiPayload, true);
  const state = createChatStreamParserState();
  const startedAt = Date.now();
  let fullText = '';
  let latestStatus: number | undefined;
  let rawStreamTail = '';
  let eventRawCharacters = 0;
  let bridgeReplayUsed = false;
  let replayState: ChatStreamParserState | null = null;
  let replayText = '';
  let streamResponse: CustomHttpStreamResponse | null = null;

  const appendDelta = (delta: string) => {
    if (!delta) {
      return;
    }
    fullText += delta;
    options.onTextDelta?.(delta, fullText);
  };

  try {
    streamResponse = await customHttpStreamRequest({
    url,
    method: 'POST',
    headers,
    bodyMode: 'json',
    body: streamBody,
    timeoutMs: resolveChatRequestTimeoutMs(cfg),
  }, {
    onStatus: (statusCode) => {
      latestStatus = statusCode;
    },
    onChunk: (chunk, statusCode) => {
      latestStatus = typeof statusCode === 'number' ? statusCode : latestStatus;
      options.onRawChunk?.(chunk);
      eventRawCharacters += chunk.length;
      rawStreamTail = `${rawStreamTail}${chunk}`.slice(-8000);
      consumeChatStreamChunk(state, chunk, appendDelta);
    },
    onDone: (statusCode) => {
      latestStatus = typeof statusCode === 'number' ? statusCode : latestStatus;
      state.bridgeDoneSeen = true;
      flushChatStreamBuffer(state, appendDelta);
    },
    onError: (message, statusCode) => {
      state.bridgeErrorMessage = message;
      state.bridgeErrorStatus = typeof statusCode === 'number' ? statusCode : null;
    },
  });
    latestStatus = streamResponse.status;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CustomChatCompletionStreamError(message, {
      status: latestStatus,
      requestDebug,
      rawStreamTail: rawStreamTail || null,
      streamDiagnostics: buildChatStreamDiagnostics(
        state,
        Math.max(0, Date.now() - startedAt),
        {
          eventRawCharacters,
          eventTextCharacters: fullText.length,
          finalTextSource: 'event-stream',
        }
      ),
    });
  }

  flushChatStreamBuffer(state, appendDelta);
  const eventTextCharacters = fullText.length;
  if (streamResponse?.text) {
    const replay = parseChatStreamText(streamResponse.text);
    replayText = replay.text;
    replayState = replay.state;
    if (!state.finishReason && replayState.finishReason) {
      state.finishReason = replayState.finishReason;
    }
    if (!state.usage && replayState.usage) {
      state.usage = replayState.usage;
    }
    if (replayState.doneMarkerSeen) {
      state.doneMarkerSeen = true;
    }
    if (replayState.completionEventSeen) {
      state.completionEventSeen = true;
    }
    if (
      replayText.trim()
      && (
        replayText.length > fullText.length
        || (!state.bridgeDoneSeen && replayState.doneMarkerSeen)
      )
    ) {
      fullText = replayText;
      bridgeReplayUsed = true;
    }
    if (!fullText.trim()) {
      const rawText = extractChatTextFromRawStream(streamResponse.text);
      if (rawText) {
        replayText = rawText;
        fullText = rawText;
        bridgeReplayUsed = true;
      }
    }
    rawStreamTail = streamResponse.text.slice(-8000);
  }

  const diagnosticsExtra: Partial<CustomChatCompletionStreamDiagnostics> = {
    eventRawCharacters,
    eventTextCharacters,
    bridgeReturnedCharacters: streamResponse?.text.length,
    bridgeReturnedByteLength: streamResponse?.byteLength,
    bridgeReturnedChunkCount: streamResponse?.chunkCount,
    replayTextCharacters: replayText ? replayText.length : undefined,
    replayDataLineCount: replayState?.dataLineCount,
    replayParsedDataLineCount: replayState?.parsedDataLineCount,
    replayDeltaCount: replayState?.deltaCount,
    replayParseFailureCount: replayState?.parseFailureCount,
    replayDoneMarkerSeen: replayState?.doneMarkerSeen,
    bridgeReplayUsed,
    finalTextSource: bridgeReplayUsed ? 'bridge-response' : 'event-stream',
  };

  if (!fullText.trim()) {
    throw new CustomChatCompletionStreamError('流式响应中未找到文本内容', {
      status: latestStatus ?? streamResponse?.status,
      requestDebug,
      rawStreamTail: rawStreamTail || null,
      streamDiagnostics: buildChatStreamDiagnostics(
        state,
        Math.max(0, Date.now() - startedAt),
        diagnosticsExtra
      ),
    });
    throw new Error('流式响应中未找到文本内容');
  }
  return {
    text: fullText,
    status: latestStatus ?? streamResponse?.status,
    finishReason: state.finishReason,
    requestDebug,
    rawStreamTail: rawStreamTail || null,
    streamDiagnostics: buildChatStreamDiagnostics(
      state,
      Math.max(0, Date.now() - startedAt),
      diagnosticsExtra
    ),
    usage: state.usage ?? undefined,
  };
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
      const rawPreview = previewPayload(parsed);
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
    const explicitContract = resolveExplicitCustomImageContract(cfg, modelName, request);
    const responseImagePaths = explicitContract?.variant?.responseImagePaths ?? [];
    const parsed = await sendGenerationRequest(cfg, modelName, request, 30000);
    const rawPreview = previewPayload(parsed);
    const imageUrl = await resolveGeneratedImageUrl(
      cfg,
      parsed,
      CONNECTIVITY_TEST_POLL_TIMEOUT_MS,
      responseImagePaths,
      explicitContract?.variant?.asyncTask,
      Boolean(explicitContract),
    );
    if (imageUrl) {
      const preparedImageSource = await materializeGeneratedImageSource(cfg, imageUrl);
      return { ok: true, status: 200, imageUrl: preparedImageSource, rawPreview };
    }
    return {
      ok: false,
      status: 200,
      errorMessage: buildImageNotFoundMessage(cfg, parsed, responseImagePaths),
      rawPreview,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, errorMessage: `请求失败：${msg}` };
  }
}
