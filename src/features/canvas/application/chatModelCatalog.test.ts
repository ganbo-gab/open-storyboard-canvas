import { describe, expect, it } from 'vitest';

import { AGNES_PROVIDER_DEFAULTS } from '@/stores/customProvidersStore';
import { buildChatModelCatalog, resolveAgentProtocol } from './chatModelCatalog';
import { migrateAgnesSettingsCredential } from '@/features/channels/runtime/agnesChannel';
import { getChannelCatalogProviders } from '@/features/channels/application/channelCatalog';

describe('Agnes chat catalog', () => {
  it('places Agnes 2.5 first and retains saved-project compatibility ids', () => {
    migrateAgnesSettingsCredential('agnes-key');
    const entries = buildChatModelCatalog(getChannelCatalogProviders());
    expect(entries.map((entry) => entry.modelId)).toEqual([
      AGNES_PROVIDER_DEFAULTS.models.chat25Flash,
      AGNES_PROVIDER_DEFAULTS.models.chat20Flash,
      AGNES_PROVIDER_DEFAULTS.models.chat15Flash,
    ]);
  });

  it('does not synthesize models outside declared channel projections', () => {
    expect(buildChatModelCatalog([])).toEqual([]);
  });

  it('uses an explicit standard endpoint shape before a stale provider kind', () => {
    const provider = {
      id: 'gateway',
      label: 'Gateway',
      mediaType: 'chat' as const,
      baseUrl: 'https://gateway.example',
      endpointPath: '/v1/chat/completions',
      apiKey: 'secret',
      apiStyle: 'openai-compatible',
      models: ['gemini-compatible'],
      supportsWebSearch: false,
      extraParams: { providerKind: 'google-gemini' },
    };
    expect(resolveAgentProtocol(provider, {})).toBe('openai-chat-completions');
    expect(resolveAgentProtocol({
      ...provider,
      endpointPath: '/v1beta/models/{model}:generateContent',
      extraParams: { providerKind: 'openai-chat-completions' },
    }, {})).toBe('google-gemini');
  });
});
