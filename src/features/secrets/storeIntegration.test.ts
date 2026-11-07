import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSecretStore, secretRefFromToken, secretStore, useSecretStatusStore, type SecretRef } from './secretStore';
import { channelPersistenceStorage } from '@/features/channels/store/channelPersistence';
// Dynamic imports intentionally exercise async store initialization after the isolated vault is installed.

const vault = new Map<string, string>();
const vaultKey = (ref: SecretRef) => JSON.stringify(ref);
const fake = createSecretStore({
  get: async (ref) => vault.get(vaultKey(ref)) ?? null,
  set: async (ref, value) => { vault.set(vaultKey(ref), value); },
  has: async (ref) => vault.has(vaultKey(ref)),
  delete: async (ref) => { vault.delete(vaultKey(ref)); },
});
beforeEach(() => {
  vault.clear(); useSecretStatusStore.setState({ states: {} });
  vi.spyOn(secretStore, 'get').mockImplementation(fake.get);
  vi.spyOn(secretStore, 'set').mockImplementation(fake.set);
  vi.spyOn(secretStore, 'has').mockImplementation(fake.has);
  vi.spyOn(secretStore, 'delete').mockImplementation(fake.delete);
});
afterEach(() => vi.restoreAllMocks());

describe('application store credential boundaries', () => {
  it('keeps built-in and Agnes keys out of React state and persisted JSON', async () => {
    const { useSettingsStore } = await import('@/stores/settingsStore');
    await useSettingsStore.persist.rehydrate();
    await useSettingsStore.getState().setProviderApiKey('vault-fixture', 'SETTINGS_PRIVATE_VALUE');
    await useSettingsStore.getState().setAgnesApiKey('AGNES_PRIVATE_VALUE');
    const settings = useSettingsStore.getState();
    expect(secretRefFromToken(settings.apiKeys['vault-fixture'])).toEqual({ namespace: 'settings', id: 'provider:vault-fixture' });
    expect(settings.agnesApiKey).not.toContain('AGNES_PRIVATE_VALUE');
    expect(JSON.stringify(settings)).not.toContain('SETTINGS_PRIVATE_VALUE');
    await vi.waitFor(() => {
      const persisted = channelPersistenceStorage.getItem('settings-storage');
      expect(persisted).toContain('__SC_SECRET_');
      expect(persisted).not.toContain('SETTINGS_PRIVATE_VALUE');
      expect(persisted).not.toContain('AGNES_PRIVATE_VALUE');
    });
    expect(await fake.reveal(secretRefFromToken(settings.apiKeys['vault-fixture'])!)).toBe('SETTINGS_PRIVATE_VALUE');
  });
  it('stores ComfyUI provider and partner credentials as refs before publishing a provider', async () => {
    const { useCustomProvidersStore } = await import('@/stores/customProvidersStore');
    await useCustomProvidersStore.persist.rehydrate();
    const saving = useCustomProvidersStore.getState().addProvider({ id: 'vault-comfy-fixture', label: 'Vault Comfy',
      baseUrl: 'http://127.0.0.1:8188', apiStyle: 'comfyui', apiKey: 'COMFY_PRIVATE_VALUE', models: ['workflow'], supportsWebSearch: false,
      extraHeaders: { 'X-Tunnel': 'TUNNEL_PRIVATE_VALUE' }, extraParams: { comfyui: { comfyOrgKey: 'PARTNER_PRIVATE_VALUE' } } });
    expect(JSON.stringify(useCustomProvidersStore.getState())).not.toContain('COMFY_PRIVATE_VALUE');
    await saving;
    const provider = useCustomProvidersStore.getState().providers.find((entry) => entry.id === 'vault-comfy-fixture')!;
    expect(provider.credentialRef).toEqual({ namespace: 'provider', id: 'vault-comfy-fixture' });
    expect(provider.credentialState).toBe('present');
    await vi.waitFor(() => {
      const persisted = channelPersistenceStorage.getItem('custom-providers-storage');
      expect(persisted).toContain('vault-comfy-fixture');
      for (const value of ['COMFY_PRIVATE_VALUE', 'TUNNEL_PRIVATE_VALUE', 'PARTNER_PRIVATE_VALUE']) expect(persisted).not.toContain(value);
    });
  });

  it('protects the recognized Comfy partner-key wire field before ordinary state or persistence', async () => {
    const { useCustomProvidersStore } = await import('@/stores/customProvidersStore');
    await useCustomProvidersStore.getState().addProvider({
      id: 'comfy-partner-wire', label: 'Partner workflow', baseUrl: 'http://127.0.0.1:8188',
      apiStyle: 'comfyui', apiKey: '', models: ['workflow'], supportsWebSearch: false,
      extraParams: { auth: { mode: 'none' }, comfyui: {
        workflow: { '1': { class_type: 'PartnerService', inputs: { api_key_comfy_org: 'COMFY_ORG_PRIVATE_WIRE_VALUE' } } },
        outputNodeIds: ['1'],
      } },
    });
    expect(JSON.stringify(useCustomProvidersStore.getState())).not.toContain('COMFY_ORG_PRIVATE_WIRE_VALUE');
    expect([...vault.values()]).toContain('COMFY_ORG_PRIVATE_WIRE_VALUE');
    await vi.waitFor(() => expect(channelPersistenceStorage.getItem('custom-providers-storage')).not.toContain('COMFY_ORG_PRIVATE_WIRE_VALUE'));
  });
  it('keeps channel getters ref-only and permits explicit transient reveal', async () => {
    const { setChannelCredential, getChannelCredential, getChannelCredentialRef, getChannelCredentialState, removeChannelCredential } = await import('@/features/channels/store/channelStore');
    await setChannelCredential('vault-channel-fixture', 'CHANNEL_PRIVATE_VALUE');
    expect(getChannelCredential('vault-channel-fixture')).not.toContain('CHANNEL_PRIVATE_VALUE');
    expect(getChannelCredentialRef('vault-channel-fixture')).toEqual({ namespace: 'channel', id: 'vault-channel-fixture' });
    expect(getChannelCredentialState('vault-channel-fixture')).toBe('present');
    expect(await fake.reveal(getChannelCredentialRef('vault-channel-fixture')!)).toBe('CHANNEL_PRIVATE_VALUE');
    await vi.waitFor(() => {
      const persisted = channelPersistenceStorage.getItem('channel-credentials-storage');
      expect(persisted).toContain('__SC_SECRET_'); expect(persisted).not.toContain('CHANNEL_PRIVATE_VALUE');
    });
    await removeChannelCredential('vault-channel-fixture');
    expect(getChannelCredentialState('vault-channel-fixture')).toBe('missing');
  });
  it('keeps custom image-host header values out of ordinary state and persistence', async () => {
    const { DEFAULT_IMAGE_HOST_SETTINGS, useSettingsStore } = await import('@/stores/settingsStore');
    await useSettingsStore.getState().setImageHostSettings({ ...DEFAULT_IMAGE_HOST_SETTINGS, enabled: true,
      uploadUrl: 'https://uploads.example/custom', extraHeaders: { Authorization: 'Bearer HOST_PRIVATE_TOKEN', 'X-Custom': 'HOST_PRIVATE_VALUE' } });
    const host = useSettingsStore.getState().imageHostSettings;
    expect(secretRefFromToken(host.extraHeaders.Authorization)?.namespace).toBe('image-host');
    expect(secretRefFromToken(host.extraHeaders['X-Custom'])?.namespace).toBe('image-host');
    expect(JSON.stringify(host)).not.toContain('HOST_PRIVATE');
    expect(await fake.get(secretRefFromToken(host.extraHeaders.Authorization)!)).toBe('Bearer HOST_PRIVATE_TOKEN');
    await vi.waitFor(() => {
      const persisted = channelPersistenceStorage.getItem('settings-storage');
      expect(persisted).toContain('uploads.example/custom');
      expect(persisted).not.toContain('HOST_PRIVATE');
    });
  });
});
