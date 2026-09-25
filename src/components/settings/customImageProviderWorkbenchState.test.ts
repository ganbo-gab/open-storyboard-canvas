import { describe, expect, it } from 'vitest';

import { customImageProviderDraftToConfig } from '@/features/canvas/application/customImageProviderConfig';
import {
  createCustomImageProviderWorkbenchDraft,
  getImageToImageVariant,
} from './customImageProviderWorkbenchState';

describe('manual image provider workbench', () => {
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
