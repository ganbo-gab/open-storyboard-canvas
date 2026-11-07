import { describe, expect, it } from 'vitest';

import { AGNES_PROVIDER_DEFAULTS } from '@/stores/customProvidersStore';
import { buildImageModelCatalog } from './modelCatalog';
import { migrateAgnesSettingsCredential } from '@/features/channels/runtime/agnesChannel';
import { getChannelCatalogProviders } from '@/features/channels/application/channelCatalog';

describe('Agnes image catalog', () => {
  it('exposes 3K only for Image 2.1 while retaining Image 2.0 explicit pixels', () => {
    migrateAgnesSettingsCredential('agnes-key');
    const entries = buildImageModelCatalog({ customProviders: getChannelCatalogProviders() });
    const image21 = entries.find(({ modelId }) => (
      modelId === AGNES_PROVIDER_DEFAULTS.models.image21Flash
    ));
    const image20 = entries.find(({ modelId }) => (
      modelId === AGNES_PROVIDER_DEFAULTS.models.image20Flash
    ));

    expect(image21?.supportedResolutions).toContain('3K');
    expect(image20?.supportedResolutions).not.toContain('3K');
    expect(image20?.supportedResolutions).toEqual([
      '1024x1024',
      '1024x768',
      '768x1024',
      'auto',
    ]);
  });
});
