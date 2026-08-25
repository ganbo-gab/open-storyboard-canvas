import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Plus, Save, Trash2 } from 'lucide-react';

import {
  isVideoCustomProvider,
  useCustomProvidersStore,
  type CustomProviderConfig,
} from '@/stores/customProvidersStore';
import {
  normalizeProviderBaseUrl,
  normalizeProviderEndpointPath,
} from '@/features/canvas/application/providerUrl';
import {
  defaultVideoInputSchemaForProviderKind,
  normalizeVideoInputSchema,
  resolveVideoInputSchemaFromExtraParams,
  type VideoInputSchema,
  type VideoReferenceRole,
} from '@/features/canvas/application/videoInputSchema';

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

type HttpMethodDraft = 'POST' | 'GET';
type VideoRequestBodyModeDraft = 'json' | 'multipart';
type VideoStatusMethodDraft = 'GET' | 'POST';

interface VideoRequestBodyHintDraft {
  modelField: string;
  promptField: string;
  sizeField: string;
  secondsField: string;
  aspectRatioField: string;
  ratioField: string;
  resolutionField: string;
  imagesField: string;
  videosField: string;
  audioField: string;
  firstFrameField: string;
  lastFrameField: string;
  modeField: string;
  framesModeValue: string;
  selectedSizeField: string;
  secondsAsString: boolean;
  useFrameFields: boolean;
}

const DEFAULT_MODELS: VideoModelDraft[] = [
  { id: 'sora-2', description: 'OpenAI Videos API 默认探索模型' },
  { id: 'sora-2-pro', description: '更高质量的视频生成模型' },
];

const DEFAULT_DURATIONS = ['4', '8', '12'];
const DEFAULT_RESOLUTIONS = ['720x1280', '1280x720', '1024x1792', '1792x1024', '1024x1024'];
const DEFAULT_ASPECT_RATIOS = ['16:9', '9:16', '1:1'];
const EMPTY_VIDEO_REQUEST_BODY_HINTS: VideoRequestBodyHintDraft = {
  modelField: '',
  promptField: '',
  sizeField: '',
  secondsField: '',
  aspectRatioField: '',
  ratioField: '',
  resolutionField: '',
  imagesField: '',
  videosField: '',
  audioField: '',
  firstFrameField: '',
  lastFrameField: '',
  modeField: '',
  framesModeValue: '',
  selectedSizeField: '',
  secondsAsString: false,
  useFrameFields: false,
};
const VIDEO_REFERENCE_ROLES: Array<{ value: VideoReferenceRole; label: string }> = [
  { value: 'reference', label: '普通参考' },
  { value: 'firstFrame', label: '首帧' },
  { value: 'lastFrame', label: '尾帧' },
  { value: 'keyframe', label: '关键帧' },
];
const DEFAULT_OPENAI_VIDEO_NOTE = 'OpenAI Videos API 兼容配置。multipart/form-data 提交 model/prompt/size/seconds/input_reference，轮询任务状态后下载视频。官方文档当前标注 Sora 2 Videos API 将在 2026-09-24 关闭，保留此预设用于兼容。';

const VIDEO_PROVIDER_TEMPLATES: VideoProviderTemplate[] = [
  {
    key: 'custom-video-api',
    label: '自定义视频 API',
    hint: '字段、请求体、轮询和结果路径都可配置，适合经常变动的聚合视频接口',
    labelValue: '自定义视频 API',
    baseUrl: 'https://api.example.com',
    endpointPath: '/v1/videos',
    modelListEndpointPath: '',
    apiStyle: 'generic-json',
    models: [{ id: 'your-video-model', description: '按服务商文档填写模型 ID' }],
    durations: ['5', '10', '15'],
    aspectRatios: DEFAULT_ASPECT_RATIOS,
    resolutions: ['1280x720', '720x1280', '1024x1024'],
    extraParams: {
      providerKind: 'custom-video-api',
      requestComposer: 'video-configurable-json',
      videoRequestBodyMode: 'json',
      videoTaskIdPath: 'task_id',
      videoStatusEndpointPath: '/v1/videos/{taskId}',
      videoStatusMethod: 'GET',
      responseVideoPaths: ['video_url', 'result_url', 'url'],
      videoStatusPath: 'status',
      videoPendingValues: ['queued', 'running', 'processing', 'pending'],
      videoSuccessValues: ['succeeded', 'success', 'completed', 'done'],
      videoFailedValues: ['failed', 'error', 'canceled', 'cancelled'],
      videoPollIntervalMs: 5000,
      videoPollTimeoutMs: 16 * 60 * 1000,
      videoRequestBodyHints: {
        modelField: 'model',
        promptField: 'prompt',
        sizeField: 'size',
        secondsField: 'seconds',
        imagesField: 'images',
        videosField: 'videos',
        audioField: 'audios',
      },
      videoInputSchema: defaultVideoInputSchemaForProviderKind('custom-video-api'),
    },
    note: '通用可配置视频 API：把服务商文档里的请求体字段路径、轮询路径、任务 ID 路径、状态值和结果 URL 路径填进表单。若字段结构很特殊，可直接使用“请求体模板 JSON”，支持 {model}、{prompt}、{seconds}、{size}、{aspect_ratio}、{images}、{videos}、{audios}、{firstFrame}、{lastFrame}、{extra.xxx} 等变量。',
  },
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
      videoInputSchema: defaultVideoInputSchemaForProviderKind('openai-videos'),
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
      videoInputSchema: defaultVideoInputSchemaForProviderKind('xai-grok-video'),
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
      videoInputSchema: defaultVideoInputSchemaForProviderKind('google-video'),
    },
    note: 'Google Veo 使用 Gemini long-running operation：POST /models/{model}:predictLongRunning 并轮询 operation name。当前模板保留真实字段元数据，但需要后续专用 gateway 组装 instances/config，不会伪装成 OpenAI Videos。',
  },
  {
    key: 'chengmeng-seedance9',
    label: '成梦 Seedance 9图',
    hint: 'POST /api/tasks，支持 9 图、3 视频、3 音频和首尾帧模式',
    labelValue: '成梦 Seedance 9图',
    baseUrl: 'https://your-api-domain.com',
    endpointPath: '/api/tasks',
    modelListEndpointPath: '',
    apiStyle: 'generic-json',
    models: [{ id: '22', description: 'Seedance 9图 model_id 示例，请按成梦模型列表调整' }],
    durations: ['1', '2', '3', '4', '5', '6', '8', '10', '12', '15'],
    aspectRatios: ['16:9', '9:16', '1:1', '3:4', '4:3', '21:9'],
    resolutions: ['720p'],
    extraParams: {
      providerKind: 'chengmeng-seedance9',
      requestComposer: 'video-configurable-json',
      videoRequestBodyMode: 'json',
      videoTaskIdPath: 'data.task_no',
      videoStatusEndpointPath: '/api/tasks/{taskId}',
      responseVideoPaths: ['data.result_url', 'data.download_url', 'result_url', 'download_url'],
      videoStatusPath: 'data.status',
      videoPendingValues: ['pending', 'running'],
      videoSuccessValues: ['completed', 'success'],
      videoFailedValues: ['failed', 'error', 'cancelled'],
      videoPollIntervalMs: 5000,
      videoPollTimeoutMs: 16 * 60 * 1000,
      videoReferenceField: 'images',
      videoRequestBodyHints: {
        modelField: 'model_id',
        promptField: 'prompt',
        sizeField: '',
        secondsField: 'values.duration',
        aspectRatioField: 'values.aspect_ratio',
        resolutionField: 'values.resolution',
        imagesField: 'images',
        videosField: 'values.videos',
        audioField: 'values.audioUrls',
        modeField: 'values.mode',
        framesModeValue: 'frames',
        firstFrameField: 'values.first_frame',
        lastFrameField: 'values.last_frame',
      },
      defaultRequestParams: {
        group_id: '14',
        values: {
          mode: 'references',
          resolution: '720p',
        },
      },
      videoInputSchema: defaultVideoInputSchemaForProviderKind('chengmeng-seedance9'),
    },
    note: '成梦 Seedance 9图：Base URL 需要填你的成梦接口域名，API Key 使用 Bearer Token。默认 model_id=22、group_id=14 只是文档示例，保存前按模型列表调整。references 模式下发送 images、values.videos、values.audioUrls；把默认参数 values.mode 改成 frames 后，前两张参考图会改发到 values.first_frame / values.last_frame。',
  },
  {
    key: 'nova-grok15',
    label: 'Nova Grok 1.5',
    hint: 'POST /v1/videos，固定 1 张首帧图，seconds 使用字符串',
    labelValue: 'Nova Grok 1.5 Video',
    baseUrl: 'https://api.novaeworld.top',
    endpointPath: '/v1/videos',
    modelListEndpointPath: '',
    apiStyle: 'generic-json',
    models: [{ id: 'grok-imagine-video-1.5-preview', description: 'Grok Imagine Video 1.5 Preview' }],
    durations: ['6', '10', '15'],
    aspectRatios: ['16:9', '9:16', '3:2'],
    resolutions: ['1280x720', '720x1280', '1792x1024'],
    extraParams: {
      providerKind: 'nova-grok-video-15',
      requestComposer: 'video-configurable-json',
      videoRequestBodyMode: 'json',
      videoTaskIdPath: 'task_id',
      videoStatusEndpointPath: '/v1/videos/{taskId}',
      responseVideoPaths: ['video_url', 'result_url', 'url'],
      responseVideoPath: 'video_url',
      videoStatusPath: 'status',
      videoPendingValues: ['queued', 'running', 'processing', 'pending'],
      videoSuccessValues: ['completed'],
      videoFailedValues: ['failed', 'error', 'cancelled'],
      videoPollIntervalMs: 5000,
      videoPollTimeoutMs: 16 * 60 * 1000,
      videoReferenceField: 'images',
      videoRequestBodyHints: {
        imagesField: 'images',
        secondsField: 'seconds',
        secondsAsString: true,
      },
      videoInputSchema: defaultVideoInputSchemaForProviderKind('nova-grok-video-15'),
    },
    note: 'Nova Grok Imagine Video 1.5 Preview：异步任务接口 POST /v1/videos，轮询 GET /v1/videos/{task_id}。它要求 images 固定 1 张首帧图，seconds 必须是字符串，结果按 video_url / result_url / url 兜底读取。',
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
      videoInputSchema: defaultVideoInputSchemaForProviderKind('seedance-video'),
    },
    note: 'Seedance / 火山方舟任务式视频模板：POST /api/v3/contents/generations/tasks 创建任务，GET /api/v3/contents/generations/tasks/{taskId} 查询结果。模型 ID、duration、ratio、resolution、generate_audio 等字段请按火山方舟控制台/文档调整；若你的账号走 AK/SK 签名或代理，请改为服务端代理后再保存。',
  },
  {
    key: 'minimax-h3',
    label: 'MiniMax H3',
    hint: '官方 v2 video_generation，支持文生/首尾帧/主体参考',
    labelValue: 'MiniMax H3',
    baseUrl: 'https://api.minimaxi.com',
    endpointPath: '/v2/video_generation',
    modelListEndpointPath: '',
    apiStyle: 'generic-json',
    models: [{ id: 'MiniMax-H3', description: 'MiniMax H3 视频生成' }],
    durations: ['6', '5', '8', '10', '12', '15'],
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'],
    resolutions: ['768P', '2K'],
    extraParams: {
      providerKind: 'minimax-h3',
      requestComposer: 'video-minimax-h3-json',
      videoRequestBodyMode: 'json',
      videoTaskIdPath: 'task_id',
      videoStatusEndpointPath: '/v2/query/video_generation/{taskId}',
      videoStatusMethod: 'GET',
      responseVideoPaths: ['task.content.url'],
      videoStatusPath: 'task.status',
      videoErrorPath: 'task.error.message',
      videoPendingValues: ['queued', 'running', 'processing', 'pending'],
      videoSuccessValues: ['succeeded'],
      videoFailedValues: ['failed', 'cancelled', 'canceled'],
      videoPollIntervalMs: 5000,
      videoPollTimeoutMs: 45 * 60 * 1000,
      videoInputSchema: defaultVideoInputSchemaForProviderKind('minimax-h3'),
    },
    note: 'MiniMax H3 官方 v2：POST /v2/video_generation，GET /v2/query/video_generation/{task_id}。默认国内站 https://api.minimaxi.com，国际站改成 https://api.minimax.io。兼容该协议的自建/反代只需改 Base URL 和 Key。一张参考图按首帧，两张按首尾帧，三张及以上或带视频/音频按主体参考。分辨率填 768P/2K。',
  },
];

const DEFAULT_VIDEO_PROVIDER_TEMPLATE = VIDEO_PROVIDER_TEMPLATES[0];

function templateByKey(key: string): VideoProviderTemplate {
  return VIDEO_PROVIDER_TEMPLATES.find((template) => template.key === key) ?? DEFAULT_VIDEO_PROVIDER_TEMPLATE;
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
  return normalizeProviderBaseUrl(value);
}

function normalizeEndpointPath(value: string): string {
  return normalizeProviderEndpointPath(value);
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

function parseJsonArrayOfStrings(text: string): { ok: boolean; value: string[]; error?: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, value: [] };
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
      return { ok: false, value: [], error: '必须是字符串数组，例如 ["video_url", "data.result_url"]' };
    }
    return { ok: true, value: uniqueStrings(parsed) };
  } catch (error) {
    return { ok: false, value: [], error: error instanceof Error ? error.message : 'JSON 数组格式不正确' };
  }
}

function csvToStrings(text: string): string[] {
  return uniqueStrings(text.split(',').map((item) => item.trim()));
}

function stringsToCsv(value: unknown, fallback: string[]): string {
  const source = Array.isArray(value) ? value : fallback;
  return uniqueStrings(source.map(String)).join(', ');
}

function numberText(value: unknown, fallback: number): string {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? String(numeric) : String(fallback);
}

function asPlainRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requestBodyHintsFromExtra(extraParams: Record<string, unknown>): VideoRequestBodyHintDraft {
  const hints = asPlainRecord(extraParams.videoRequestBodyHints);
  return {
    modelField: typeof hints.modelField === 'string' ? hints.modelField : '',
    promptField: typeof hints.promptField === 'string' ? hints.promptField : '',
    sizeField: typeof hints.sizeField === 'string' ? hints.sizeField : '',
    secondsField: typeof hints.secondsField === 'string' ? hints.secondsField : '',
    aspectRatioField: typeof hints.aspectRatioField === 'string' ? hints.aspectRatioField : '',
    ratioField: typeof hints.ratioField === 'string' ? hints.ratioField : '',
    resolutionField: typeof hints.resolutionField === 'string' ? hints.resolutionField : '',
    imagesField: typeof hints.imagesField === 'string'
      ? hints.imagesField
      : (typeof hints.referenceImageField === 'string' ? hints.referenceImageField : ''),
    videosField: typeof hints.videosField === 'string'
      ? hints.videosField
      : (typeof hints.videoField === 'string' ? hints.videoField : ''),
    audioField: typeof hints.audioField === 'string'
      ? hints.audioField
      : (typeof hints.audiosField === 'string' ? hints.audiosField : ''),
    firstFrameField: typeof hints.firstFrameField === 'string' ? hints.firstFrameField : '',
    lastFrameField: typeof hints.lastFrameField === 'string' ? hints.lastFrameField : '',
    modeField: typeof hints.modeField === 'string' ? hints.modeField : '',
    framesModeValue: typeof hints.framesModeValue === 'string' ? hints.framesModeValue : '',
    selectedSizeField: typeof hints.selectedSizeField === 'string' ? hints.selectedSizeField : '',
    secondsAsString: hints.secondsAsString === true,
    useFrameFields: hints.useFrameFields === true,
  };
}

function compactRequestBodyHints(hints: VideoRequestBodyHintDraft): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  Object.entries(hints).forEach(([key, value]) => {
    if (typeof value === 'boolean') {
      if (value) next[key] = value;
      return;
    }
    const text = value.trim();
    if (text || ['modelField', 'promptField', 'sizeField', 'secondsField'].includes(key)) {
      next[key] = text;
    }
  });
  return next;
}

function responseVideoPathsFromExtra(extraParams: Record<string, unknown>): string[] {
  const paths = Array.isArray(extraParams.responseVideoPaths)
    ? extraParams.responseVideoPaths.map(String)
    : [];
  const single = typeof extraParams.responseVideoPath === 'string' ? extraParams.responseVideoPath : '';
  return uniqueStrings([...paths, single]);
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

function schemaFromExtra(extraParams: Record<string, unknown>): VideoInputSchema {
  return resolveVideoInputSchemaFromExtraParams(extraParams);
}

function updateSchemaImage(
  schema: VideoInputSchema,
  patch: Partial<VideoInputSchema['images']>
): VideoInputSchema {
  return normalizeVideoInputSchema({
    ...schema,
    images: {
      ...schema.images,
      ...patch,
    },
  }, schema);
}

function updateSchemaVideo(
  schema: VideoInputSchema,
  patch: Partial<VideoInputSchema['video']>
): VideoInputSchema {
  return normalizeVideoInputSchema({
    ...schema,
    video: {
      ...schema.video,
      ...patch,
    },
  }, schema);
}

function updateSchemaAudio(
  schema: VideoInputSchema,
  patch: Partial<VideoInputSchema['audio']>
): VideoInputSchema {
  return normalizeVideoInputSchema({
    ...schema,
    audio: {
      ...schema.audio,
      ...patch,
    },
  }, schema);
}

export const VideoProvidersSection = memo(function VideoProvidersSection() {
  const providers = useCustomProvidersStore((state) => state.providers);
  const pendingEditId = useCustomProvidersStore((state) => state.pendingEditId);
  const addProvider = useCustomProvidersStore((state) => state.addProvider);
  const updateProvider = useCustomProvidersStore((state) => state.updateProvider);
  const setPendingEditId = useCustomProvidersStore((state) => state.setPendingEditId);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [label, setLabel] = useState(DEFAULT_VIDEO_PROVIDER_TEMPLATE.labelValue);
  const [baseUrl, setBaseUrl] = useState(DEFAULT_VIDEO_PROVIDER_TEMPLATE.baseUrl);
  const [endpointPath, setEndpointPath] = useState(DEFAULT_VIDEO_PROVIDER_TEMPLATE.endpointPath);
  const [modelListEndpointPath, setModelListEndpointPath] = useState(DEFAULT_VIDEO_PROVIDER_TEMPLATE.modelListEndpointPath);
  const [httpMethod, setHttpMethod] = useState<HttpMethodDraft>('POST');
  const [apiStyle, setApiStyle] = useState(DEFAULT_VIDEO_PROVIDER_TEMPLATE.apiStyle);
  const [videoRequestBodyMode, setVideoRequestBodyMode] = useState<VideoRequestBodyModeDraft>('json');
  const [videoTaskIdPath, setVideoTaskIdPath] = useState('task_id');
  const [videoStatusEndpointPath, setVideoStatusEndpointPath] = useState('/v1/videos/{taskId}');
  const [videoStatusMethod, setVideoStatusMethod] = useState<VideoStatusMethodDraft>('GET');
  const [videoStatusRequestBodyText, setVideoStatusRequestBodyText] = useState('{}');
  const [videoStatusQueryParamsText, setVideoStatusQueryParamsText] = useState('{}');
  const [videoStatusPath, setVideoStatusPath] = useState('status');
  const [videoErrorPath, setVideoErrorPath] = useState('error');
  const [responseVideoPathsText, setResponseVideoPathsText] = useState('["video_url"]');
  const [videoPendingValuesText, setVideoPendingValuesText] = useState('queued, running, processing, pending');
  const [videoSuccessValuesText, setVideoSuccessValuesText] = useState('succeeded, success, completed, done');
  const [videoFailedValuesText, setVideoFailedValuesText] = useState('failed, error, canceled, cancelled');
  const [videoPollIntervalMs, setVideoPollIntervalMs] = useState('5000');
  const [videoPollTimeoutMs, setVideoPollTimeoutMs] = useState(String(16 * 60 * 1000));
  const [videoRequestBodyTemplateText, setVideoRequestBodyTemplateText] = useState('{}');
  const [videoRequestBodyHints, setVideoRequestBodyHints] = useState<VideoRequestBodyHintDraft>(EMPTY_VIDEO_REQUEST_BODY_HINTS);
  const [templateExtraParams, setTemplateExtraParams] = useState<Record<string, unknown>>(DEFAULT_VIDEO_PROVIDER_TEMPLATE.extraParams);
  const [providerNote, setProviderNote] = useState(DEFAULT_VIDEO_PROVIDER_TEMPLATE.note);
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<VideoModelDraft[]>(DEFAULT_VIDEO_PROVIDER_TEMPLATE.models);
  const [newModelId, setNewModelId] = useState('');
  const [newModelDescription, setNewModelDescription] = useState('');
  const [durations, setDurations] = useState<string[]>(DEFAULT_VIDEO_PROVIDER_TEMPLATE.durations);
  const [aspectRatios, setAspectRatios] = useState<string[]>(DEFAULT_VIDEO_PROVIDER_TEMPLATE.aspectRatios);
  const [resolutions, setResolutions] = useState<string[]>(DEFAULT_VIDEO_PROVIDER_TEMPLATE.resolutions);
  const [inputSchema, setInputSchema] = useState<VideoInputSchema>(
    () => schemaFromExtra(DEFAULT_VIDEO_PROVIDER_TEMPLATE.extraParams)
  );
  const [customDuration, setCustomDuration] = useState('');
  const [customAspectRatio, setCustomAspectRatio] = useState('');
  const [customResolution, setCustomResolution] = useState('');
  const [defaultParamsText, setDefaultParamsText] = useState('{}');
  const [savedFlash, setSavedFlash] = useState(false);

  const parsedDefaultParams = useMemo(() => parseJsonObject(defaultParamsText), [defaultParamsText]);
  const parsedStatusRequestBody = useMemo(() => parseJsonObject(videoStatusRequestBodyText), [videoStatusRequestBodyText]);
  const parsedStatusQueryParams = useMemo(() => parseJsonObject(videoStatusQueryParamsText), [videoStatusQueryParamsText]);
  const parsedResponseVideoPaths = useMemo(() => parseJsonArrayOfStrings(responseVideoPathsText), [responseVideoPathsText]);
  const parsedVideoRequestBodyTemplate = useMemo(() => parseJsonObject(videoRequestBodyTemplateText), [videoRequestBodyTemplateText]);

  const applyExtraParamsToForm = useCallback((extraParams: Record<string, unknown>) => {
    setTemplateExtraParams({ ...extraParams });
    setVideoRequestBodyMode(extraParams.videoRequestBodyMode === 'multipart' || extraParams.requestBodyMode === 'multipart'
      ? 'multipart'
      : 'json');
    setVideoTaskIdPath(typeof extraParams.videoTaskIdPath === 'string' ? extraParams.videoTaskIdPath : '');
    setVideoStatusEndpointPath(typeof extraParams.videoStatusEndpointPath === 'string'
      ? extraParams.videoStatusEndpointPath
      : '');
    setVideoStatusMethod(String(extraParams.videoStatusMethod ?? extraParams.videoPollMethod ?? 'GET').toUpperCase() === 'POST'
      ? 'POST'
      : 'GET');
    setVideoStatusRequestBodyText(stringifyJsonObject(extraParams.videoStatusRequestBody ?? extraParams.videoPollRequestBody));
    setVideoStatusQueryParamsText(stringifyJsonObject(extraParams.videoStatusQueryParams ?? extraParams.videoPollQueryParams));
    setVideoStatusPath(typeof extraParams.videoStatusPath === 'string' ? extraParams.videoStatusPath : 'status');
    setVideoErrorPath(typeof extraParams.videoErrorPath === 'string' ? extraParams.videoErrorPath : 'error');
    const responsePaths = responseVideoPathsFromExtra(extraParams);
    setResponseVideoPathsText(JSON.stringify(responsePaths.length > 0 ? responsePaths : ['video_url'], null, 2));
    setVideoPendingValuesText(stringsToCsv(extraParams.videoPendingValues, ['queued', 'running', 'processing', 'pending']));
    setVideoSuccessValuesText(stringsToCsv(extraParams.videoSuccessValues, ['succeeded', 'success', 'completed', 'done']));
    setVideoFailedValuesText(stringsToCsv(extraParams.videoFailedValues, ['failed', 'error', 'canceled', 'cancelled']));
    setVideoPollIntervalMs(numberText(extraParams.videoPollIntervalMs, 5000));
    setVideoPollTimeoutMs(numberText(extraParams.videoPollTimeoutMs, 16 * 60 * 1000));
    setVideoRequestBodyTemplateText(stringifyJsonObject(extraParams.videoRequestBodyTemplate ?? extraParams.requestBodyTemplate));
    setVideoRequestBodyHints(requestBodyHintsFromExtra(extraParams));
  }, []);

  const resetForm = useCallback(() => {
    const template = DEFAULT_VIDEO_PROVIDER_TEMPLATE;
    setEditingId(null);
    setLabel(template.labelValue);
    setBaseUrl(template.baseUrl);
    setEndpointPath(template.endpointPath);
    setModelListEndpointPath(template.modelListEndpointPath);
    setHttpMethod('POST');
    setApiStyle(template.apiStyle);
    applyExtraParamsToForm(template.extraParams);
    setProviderNote(template.note);
    setApiKey('');
    setModels(template.models);
    setNewModelId('');
    setNewModelDescription('');
    setDurations(template.durations);
    setAspectRatios(template.aspectRatios);
    setResolutions(template.resolutions);
    setInputSchema(schemaFromExtra(template.extraParams));
    setCustomDuration('');
    setCustomAspectRatio('');
    setCustomResolution('');
    setDefaultParamsText(stringifyJsonObject(template.extraParams.defaultRequestParams));
  }, [applyExtraParamsToForm]);

  useEffect(() => {
    if (!pendingEditId) return;
    const provider = providers.find((item) => item.id === pendingEditId);
    if (!provider || !isVideoCustomProvider(provider)) return;
    setEditingId(provider.id);
    setLabel(provider.label);
    setBaseUrl(provider.baseUrl);
    setEndpointPath(provider.endpointPath ?? '/v1/videos');
    setModelListEndpointPath(provider.modelListEndpointPath ?? '');
    setHttpMethod(provider.httpMethod === 'GET' ? 'GET' : 'POST');
    setApiStyle(provider.apiStyle || 'generic-json');
    applyExtraParamsToForm(provider.extraParams ?? {});
    setProviderNote(provider.note ?? '');
    setApiKey(provider.apiKey);
    setModels(modelDraftsFromProvider(provider));
    setDurations(arrayFromExtra(provider, 'supportedDurations', DEFAULT_DURATIONS));
    setAspectRatios(arrayFromExtra(provider, 'supportedRatios', DEFAULT_ASPECT_RATIOS));
    setResolutions(provider.supportedResolutions && provider.supportedResolutions.length > 0
      ? provider.supportedResolutions
      : arrayFromExtra(provider, 'supportedResolutions', DEFAULT_RESOLUTIONS));
    setInputSchema(schemaFromExtra(provider.extraParams ?? {}));
    setDefaultParamsText(stringifyJsonObject(provider.extraParams?.defaultRequestParams));
    setPendingEditId(null);
  }, [applyExtraParamsToForm, pendingEditId, providers, setPendingEditId]);

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
    setHttpMethod('POST');
    setApiStyle(template.apiStyle);
    setModels(template.models);
    setDurations(template.durations);
    setAspectRatios(template.aspectRatios);
    setResolutions(template.resolutions);
    applyExtraParamsToForm(template.extraParams);
    setInputSchema(schemaFromExtra(template.extraParams));
    setProviderNote(template.note);
    setDefaultParamsText(stringifyJsonObject(template.extraParams.defaultRequestParams));
    setNewModelId('');
    setNewModelDescription('');
  }, [applyExtraParamsToForm]);

  const handleSave = useCallback(() => {
    const cleanModels = models.filter((model) => model.id.trim()).map((model) => ({
      id: model.id.trim(),
      description: model.description.trim(),
    }));
    if (
      !label.trim()
      || !baseUrl.trim()
      || cleanModels.length === 0
      || !parsedDefaultParams.ok
      || !parsedStatusRequestBody.ok
      || !parsedStatusQueryParams.ok
      || !parsedResponseVideoPaths.ok
      || !parsedVideoRequestBodyTemplate.ok
    ) return;
    const modelDescriptions = Object.fromEntries(
      cleanModels
        .filter((model) => model.description)
        .map((model) => [model.id, model.description])
    );
    const requestBodyTemplate = parsedVideoRequestBodyTemplate.value;
    const hasRequestBodyTemplate = Object.keys(requestBodyTemplate).length > 0;
    const statusRequestBody = parsedStatusRequestBody.value;
    const statusQueryParams = parsedStatusQueryParams.value;
    const responseVideoPaths = parsedResponseVideoPaths.value;
    const pendingValues = csvToStrings(videoPendingValuesText);
    const successValues = csvToStrings(videoSuccessValuesText);
    const failedValues = csvToStrings(videoFailedValuesText);
    const intervalMs = Number(videoPollIntervalMs);
    const timeoutMs = Number(videoPollTimeoutMs);
    const mergedExtraParams: Record<string, unknown> = {
      ...templateExtraParams,
      providerConfigVersion: 'video-v1',
      mediaType: 'video',
      supportedDurations: durations,
      supportedRatios: aspectRatios,
      supportedResolutions: resolutions,
      requestComposer: templateExtraParams.requestComposer ?? 'video-configurable-json',
      videoRequestBodyMode,
      videoTaskIdPath: videoTaskIdPath.trim(),
      videoStatusEndpointPath: videoStatusEndpointPath.trim(),
      videoStatusMethod,
      videoStatusPath: videoStatusPath.trim(),
      videoErrorPath: videoErrorPath.trim(),
      responseVideoPaths,
      responseVideoPath: responseVideoPaths[0] ?? '',
      videoPendingValues: pendingValues,
      videoSuccessValues: successValues,
      videoFailedValues: failedValues,
      videoPollIntervalMs: Number.isFinite(intervalMs) ? intervalMs : 5000,
      videoPollTimeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 16 * 60 * 1000,
      videoRequestBodyHints: compactRequestBodyHints(videoRequestBodyHints),
      videoInputSchema: inputSchema,
      modelDescriptions,
      defaultRequestParams: parsedDefaultParams.value,
    };
    if (hasRequestBodyTemplate) {
      mergedExtraParams.videoRequestBodyTemplate = requestBodyTemplate;
    } else {
      delete mergedExtraParams.videoRequestBodyTemplate;
      delete mergedExtraParams.requestBodyTemplate;
    }
    if (Object.keys(statusRequestBody).length > 0) {
      mergedExtraParams.videoStatusRequestBody = statusRequestBody;
    } else {
      delete mergedExtraParams.videoStatusRequestBody;
      delete mergedExtraParams.videoPollRequestBody;
    }
    if (Object.keys(statusQueryParams).length > 0) {
      mergedExtraParams.videoStatusQueryParams = statusQueryParams;
    } else {
      delete mergedExtraParams.videoStatusQueryParams;
      delete mergedExtraParams.videoPollQueryParams;
    }
    const config: CustomProviderConfig = {
      id: editingId ?? generateProviderId(),
      label: label.trim(),
      mediaType: 'video',
      baseUrl: normalizeBaseUrl(baseUrl),
      endpointPath: normalizeEndpointPath(endpointPath),
      modelListEndpointPath: normalizeEndpointPath(modelListEndpointPath),
      httpMethod,
      apiKey,
      apiStyle,
      models: cleanModels.map((model) => model.id),
      supportsWebSearch: false,
      extraHeaders: {},
      queryParams: {},
      responseFormat: 'generic',
      supportedResolutions: resolutions,
      extraParams: mergedExtraParams,
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
    httpMethod,
    inputSchema,
    label,
    modelListEndpointPath,
    models,
    parsedDefaultParams,
    parsedResponseVideoPaths,
    parsedStatusQueryParams,
    parsedStatusRequestBody,
    parsedVideoRequestBodyTemplate,
    providerNote,
    resolutions,
    templateExtraParams,
    updateProvider,
    videoErrorPath,
    videoFailedValuesText,
    videoPendingValuesText,
    videoPollIntervalMs,
    videoPollTimeoutMs,
    videoRequestBodyHints,
    videoRequestBodyMode,
    videoStatusEndpointPath,
    videoStatusMethod,
    videoStatusPath,
    videoSuccessValuesText,
    videoTaskIdPath,
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
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-text-muted">提交方法</span>
            <select
              value={httpMethod}
              onChange={(event) => setHttpMethod(event.target.value === 'GET' ? 'GET' : 'POST')}
              className="h-9 w-full rounded-md border border-border-dark bg-surface-dark px-3 text-sm text-text-dark outline-none focus:border-accent"
            >
              <option value="POST">POST</option>
              <option value="GET">GET</option>
            </select>
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-text-muted">请求体模式</span>
            <select
              value={videoRequestBodyMode}
              onChange={(event) => setVideoRequestBodyMode(event.target.value === 'multipart' ? 'multipart' : 'json')}
              className="h-9 w-full rounded-md border border-border-dark bg-surface-dark px-3 text-sm text-text-dark outline-none focus:border-accent"
            >
              <option value="json">JSON / 查询参数</option>
              <option value="multipart">multipart/form-data</option>
            </select>
          </label>
        </div>

        <div className="mt-4 rounded-lg border border-border-dark bg-surface-dark p-3">
          <div className="text-xs font-medium text-text-muted">自定义请求体映射</div>
          <div className="mt-1 text-[11px] leading-4 text-text-muted">
            字段支持点路径，例如 values.duration。留空表示不发送该字段；若使用下面的请求体模板 JSON，则模板优先。
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
            {[
              ['模型字段', 'modelField', 'model'],
              ['提示词字段', 'promptField', 'prompt'],
              ['秒数字段', 'secondsField', 'seconds'],
              ['尺寸字段', 'sizeField', 'size'],
              ['画幅字段', 'aspectRatioField', 'aspect_ratio'],
              ['比例字段', 'ratioField', 'ratio'],
              ['分辨率字段', 'resolutionField', 'resolution'],
              ['已选尺寸字段', 'selectedSizeField', 'size'],
              ['图片数组字段', 'imagesField', 'images'],
              ['视频数组字段', 'videosField', 'videos'],
              ['音频数组字段', 'audioField', 'audios'],
              ['首帧字段', 'firstFrameField', 'first_frame'],
              ['尾帧字段', 'lastFrameField', 'last_frame'],
              ['模式字段', 'modeField', 'values.mode'],
              ['首尾帧模式值', 'framesModeValue', 'frames'],
            ].map(([title, key, placeholder]) => (
              <label key={key} className="flex flex-col gap-1 text-[11px] text-text-muted">
                {title}
                <input
                  value={String(videoRequestBodyHints[key as keyof VideoRequestBodyHintDraft] ?? '')}
                  onChange={(event) => setVideoRequestBodyHints((current) => ({
                    ...current,
                    [key]: event.target.value,
                  }))}
                  className="h-8 rounded-md border border-border-dark bg-bg-dark px-2 font-mono text-xs text-text-dark outline-none focus:border-accent"
                  placeholder={placeholder}
                />
              </label>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-4">
            <label className="flex items-center gap-2 text-[11px] text-text-muted">
              <input
                type="checkbox"
                checked={videoRequestBodyHints.secondsAsString}
                onChange={(event) => setVideoRequestBodyHints((current) => ({
                  ...current,
                  secondsAsString: event.target.checked,
                }))}
                className="h-3.5 w-3.5 accent-accent"
              />
              秒数转字符串
            </label>
            <label className="flex items-center gap-2 text-[11px] text-text-muted">
              <input
                type="checkbox"
                checked={videoRequestBodyHints.useFrameFields}
                onChange={(event) => setVideoRequestBodyHints((current) => ({
                  ...current,
                  useFrameFields: event.target.checked,
                }))}
                className="h-3.5 w-3.5 accent-accent"
              />
              强制使用首帧/尾帧字段
            </label>
          </div>
          <details className="mt-3 rounded-md border border-border-dark bg-bg-dark p-3">
            <summary className="cursor-pointer text-[11px] font-medium text-text-muted hover:text-text-dark">
              请求体模板 JSON（可选，高优先级）
            </summary>
            <div className="mt-2 text-[11px] leading-5 text-text-muted">
              支持变量：{'{model}'}、{'{prompt}'}、{'{seconds}'}、{'{size}'}、{'{aspect_ratio}'}、{'{images}'}、{'{videos}'}、{'{audios}'}、{'{firstFrame}'}、{'{lastFrame}'}、{'{extra.xxx}'}。
            </div>
            <textarea
              value={videoRequestBodyTemplateText}
              onChange={(event) => setVideoRequestBodyTemplateText(event.target.value)}
              className="ui-scrollbar mt-2 h-[130px] w-full resize-none rounded-md border border-border-dark bg-surface-dark px-3 py-2 font-mono text-[11px] leading-5 text-text-dark outline-none focus:border-accent"
              spellCheck={false}
            />
            {!parsedVideoRequestBodyTemplate.ok && (
              <div className="mt-1 text-[10px] text-red-300">{parsedVideoRequestBodyTemplate.error}</div>
            )}
          </details>
        </div>

        <div className="mt-4 rounded-lg border border-border-dark bg-surface-dark p-3">
          <div className="text-xs font-medium text-text-muted">异步任务 / 轮询解析</div>
          <div className="mt-1 text-[11px] leading-4 text-text-muted">
            提交后从任务 ID 路径取 taskId，再按轮询路径查询状态和结果 URL。路径支持 data.task_no、data.result_url、content[0].url。
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
            <label className="flex flex-col gap-1 text-[11px] text-text-muted">
              任务 ID 路径
              <input
                value={videoTaskIdPath}
                onChange={(event) => setVideoTaskIdPath(event.target.value)}
                className="h-8 rounded-md border border-border-dark bg-bg-dark px-2 font-mono text-xs text-text-dark outline-none focus:border-accent"
                placeholder="data.task_no / task_id"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-text-muted lg:col-span-2">
              轮询路径
              <input
                value={videoStatusEndpointPath}
                onChange={(event) => setVideoStatusEndpointPath(event.target.value)}
                className="h-8 rounded-md border border-border-dark bg-bg-dark px-2 font-mono text-xs text-text-dark outline-none focus:border-accent"
                placeholder="/v1/videos/{taskId}"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-text-muted">
              轮询方法
              <select
                value={videoStatusMethod}
                onChange={(event) => setVideoStatusMethod(event.target.value === 'POST' ? 'POST' : 'GET')}
                className="h-8 rounded-md border border-border-dark bg-bg-dark px-2 text-xs text-text-dark outline-none focus:border-accent"
              >
                <option value="GET">GET</option>
                <option value="POST">POST</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-text-muted">
              状态路径
              <input
                value={videoStatusPath}
                onChange={(event) => setVideoStatusPath(event.target.value)}
                className="h-8 rounded-md border border-border-dark bg-bg-dark px-2 font-mono text-xs text-text-dark outline-none focus:border-accent"
                placeholder="status / data.status"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-text-muted">
              错误信息路径
              <input
                value={videoErrorPath}
                onChange={(event) => setVideoErrorPath(event.target.value)}
                className="h-8 rounded-md border border-border-dark bg-bg-dark px-2 font-mono text-xs text-text-dark outline-none focus:border-accent"
                placeholder="error / message"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-text-muted">
              轮询间隔 ms
              <input
                value={videoPollIntervalMs}
                onChange={(event) => setVideoPollIntervalMs(event.target.value)}
                className="h-8 rounded-md border border-border-dark bg-bg-dark px-2 font-mono text-xs text-text-dark outline-none focus:border-accent"
                placeholder="5000"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-text-muted">
              超时 ms
              <input
                value={videoPollTimeoutMs}
                onChange={(event) => setVideoPollTimeoutMs(event.target.value)}
                className="h-8 rounded-md border border-border-dark bg-bg-dark px-2 font-mono text-xs text-text-dark outline-none focus:border-accent"
                placeholder="960000"
              />
            </label>
          </div>
          <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
            <label className="flex flex-col gap-1 text-[11px] text-text-muted">
              结果视频路径 JSON
              <textarea
                value={responseVideoPathsText}
                onChange={(event) => setResponseVideoPathsText(event.target.value)}
                className="ui-scrollbar h-[86px] resize-none rounded-md border border-border-dark bg-bg-dark px-3 py-2 font-mono text-[11px] leading-5 text-text-dark outline-none focus:border-accent"
                spellCheck={false}
              />
              {!parsedResponseVideoPaths.ok && (
                <span className="text-[10px] text-red-300">{parsedResponseVideoPaths.error}</span>
              )}
            </label>
            <div className="grid grid-cols-1 gap-2">
              <label className="flex flex-col gap-1 text-[11px] text-text-muted">
                等待状态（逗号分隔）
                <input
                  value={videoPendingValuesText}
                  onChange={(event) => setVideoPendingValuesText(event.target.value)}
                  className="h-8 rounded-md border border-border-dark bg-bg-dark px-2 font-mono text-xs text-text-dark outline-none focus:border-accent"
                />
              </label>
              <label className="flex flex-col gap-1 text-[11px] text-text-muted">
                成功状态（逗号分隔）
                <input
                  value={videoSuccessValuesText}
                  onChange={(event) => setVideoSuccessValuesText(event.target.value)}
                  className="h-8 rounded-md border border-border-dark bg-bg-dark px-2 font-mono text-xs text-text-dark outline-none focus:border-accent"
                />
              </label>
              <label className="flex flex-col gap-1 text-[11px] text-text-muted">
                失败状态（逗号分隔）
                <input
                  value={videoFailedValuesText}
                  onChange={(event) => setVideoFailedValuesText(event.target.value)}
                  className="h-8 rounded-md border border-border-dark bg-bg-dark px-2 font-mono text-xs text-text-dark outline-none focus:border-accent"
                />
              </label>
            </div>
          </div>
          <details className="mt-3 rounded-md border border-border-dark bg-bg-dark p-3">
            <summary className="cursor-pointer text-[11px] font-medium text-text-muted hover:text-text-dark">
              轮询 body / query 模板
            </summary>
            <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
              <label className="flex flex-col gap-1 text-[11px] text-text-muted">
                POST body JSON
                <textarea
                  value={videoStatusRequestBodyText}
                  onChange={(event) => setVideoStatusRequestBodyText(event.target.value)}
                  className="ui-scrollbar h-[90px] resize-none rounded-md border border-border-dark bg-surface-dark px-3 py-2 font-mono text-[11px] leading-5 text-text-dark outline-none focus:border-accent"
                  spellCheck={false}
                />
                {!parsedStatusRequestBody.ok && (
                  <span className="text-[10px] text-red-300">{parsedStatusRequestBody.error}</span>
                )}
              </label>
              <label className="flex flex-col gap-1 text-[11px] text-text-muted">
                GET query JSON
                <textarea
                  value={videoStatusQueryParamsText}
                  onChange={(event) => setVideoStatusQueryParamsText(event.target.value)}
                  className="ui-scrollbar h-[90px] resize-none rounded-md border border-border-dark bg-surface-dark px-3 py-2 font-mono text-[11px] leading-5 text-text-dark outline-none focus:border-accent"
                  spellCheck={false}
                />
                {!parsedStatusQueryParams.ok && (
                  <span className="text-[10px] text-red-300">{parsedStatusQueryParams.error}</span>
                )}
              </label>
            </div>
          </details>
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

        <div className="mt-4 rounded-lg border border-border-dark bg-surface-dark p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-xs font-medium text-text-muted">视频输入能力 Schema</div>
              <div className="mt-1 text-[11px] leading-4 text-text-muted">
                视频节点会按这里的能力显示图片、视频、音频引用，并在需要时自动把参考图上传到已启用的图床。
              </div>
            </div>
            <button
              type="button"
              onClick={() => setInputSchema(schemaFromExtra(templateExtraParams))}
              className="rounded-md border border-border-dark bg-bg-dark px-2 py-1 text-[11px] text-text-muted hover:border-accent/50 hover:text-text-dark"
            >
              按模板恢复
            </button>
          </div>

          <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-3">
            <div className="rounded-lg border border-border-dark bg-bg-dark p-3">
              <label className="flex items-center gap-2 text-xs font-medium text-text-dark">
                <input
                  type="checkbox"
                  checked={inputSchema.images.enabled}
                  onChange={(event) => setInputSchema((current) => updateSchemaImage(current, {
                    enabled: event.target.checked,
                    max: event.target.checked ? Math.max(1, current.images.max || 1) : 0,
                  }))}
                  className="h-4 w-4 accent-accent"
                />
                图片引用
              </label>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1 text-[11px] text-text-muted">
                  最少
                  <input
                    type="number"
                    min={0}
                    max={9}
                    value={inputSchema.images.min}
                    disabled={!inputSchema.images.enabled}
                    onChange={(event) => setInputSchema((current) => updateSchemaImage(current, {
                      min: Number(event.target.value),
                    }))}
                    className="h-8 rounded-md border border-border-dark bg-surface-dark px-2 text-xs text-text-dark outline-none focus:border-accent disabled:opacity-50"
                  />
                </label>
                <label className="flex flex-col gap-1 text-[11px] text-text-muted">
                  最多
                  <input
                    type="number"
                    min={0}
                    max={9}
                    value={inputSchema.images.max}
                    disabled={!inputSchema.images.enabled}
                    onChange={(event) => setInputSchema((current) => updateSchemaImage(current, {
                      max: Number(event.target.value),
                    }))}
                    className="h-8 rounded-md border border-border-dark bg-surface-dark px-2 text-xs text-text-dark outline-none focus:border-accent disabled:opacity-50"
                  />
                </label>
              </div>
              <label className="mt-3 flex items-center gap-2 text-[11px] text-text-muted">
                <input
                  type="checkbox"
                  checked={inputSchema.images.requireImageHost}
                  disabled={!inputSchema.images.enabled}
                  onChange={(event) => setInputSchema((current) => updateSchemaImage(current, {
                    requireImageHost: event.target.checked,
                  }))}
                  className="h-3.5 w-3.5 accent-accent"
                />
                请求前转为图床 URL
              </label>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {VIDEO_REFERENCE_ROLES.map((role) => {
                  const active = inputSchema.images.roles.includes(role.value);
                  return (
                    <button
                      key={role.value}
                      type="button"
                      disabled={!inputSchema.images.enabled}
                      onClick={() => setInputSchema((current) => {
                        const roles = current.images.roles.includes(role.value)
                          ? current.images.roles.filter((item) => item !== role.value)
                          : [...current.images.roles, role.value];
                        return updateSchemaImage(current, {
                          roles: roles.length > 0 ? roles : ['reference'],
                        });
                      })}
                      className={`rounded-md border px-2 py-1 text-[11px] transition-colors disabled:opacity-50 ${
                        active
                          ? 'border-accent/60 bg-accent/15 text-accent'
                          : 'border-border-dark bg-surface-dark text-text-muted hover:border-accent/40 hover:text-text-dark'
                      }`}
                    >
                      {role.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="rounded-lg border border-border-dark bg-bg-dark p-3">
              <label className="flex items-center gap-2 text-xs font-medium text-text-dark">
                <input
                  type="checkbox"
                  checked={inputSchema.video.enabled}
                  onChange={(event) => setInputSchema((current) => updateSchemaVideo(current, {
                    enabled: event.target.checked,
                    max: event.target.checked ? Math.max(1, current.video.max || 1) : 0,
                  }))}
                  className="h-4 w-4 accent-accent"
                />
                视频引用
              </label>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1 text-[11px] text-text-muted">
                  最少
                  <input
                    type="number"
                    min={0}
                    max={9}
                    value={inputSchema.video.min}
                    disabled={!inputSchema.video.enabled}
                    onChange={(event) => setInputSchema((current) => updateSchemaVideo(current, {
                      min: Number(event.target.value),
                    }))}
                    className="h-8 rounded-md border border-border-dark bg-surface-dark px-2 text-xs text-text-dark outline-none focus:border-accent disabled:opacity-50"
                  />
                </label>
                <label className="flex flex-col gap-1 text-[11px] text-text-muted">
                  最多
                  <input
                    type="number"
                    min={0}
                    max={9}
                    value={inputSchema.video.max}
                    disabled={!inputSchema.video.enabled}
                    onChange={(event) => setInputSchema((current) => updateSchemaVideo(current, {
                      max: Number(event.target.value),
                    }))}
                    className="h-8 rounded-md border border-border-dark bg-surface-dark px-2 text-xs text-text-dark outline-none focus:border-accent disabled:opacity-50"
                  />
                </label>
              </div>
              <label className="mt-3 flex flex-col gap-1 text-[11px] text-text-muted">
                请求字段
                <input
                  value={inputSchema.video.field}
                  disabled={!inputSchema.video.enabled}
                  onChange={(event) => setInputSchema((current) => updateSchemaVideo(current, {
                    field: event.target.value,
                  }))}
                  className="h-8 rounded-md border border-border-dark bg-surface-dark px-2 font-mono text-xs text-text-dark outline-none focus:border-accent disabled:opacity-50"
                  placeholder="video_url"
                />
              </label>
            </div>

            <div className="rounded-lg border border-border-dark bg-bg-dark p-3">
              <label className="flex items-center gap-2 text-xs font-medium text-text-dark">
                <input
                  type="checkbox"
                  checked={inputSchema.audio.enabled}
                  onChange={(event) => setInputSchema((current) => updateSchemaAudio(current, {
                    enabled: event.target.checked,
                    max: event.target.checked ? Math.max(1, current.audio.max || 1) : 0,
                  }))}
                  className="h-4 w-4 accent-accent"
                />
                音频引用
              </label>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1 text-[11px] text-text-muted">
                  最少
                  <input
                    type="number"
                    min={0}
                    max={9}
                    value={inputSchema.audio.min}
                    disabled={!inputSchema.audio.enabled}
                    onChange={(event) => setInputSchema((current) => updateSchemaAudio(current, {
                      min: Number(event.target.value),
                    }))}
                    className="h-8 rounded-md border border-border-dark bg-surface-dark px-2 text-xs text-text-dark outline-none focus:border-accent disabled:opacity-50"
                  />
                </label>
                <label className="flex flex-col gap-1 text-[11px] text-text-muted">
                  最多
                  <input
                    type="number"
                    min={0}
                    max={9}
                    value={inputSchema.audio.max}
                    disabled={!inputSchema.audio.enabled}
                    onChange={(event) => setInputSchema((current) => updateSchemaAudio(current, {
                      max: Number(event.target.value),
                    }))}
                    className="h-8 rounded-md border border-border-dark bg-surface-dark px-2 text-xs text-text-dark outline-none focus:border-accent disabled:opacity-50"
                  />
                </label>
              </div>
              <label className="mt-3 flex flex-col gap-1 text-[11px] text-text-muted">
                请求字段
                <input
                  value={inputSchema.audio.field}
                  disabled={!inputSchema.audio.enabled}
                  onChange={(event) => setInputSchema((current) => updateSchemaAudio(current, {
                    field: event.target.value,
                  }))}
                  className="h-8 rounded-md border border-border-dark bg-surface-dark px-2 font-mono text-xs text-text-dark outline-none focus:border-accent disabled:opacity-50"
                  placeholder="audio_url"
                />
              </label>
              <div className="mt-2 text-[10px] leading-4 text-text-muted">
                当前画布还没有音频节点；启用后会保留 schema，后续接入音频资产时直接生效。
              </div>
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
            disabled={
              !label.trim()
              || !baseUrl.trim()
              || models.length === 0
              || !parsedDefaultParams.ok
              || !parsedStatusRequestBody.ok
              || !parsedStatusQueryParams.ok
              || !parsedResponseVideoPaths.ok
              || !parsedVideoRequestBodyTemplate.ok
            }
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
