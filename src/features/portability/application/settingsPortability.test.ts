import { afterEach, describe, expect, it } from 'vitest';
import { useCustomProvidersStore } from '@/stores/customProvidersStore';
import { usePromptLibraryStore } from '@/stores/promptLibraryStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useThemeStore } from '@/stores/themeStore';
import {
  applySettingsBundle,
  assertSettingsBundleSize,
  buildSettingsBundle,
  previewSettingsImport,
  scanSensitiveSettingsExport,
  serializeSettingsBundle,
} from './settingsPortability';
import { SETTINGS_BUNDLE_MAX_BYTES } from './types';

const originalSettings = useSettingsStore.getState();
const originalProviders = useCustomProvidersStore.getState();
const originalPromptLibrary = usePromptLibraryStore.getState();
const originalTheme = useThemeStore.getState();

afterEach(() => {
  useSettingsStore.setState(originalSettings, true);
  useCustomProvidersStore.setState(originalProviders, true);
  usePromptLibraryStore.setState(originalPromptLibrary, true);
  useThemeStore.setState(originalTheme, true);
});

describe('settings portability security', () => {
  it('excludes every credential, Dreamina session, and machine path by default', () => {
    useSettingsStore.setState({
      apiKeys: { grsai: 'secret-built-in-key' },
      agnesApiKey: 'secret-agnes-key',
      dreaminaDefaultSessionId: 88,
      downloadPresetPaths: ['/Users/test/Downloads'],
      imageHostSettings: {
        ...originalSettings.imageHostSettings,
        seedvault: {
          ...originalSettings.imageHostSettings.seedvault,
          email: 'person@example.com',
          password: 'secret-password',
          token: 'secret-token',
        },
      },
    });
    useCustomProvidersStore.setState({
      providers: [{
        id: 'custom',
        label: 'Custom',
        baseUrl: 'https://example.com',
        apiKey: 'secret-custom-key',
        apiStyle: 'generic-json',
        models: ['model'],
        supportsWebSearch: false,
        extraHeaders: {
          Authorization: 'Bearer secret-header',
          'X-Client': 'portable',
        },
        extraParams: {
          accessToken: 'secret-nested-token',
          cachePath: '/Users/test/cache',
          volumePath: '/Volumes/Studio/cache',
          mountPath: '/mnt/storyboards',
          installPath: '/opt/storyboard/bin',
          networkPath: '\\\\server\\share\\file',
          resultEndpointPath: '/v1/tasks/{taskId}',
        },
      }],
    });

    const serialized = serializeSettingsBundle(false);
    expect(scanSensitiveSettingsExport(serialized)).toEqual([]);
    expect(serialized).not.toContain('secret-');
    expect(serialized).not.toContain('/Users/test');
    expect(serialized).not.toContain('/Volumes/Studio');
    expect(serialized).not.toContain('/mnt/storyboards');
    expect(serialized).not.toContain('/opt/storyboard');
    expect(serialized).not.toContain('server\\\\share');
    expect(serialized).toContain('/v1/tasks/{taskId}');
    expect(serialized).not.toContain('dreaminaDefaultSessionId');
    expect(buildSettingsBundle(false).credentials).toBeUndefined();
  });

  it('only adds explicit credential fields when requested', () => {
    useSettingsStore.setState({ apiKeys: { grsai: 'key' }, agnesApiKey: 'agnes' });
    const bundle = buildSettingsBundle(true);
    expect(bundle.includesCredentials).toBe(true);
    expect(bundle.credentials?.providerApiKeys).toEqual({ grsai: 'key' });
    expect(bundle.credentials?.agnesApiKey).toBe('agnes');
    expect(JSON.stringify(bundle)).not.toContain('dreaminaDefaultSessionId');
  });

  it('covers audio, video-provider, and portable download preferences', () => {
    useSettingsStore.setState({
      downloadPresetPaths: ['relative/downloads', '/Users/test/Downloads'],
      audioGenerationSettings: {
        ...originalSettings.audioGenerationSettings,
        defaultOutputMode: 'segmented',
        defaultTimeoutMs: 240000,
      },
    });
    useCustomProvidersStore.setState({
      providers: [{
        id: 'video-provider',
        label: 'Video Provider',
        mediaType: 'video',
        baseUrl: 'https://video.example.com/v1',
        endpointPath: '/videos',
        apiKey: '',
        apiStyle: 'openai-compatible',
        models: ['video-model'],
        supportsWebSearch: false,
        extraParams: { defaultRequestParams: { duration: 8 } },
      }],
    });

    const bundle = buildSettingsBundle(false);
    expect(bundle.categories.general.downloadPresetPaths).toEqual(['relative/downloads']);
    expect(bundle.categories.models.audioGenerationSettings).toMatchObject({
      defaultOutputMode: 'segmented',
      defaultTimeoutMs: 240000,
    });
    expect(bundle.categories.providers.items).toEqual([
      expect.objectContaining({
        id: 'video-provider',
        mediaType: 'video',
        extraParams: { defaultRequestParams: { duration: 8 } },
      }),
    ]);
  });

  it('round-trips retired text Agent settings as compatibility data', () => {
    const legacyAgent = {
      id: 'legacy-agent-a',
      name: 'Legacy formatter',
      enabled: true,
      prompt: 'Return structured storyboard JSON.',
      defaultModel: 'custom:chat:model-a',
      inputSources: [{
        id: 'legacy-source-a',
        type: 'json' as const,
        label: 'Previous result',
        sourceAgentId: 'legacy-agent-b',
        jsonPath: '$.shots',
        enabled: true,
      }],
      jsonExample: '{"shots":[]}',
      jsonFields: [{ id: 'field-a', path: '$.shots', label: 'Shots', enabled: true }],
      createdAt: 1,
      updatedAt: 2,
    };
    useSettingsStore.setState({ textAgents: [legacyAgent] });
    const bundle = buildSettingsBundle(false);
    expect(bundle.categories.prompts.textAgents).toEqual([legacyAgent]);

    useSettingsStore.setState({ textAgents: [] });
    applySettingsBundle(bundle, new Set(['prompts']));
    expect(useSettingsStore.getState().textAgents).toEqual([legacyAgent]);
  });

  it('rejects oversized settings text before JSON parsing', () => {
    expect(() => assertSettingsBundleSize('x'.repeat(SETTINGS_BUNDLE_MAX_BYTES + 1))).toThrow(/16 MB/i);
  });

  it('rejects invalid setting types and provider structures without mutating stores', () => {
    useSettingsStore.setState({ useUploadFilenameAsNodeTitle: true });
    useCustomProvidersStore.setState({ providers: [] });
    const invalidSetting = buildSettingsBundle(false);
    invalidSetting.categories.general.useUploadFilenameAsNodeTitle = 'yes';
    expect(() => applySettingsBundle(invalidSetting, new Set(['general']))).toThrow(/must be boolean/i);
    expect(useSettingsStore.getState().useUploadFilenameAsNodeTitle).toBe(true);

    const invalidProvider = buildSettingsBundle(false);
    invalidProvider.categories.providers.items = [{
      id: 'bad',
      label: 'Bad',
      mediaType: 'document',
      baseUrl: 'https://example.com',
      apiStyle: 'generic-json',
      models: [42],
      supportsWebSearch: false,
    }];
    expect(() => applySettingsBundle(invalidProvider, new Set(['providers']))).toThrow(/mediaType|models/i);
    expect(useCustomProvidersStore.getState().providers).toEqual([]);
  });

  it('shows field-level before/after values while reducing credentials to counts', () => {
    useSettingsStore.setState({
      useUploadFilenameAsNodeTitle: true,
      apiKeys: { grsai: 'current-secret' },
      agnesApiKey: 'current-agnes',
    });
    const payload = buildSettingsBundle(true);
    payload.categories.general.useUploadFilenameAsNodeTitle = false;
    payload.credentials = {
      providerApiKeys: { grsai: 'incoming-secret' },
      agnesApiKey: 'incoming-agnes',
    };

    const diffs = previewSettingsImport(payload);
    expect(diffs.find((diff) => diff.category === 'general')?.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: 'useUploadFilenameAsNodeTitle',
        before: { kind: 'value', text: 'true' },
        after: { kind: 'value', text: 'false' },
      }),
    ]));
    expect(diffs.find((diff) => diff.category === 'credentials')?.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: 'providerApiKeys',
        before: { kind: 'credential', configuredCount: 1 },
        after: { kind: 'credential', configuredCount: 1 },
        sensitive: true,
      }),
    ]));
    expect(JSON.stringify(diffs)).not.toContain('current-secret');
    expect(JSON.stringify(diffs)).not.toContain('incoming-secret');
  });

  it('rolls every store back when applying one category fails', () => {
    useSettingsStore.setState({ useUploadFilenameAsNodeTitle: true });
    useCustomProvidersStore.setState({ providers: [] });
    usePromptLibraryStore.setState({ favoritePrompts: {} });
    useThemeStore.setState({
      theme: 'dark',
      setTheme: () => {
        throw new Error('theme apply failed');
      },
    });
    const payload = buildSettingsBundle(false);
    payload.categories.general.useUploadFilenameAsNodeTitle = false;
    payload.categories.appearance.theme = 'light';
    payload.categories.providers.items = [{
      id: 'imported',
      label: 'Imported',
      baseUrl: 'https://example.com',
      apiStyle: 'generic-json',
      models: ['model'],
      supportsWebSearch: false,
    }];
    payload.categories.prompts.favoritePrompts = {
      imported: {
        id: 'imported',
        title: 'Imported',
        prompt: 'Prompt',
        excerpt: 'Prompt',
        category: 'Test',
        source: 'Local',
        tags: [],
        coverUrl: 'https://example.com/cover.png',
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        origin: 'local',
      },
    };

    expect(() => applySettingsBundle(
      payload,
      new Set(['general', 'appearance', 'providers', 'prompts'])
    )).toThrow('theme apply failed');
    expect(useSettingsStore.getState().useUploadFilenameAsNodeTitle).toBe(true);
    expect(useCustomProvidersStore.getState().providers).toEqual([]);
    expect(usePromptLibraryStore.getState().favoritePrompts).toEqual({});
    expect(useThemeStore.getState().theme).toBe('dark');
  });
});
