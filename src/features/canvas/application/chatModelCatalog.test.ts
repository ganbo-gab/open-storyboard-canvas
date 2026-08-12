import { describe, expect, it } from 'vitest';

import { AGNES_PROVIDER_DEFAULTS } from '@/stores/customProvidersStore';
import { buildChatModelCatalog } from './chatModelCatalog';

describe('Agnes chat catalog', () => {
  it('places Agnes 2.5 first and retains saved-project compatibility ids', () => {
    const entries = buildChatModelCatalog([], 'agnes-key');
    expect(entries.map((entry) => entry.modelId)).toEqual([
      AGNES_PROVIDER_DEFAULTS.models.chat25Flash,
      AGNES_PROVIDER_DEFAULTS.models.chat20Flash,
      AGNES_PROVIDER_DEFAULTS.models.chat15Flash,
    ]);
  });

  it('does not expose Agnes models without a saved key', () => {
    expect(buildChatModelCatalog([], '   ')).toEqual([]);
  });
});
