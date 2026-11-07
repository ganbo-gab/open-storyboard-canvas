import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCustomProvidersStore, type CustomProviderConfig } from '@/stores/customProvidersStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useMemorySecretVault, revealChannelCredential } from '@/features/secrets/testSupport';
import { secretRefFromToken, secretStore } from '@/features/secrets/secretStore';
import { channelPersistenceStorage } from '../store/channelPersistence';
import { getChannelCredentialRef, getChannelCredentialState, migrateLegacyProviders, replaceChannelCredentials, useChannelStore } from '../store/channelStore';
import { describeChannelMigrationIssues } from '../application/channelMigrationIssues';
import { migrateAgnesSettingsCredential } from '../runtime/agnesChannel';

useMemorySecretVault();
const persisted = new Map<string, string>();
const provider = (id: string, patch: Partial<CustomProviderConfig> = {}): CustomProviderConfig => ({
  id, label: `旧渠道 ${id}`, apiKey: `${id}-PRIVATE_KEY`, baseUrl: 'https://relay.example.test/v1',
  endpointPath: '/images/generations', apiStyle: 'openai-compatible', models: ['image-a'], supportsWebSearch: false,
  ...patch,
});

beforeEach(async () => {
  persisted.clear();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => persisted.get(key) ?? null,
    setItem: (key: string, value: string) => { persisted.set(key, value); },
    removeItem: (key: string) => { persisted.delete(key); },
  });
  await useCustomProvidersStore.persist.rehydrate();
  await useChannelStore.persist.rehydrate();
  await useSettingsStore.persist.rehydrate();
  replaceChannelCredentials({});
  useChannelStore.setState({ channels: [], migratedLegacyIds: [] });
  useCustomProvidersStore.setState({ providers: [] });
  useSettingsStore.setState({ apiKeys: {}, agnesApiKey: '', isHydrated: false });
});
afterEach(() => { vi.unstubAllGlobals(); });

async function expectNoPlaintext(values: string[]): Promise<void> {
  await vi.waitFor(() => {
    for (const raw of persisted.values()) for (const value of values) expect(raw).not.toContain(value);
  });
  const state = JSON.stringify([useChannelStore.getState(), useCustomProvidersStore.getState(), useSettingsStore.getState()]);
  for (const value of values) expect(state).not.toContain(value);
}

describe('settings and channel migration acceptance', () => {
  it('hydrates legacy HTTP, chat and dedicated-adapter providers with usable vault refs and explicit loss details', async () => {
    const http = provider('acceptance-lossy', {
      baseUrl: 'https://relay.example.test/v1?api-version=2024#setup',
      responseFormat: 'generic', models: ['image-a', 'image-a', ''],
      extraHeaders: { Authorization: 'Bearer SECOND_PRIVATE_KEY' },
      modelMetadata: { 'image-a': { contextWindow: 16000 } },
      extraParams: { vendorExtension: { audit: true } },
    });
    const chat = provider('acceptance-chat', { mediaType: 'chat', endpointPath: '/chat/completions', models: ['chat-a'] });
    const comfy = provider('acceptance-comfy', { apiStyle: 'comfyui', baseUrl: 'http://127.0.0.1:8188', models: ['workflow'],
      extraParams: { comfyui: { comfyOrgKey: 'COMFY_PARTNER_PRIVATE_KEY' } } });
    const signed = provider('acceptance-signed', { apiStyle: 'generic-json', extraParams: { transport: 'signed' } });
    const inputs = [http, chat, comfy, signed];
    channelPersistenceStorage.setItem('custom-providers-storage', JSON.stringify({ version: 0, state: { providers: inputs } }));
    channelPersistenceStorage.setItem('legacy_custom_providers_raw', JSON.stringify(inputs));
    await useCustomProvidersStore.persist.rehydrate();
    await vi.waitFor(() => expect(useChannelStore.getState().channels.map((entry) => entry.profile.id).sort())
      .toEqual([http.id, chat.id, signed.id].sort()));

    const record = useChannelStore.getState().channels.find((entry) => entry.profile.id === http.id)!;
    expect(record.origin).toBe('native');
    expect(record.profile.models.map((model) => model.id)).toEqual(['image-a']);
    expect(record.profile.operations['image.generate']?.path).toContain('api-version=2024');
    expect(record.profile.operations['image.generate']?.path).not.toContain('#setup');
    expect(record.profile.headers?.Authorization).toBeUndefined();
    const details = describeChannelMigrationIssues(record);
    expect(details).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'baseUrl', kind: 'converted' }),
      expect.objectContaining({ path: 'extraHeaders.Authorization', kind: 'dropped' }),
      expect.objectContaining({ path: 'extraParams.vendorExtension', kind: 'dropped' }),
      expect.objectContaining({ path: 'modelMetadata', kind: 'dropped' }),
      expect.objectContaining({ path: 'models[1]', kind: 'dropped' }),
      expect.objectContaining({ path: 'models[2]', kind: 'dropped' }),
      expect.objectContaining({ path: 'responseFormat', kind: 'unsupported' }),
    ]));
    for (const issue of details) {
      expect(issue.detail.length).toBeGreaterThan(0);
      expect(Object.keys(issue).sort()).toEqual(['detail', 'kind', 'path']);
    }
    expect(details.some((issue) => /credentialRef|credentialState|apiKey/.test(issue.path))).toBe(false);
    expect(useChannelStore.getState().channels.find((entry) => entry.profile.id === signed.id)).toMatchObject({
      profile: { operations: {} }, migrationIssues: expect.arrayContaining([expect.objectContaining({ key: 'apiStyle', kind: 'unsupported' })]),
    });
    for (const input of [http, chat, signed]) {
      expect(getChannelCredentialRef(input.id)).toBeTruthy();
      expect(getChannelCredentialState(input.id)).toBe('present');
      expect(await revealChannelCredential(input.id)).toBe(input.apiKey);
    }
    const special = useCustomProvidersStore.getState().providers.find((entry) => entry.id === comfy.id)!;
    expect(special.apiStyle).toBe('comfyui');
    const specialRef = secretRefFromToken(special.apiKey);
    expect(specialRef).not.toBeNull();
    expect(await secretStore.reveal(specialRef!)).toBe(comfy.apiKey);
    expect(useChannelStore.getState().channels.some((entry) => entry.profile.id === comfy.id)).toBe(false);
    await expectNoPlaintext([...inputs.map((input) => input.apiKey), 'SECOND_PRIVATE_KEY', 'COMFY_PARTNER_PRIVATE_KEY']);
    await vi.waitFor(() => expect(channelPersistenceStorage.getItem('legacy_custom_providers')).toContain('vendorExtension'));
    const backup = channelPersistenceStorage.getItem('legacy_custom_providers')!;
    expect(backup).toContain('audit');
    const originals = JSON.parse(backup) as CustomProviderConfig[];
    expect(originals.map((entry) => entry.id).sort()).toEqual(inputs.map((entry) => entry.id).sort());
    const headerRef = secretRefFromToken(originals.find((entry) => entry.id === http.id)!.extraHeaders!.Authorization);
    expect(headerRef).not.toBeNull();
    expect(await secretStore.reveal(headerRef!)).toBe('Bearer SECOND_PRIVATE_KEY');
    const partner = originals.find((entry) => entry.id === comfy.id)!.extraParams!.comfyui as { comfyOrgKey: string };
    const partnerRef = secretRefFromToken(partner.comfyOrgKey);
    expect(partnerRef).not.toBeNull();
    expect(await secretStore.reveal(partnerRef!)).toBe('COMFY_PARTNER_PRIVATE_KEY');

    const first = structuredClone(useChannelStore.getState().channels);
    // Reopening persisted settings starts after queued vault/config writes have committed.
    await vi.waitFor(() => {
      const saved = JSON.parse(channelPersistenceStorage.getItem('channels-v2-storage')!) as { state: { channels: unknown[] } };
      expect(saved.state.channels).toEqual(first);
    });
    migrateLegacyProviders(inputs);
    await useChannelStore.persist.rehydrate();
    await vi.waitFor(() => expect(useChannelStore.getState().channels).toEqual(first));
    expect(describeChannelMigrationIssues(useChannelStore.getState().channels.find((entry) => entry.profile.id === http.id)!)).toEqual(details);
    expect(await revealChannelCredential(http.id)).toBe(http.apiKey);
    await expectNoPlaintext(inputs.map((input) => input.apiKey));
  });

  it.each([
    { name: 'single apiKey', version: 0, state: { apiKey: 'OLD_SINGLE_PRIVATE_KEY' }, expected: { ppio: 'OLD_SINGLE_PRIVATE_KEY' } },
    { name: 'provider-key map', version: 21, state: { apiKeys: { ppio: 'OLD_PPIO_PRIVATE_KEY', grsai: 'OLD_GRSAI_PRIVATE_KEY' } },
      expected: { ppio: 'OLD_PPIO_PRIVATE_KEY', grsai: 'OLD_GRSAI_PRIVATE_KEY' } },
  ])('hydrates $name settings, preserves preferences and migrates Agnes into real channels', async ({ version, state, expected }) => {
    channelPersistenceStorage.setItem('settings-storage', JSON.stringify({ version, state: {
      ...state, agnesApiKey: 'OLD_AGNES_PRIVATE_KEY', promptDefaultLanguage: 'en', enableAiTextStreaming: false,
      canvasMouseBindingPreset: 'custom', canvasMouseBindings: { leftDrag: 'panCanvas' },
      showNodePrice: true, priceDisplayCurrencyMode: 'cny',
    } }));
    await useSettingsStore.persist.rehydrate();
    await vi.waitFor(() => expect(useSettingsStore.getState().isHydrated).toBe(true));
    const settings = useSettingsStore.getState();
    expect(settings).toMatchObject({ promptDefaultLanguage: 'en', enableAiTextStreaming: false,
      canvasLeftDragMode: 'select', canvasWheelMode: 'auto' });
    for (const [id, value] of Object.entries(expected)) {
      const ref = secretRefFromToken(settings.apiKeys[id]);
      expect(ref).not.toBeNull();
      expect(await secretStore.reveal(ref!)).toBe(value);
    }
    migrateAgnesSettingsCredential(settings.agnesApiKey);
    await vi.waitFor(() => expect(useChannelStore.getState().channels.filter((entry) => entry.profile.id.startsWith('settings-agnes-'))).toHaveLength(3));
    for (const media of ['image', 'video', 'chat']) {
      expect(await revealChannelCredential(`settings-agnes-${media}`)).toBe('OLD_AGNES_PRIVATE_KEY');
    }
    const video = useChannelStore.getState().channels.find((entry) => entry.profile.id === 'settings-agnes-video')!;
    expect(describeChannelMigrationIssues(video)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'supportedResolutions', kind: 'converted' }),
      expect.objectContaining({ path: 'referenceImages', kind: 'unsupported' }),
      expect.objectContaining({ path: 'frame_rate', kind: 'unsupported' }),
    ]));
    expect(video.profile.models[0].refs?.image).toBe(0);
    await expectNoPlaintext([...Object.values(expected), 'OLD_AGNES_PRIVATE_KEY']);
    await vi.waitFor(() => {
      const saved = JSON.parse(channelPersistenceStorage.getItem('settings-storage')!) as { state: Record<string, unknown> };
      expect(saved.state).not.toHaveProperty('canvasMouseBindingPreset');
      expect(saved.state).not.toHaveProperty('canvasMouseBindings');
      expect(saved.state).not.toHaveProperty('showNodePrice');
      expect(saved.state).not.toHaveProperty('priceDisplayCurrencyMode');
    });
    const channels = structuredClone(useChannelStore.getState().channels);
    await useSettingsStore.persist.rehydrate();
    migrateAgnesSettingsCredential(useSettingsStore.getState().agnesApiKey);
    expect(useChannelStore.getState().channels).toEqual(channels);
    expect(await revealChannelCredential('settings-agnes-chat')).toBe('OLD_AGNES_PRIVATE_KEY');
  });

  it('describes unclassified older issue records conservatively without exposing legacy field values or mutating records', () => {
    const record = { migrationIssues: [{ key: 'vendor.oldFlag', reason: 'This setting requires manual review.', value: 'PRIVATE_LEGACY_VALUE' }] };
    const before = structuredClone(record);
    const details = describeChannelMigrationIssues(record);
    expect(details).toEqual([{ path: 'vendor.oldFlag', kind: 'unsupported', detail: 'This setting requires manual review.' }]);
    expect(JSON.stringify(details)).not.toContain('PRIVATE_LEGACY_VALUE');
    expect(record).toEqual(before);
    details[0].detail = 'Changed by a consumer';
    expect(record).toEqual(before);
  });
});
