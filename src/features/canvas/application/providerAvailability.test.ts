import { MINIMAX_H3_PRESET } from './minimaxH3';
import { describe, expect, it } from 'vitest';
import { getConfiguredImageProviderCount, hasConfiguredImageProvider, hasConfiguredAnyProvider } from './providerAvailability';

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

describe('global provider onboarding', () => {
  const input = { apiKeys: {}, builtInProviderIds: [], customProviders: [] };
  it('recognizes a video-only setup without declaring image support', () => {
    const configured = { ...input, customProviders: [{ ...MINIMAX_H3_PRESET.template, id: 'h3', apiKey: 'test-key' }] };
    expect(hasConfiguredAnyProvider(configured)).toBe(true);
    expect(hasConfiguredImageProvider(configured)).toBe(false);
    expect(hasConfiguredAnyProvider({ ...input, customProviders: [{ ...configured.customProviders[0], apiKey: '' }] })).toBe(false);
  });
});
