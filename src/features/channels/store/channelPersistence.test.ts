import { afterEach, describe, expect, it, vi } from 'vitest';
import { channelPersistenceStorage } from './channelPersistence';
import { useChannelStore } from './channelStore';
import { useCustomProvidersStore } from '@/stores/customProvidersStore';

afterEach(() => vi.unstubAllGlobals());

describe('channel initialization without browser storage', () => {
  it('keeps real hydration APIs and working synchronized state in Node/SSR', async () => {
    vi.stubGlobal('localStorage', undefined);
    expect(useChannelStore.persist.onFinishHydration).toBeTypeOf('function');
    expect(useCustomProvidersStore.persist.onFinishHydration).toBeTypeOf('function');
    channelPersistenceStorage.setItem('node-storage-probe', 'process-local');
    expect(channelPersistenceStorage.getItem('node-storage-probe')).toBe('process-local');
    channelPersistenceStorage.removeItem('node-storage-probe');
    expect(channelPersistenceStorage.getItem('node-storage-probe')).toBeNull();
    const provider = { id: 'node-legacy', label: 'Node provider', baseUrl: 'https://relay.example', apiKey: '', apiStyle: 'openai-compatible', models: ['model'], supportsWebSearch: false };
    useCustomProvidersStore.getState().addProvider(provider);
    expect(useCustomProvidersStore.getState().providers).toContainEqual(provider);
    expect(useChannelStore.getState().channels.some((entry) => entry.profile.id === provider.id)).toBe(true);
    useCustomProvidersStore.getState().removeProvider(provider.id);
    useChannelStore.setState((state) => ({ channels: state.channels.filter((entry) => entry.profile.id !== provider.id) }));
  });

  it('uses browser storage when it becomes available and invokes real hydration callbacks', async () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (name: string) => values.get(name) ?? null,
      setItem: (name: string, value: string) => { values.set(name, value); }, removeItem: (name: string) => { values.delete(name); } });
    const callback = vi.fn(); const unsubscribe = useChannelStore.persist.onFinishHydration(callback);
    try {
      values.set('channels-v2-storage', JSON.stringify({ version: 2, state: { channels: [], migratedLegacyIds: [] } }));
      await useChannelStore.persist.rehydrate();
      expect(callback).toHaveBeenCalledTimes(1);
      channelPersistenceStorage.setItem('browser-probe', 'durable');
      expect(values.get('browser-probe')).toBe('durable');
    } finally { unsubscribe(); }
  });
});
