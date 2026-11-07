import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrateLegacyProviders, projectChannelProviders, removeChannelCredential,
  useChannelStore } from '../store/channelStore';
import { channelPersistenceStorage } from '../store/channelPersistence';
import { migrateLegacyConfig } from './legacyConfig';
import type { CustomProviderConfig } from '@/stores/customProvidersStore';
import type { ChannelProfileV2 } from '../domain/profile';
import { revealChannelCredential, useMemorySecretVault } from '@/features/secrets/testSupport';

useMemorySecretVault();

const original = useChannelStore.getState();
const provider = (patch: Partial<CustomProviderConfig> = {}): CustomProviderConfig => ({
  id: 'migration-store-fixture', label: 'Relay', apiKey: 'fixture-key', baseUrl: 'https://relay.example/v1',
  endpointPath: '/images/generations', apiStyle: 'openai-compatible', models: ['image'], supportsWebSearch: false,
  ...patch,
});
beforeEach(async () => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  useChannelStore.setState({ channels: [], migratedLegacyIds: [] });
  await removeChannelCredential(provider().id);
});
afterEach(async () => {
  await removeChannelCredential(provider().id);
  useChannelStore.setState(original);
  vi.unstubAllGlobals();
});

describe('automatic native legacy cutover', () => {
  it('projects each model chat contract independently when one channel mixes protocols', () => {
    const profile: ChannelProfileV2 = { version: 2, id: 'mixed-protocol', name: 'Mixed', baseUrl: 'https://relay.example', auth: { type: 'none' }, operations: {}, models: [
      { id: 'chat', operations: ['chat'], params: [{ key: 'stream', label: 'Stream', type: 'boolean', default: true }], capabilities: { supportsMultimodal: false, contextWindow: 32768 }, modes: [{ id: 'chat', label: 'Chat', operation: 'chat', endpoint: {
        method: 'POST', path: '/v1/chat/completions', body: 'json', template: { messages: '{{messages}}', stream: '{{param.stream}}', tools: '{{chatPayload.tools}}', tool_choice: '{{chatPayload.tool_choice}}' }, response: { mode: 'sync', outputs: [] },
      } }] },
      { id: 'claude', operations: ['chat'], params: [{ key: 'stream', label: 'Stream', type: 'boolean', default: true }], capabilities: { supportsTools: false, maxOutputTokens: 8192 }, modes: [{ id: 'messages', label: 'Messages', operation: 'chat', endpoint: {
        method: 'POST', path: '/v1/messages', body: 'json', template: { system: '{{chatPayload.system}}', messages: '{{messages}}', stream: '{{param.stream}}', tools: '{{chatPayload.tools}}' }, response: { mode: 'sync', outputs: [] },
      } }] },
      { id: 'responses', operations: ['chat'], params: [], modes: [{ id: 'responses', label: 'Responses', operation: 'chat', endpoint: {
        method: 'POST', path: '/v1/responses', body: 'json', template: { input: '{{chatPayload.input}}', tools: '{{chatPayload.tools}}' }, response: { mode: 'sync', outputs: [] },
      } }] },
    ] };
    const [projection] = projectChannelProviders([{ profile, origin: 'native', migrationIssues: [], createdAt: 1, updatedAt: 1 }]);
    expect(projection.modelMetadata?.chat).toMatchObject({ agentProtocol: 'openai-chat-completions', supportsStreaming: true, supportsMultimodal: false, contextWindow: 32768 });
    expect(projection.modelMetadata?.claude).toMatchObject({ agentProtocol: 'anthropic-messages', supportsStreaming: true, supportsTools: false, maxOutputTokens: 8192 });
    expect(projection.modelMetadata?.responses).toMatchObject({ agentProtocol: 'openai-responses', supportsStreaming: false, supportsTools: true });
    const [reordered] = projectChannelProviders([{ profile: { ...profile, models: [...profile.models].reverse() }, origin: 'native', migrationIssues: [], createdAt: 1, updatedAt: 1 }]);
    expect(reordered.modelMetadata).toEqual(projection.modelMetadata);
  });
  it('fills known metadata for old channels without changing their saved values or overriding gateway limits', () => {
    const profile: ChannelProfileV2 = { version: 2, id: 'known-model', name: 'Existing', baseUrl: 'https://relay.example', auth: { type: 'none' },
      operations: { chat: { method: 'POST', path: '/v1/chat/completions', body: 'json', template: { messages: '{{messages}}' }, response: { mode: 'sync', outputs: [] } } },
      models: [{ id: 'deepseek-flash', operations: ['chat'], params: [], capabilities: { contextWindow: 32768, supportsMultimodal: false } },
        { id: 'deepseek-v4.1-flash', operations: ['chat'], params: [] }] };
    const before = JSON.stringify(profile);
    const [projected] = projectChannelProviders([{ profile, origin: 'native', migrationIssues: [], createdAt: 1, updatedAt: 1 }]);
    expect(projected.modelMetadata?.['deepseek-flash']).toMatchObject({ contextWindow: 32768, supportsMultimodal: false });
    expect(projected.modelMetadata?.['deepseek-v4.1-flash']).toMatchObject({ contextWindow: 1000000, supportsMultimodal: true });
    expect(projected.modelMetadata?.['deepseek-v4.1-flash']?.supportsTools).toBe(false);
    expect(JSON.stringify(profile)).toBe(before);
  });
  it('activates lossy HTTP records after vault migration, stores ref-only backups, and is idempotent', async () => {
    const input = provider({ extraParams: { vendorExtension: { retainedInBackup: true } } });
    const raw = JSON.stringify({ state: { providers: [input], unknown: 'preserve' }, version: 0 }, null, 2);
    channelPersistenceStorage.setItem('custom-providers-storage', raw);
    migrateLegacyProviders([input]);
    await vi.waitFor(() => expect(useChannelStore.getState().channels).toHaveLength(1));
    const first = useChannelStore.getState().channels[0];
    expect(first.origin).toBe('native');
    expect(first.migrationIssues).toContainEqual(expect.objectContaining({ key: 'extraParams.vendorExtension' }));
    expect(first.profile.operations['image.generate']).toBeDefined();
    expect(await revealChannelCredential(input.id)).toBe(input.apiKey);
    expect(channelPersistenceStorage.getItem('legacy_custom_providers_raw')).toBeNull();
    await vi.waitFor(() => {
      const backup = channelPersistenceStorage.getItem('legacy_custom_providers');
      expect(backup).toContain('retainedInBackup');
      expect(backup).not.toContain(input.apiKey);
    });
    expect(projectChannelProviders([first])[0].extraParams?.channelProfileId).toBe(input.id);
    migrateLegacyProviders([input]);
    expect(useChannelStore.getState().channels).toEqual([first]);
    expect(useChannelStore.getState().migratedLegacyIds).toEqual([input.id]);
  });

  it('promotes already migrated review-only records and restores credentials from the original backup on hydration', async () => {
    const input = provider();
    channelPersistenceStorage.setItem('legacy_custom_providers', JSON.stringify([input]));
    const record = { profile: migrateLegacyConfig(input).profile, origin: 'legacy', migrationIssues: [], createdAt: 12, updatedAt: 13 };
    channelPersistenceStorage.setItem('channels-v2-storage', JSON.stringify({ version: 2,
      state: { channels: [record], migratedLegacyIds: [input.id] } }));
    await useChannelStore.persist.rehydrate();
    await vi.waitFor(() => expect(useChannelStore.getState().channels[0]).toMatchObject({ origin: 'native', createdAt: 12 }));
    expect(await revealChannelCredential(input.id)).toBe(input.apiKey);
  });

  it.each(['comfyui', 'dreamina-cli', 'local-audio', 'minimax-h3'])('backs up %s with refs while leaving its dedicated adapter authoritative', async (apiStyle) => {
    const input = provider({ apiStyle });
    migrateLegacyProviders([input]);
    expect(useChannelStore.getState().channels).toEqual([]);
    expect(useChannelStore.getState().migratedLegacyIds).toEqual([]);
    await vi.waitFor(() => {
      const backup = channelPersistenceStorage.getItem('legacy_custom_providers');
      expect(backup).toContain(apiStyle);
      expect(backup).not.toContain(input.apiKey);
    });
  });

  it('exposes faithful OpenAI streaming and native protocol capabilities to catalogs', async () => {
    const input = provider({ mediaType: 'chat', endpointPath: '/chat/completions' });
    migrateLegacyProviders([input]);
    await vi.waitFor(() => expect(useChannelStore.getState().channels).toHaveLength(1));
    const projected = projectChannelProviders(useChannelStore.getState().channels)[0];
    expect(projected.modelMetadata?.image).toMatchObject({ supportsTools: true, supportsStreaming: true,
      supportsMultimodal: true, agentProtocol: 'openai-chat-completions' });
    expect(projected.extraParams?.channelModels).toEqual(useChannelStore.getState().channels[0].profile.models);
  });
});
