import { afterEach, expect, it, vi } from 'vitest';

const gate = vi.hoisted(() => ({ promise: Promise.resolve(true) }));
vi.mock('@/features/secrets/secretStore', async (original) => {
  const module = await original<typeof import('@/features/secrets/secretStore')>();
  return { ...module, secretStore: { ...module.secretStore, has: vi.fn(() => gate.promise) } };
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

function installStorage(entries: Array<[string, string]> = []): Map<string, string> {
  const values = new Map(entries);
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => values.delete(key),
  });
  return values;
}

it('hydrates an empty first launch with concurrent callers without writing defaults', async () => {
  const values = installStorage();
  const { ensureChannelStoresHydrated, channelStoresHydrated, useChannelStore } = await import('./channelStore');
  await Promise.all([ensureChannelStoresHydrated(), ensureChannelStoresHydrated(), ensureChannelStoresHydrated()]);
  expect(channelStoresHydrated()).toBe(true);
  expect(useChannelStore.getState().channels).toEqual([]);
  expect(values.has('channels-v2-storage')).toBe(false);
});

it('keeps delayed saved records when several mutations await initial hydration', async () => {
  const pending = Promise.withResolvers<boolean>();
  gate.promise = pending.promise;
  const saved = JSON.stringify({ version: 2, state: {
    channels: [{ profile: { version: 2, id: 'native-channel', name: 'Native', baseUrl: 'https://example.test',
      auth: { type: 'bearer' }, operations: {}, models: [] },
    origin: 'native', migrationIssues: [], createdAt: 1, updatedAt: 2,
    credentialRef: { namespace: 'channel', id: 'concurrent-channel-ref' } }],
    migratedLegacyIds: [],
  } });
  const values = installStorage([['channels-v2-storage', saved]]);
  const { ensureChannelStoresHydrated, channelStoresHydrated, useChannelStore } = await import('./channelStore');
  const completions = [ensureChannelStoresHydrated(), ensureChannelStoresHydrated(), ensureChannelStoresHydrated()];
  expect(channelStoresHydrated()).toBe(false);
  pending.resolve(true);
  await Promise.all(completions);
  expect(useChannelStore.getState().channels[0]?.profile.id).toBe('native-channel');
  expect(values.get('channels-v2-storage')).toBe(saved);
});

it.each([
  { version: 99, state: { channels: [], migratedLegacyIds: [] } },
  { version: 2, state: { channels: 'invalid-list', migratedLegacyIds: [] } },
  { version: 2, state: { channels: [{ profile: { id: 'incomplete' } }], migratedLegacyIds: [] } },
])('protects unsupported or structurally damaged channel storage: %j', async (envelope) => {
  const saved = JSON.stringify(envelope);
  const values = installStorage([['channels-v2-storage', saved]]);
  const { ensureChannelStoresHydrated, useChannelStore } = await import('./channelStore');
  await expect(ensureChannelStoresHydrated()).rejects.toThrow('渠道配置尚未读取完成');
  // Even a caller bypassing the service barrier cannot persist defaults over it.
  useChannelStore.setState({ channels: [], migratedLegacyIds: [] });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(values.get('channels-v2-storage')).toBe(saved);
});

it('preserves unknown valid channel fields through hydration and subsequent persistence', async () => {
  const profile = { version: 2, id: 'extended', name: 'Extended', baseUrl: 'https://example.test',
    auth: { type: 'none' }, operations: {}, models: [], vendorExtension: { nested: 'keep' } };
  const saved = JSON.stringify({ version: 2, envelopeExtension: 'keep', state: { channels: [{ profile, origin: 'native', migrationIssues: [],
    createdAt: 1, updatedAt: 2, recordExtension: true }], migratedLegacyIds: [], stateExtension: 'keep' } });
  const values = installStorage([['channels-v2-storage', saved]]);
  const { ensureChannelStoresHydrated, useChannelStore } = await import('./channelStore');
  await ensureChannelStoresHydrated();
  useChannelStore.setState({ migratedLegacyIds: ['extended'] });
  await vi.waitFor(() => expect(JSON.parse(values.get('channels-v2-storage')!)).toMatchObject({ envelopeExtension: 'keep', state: {
    stateExtension: 'keep', migratedLegacyIds: ['extended'], channels: [{ recordExtension: true, profile: { vendorExtension: { nested: 'keep' } } }],
  } }));
});

it.each([
  { version: 99, state: { credentials: {} } },
  { version: 1, state: { credentials: [] } },
])('protects unsupported or damaged credential maps: %j', async (envelope) => {
  const saved = JSON.stringify(envelope);
  const values = installStorage([['channel-credentials-storage', saved]]);
  const { ensureChannelStoresHydrated, replaceChannelCredentials } = await import('./channelStore');
  await expect(ensureChannelStoresHydrated()).rejects.toThrow('渠道配置尚未读取完成');
  replaceChannelCredentials({});
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(values.get('channel-credentials-storage')).toBe(saved);
});

it('refuses migrations after malformed saved data instead of replacing it with defaults', async () => {
  const saved = '{invalid-channel-json';
  const values = installStorage([['channels-v2-storage', saved]]);
  const { ensureChannelStoresHydrated, channelStoresHydrated, migrateLegacyProviders } = await import('./channelStore');
  await expect(ensureChannelStoresHydrated()).rejects.toThrow('渠道配置尚未读取完成');
  expect(channelStoresHydrated()).toBe(false);
  migrateLegacyProviders([{ id: 'old-provider', label: 'Old provider', apiKey: '', baseUrl: 'https://old.example.test',
    apiStyle: 'openai-compatible', models: ['image'], supportsWebSearch: false }]);
  const { migrateAgnesSettingsCredential } = await import('../runtime/agnesChannel');
  migrateAgnesSettingsCredential('__SC_SECRET_eyJuYW1lc3BhY2UiOiJzZXR0aW5ncyIsImlkIjoiYWduZXMifQ__');
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(values.get('channels-v2-storage')).toBe(saved);
});
