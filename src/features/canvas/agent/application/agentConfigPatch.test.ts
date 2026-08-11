import { beforeEach, describe, expect, it } from 'vitest';
import { useCustomProvidersStore } from '@/stores/customProvidersStore';
import {
  PersistentAgentConfigRollbackStore,
  applyAgentProviderPatch,
  getAgentProviderRevision,
  previewAgentProviderPatch,
  rollbackAgentProviderPatch,
} from './agentConfigPatch';

describe('agent config patch', () => {
  beforeEach(() => useCustomProvidersStore.setState({ providers: [{ id: 'chat', label: 'Chat', mediaType: 'chat', baseUrl: 'https://old.example/v1', endpointPath: '/chat/completions', apiKey: 'secret', apiStyle: 'openai-compatible', models: ['model-a'], supportsWebSearch: false }] }));

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
