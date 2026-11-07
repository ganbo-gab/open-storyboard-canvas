import { afterEach, expect, it } from 'vitest';
import { saveChannelRecord, useChannelStore } from '@/features/channels/store/channelStore';
import { getAgentGenerationCatalog } from './agentGenerationCatalog';

const original = useChannelStore.getState();
afterEach(() => useChannelStore.setState(original));

it('offers usable configured generation models and declared choices without exposing connection configuration', () => {
  useChannelStore.setState({ channels: [], migratedLegacyIds: [] });
  saveChannelRecord({ version: 2, id: 'agent-generation-catalog', name: 'Configured image provider', baseUrl: 'https://private-transport.example.test',
    auth: { type: 'none' }, operations: { 'image.generate': { method: 'POST', path: '/private-generation-route', body: 'json',
      template: { model: '{{model}}', prompt: '{{prompt}}' }, response: { mode: 'sync', outputs: [] } } },
    models: [{ id: 'gpt-image-2.6', label: 'My image model', operations: ['image.generate'], params: [],
      modes: [{ id: 'portrait', label: 'Portrait', operation: 'image.generate', slots: [], params: [
        { key: 'size', label: 'Size', type: 'enum', options: [{ label: 'Portrait', value: '1024x1536' }], default: '1024x1536' },
      ] }] }],
  });
  const catalog = getAgentGenerationCatalog();
  expect(catalog.image).toEqual([expect.objectContaining({
    modelId: 'custom:channel-agent-generation-catalog-image:gpt-image-2.6', label: 'My image model', provider: 'Configured image provider',
    supportedResolutions: ['1024x1536'], modes: [expect.objectContaining({ id: 'portrait', params: [expect.objectContaining({ values: ['1024x1536'] })] })],
  })]);
  expect(catalog.video).toEqual([]);
  expect(JSON.stringify(catalog)).not.toContain('private-transport');
  expect(JSON.stringify(catalog)).not.toContain('private-generation-route');
  expect(JSON.stringify(catalog)).not.toContain('credential');
});
