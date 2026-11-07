import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_IMAGE_HOST_SETTINGS, imageHostConfigurationError, importedImageHostSettings, normalizeImageHostSettings, retireImageHostStorage, type ImageHostSettings } from './imageHostSettings';
import { createSecretStorage } from '@/features/secrets/credentialMigration';
import { createSecretStore } from '@/features/secrets/secretStore';
import { useSettingsStore } from '@/stores/settingsStore';

describe('custom image host configuration and retirement', () => {
  it('starts disabled with no default external address', () => {
    expect(DEFAULT_IMAGE_HOST_SETTINGS).toMatchObject({ version: 2, enabled: false, uploadUrl: '', extraHeaders: {} });
    expect(normalizeImageHostSettings(undefined)).toEqual(DEFAULT_IMAGE_HOST_SETTINGS);
  });
  it.each(['pixhost', 'seedvault'] as const)('disables the old %s provider in migrations and same-version hydration', async (provider) => {
    const old = { enabled: true, provider, pixhost: { apiBaseUrl: 'https://api.pixhost.to' },
      seedvault: { apiBaseUrl: 'https://img.seedvault.cn/api/v1', email: 'private@example.test', password: 'OLD_PASSWORD', token: 'OLD_TOKEN' } };
    const normalized = normalizeImageHostSettings(old);
    expect(normalized).toMatchObject({ enabled: false, uploadUrl: '', migrationNotice: 'retired-provider' });
    expect(JSON.stringify(normalized)).not.toMatch(/OLD_PASSWORD|OLD_TOKEN|private@example/);
    const options = useSettingsStore.persist.getOptions();
    expect(await options.migrate?.({ imageHostSettings: old }, 25)).toMatchObject({ imageHostSettings: normalized });
    expect(options.merge?.({ imageHostSettings: old }, useSettingsStore.getInitialState())).toMatchObject({ imageHostSettings: normalized });
  });
  it('keeps a custom legacy endpoint as a disabled reviewable draft without accounts or query credentials', () => {
    const migrated = normalizeImageHostSettings({ enabled: true, provider: 'seedvault', seedvault: {
      apiBaseUrl: 'https://user:password@uploads.example/api?token=OLD_TOKEN', token: 'OLD_TOKEN', password: 'OLD_PASSWORD' } });
    expect(migrated).toMatchObject({ enabled: false, uploadUrl: 'https://uploads.example/api/upload', fileField: 'file', responseUrlPath: 'data.links.url',
      migrationNotice: 'custom-endpoint', legacyDraft: { provider: 'seedvault', endpoint: 'https://uploads.example/api' }, extraHeaders: {} });
    expect(JSON.stringify(migrated)).not.toMatch(/OLD_TOKEN|OLD_PASSWORD|user:password/);
  });
  it('retains explicitly saved current configurations but disables imported ones', () => {
    const settings = { ...DEFAULT_IMAGE_HOST_SETTINGS, enabled: true, uploadUrl: 'https://uploads.example/send' };
    expect(normalizeImageHostSettings(settings)).toEqual(settings);
    expect(importedImageHostSettings(settings)).toMatchObject({ enabled: false, migrationNotice: 'imported', uploadUrl: settings.uploadUrl });
    expect(imageHostConfigurationError(settings)).toBeNull();
  });
  it('rejects invalid paths and headers before upload', () => {
    const settings = { ...DEFAULT_IMAGE_HOST_SETTINGS, enabled: true, uploadUrl: 'https://uploads.example/send' };
    const invalid: Partial<ImageHostSettings>[] = [{ uploadUrl: '' }, { uploadUrl: 'https://user:secret@uploads.example/send' }, { fileField: '' },
      { responseUrlPath: 'data..url' }, { extraHeaders: { 'Content-Type': 'multipart/form-data' } }, { extraHeaders: { Authorization: 'token\r\ninjected: value' } }];
    for (const patch of invalid) {
      expect(imageHostConfigurationError({ ...settings, ...patch })).not.toBeNull();
    }
    expect(imageHostConfigurationError({ ...settings, responseUrlPath: '$.data.images[0].url' })).toBeNull();
  });
  it('removes retired login values before generic credential migration without deleting existing media or writing the vault', async () => {
    let raw = JSON.stringify({ version: 25, state: { imageHostSettings: { enabled: true, provider: 'seedvault',
      seedvault: { apiBaseUrl: 'https://img.seedvault.cn/api/v1', password: 'OLD_PASSWORD', token: 'OLD_TOKEN' } },
      lastModelConfigByPanel: { image: { entryId: 'keep-model', ratio: '1:1' } } } });
    const backend = { get: vi.fn(async () => null), set: vi.fn(async () => {}), delete: vi.fn(async () => {}), has: vi.fn(async () => false) };
    const storage = createSecretStorage(retireImageHostStorage({ getItem: () => raw, setItem: (_key, value) => { raw = value; }, removeItem: vi.fn() }), 'settings', createSecretStore(backend));
    const restored = await storage.getItem('settings-storage');
    expect(restored).not.toMatch(/OLD_PASSWORD|OLD_TOKEN/);
    expect(raw).not.toMatch(/OLD_PASSWORD|OLD_TOKEN/);
    expect(raw).toContain('keep-model');
    expect(backend.set).not.toHaveBeenCalled();
    expect(backend.delete).not.toHaveBeenCalled();
  });
});
