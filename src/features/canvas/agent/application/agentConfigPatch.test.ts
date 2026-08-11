import { beforeEach, describe, expect, it } from 'vitest';
import { useCustomProvidersStore } from '@/stores/customProvidersStore';
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

describe('agent config patch', () => {
  beforeEach(() => {
    useCustomProvidersStore.setState({ providers: [{ id: 'chat', label: 'Chat', mediaType: 'chat', baseUrl: 'https://old.example/v1', endpointPath: '/chat/completions', apiKey: 'secret', apiStyle: 'openai-compatible', models: ['model-a'], supportsWebSearch: false }] });
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

  it('previews, applies and rolls back only allowlisted fields', () => {
    const patch = { version: 1 as const, providerId: 'chat', baseRevision: getAgentProviderRevision('chat')!, changes: { baseUrl: 'https://new.example/v1', modelId: 'model-a', modelMetadata: { supportsTools: true } } };
    expect(previewAgentProviderPatch(patch)).toMatchObject({ ok: true, credential: 'configured' });
    const applied = applyAgentProviderPatch(patch);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(useCustomProvidersStore.getState().providers[0].apiKey).toBe('secret');
    expect(rollbackAgentProviderPatch(applied.rollbackToken)).toMatchObject({ ok: true });
    expect(useCustomProvidersStore.getState().providers[0].baseUrl).toBe('https://old.example/v1');
  });

  it('fails closed on revision conflict', () => {
    expect(previewAgentProviderPatch({ version: 1, providerId: 'chat', baseRevision: 'stale', changes: { endpointPath: '/responses' } })).toMatchObject({ ok: false, issues: [expect.stringContaining('变化')] });
  });

  it('does not let rollback overwrite a provider changed after apply', () => {
    const patch = { version: 1 as const, providerId: 'chat', baseRevision: getAgentProviderRevision('chat')!, changes: { endpointPath: '/responses' } };
    const applied = applyAgentProviderPatch(patch);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    useCustomProvidersStore.getState().updateProvider('chat', { baseUrl: 'https://concurrent.example/v1' });
    expect(rollbackAgentProviderPatch(applied.rollbackToken)).toMatchObject({
      ok: false,
      error: expect.stringContaining('变化'),
    });
    expect(useCustomProvidersStore.getState().providers[0].baseUrl).toBe('https://concurrent.example/v1');
    expect(useCustomProvidersStore.getState().providers[0].endpointPath).toBe('/responses');
  });

  it('rolls back only the allowlisted fields changed by the patch', () => {
    const patch = { version: 1 as const, providerId: 'chat', baseRevision: getAgentProviderRevision('chat')!, changes: { endpointPath: '/responses' } };
    const applied = applyAgentProviderPatch(patch);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    useCustomProvidersStore.getState().updateProvider('chat', { label: 'Renamed concurrently', apiKey: 'new-secret' });
    expect(rollbackAgentProviderPatch(applied.rollbackToken)).toMatchObject({ ok: true });
    expect(useCustomProvidersStore.getState().providers[0]).toMatchObject({
      label: 'Renamed concurrently',
      apiKey: 'new-secret',
      endpointPath: '/chat/completions',
    });
  });

  it('restores a config rollback snapshot after a process restart', () => {
    const values = new Map<string, string>();
    const providerEndpointAtCheckpoint: Array<string | undefined> = [];
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        providerEndpointAtCheckpoint.push(useCustomProvidersStore.getState().providers[0].endpointPath);
        values.set(key, value);
      },
    };
    const patch = { version: 1 as const, providerId: 'chat', baseRevision: getAgentProviderRevision('chat')!, changes: { endpointPath: '/responses' } };
    const applied = applyAgentProviderPatch(patch, new PersistentAgentConfigRollbackStore(storage));
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    expect(providerEndpointAtCheckpoint[0]).toBe('/chat/completions');
    expect(Array.from(values.values()).join('\n')).not.toContain('secret');
    expect(rollbackAgentProviderPatch(
      applied.rollbackToken,
      new PersistentAgentConfigRollbackStore(storage),
    )).toMatchObject({ ok: true, providerId: 'chat' });
    expect(useCustomProvidersStore.getState().providers[0].endpointPath).toBe('/chat/completions');
  });

  it('drops malformed persisted rollback authority', () => {
    const values = new Map<string, string>();
    values.set('storyboard-copilot:canvas-agent:config-rollbacks:v1', JSON.stringify({
      version: 1,
      snapshots: [{ token: 'forged', providerId: 'chat', appliedRevision: 1, previous: { apiKey: 'stolen' }, createdAt: 1 }],
    }));
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    expect(rollbackAgentProviderPatch('forged', new PersistentAgentConfigRollbackStore(storage))).toMatchObject({ ok: false });
    expect(useCustomProvidersStore.getState().providers[0].apiKey).toBe('secret');
  });

  it('restores fields that were absent before a restart', () => {
    useCustomProvidersStore.setState((state) => ({
      providers: state.providers.map((provider) => ({
        ...provider,
        endpointPath: undefined,
        modelMetadata: undefined,
      })),
    }));
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const patch = {
      version: 1 as const,
      providerId: 'chat',
      baseRevision: getAgentProviderRevision('chat')!,
      changes: { endpointPath: '/responses', modelId: 'model-a', modelMetadata: { supportsTools: true } },
    };
    const applied = applyAgentProviderPatch(patch, new PersistentAgentConfigRollbackStore(storage));
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(rollbackAgentProviderPatch(applied.rollbackToken, new PersistentAgentConfigRollbackStore(storage))).toMatchObject({ ok: true });
    expect(useCustomProvidersStore.getState().providers[0].endpointPath).toBeUndefined();
    expect(useCustomProvidersStore.getState().providers[0].modelMetadata).toBeUndefined();
  });
});
