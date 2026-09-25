import { describe, expect, it } from 'vitest';
import { getConfiguredImageProviderCount, hasConfiguredImageProvider } from './providerAvailability';

describe('image provider availability', () => {
  const empty = {
    apiKeys: {},
    builtInProviderIds: [],
    customProviders: [],
    dreaminaStatus: { loggedIn: false },
  };

  it('counts an Agnes key as a configured image provider', () => {
    expect(hasConfiguredImageProvider(empty)).toBe(false);
    expect(getConfiguredImageProviderCount({ ...empty, agnesApiKey: 'agnes-secret' })).toBe(1);
    expect(hasConfiguredImageProvider({ ...empty, agnesApiKey: '  agnes-secret  ' })).toBe(true);
  });
});
