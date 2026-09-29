import {
  createEmptyCustomImageProviderDraft,
  type CustomImageProviderDraft,
} from '@/features/canvas/application/customImageProviderConfig';
import type { GenerateRequest } from '@/commands/ai';
import type { CustomProviderConfig } from '@/stores/customProvidersStore';
import { createComfyUIWorkflowTemplate, getComfyUIReferenceRequirements, getComfyUIVideoCapabilities, parseComfyUIConfig } from '@/features/canvas/infrastructure/comfyuiGateway';
import type { ImageFieldDescriptorV1, ImageRequestVariantV1, JsonTemplateValue } from '@/features/canvas/application/customImageProviderContract';

export type CustomImageProviderCreationRoute = 'ai' | 'manual' | 'comfyui';

export const CUSTOM_IMAGE_PROVIDER_WORKBENCH_STEPS = [
  'connection',
  'request',
  'images',
  'response',
  'capabilities',
  'review',
] as const;

export type CustomImageProviderWorkbenchStep = typeof CUSTOM_IMAGE_PROVIDER_WORKBENCH_STEPS[number];

export const DEFAULT_IMAGE_BODY_TEMPLATE: Record<string, JsonTemplateValue> = {
  model: '{{model}}',
  prompt: '{{prompt}}',
  size: '{{size}}',
  aspect_ratio: '{{aspectRatio}}',
};

export function createCustomImageProviderWorkbenchDraft(): CustomImageProviderDraft {
  const draft = createEmptyCustomImageProviderDraft();
  return {
    ...draft,
    apiStyle: 'generic-json',
    responseFormat: 'generic',
    imageRequestContract: {
      version: 1,
      textToImage: {
        endpointPath: '',
        method: 'POST',
        bodyMode: 'json',
        bodyTemplate: { ...DEFAULT_IMAGE_BODY_TEMPLATE },
        responseImagePaths: ['data[0].url'],
      },
    },
  };
}

export function createComfyUIProviderWorkbenchDraft(): CustomImageProviderDraft {
  const draft = createEmptyCustomImageProviderDraft();
  const template = createComfyUIWorkflowTemplate('text-to-image');
  return {
    ...draft,
    label: 'ComfyUI',
    baseUrl: 'http://127.0.0.1:8188',
    endpointPath: '/prompt',
    modelListEndpointPath: '',
    apiStyle: 'comfyui',
    responseFormat: 'generic',
    models: ['workflow'],
    extraParams: {
      ...draft.extraParams,
      allowNoApiKey: true,
      auth: { mode: 'none' },
      comfyui: {
        ...template,
        templateId: 'text-to-image',
        pollIntervalMs: 1500,
        pollTimeoutMs: 600000,
      },
    },
    imageRequestContract: { version: 1 },
  };
}

export function splitWorkbenchValues(value: string): string[] {
  const seen = new Set<string>();
  return value
    .split(/[\n,，]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry && !seen.has(entry) && Boolean(seen.add(entry)));
}

export function getTextToImageVariant(draft: CustomImageProviderDraft): ImageRequestVariantV1 {
  return draft.imageRequestContract.textToImage ?? {
    endpointPath: draft.endpointPath,
    method: draft.httpMethod ?? 'POST',
    bodyMode: 'json',
    bodyTemplate: { ...DEFAULT_IMAGE_BODY_TEMPLATE },
    responseImagePaths: ['data[0].url'],
  };
}

export function getImageToImageVariant(draft: CustomImageProviderDraft): ImageRequestVariantV1 {
  return draft.imageRequestContract.imageToImage ?? {
    endpointPath: getTextToImageVariant(draft).endpointPath ?? '',
    method: getTextToImageVariant(draft).method ?? 'POST',
    bodyMode: getTextToImageVariant(draft).bodyMode ?? 'json',
    imageFields: [{ name: 'image', mode: 'single', encoding: 'data-url' }],
    responseImagePaths: getTextToImageVariant(draft).responseImagePaths ?? ['data[0].url'],
  };
}

export function updateFirstWorkbenchImageField(
  variant: ImageRequestVariantV1,
  patch: Partial<ImageFieldDescriptorV1>,
): ImageFieldDescriptorV1[] {
  const first = variant.imageFields?.[0] ?? { name: 'image', mode: 'single', encoding: 'data-url' };
  return [{ ...first, ...patch }, ...(variant.imageFields?.slice(1) ?? [])];
}

export function createWorkbenchPreviewRequest(config: CustomProviderConfig, model: string): GenerateRequest {
  const sample: GenerateRequest = {
    prompt: 'preview prompt', model: `custom:${config.id}:${model}`, size: '1024x1024', aspect_ratio: '1:1',
  };
  if (config.apiStyle !== 'comfyui') return sample;
  const comfy = parseComfyUIConfig(config);
  const references = getComfyUIReferenceRequirements(comfy);
  sample.reference_images = Array.from({ length: references.min }, () => 'data:image/png;base64,AAAA');
  if (config.mediaType === 'video') {
    const capabilities = getComfyUIVideoCapabilities(comfy);
    sample.size = capabilities.supportedResolutions[0];
    sample.aspect_ratio = capabilities.supportedAspectRatios[0];
    const duration = Number(capabilities.supportedDurations[0]);
    if (Number.isFinite(duration) && duration > 0) sample.extra_params = { seconds: duration };
  }
  return sample;
}
