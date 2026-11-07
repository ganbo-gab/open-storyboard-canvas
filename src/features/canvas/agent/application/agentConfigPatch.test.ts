import { beforeEach, describe, expect, it } from 'vitest';
import { useCustomProvidersStore } from '@/stores/customProvidersStore';
import { updateChannel } from '@/features/channels/application/channelService';
import { channelProviderId, removeChannelCredential, saveChannelRecord, setChannelCredential, useChannelStore } from '@/features/channels/store/channelStore';
import type { ChannelProfileV2 } from '@/features/channels/domain/profile';
import {
  DEFAULT_GENERATION_NETWORK_SETTINGS,
  useSettingsStore,
} from '@/stores/settingsStore';
import {
  PersistentAgentConfigRollbackStore,
  applyAgentGenerationNetworkPatch,
  applyAgentProviderPatch,
  getAgentGenerationNetworkRevision,
  getAgentProviderRevision,
  previewAgentGenerationNetworkPatch,
  previewAgentProviderPatch,
  rollbackAgentProviderPatch,
} from './agentConfigPatch';
import { revealChannelCredential, useMemorySecretVault } from '@/features/secrets/testSupport';

useMemorySecretVault();

function currentProfile(): ChannelProfileV2 {
  return useChannelStore.getState().channels.find((entry) => entry.profile.id === 'chat')!.profile;
}

describe('agent config patch', () => {
  beforeEach(async () => {
    useCustomProvidersStore.setState({ providers: [] });
    useChannelStore.setState({ channels: [], migratedLegacyIds: [] });
    await removeChannelCredential('chat');
    saveChannelRecord({
      version: 2, id: 'chat', name: 'Chat', baseUrl: 'https://old.example/v1', auth: { type: 'bearer' },
      operations: { chat: { method: 'POST', path: '/chat/completions', body: 'json',
        template: { model: '{{model}}', messages: '{{messages}}', tools: '{{tools}}' },
        response: { mode: 'sync', outputs: [] } } },
      models: [{ id: 'model-a', operations: ['chat'], params: [] }],
    } satisfies ChannelProfileV2);
    await setChannelCredential('chat', 'secret');
    useSettingsStore.setState({
      generationNetworkSettings: { ...DEFAULT_GENERATION_NETWORK_SETTINGS },
    });
  });

  it('previews, applies and rolls back a system to direct network route patch', () => {
    const rollbackStore = new PersistentAgentConfigRollbackStore(null);
    const patch = {
      baseRevision: getAgentGenerationNetworkRevision(),
      route: 'direct' as const,
    };

    expect(previewAgentGenerationNetworkPatch(patch)).toMatchObject({
      ok: true,
      credential: 'missing',
      diff: [{
        field: 'generationNetworkSettings.route',
        before: 'system',
        after: 'direct',
      }],
    });

    const applied = applyAgentGenerationNetworkPatch(patch, rollbackStore);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(useSettingsStore.getState().generationNetworkSettings).toEqual({
      route: 'direct',
      customProxyUrl: '',
    });

    expect(rollbackAgentProviderPatch(applied.rollbackToken, rollbackStore)).toMatchObject({
      ok: true,
      providerId: '__application_generation_network__',
    });
    expect(useSettingsStore.getState().generationNetworkSettings).toEqual(
      DEFAULT_GENERATION_NETWORK_SETTINGS,
    );
  });

  it('fails closed when custom-proxy has no user-configured proxy URL', () => {
    const patch = {
      baseRevision: getAgentGenerationNetworkRevision(),
      route: 'custom-proxy' as const,
    };

    expect(previewAgentGenerationNetworkPatch(patch)).toMatchObject({
      ok: false,
      credential: 'missing',
      issues: [expect.stringContaining('自定义代理地址')],
    });
    expect(applyAgentGenerationNetworkPatch(
      patch,
      new PersistentAgentConfigRollbackStore(null),
    )).toMatchObject({
      ok: false,
      issues: [expect.stringContaining('自定义代理地址')],
    });
    expect(useSettingsStore.getState().generationNetworkSettings.route).toBe('system');
  });

  it('does not let network rollback overwrite settings changed after apply', () => {
    const rollbackStore = new PersistentAgentConfigRollbackStore(null);
    const applied = applyAgentGenerationNetworkPatch({
      baseRevision: getAgentGenerationNetworkRevision(),
      route: 'direct',
    }, rollbackStore);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    useSettingsStore.getState().setGenerationNetworkSettings({
      route: 'direct',
      customProxyUrl: 'http://proxy.example:8080',
    });
    expect(rollbackAgentProviderPatch(applied.rollbackToken, rollbackStore)).toMatchObject({
      ok: false,
      providerId: '__application_generation_network__',
      error: expect.stringContaining('变化'),
    });
    expect(useSettingsStore.getState().generationNetworkSettings).toEqual({
      route: 'direct',
      customProxyUrl: 'http://proxy.example:8080',
    });
  });

  it('keeps proxy URL and credentials out of rollback storage and receipt payloads', () => {
    const proxyUrl = 'http://proxy-user:proxy-password@proxy.example:8080';
    useSettingsStore.getState().setGenerationNetworkSettings({
      route: 'system',
      customProxyUrl: proxyUrl,
    });
    const values = new Map<string, string>();
    const persistedWrites: string[] = [];
    const rollbackStore = new PersistentAgentConfigRollbackStore({
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
        persistedWrites.push(value);
      },
    });
    const patch = {
      baseRevision: getAgentGenerationNetworkRevision(),
      route: 'custom-proxy' as const,
    };
    const preview = previewAgentGenerationNetworkPatch(patch);
    const applied = applyAgentGenerationNetworkPatch(patch, rollbackStore);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    const rollback = rollbackAgentProviderPatch(applied.rollbackToken, rollbackStore);
    expect(rollback).toMatchObject({ ok: true });
    const serializedReceipts = JSON.stringify({ preview, applied, rollback });
    const serializedRollbackStorage = persistedWrites.join('\n');
    for (const serialized of [serializedReceipts, serializedRollbackStorage]) {
      expect(serialized).not.toContain(proxyUrl);
      expect(serialized).not.toContain('proxy-user');
      expect(serialized).not.toContain('proxy-password');
    }
  });

  it('previews, applies and rolls back only native allowlisted fields', async () => {
    const rollbackStore = new PersistentAgentConfigRollbackStore(null);
    const patch = { version: 1 as const, providerId: 'chat', baseRevision: getAgentProviderRevision('chat')!,
      changes: { baseUrl: 'https://new.example/v1', modelId: 'model-a', modelMetadata: { description: 'Model A' } } };
    expect(previewAgentProviderPatch(patch)).toMatchObject({ ok: true, providerId: 'chat', credential: 'configured', diff: [
      { field: 'baseUrl', before: 'https://old.example/v1', after: 'https://new.example/v1' },
      { field: 'models.model-a.label', before: null, after: 'Model A' },
    ] });
    const applied = applyAgentProviderPatch(patch, rollbackStore);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(currentProfile()).toMatchObject({ baseUrl: 'https://new.example/v1', models: [{ label: 'Model A' }] });
    expect(await revealChannelCredential('chat')).toBe('secret');
    expect(useCustomProvidersStore.getState().providers.every((provider) => provider.extraParams?.channelProfileId)).toBe(true);
    expect(rollbackAgentProviderPatch(applied.rollbackToken, rollbackStore)).toMatchObject({ ok: true });
    expect(currentProfile().baseUrl).toBe('https://old.example/v1');
    expect(currentProfile().models[0].label).toBeUndefined();
  });

  it('resolves old provider IDs and projected IDs to one native profile without aliases', () => {
    const id = channelProviderId('chat', 'chat');
    expect(getAgentProviderRevision(id)).toBe(getAgentProviderRevision('chat'));
    const patch = { version: 1 as const, providerId: id, baseRevision: getAgentProviderRevision(id)!, changes: { endpointPath: '/responses' } };
    expect(previewAgentProviderPatch(patch)).toMatchObject({ ok: true, providerId: 'chat', diff: [
      { field: 'operations.chat.path', before: '/chat/completions', after: '/responses' },
    ] });
    const rollbackStore = new PersistentAgentConfigRollbackStore(null);
    const applied = applyAgentProviderPatch(patch, rollbackStore);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(useChannelStore.getState().channels.map((entry) => entry.profile.id)).toEqual(['chat']);
    expect(rollbackStore.get(applied.rollbackToken)?.providerId).toBe('chat');
    expect(currentProfile().operations.chat?.path).toBe('/responses');
  });

  it('patches an auto-migrated HTTP provider by its persisted old ID', async () => {
    const id = 'agent-patch-legacy-chat';
    await removeChannelCredential(id);
    await useCustomProvidersStore.getState().addProvider({ id, label: 'Legacy Chat', mediaType: 'chat',
      baseUrl: 'https://legacy.example/v1', endpointPath: '/chat/completions', apiKey: 'legacy-key',
      apiStyle: 'openai-compatible', models: ['model-a'], supportsWebSearch: false });
    expect(useCustomProvidersStore.getState().providers.some((provider) => provider.id === id)).toBe(false);
    const patch = { version: 1 as const, providerId: id, baseRevision: getAgentProviderRevision(id)!,
      changes: { baseUrl: 'https://native.example' } };
    expect(previewAgentProviderPatch(patch)).toMatchObject({ ok: true, providerId: id, credential: 'configured' });
    const rollbackStore = new PersistentAgentConfigRollbackStore(null);
    const applied = applyAgentProviderPatch(patch, rollbackStore);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(useChannelStore.getState().channels.find((entry) => entry.profile.id === id)?.profile.baseUrl).toBe('https://native.example');
    expect(await revealChannelCredential(id)).toBe('legacy-key');
    expect(rollbackAgentProviderPatch(applied.rollbackToken, rollbackStore)).toMatchObject({ ok: true, providerId: id });
    expect(useCustomProvidersStore.getState().providers.some((provider) => provider.id === id)).toBe(false);
  });

  it('fails closed on revision conflict', () => {
    const patch = { version: 1 as const, providerId: 'chat', baseRevision: 'stale', changes: { endpointPath: '/responses' } };
    expect(previewAgentProviderPatch(patch)).toMatchObject({ ok: false, issues: [expect.stringContaining('变化')] });
    expect(applyAgentProviderPatch(patch)).toMatchObject({ ok: false });
    expect(currentProfile().operations.chat?.path).toBe('/chat/completions');
  });

  it('does not let rollback overwrite a channel changed after apply', async () => {
    const rollbackStore = new PersistentAgentConfigRollbackStore(null);
    const applied = applyAgentProviderPatch({ version: 1, providerId: 'chat', baseRevision: getAgentProviderRevision('chat')!, changes: { endpointPath: '/responses' } }, rollbackStore);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    await updateChannel('chat', { ...currentProfile(), baseUrl: 'https://concurrent.example/v1' });
    expect(rollbackAgentProviderPatch(applied.rollbackToken, rollbackStore)).toMatchObject({ ok: false, error: expect.stringContaining('变化') });
    expect(currentProfile().baseUrl).toBe('https://concurrent.example/v1');
    expect(currentProfile().operations.chat?.path).toBe('/responses');
  });

  it('preserves concurrent display-only and separate credential edits during rollback', async () => {
    const rollbackStore = new PersistentAgentConfigRollbackStore(null);
    const applied = applyAgentProviderPatch({ version: 1, providerId: 'chat', baseRevision: getAgentProviderRevision('chat')!, changes: { endpointPath: '/responses' } }, rollbackStore);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    await updateChannel('chat', { ...currentProfile(), name: 'Renamed concurrently', notes: ['User note'] }, 'new-secret');
    expect(rollbackAgentProviderPatch(applied.rollbackToken, rollbackStore)).toMatchObject({ ok: true });
    expect(currentProfile()).toMatchObject({ name: 'Renamed concurrently', notes: ['User note'], operations: { chat: { path: '/chat/completions' } } });
    expect(await revealChannelCredential('chat')).toBe('new-secret');
  });

  it('restores a native rollback checkpoint after restart without persisting credentials', () => {
    const values = new Map<string, string>();
    const providerEndpointAtCheckpoint: Array<string | undefined> = [];
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        providerEndpointAtCheckpoint.push(currentProfile().operations.chat?.path);
        values.set(key, value);
      },
    };
    const patch = { version: 1 as const, providerId: 'chat', baseRevision: getAgentProviderRevision('chat')!, changes: { endpointPath: '/responses' } };
    const applied = applyAgentProviderPatch(patch, new PersistentAgentConfigRollbackStore(storage));
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(providerEndpointAtCheckpoint[0]).toBe('/chat/completions');
    expect(Array.from(values.values()).join('\n')).not.toContain('secret');
    expect(JSON.stringify({ preview: previewAgentProviderPatch(patch), applied })).not.toContain('secret');
    expect(rollbackAgentProviderPatch(applied.rollbackToken, new PersistentAgentConfigRollbackStore(storage))).toMatchObject({ ok: true, providerId: 'chat' });
    expect(currentProfile().operations.chat?.path).toBe('/chat/completions');
  });

  it('drops malformed persisted rollback authority', async () => {
    const raw = JSON.stringify({ version: 1, snapshots: [
      { token: 'forged', providerId: 'chat', appliedRevision: 1, previous: { apiKey: 'stolen' }, createdAt: 1 },
      { token: 'forged-path', providerId: 'chat', appliedRevision: getAgentProviderRevision('chat'), previous: { operationPaths: { auth: 'stolen' } }, createdAt: 1 },
    ] });
    const storage = { getItem: () => raw, setItem: () => { throw new Error('must not write'); } };
    for (const token of ['forged', 'forged-path']) {
      expect(rollbackAgentProviderPatch(token, new PersistentAgentConfigRollbackStore(storage))).toMatchObject({ ok: false });
    }
    expect(await revealChannelCredential('chat')).toBe('secret');
  });

  it('restores an absent optional model label after restart', () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value) };
    const patch = { version: 1 as const, providerId: 'chat', baseRevision: getAgentProviderRevision('chat')!,
      changes: { endpointPath: '/responses', modelId: 'model-a', modelMetadata: { description: 'Model A' } } };
    const applied = applyAgentProviderPatch(patch, new PersistentAgentConfigRollbackStore(storage));
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(rollbackAgentProviderPatch(applied.rollbackToken, new PersistentAgentConfigRollbackStore(storage))).toMatchObject({ ok: true });
    expect(Object.prototype.hasOwnProperty.call(currentProfile().models[0], 'label')).toBe(false);
    expect(currentProfile().operations.chat?.path).toBe('/chat/completions');
  });

  it('explicitly rejects unrepresentable legacy protocol and capability fields', () => {
    for (const changes of [{ apiStyle: 'anthropic' }, { modelId: 'model-a', modelMetadata: { supportsTools: true } },
      { modelId: 'model-a', modelMetadata: { contextWindow: 1000 } }]) {
      const patch = { version: 1 as const, providerId: 'chat', baseRevision: getAgentProviderRevision('chat')!, changes };
      expect(previewAgentProviderPatch(patch)).toMatchObject({ ok: false, issues: expect.arrayContaining([expect.stringContaining('无法表示')]) });
      expect(applyAgentProviderPatch(patch)).toMatchObject({ ok: false });
    }
    expect(currentProfile().models[0]).toEqual({ id: 'model-a', operations: ['chat'], params: [] });
  });

  it('validates the native profile and rejects unknown or credential-bearing fields', async () => {
    for (const changes of [{ baseUrl: 'https://user:password@example.com' }, { baseUrl: 'https://new.example/' },
      { endpointPath: '/{{undeclared}}' }, { baseUrl: 'https://secret.example' }, { apiKey: 'stolen' },
      { modelId: 'missing', modelMetadata: { description: 'Missing' } }]) {
      const patch = { version: 1 as const, providerId: 'chat', baseRevision: getAgentProviderRevision('chat')!, changes };
      expect(previewAgentProviderPatch(patch)).toMatchObject({ ok: false, diff: [] });
      expect(applyAgentProviderPatch(patch)).toMatchObject({ ok: false });
    }
    expect(currentProfile().baseUrl).toBe('https://old.example/v1');
    expect(await revealChannelCredential('chat')).toBe('secret');
  });

  it('fails explicitly for an endpoint without a unique native operation', async () => {
    await updateChannel('chat', { ...currentProfile(), operations: {}, models: [{ id: 'model-a', operations: [], params: [] }] });
    const patch = { version: 1 as const, providerId: 'chat', baseRevision: getAgentProviderRevision('chat')!, changes: { endpointPath: '/responses' } };
    expect(previewAgentProviderPatch(patch)).toMatchObject({ ok: false, issues: expect.arrayContaining([expect.stringContaining('唯一')]) });
    expect(applyAgentProviderPatch(patch)).toMatchObject({ ok: false });
    expect(currentProfile().operations).toEqual({});
  });

  it('rejects ambiguous native paths while a media-specific provider selects its own operation', async () => {
    const profile = currentProfile();
    await updateChannel('chat', { ...profile, operations: { ...profile.operations,
      'image.generate': { method: 'POST', path: '/images', body: 'json', response: { mode: 'sync', outputs: [] } } },
      models: [...profile.models, { id: 'image-a', operations: ['image.generate'], params: [] }] });
    const patch = { version: 1 as const, providerId: 'chat', baseRevision: getAgentProviderRevision('chat')!, changes: { endpointPath: '/responses' } };
    expect(previewAgentProviderPatch(patch)).toMatchObject({ ok: false, issues: expect.arrayContaining([expect.stringContaining('唯一')]) });
    expect(previewAgentProviderPatch({ ...patch, providerId: channelProviderId('chat', 'chat') })).toMatchObject({ ok: true,
      diff: [{ field: 'operations.chat.path', before: '/chat/completions', after: '/responses' }] });
  });

  it('rejects noops and cannot create a missing native operation through an absent legacy endpoint', () => {
    const patch = { version: 1 as const, providerId: 'chat', baseRevision: getAgentProviderRevision('chat')!,
      changes: { modelId: 'model-a', modelMetadata: { description: null } } };
    expect(previewAgentProviderPatch(patch)).toMatchObject({ ok: false, issues: [expect.stringContaining('没有产生')] });
    expect(applyAgentProviderPatch(patch)).toMatchObject({ ok: false });
    expect(Object.prototype.hasOwnProperty.call(currentProfile().models[0], 'label')).toBe(false);
  });

  it('rechecks the native revision after persisting rollback authority', () => {
    const values = new Map<string, string>();
    let changed = false;
    const rollbackStore = new PersistentAgentConfigRollbackStore({ getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
        if (!changed) {
          changed = true;
          saveChannelRecord({ ...currentProfile(), baseUrl: 'https://concurrent.example' });
        }
      } });
    expect(applyAgentProviderPatch({ version: 1, providerId: 'chat', baseRevision: getAgentProviderRevision('chat')!,
      changes: { endpointPath: '/responses' } }, rollbackStore)).toMatchObject({ ok: false, issues: [expect.stringContaining('变化')] });
    expect(currentProfile().baseUrl).toBe('https://concurrent.example');
    expect(currentProfile().operations.chat?.path).toBe('/chat/completions');
    expect(JSON.parse(Array.from(values.values())[0]).snapshots).toEqual([]);
  });

  it('never mutates the channel when the durable checkpoint cannot be written', async () => {
    const before = structuredClone(currentProfile());
    const rollbackStore = new PersistentAgentConfigRollbackStore({ getItem: () => null, setItem: () => { throw new Error('disk full'); } });
    expect(() => applyAgentProviderPatch({ version: 1, providerId: 'chat', baseRevision: getAgentProviderRevision('chat')!,
      changes: { endpointPath: '/responses' } }, rollbackStore)).toThrow('disk full');
    expect(currentProfile()).toEqual(before);
    expect(await revealChannelCredential('chat')).toBe('secret');
  });
});
