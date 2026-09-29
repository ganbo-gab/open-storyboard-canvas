import { describe, expect, it } from 'vitest';

import { customImageProviderDraftToConfig } from '@/features/canvas/application/customImageProviderConfig';
import { createComfyUIWorkflowTemplate, parseComfyUIConfig, prepareComfyUIWorkflow } from '@/features/canvas/infrastructure/comfyuiGateway';
import {
  createCustomImageProviderWorkbenchDraft,
  createComfyUIProviderWorkbenchDraft,
  createWorkbenchPreviewRequest,
  getImageToImageVariant,
  updateFirstWorkbenchImageField,
} from './customImageProviderWorkbenchState';

describe('manual image provider workbench', () => {
  it('previews local H3 with video capabilities instead of image dimensions', () => {
    const draft = createComfyUIProviderWorkbenchDraft();
    draft.mediaType = 'video';
    draft.extraParams.comfyui = {
      workflow: {
        '1': { class_type: 'MiniMaxH3ImageToVideo', inputs: { prompt: '', width: 1344, height: 768, length: 124 } },
        '2': { class_type: 'SaveVideo', inputs: { video: ['1', 0] } },
      },
      bindings: { images: [] }, outputNodeIds: ['2'],
    };
    const config = customImageProviderDraftToConfig(draft, 'h3').value!;
    const sample = createWorkbenchPreviewRequest(config, 'h3');
    expect(sample).toMatchObject({ size: '768P', aspect_ratio: '16:9', extra_params: { seconds: 5 } });
    const workflow = prepareComfyUIWorkflow(parseComfyUIConfig(config), sample);
    expect(workflow['1'].inputs).toMatchObject({ width: 1344, height: 768, length: 124 });
  });

  it('supplies required image placeholders when previewing an image-to-image workflow', () => {
    const draft = createComfyUIProviderWorkbenchDraft();
    draft.extraParams.comfyui = createComfyUIWorkflowTemplate('image-to-image', 'sd.safetensors');
    const config = customImageProviderDraftToConfig(draft, 'i2i').value!;
    const sample = createWorkbenchPreviewRequest(config, 'workflow');
    expect(sample.reference_images).toHaveLength(1);
    const workflow = prepareComfyUIWorkflow(parseComfyUIConfig(config), sample, ['placeholder.png']);
    expect(workflow['4'].inputs).toMatchObject({ image: 'placeholder.png' });
  });

  it('preserves additional imported image fields through editing and saving', () => {
    const draft = createCustomImageProviderWorkbenchDraft();
    draft.baseUrl = 'https://relay.example/v1';
    draft.models = ['image-model'];
    const variant = getImageToImageVariant(draft);
    variant.imageFields = [
      { name: 'image', mode: 'single', encoding: 'data-url' },
      { name: 'mask', mode: 'single', encoding: 'base64' },
    ];
    draft.imageRequestContract.imageToImage = {
      ...variant,
      imageFields: updateFirstWorkbenchImageField(variant, { name: 'images', mode: 'array', encoding: 'url' }),
    };
    const saved = customImageProviderDraftToConfig(draft, 'provider-1');
    expect(saved.issues).toEqual([]);
    expect(saved.value?.extraParams?.imageRequestContract).toMatchObject({ imageToImage: { imageFields: [
      { name: 'images', mode: 'array', encoding: 'url' },
      { name: 'mask', mode: 'single', encoding: 'base64' },
    ] } });
    expect(variant.imageFields[0].name).toBe('image');
  });

  it('persists the image field shown when image-to-image is first enabled', () => {
    const draft = createCustomImageProviderWorkbenchDraft();
    draft.baseUrl = 'https://relay.example/v1';
    draft.models = ['image-model'];
    draft.imageRequestContract.textToImage = {
      ...draft.imageRequestContract.textToImage,
      endpointPath: '/images/generations',
    };

    draft.imageRequestContract.imageToImage = getImageToImageVariant(draft);
    const saved = customImageProviderDraftToConfig(draft, 'provider-1');

    expect(saved.issues).toEqual([]);
    expect(saved.value?.extraParams?.imageRequestContract).toMatchObject({
      imageToImage: {
        endpointPath: '/images/generations',
        imageFields: [{ name: 'image', mode: 'single', encoding: 'data-url' }],
        responseImagePaths: ['data[0].url'],
      },
    });
  });
});
