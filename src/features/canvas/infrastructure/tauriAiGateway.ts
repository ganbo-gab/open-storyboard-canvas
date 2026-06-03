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
} from './customProviderGateway';
import type { GenerateVideoPayload } from '../application/ports';

function isDreaminaModel(id: string): boolean { return id.startsWith('dreamina:'); }
function isCustomModel(id: string): boolean { return id.startsWith('custom:'); }
function isAgnesModel(id: string): boolean { return id.startsWith('agnes:'); }
function isDreaminaJob(id: string): boolean { return id.startsWith('dreamina-local-'); }
function isCustomJob(id: string): boolean { return id.startsWith('custom-local-'); }

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
