import { afterEach, expect, it, vi } from 'vitest';

const gate = vi.hoisted(() => ({ promise: Promise.resolve(true) }));
vi.mock('@/features/secrets/secretStore', async (original) => {
  const module = await original<typeof import('@/features/secrets/secretStore')>();
  return { ...module, secretStore: { ...module.secretStore, has: vi.fn(() => gate.promise) } };
});
afterEach(() => vi.unstubAllGlobals());

it('waits for native channels before migrating the legacy Agnes setting', async () => {
  const pending = Promise.withResolvers<boolean>();
  gate.promise = pending.promise;
  const profile = {
    version: 2, id: 'saved-deepseek', name: 'DeepSeek', baseUrl: 'https://api.example.test', auth: { type: 'bearer' },
    operations: { chat: { method: 'POST', path: '/v1/chat/completions', body: 'json',
      template: { messages: '{{messages}}' }, response: { mode: 'sync', outputs: [] } } },
    models: [{ id: 'deepseek-flash', operations: ['chat'], params: [] }],
  };
  const saved = JSON.stringify({ version: 2, state: { channels: [{ profile,
    credentialRef: { namespace: 'channel', id: 'agnes-hydration-saved-key' }, origin: 'native',
    migrationIssues: [], createdAt: 1, updatedAt: 2 }], migratedLegacyIds: [] } });
  const values = new Map([['channels-v2-storage', saved]]);
  const writes: string[] = [];
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); if (key === 'channels-v2-storage') writes.push(value); },
    removeItem: (key: string) => values.delete(key),
  });
  const { useChannelStore, channelStoresHydrated } = await import('../store/channelStore');
  const { secretStore, secretToken } = await import('@/features/secrets/secretStore');
  const { migrateAgnesSettingsCredential } = await import('./agnesChannel');
  await vi.waitFor(() => expect(secretStore.has).toHaveBeenCalled());
  expect(channelStoresHydrated()).toBe(false);
  migrateAgnesSettingsCredential(secretToken({ namespace: 'settings', id: 'legacy-agnes' }));
  expect(useChannelStore.getState().channels).toEqual([]);
  expect(values.get('channels-v2-storage')).toBe(saved);
  pending.resolve(true);
  await vi.waitFor(() => expect(channelStoresHydrated()).toBe(true));
  await vi.waitFor(() => expect(useChannelStore.getState().channels.map((entry) => entry.profile.id))
    .toEqual(expect.arrayContaining(['saved-deepseek', 'settings-agnes-image', 'settings-agnes-video', 'settings-agnes-chat'])));
  await vi.waitFor(() => expect(writes.length).toBeGreaterThan(0));
  expect(writes.every((value) => value.includes('saved-deepseek'))).toBe(true);
});
