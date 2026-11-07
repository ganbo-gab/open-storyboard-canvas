// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { buildChannelAudioModelCatalog, useChannelAudioModelCatalog } from './audioModelCatalog';
import { setChannelCredential, useChannelStore, type ChannelRecord } from '../store/channelStore';
import { useMemorySecretVault } from '@/features/secrets/testSupport';

useMemorySecretVault();

function record(): ChannelRecord {
  return { origin: 'native', migrationIssues: [], createdAt: 1, updatedAt: 1, profile: {
    version: 2, id: 'audio-catalog', name: 'Audio channel', baseUrl: 'https://relay.example', auth: { type: 'bearer' }, operations: {}, models: [
      { id: 'voice', label: 'Voice', operations: [], params: [], modes: [{ id: 'speak', label: 'Speak', operation: 'audio.generate', slots: [], endpoint: {
        method: 'POST', path: '/speak', body: 'json', template: { text: '{{prompt}}' }, response: { mode: 'sync', outputs: [{ path: 'url', as: 'url', kind: 'audio' }] },
      } }] },
      { id: 'not-audio', label: 'Image', operations: ['image.generate'], params: [] },
    ],
  } };
}
afterEach(cleanup);
describe('declared channel audio catalog', () => {
  it('updates audio availability after verified async vault writes without editing the profile', async () => {
    useChannelStore.setState({ channels: [record()] });
    await setChannelCredential('audio-catalog', '');
    const hook = renderHook(() => useChannelAudioModelCatalog());
    expect(hook.result.current[0].usable).toBe(false);
    await act(async () => { await setChannelCredential('audio-catalog', 'configured-key'); });
    expect(hook.result.current[0].usable).toBe(true);
  });
  it('exposes audio controls for a model whose first implicit operation is chat', () => {
    const channel = record();
    channel.profile.auth = { type: 'none' };
    channel.profile.models = [{ id: 'mixed', operations: ['chat', 'audio.generate'], params: [{ key: 'voice', label: 'Voice', type: 'text', default: 'calm' }] }];
    expect(buildChannelAudioModelCatalog([channel])[0]).toMatchObject({ usable: true, modes: [{ operation: 'audio.generate', mode: { id: 'default', operation: 'audio.generate' }, params: [{ key: 'voice' }] }] });
  });
  it('includes audio-only modes with full declarations and stable IDs, and reports absent credentials', async () => {
    await setChannelCredential('audio-catalog', '');
    const entries = buildChannelAudioModelCatalog([record()]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: 'custom:channel-audio-catalog-audio:voice', modelLabel: 'Voice', usable: false,
      channelModelRef: { profileId: 'audio-catalog', modelId: 'voice' }, modes: [{ mode: { id: 'speak' }, operation: 'audio.generate' }] });
    await setChannelCredential('audio-catalog', 'configured-key');
    expect(buildChannelAudioModelCatalog([record()])[0]).toMatchObject({ usable: true });
  });
});
