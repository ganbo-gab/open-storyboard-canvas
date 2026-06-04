import {
  generateImage,
  getGenerateImageJob,
  setApiKey,
  submitGenerateImageJob,
} from '@/commands/ai';
import { imageUrlToDataUrl, persistImageLocally } from '@/features/canvas/application/imageData';

import type { AiGateway, GenerateImagePayload } from '../application/ports';
import { submitDreaminaJob, getDreaminaJob } from './dreaminaGateway';
import {
  submitCustomProviderJob,
  getCustomProviderJob,
  submitCustomVideoJob,
  buildCustomProviderRequestDebugPreview,
  buildCustomVideoProviderRequestDebugPreview,
  type CustomProviderRequestDebugPreview,
} from './customProviderGateway';
import type { GenerateVideoPayload } from '../application/ports';

function isDreaminaModel(id: string): boolean { return id.startsWith('dreamina:'); }
function isCustomModel(id: string): boolean { return id.startsWith('custom:'); }
function isAgnesModel(id: string): boolean { return id.startsWith('agnes:'); }
function isDreaminaJob(id: string): boolean { return id.startsWith('dreamina-local-'); }
function isCustomJob(id: string): boolean { return id.startsWith('custom-local-'); }

export interface GenerateImageDebugPreview {
  route: 'builtin' | 'dreamina' | 'custom' | 'agnes';
  gatewayRequest: {
    prompt: string;
    model: string;
    size: string;
    aspectRatio: string;
    referenceImages?: unknown[];
    extraParams?: unknown;
  };
  providerRequest?: CustomProviderRequestDebugPreview;
}

export interface GenerateVideoDebugPreview {
  route: 'custom' | 'agnes';
  gatewayRequest: {
    prompt: string;
    model: string;
    size: string;
    aspectRatio: string;
    referenceImages?: unknown[];
    extraParams?: unknown;
  };
  providerRequest?: CustomProviderRequestDebugPreview;
}

async function normalizeReferenceImages(payload: GenerateImagePayload): Promise<string[] | undefined> {
  const isKieModel = payload.model.startsWith('kie/');
  const isFalModel = payload.model.startsWith('fal/');
  const isCustomOrDreamina = isDreaminaModel(payload.model) || isCustomModel(payload.model) || isAgnesModel(payload.model);
  return payload.referenceImages
    ? await Promise.all(
      payload.referenceImages.map(async (imageUrl) =>
        isKieModel || isFalModel || isCustomOrDreamina
          ? await imageUrlToDataUrl(imageUrl)
          : await persistImageLocally(imageUrl)
      )
    )
    : undefined;
}

async function normalizeVideoReferenceImages(payload: GenerateVideoPayload): Promise<string[] | undefined> {
  const sources = [
    ...(payload.inputReference ? [payload.inputReference] : []),
    ...(payload.referenceImages ?? []),
  ];
  if (sources.length === 0) return undefined;
  return await Promise.all(sources.map(async (imageUrl) => await imageUrlToDataUrl(imageUrl)));
}

function summarizeDebugString(value: string, maxLength = 500): string {
  const trimmed = value.trim();
  const commaIndex = trimmed.indexOf(',');
  if (/^data:[^,]+;base64,/i.test(trimmed) && commaIndex >= 0) {
    const meta = trimmed.slice(0, commaIndex);
    const base64 = trimmed.slice(commaIndex + 1);
    return `${meta},[base64 ${base64.length} chars]`;
  }
  if (/^[A-Za-z0-9+/=]+$/.test(trimmed) && trimmed.length > 300) {
    return `[base64 ${trimmed.length} chars]`;
  }
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}...(${trimmed.length} chars)` : value;
}

function isSensitiveDebugFieldName(name: string): boolean {
  return /(authorization|api[-_ ]?key|access[-_ ]?token|secret|password|bearer|x-goog-api-key)/i.test(name);
}

function summarizeDebugValue(value: unknown, key = '', depth = 0): unknown {
  if (value === undefined || value === null) return value;
  if (typeof value === 'string') return isSensitiveDebugFieldName(key) ? '[masked]' : summarizeDebugString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return depth >= 5 ? `[array ${value.length}]` : value.map((item, index) => summarizeDebugValue(item, `${key}[${index}]`, depth + 1));
  }
  if (typeof value === 'object') {
    if (depth >= 5) return '[object]';
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        summarizeDebugValue(item, key, depth + 1),
      ])
    );
  }
  return String(value);
}

function resolveImageRoute(model: string): GenerateImageDebugPreview['route'] {
  if (isDreaminaModel(model)) return 'dreamina';
  if (isAgnesModel(model)) return 'agnes';
  if (isCustomModel(model)) return 'custom';
  return 'builtin';
}

export async function buildGenerateImageDebugPreview(
  payload: GenerateImagePayload,
): Promise<GenerateImageDebugPreview> {
  const normalizedReferenceImages = await normalizeReferenceImages(payload);
  const request = {
    prompt: payload.prompt,
    model: payload.model,
    size: payload.size,
    aspect_ratio: payload.aspectRatio,
    reference_images: normalizedReferenceImages,
    extra_params: payload.extraParams,
  };
  const route = resolveImageRoute(payload.model);
  return {
    route,
    gatewayRequest: {
      prompt: summarizeDebugString(payload.prompt),
      model: payload.model,
      size: payload.size,
      aspectRatio: payload.aspectRatio,
      referenceImages: normalizedReferenceImages?.map((image) => summarizeDebugString(image)),
      extraParams: summarizeDebugValue(payload.extraParams),
    },
    providerRequest:
      route === 'custom' || route === 'agnes'
        ? buildCustomProviderRequestDebugPreview(request)
        : undefined,
  };
}

export async function buildGenerateVideoDebugPreview(
  payload: GenerateVideoPayload,
): Promise<GenerateVideoDebugPreview> {
  if (!isCustomModel(payload.model) && !isAgnesModel(payload.model)) {
    throw new Error('视频生成当前仅支持自定义视频服务商配置');
  }
  const normalizedReferenceImages = await normalizeVideoReferenceImages(payload);
  const request = {
    prompt: payload.prompt,
    model: payload.model,
    size: payload.size,
    aspect_ratio: payload.aspectRatio ?? 'auto',
    reference_images: normalizedReferenceImages,
    extra_params: {
      ...(payload.extraParams ?? {}),
      ...(typeof payload.seconds === 'number' ? { seconds: payload.seconds } : {}),
    },
  };
  const route = isAgnesModel(payload.model) ? 'agnes' : 'custom';
  return {
    route,
    gatewayRequest: {
      prompt: summarizeDebugString(payload.prompt),
      model: payload.model,
      size: payload.size,
      aspectRatio: payload.aspectRatio ?? 'auto',
      referenceImages: normalizedReferenceImages?.map((image) => summarizeDebugString(image)),
      extraParams: summarizeDebugValue(request.extra_params),
    },
    providerRequest: buildCustomVideoProviderRequestDebugPreview(request),
  };
}

export const tauriAiGateway: AiGateway = {
  setApiKey,
  generateImage: async (payload: GenerateImagePayload) => {
    const normalizedReferenceImages = await normalizeReferenceImages(payload);

    return await generateImage({
      prompt: payload.prompt,
      model: payload.model,
      size: payload.size,
      aspect_ratio: payload.aspectRatio,
      reference_images: normalizedReferenceImages,
      extra_params: payload.extraParams,
    });
  },
  submitGenerateImageJob: async (payload: GenerateImagePayload) => {
    const normalizedReferenceImages = await normalizeReferenceImages(payload);
    // Route by model prefix: the built-in Rust gateway only knows about the
    // static built-in models (grsai/fal/kie/ppio); dreamina:* and custom:*
    // entries fan out to their own TS-side adapters.
    const request = {
      prompt: payload.prompt,
      model: payload.model,
      size: payload.size,
      aspect_ratio: payload.aspectRatio,
      reference_images: normalizedReferenceImages,
      extra_params: payload.extraParams,
    };
    if (isDreaminaModel(payload.model)) return await submitDreaminaJob(request);
    if (isCustomModel(payload.model) || isAgnesModel(payload.model)) return await submitCustomProviderJob(request);
    return await submitGenerateImageJob(request);
  },
  getGenerateImageJob: async (jobId: string) => {
    if (isDreaminaJob(jobId)) return getDreaminaJob(jobId);
    if (isCustomJob(jobId)) return getCustomProviderJob(jobId);
    return await getGenerateImageJob(jobId);
  },
  submitGenerateVideoJob: async (payload: GenerateVideoPayload) => {
    if (!isCustomModel(payload.model) && !isAgnesModel(payload.model)) {
      throw new Error('视频生成当前仅支持自定义视频服务商配置');
    }
    const normalizedReferenceImages = await normalizeVideoReferenceImages(payload);
    return await submitCustomVideoJob({
      prompt: payload.prompt,
      model: payload.model,
      size: payload.size,
      aspect_ratio: payload.aspectRatio ?? 'auto',
      reference_images: normalizedReferenceImages,
      extra_params: {
        ...(payload.extraParams ?? {}),
        ...(typeof payload.seconds === 'number' ? { seconds: payload.seconds } : {}),
      },
    });
  },
  getGenerateVideoJob: async (jobId: string) => {
    if (isCustomJob(jobId)) return getCustomProviderJob(jobId);
    return { job_id: jobId, status: 'not_found', result: null, error: 'video job id not found' };
  },
};
