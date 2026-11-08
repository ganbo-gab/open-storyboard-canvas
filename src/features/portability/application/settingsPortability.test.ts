import { DEFAULT_CANVAS_MOUSE_BINDINGS } from '@/features/settings/canvasMouseSettings';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useCustomProvidersStore } from '@/stores/customProvidersStore';
import { usePromptLibraryStore } from '@/stores/promptLibraryStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useThemeStore } from '@/stores/themeStore';
import type { ChannelProfileV2 } from '@/features/channels/domain/profile';
import type { ComfyUIWorkflowCollection } from '@/features/channels/application/comfyWorkflows';
import { useChannelStore, getChannelCredential, snapshotChannelCredentials, replaceChannelCredentials } from '@/features/channels/store/channelStore';
import { channelPersistenceStorage } from '@/features/channels/store/channelPersistence';
import { secretRefFromToken, secretToken } from '@/features/secrets/secretStore';
import {
  applySettingsBundle,
  assertSettingsBundleSize,
  buildSettingsBundle,
  parseSettingsBundle,
  previewSettingsImport,
  scanSensitiveSettingsExport,
  serializeSettingsBundle,
} from './settingsPortability';
import { SETTINGS_BUNDLE_MAX_BYTES } from './types';

const originalSettings = useSettingsStore.getState();
const originalProviders = useCustomProvidersStore.getState();
const originalPromptLibrary = usePromptLibraryStore.getState();
const originalTheme = useThemeStore.getState();
const originalChannels = useChannelStore.getState();
const originalCredentials = snapshotChannelCredentials();
const backupNames = ['legacy_custom_providers', 'legacy_custom_providers_raw'];
const originalBackups = backupNames.map((name) => ({ name, value: channelPersistenceStorage.getItem(name) }));

function profile(id: string): ChannelProfileV2 {
  return { version: 2, id, name: id, baseUrl: 'https://example.com', auth: { type: 'header', name: 'X-Api-Key' },
    operations: { chat: { method: 'POST', path: '/v1/chat/completions', body: 'json',
      template: { model: '{{model}}', messages: '{{messages}}', max_tokens: '{{param.max_tokens}}' },
      response: { mode: 'sync', outputs: [{ path: 'choices[0].message.content', as: 'url' }] } } },
    models: [{ id: 'model', operations: ['chat'], params: [{ key: 'max_tokens', label: 'Max tokens', type: 'number', default: 1024 }] }] };
}

/** Fixed record fixtures never call the credential backend or a provider. */
function createChannel(input: ChannelProfileV2, token = ''): void {
  const credentialRef = secretRefFromToken(token);
  useChannelStore.setState((state) => ({ channels: [...state.channels, {
    profile: input, origin: 'native', migrationIssues: [], createdAt: 1, updatedAt: 2,
    ...(credentialRef ? { credentialRef } : {}),
  }] }));
  if (credentialRef) replaceChannelCredentials({ ...snapshotChannelCredentials(), [input.id]: token });
}

beforeEach(() => {
  for (const name of backupNames) channelPersistenceStorage.removeItem(name);
  useChannelStore.setState({ channels: [], migratedLegacyIds: [] });
  replaceChannelCredentials({});
  useCustomProvidersStore.setState({ providers: [] });
});

afterEach(() => {
  useSettingsStore.setState(originalSettings, true);
  for (const { name, value } of originalBackups) {
    if (value === null) channelPersistenceStorage.removeItem(name); else channelPersistenceStorage.setItem(name, value);
  }
  useChannelStore.setState(originalChannels, true);
  replaceChannelCredentials(originalCredentials);
  useCustomProvidersStore.setState(originalProviders, true);
  usePromptLibraryStore.setState(originalPromptLibrary, true);
  useThemeStore.setState(originalTheme, true);
});

describe('settings portability security', () => {
  it('imports a current custom host as a disabled draft with references only', () => {
    const reference = secretToken({ namespace: 'image-host', id: 'custom/header' });
    const bundle = buildSettingsBundle();
    bundle.categories.imageHosting = { ...originalSettings.imageHostSettings, enabled: true,
      uploadUrl: 'https://uploads.example/custom', fileField: 'picture', responseUrlPath: 'result.url',
      extraHeaders: { Authorization: reference, 'X-Unknown-Credential': 'sentinel-raw-header', 'X-Unusual': 'sentinel-custom-header' } };
    const parsed = parseSettingsBundle(JSON.stringify(bundle));
    expect(JSON.stringify(parsed)).not.toContain('sentinel-');
    applySettingsBundle(parsed, new Set(['imageHosting']));
    expect(useSettingsStore.getState().imageHostSettings).toMatchObject({ enabled: false, uploadUrl: 'https://uploads.example/custom',
      fileField: 'picture', responseUrlPath: 'result.url', migrationNotice: 'imported', extraHeaders: { Authorization: reference, 'X-Unusual': '' } });
  });
  it('excludes every credential, Dreamina session, and machine path by default', () => {
    useSettingsStore.setState({
      apiKeys: { grsai: 'secret-built-in-key' },
      agnesApiKey: 'secret-agnes-key',
      dreaminaDefaultSessionId: 88,
      downloadPresetPaths: ['/Users/test/Downloads'],
      imageHostSettings: {
        ...originalSettings.imageHostSettings,
        uploadUrl: 'https://uploads.example/images',
        extraHeaders: { Authorization: 'secret-token', 'X-Custom': 'secret-password' },
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

    const native = profile('native-paths');
    native.operations.chat!.path = '/v1/tasks/{taskId}';
    createChannel(native, secretToken({ namespace: 'channel', id: native.id }));
    const serialized = serializeSettingsBundle();
    expect(scanSensitiveSettingsExport(serialized)).toEqual([]);
    expect(serialized).not.toContain('secret-');
    expect(serialized).not.toContain('/Users/test');
    expect(serialized).not.toContain('/Volumes/Studio');
    expect(serialized).not.toContain('/mnt/storyboards');
    expect(serialized).not.toContain('/opt/storyboard');
    expect(serialized).not.toContain('server\\\\share');
    expect(serialized).toContain('/v1/tasks/{taskId}');
    expect(serialized).not.toContain('dreaminaDefaultSessionId');
    expect(buildSettingsBundle()).not.toHaveProperty('credentials');
  });

  it('has no credential opt-in and discards even malformed legacy credential sections', () => {
    useSettingsStore.setState({ apiKeys: { grsai: 'sentinel-built-in-key' }, agnesApiKey: 'sentinel-agnes-key' });
    const bundle = buildSettingsBundle();
    expect(bundle.includesCredentials).toBe(false);
    expect(bundle).not.toHaveProperty('credentials');
    for (const credentials of [
      { providerApiKeys: { grsai: 'sentinel-import-key' }, agnesApiKey: 'sentinel-import-agnes' },
      { legacyProviderBackups: { old: '{"apiKey":"sentinel-backup-key"}' } },
      { imageHost: { token: ['sentinel-malformed-token'] } },
    ]) {
      const parsed = parseSettingsBundle(JSON.stringify({ ...bundle, includesCredentials: true, credentials }));
      expect(parsed.includesCredentials).toBe(false);
      expect(parsed).not.toHaveProperty('credentials');
      expect(JSON.stringify(parsed)).not.toContain('sentinel-');
      applySettingsBundle(parsed, new Set(['credentials']));
    }
    expect(useSettingsStore.getState().apiKeys.grsai).toBe('sentinel-built-in-key');
  });

  it('redacts nested legacy provider, ComfyUI, image-host and agent-model fixtures while preserving refs', () => {
    const providerRef = { namespace: 'comfyui' as const, id: 'comfy-fixture' };
    const modelRef = { namespace: 'agent-model' as const, id: 'agent-fixture' };
    const tokenRef = { namespace: 'image-host' as const, id: 'custom-header' };
    useCustomProvidersStore.setState({ providers: [{
      id: 'comfy-fixture', label: 'Comfy', apiStyle: 'comfyui', models: ['workflow'], supportsWebSearch: false,
      baseUrl: 'https://user:sentinel-url-password@comfy.example?api_key=sentinel-url-key&mode=portable',
      apiKey: 'sentinel-provider-key', credentialRef: providerRef,
      extraHeaders: { Authorization: 'Bearer sentinel-header', 'X-Access-Key': 'sentinel-header-key', 'X-Client': 'portable' },
      queryParams: { access_token: 'sentinel-query-token', key: 'sentinel-query-key', format: 'json' },
      extraParams: {
        comfyui: { password: 'sentinel-comfy-password', token: 'sentinel-comfy-token', credentialRef: providerRef },
        workflow: JSON.stringify({ nested: { apiKey: 'sentinel-workflow-key' }, headers: [{ name: 'Authorization', value: 'sentinel-entry-header' }] }),
      },
    }] });
    useSettingsStore.setState({
      lastModelConfigByPanel: {
        text: { entryId: 'portable-model', ratio: '1:1', extraParams: {
          agents: [{ apiKey: 'sentinel-agent-key', credentialRef: modelRef }],
          request: { url: 'https://agent.example/run?access_token=sentinel-agent-url&mode=portable', max_tokens: 2048 },
        } },
      },
      imageHostSettings: {
        ...originalSettings.imageHostSettings,
        uploadUrl: 'https://images.example/upload?authorization=sentinel-image-url',
        extraHeaders: { Authorization: secretToken(tokenRef), 'X-Custom': 'sentinel-image-token' },
      },
    });
    const native = profile('channel-fixture');
    native.operations.chat!.template = { messages: '{{messages}}', api_key: 'sentinel-channel-key' };
    native.headers = { Authorization: 'Bearer sentinel-channel-header', 'X-Client': 'portable' };
    createChannel(native, secretToken({ namespace: 'channel', id: native.id }));
    useChannelStore.setState((state) => ({ channels: state.channels.map((record) => ({
      ...record, migrationIssues: [{ key: 'extraParams.apiKey', value: 'sentinel-migration-key', reason: 'Unsupported' }],
    })) }));
    channelPersistenceStorage.setItem('legacy_custom_providers', JSON.stringify([{
      id: 'old-backup', apiKey: 'sentinel-old-backup-key', extraParams: { password: 'sentinel-old-backup-password' },
    }]));
    const serialized = serializeSettingsBundle();
    expect(serialized).not.toContain('sentinel-');
    expect(scanSensitiveSettingsExport(serialized)).toEqual([]);
    const bundle = parseSettingsBundle(serialized);
    expect(bundle.categories.providers.items).toEqual([expect.objectContaining({ credentialRef: providerRef })]);
    expect(bundle.categories.providers.channels).toEqual([expect.objectContaining({
      credentialRef: { namespace: 'channel', id: native.id },
      profile: expect.objectContaining({ headers: { 'X-Client': 'portable' } }),
    })]);
    expect(bundle.categories.imageHosting.extraHeaders).toEqual({ Authorization: secretToken(tokenRef), 'X-Custom': '' });
    expect(JSON.stringify(bundle.categories.models)).toContain(JSON.stringify(modelRef));
    expect(serialized).toContain('max_tokens');
    expect(serialized).toContain('mode=portable');
    const legacy = JSON.parse(serialized) as Record<string, unknown>;
    legacy.includesCredentials = true;
    legacy.credentials = { legacyProviderBackups: { old: '{"apiKey":"sentinel-encoded-import"}' } };
    expect(JSON.stringify(parseSettingsBundle(JSON.stringify(legacy)))).not.toContain('sentinel-');
  });

  it('imports old nested settings as redacted configuration and ref-only credentials', () => {
    const providerRef = { namespace: 'comfyui' as const, id: 'imported-comfy' };
    const modelRef = { namespace: 'agent-model' as const, id: 'imported-agent' };
    const passwordRef = { namespace: 'image-host' as const, id: 'imported-password' };
    const tokenRef = { namespace: 'image-host' as const, id: 'imported-token' };
    const legacy = { ...buildSettingsBundle(), schemaVersion: 1, createdAt: '1970-01-01T00:00:00.000Z',
      includesCredentials: true, credentials: { providerApiKeys: { old: 'sentinel-old-section' } } };
    legacy.categories.general.apiKeys = { old: 'sentinel-nested-settings-key' };
    legacy.categories.models.lastModelConfigByPanel = {
      text: { entryId: 'model', ratio: '1:1', extraParams: {
        agentModel: { apiKey: 'sentinel-old-agent-key', credentialRef: modelRef },
        backup: '{"token":"sentinel-old-model-backup"}',
      } },
    };
    legacy.categories.providers = { items: [{
      id: 'imported-comfy', label: 'Imported Comfy', baseUrl: 'http://localhost:8188',
      apiStyle: 'comfyui', models: ['workflow'], supportsWebSearch: false,
      apiKey: 'sentinel-old-comfy-key', credentialRef: providerRef,
      extraHeaders: { Authorization: 'sentinel-old-authorization' },
      queryParams: { access_token: 'sentinel-old-query-token' },
    }] };
    legacy.categories.imageHosting = {
      enabled: true, provider: 'seedvault', pixhost: { apiBaseUrl: 'https://api.pixhost.to', contentType: '0', maxThumbnailSize: '420' },
      seedvault: { apiBaseUrl: 'https://old-custom.example/api', strategyId: '', password: 'sentinel-old-image-password', token: 'sentinel-old-image-token', passwordRef, tokenRef },
    };
    const payload = parseSettingsBundle(JSON.stringify(legacy));
    expect(JSON.stringify(payload)).not.toContain('sentinel-');
    expect(payload).not.toHaveProperty('credentials');
    applySettingsBundle(payload, new Set(['general', 'models', 'providers', 'imageHosting', 'credentials']));
    expect(useCustomProvidersStore.getState().providers).toEqual([
      expect.objectContaining({ credentialRef: providerRef, apiKey: secretToken(providerRef) }),
    ]);
    expect(useSettingsStore.getState().imageHostSettings).toMatchObject({
      enabled: false, uploadUrl: 'https://old-custom.example/api/upload', extraHeaders: {}, migrationNotice: 'imported',
    });
    expect(useSettingsStore.getState().imageHostSettings).not.toHaveProperty('seedvault');
    expect(JSON.stringify(useSettingsStore.getState().lastModelConfigByPanel)).not.toContain('sentinel-');
    expect(serializeSettingsBundle()).not.toContain('sentinel-');
  });

  it('exports channel configuration and portable download preferences without retired audio settings', () => {
    useSettingsStore.setState({
      downloadPresetPaths: ['relative/downloads', '/Users/test/Downloads'],
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

    const bundle = buildSettingsBundle();
    expect(bundle.categories.general.downloadPresetPaths).toEqual(['relative/downloads']);
    expect(bundle.categories.models).not.toHaveProperty('audioGenerationSettings');
    expect(bundle.categories.providers.items).toEqual([]);
    expect(bundle.categories.providers.channels).toEqual([
      expect.objectContaining({ origin: 'native', profile: expect.objectContaining({
        id: 'video-provider', models: [expect.objectContaining({ id: 'video-model', operations: ['video.generate'] })],
        // Same endpoint as the legacy https://video.example.com/v1 + /videos.
        baseUrl: 'https://video.example.com',
        operations: expect.objectContaining({ 'video.generate': expect.objectContaining({ path: '/v1/videos' }) }),
      }) }),
    ]);
  });

  it('imports the supported parts of an older bundle without restoring retired audio adapters', () => {
    const legacy = buildSettingsBundle();
    legacy.categories.models.audioGenerationSettings = { models: [{ id: 'local-doubao-tts', enabled: true }], apiBaseUrl: 'http://old-audio.invalid' };
    legacy.categories.models.grsaiNanoBananaProModel = 'retained-model';
    const payload = parseSettingsBundle(JSON.stringify(legacy));
    expect(payload.categories.models).not.toHaveProperty('audioGenerationSettings');
    applySettingsBundle(payload, new Set(['models']));
    expect(useSettingsStore.getState()).not.toHaveProperty('audioGenerationSettings');
    expect(useSettingsStore.getState().grsaiNanoBananaProModel).toBe('retained-model');
    expect(buildSettingsBundle().categories.models).not.toHaveProperty('audioGenerationSettings');
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
    const bundle = buildSettingsBundle();
    expect(bundle.categories.prompts.textAgents).toEqual([legacyAgent]);

    useSettingsStore.setState({ textAgents: [] });
    applySettingsBundle(bundle, new Set(['prompts']));
    expect(useSettingsStore.getState().textAgents).toEqual([legacyAgent]);
  });

  it('round-trips Agent defaults and rejects malformed imported defaults without modifying settings', () => {
    useSettingsStore.getState().setAgentDefaults({ modelId: 'custom:local-fixture:chat', executionMode: 'auto' });
    const bundle = parseSettingsBundle(serializeSettingsBundle());
    useSettingsStore.getState().setAgentDefaults({ modelId: null, executionMode: 'manual' });
    applySettingsBundle(bundle, new Set(['general']));
    expect(useSettingsStore.getState().agentDefaults).toEqual({ modelId: 'custom:local-fixture:chat', executionMode: 'auto' });
    const before = useSettingsStore.getState().agentDefaults;
    bundle.categories.general.agentDefaults = { modelId: 'custom:local-fixture:chat', executionMode: 'unapproved-mode' };
    expect(() => applySettingsBundle(bundle, new Set(['general']))).toThrow();
    expect(useSettingsStore.getState().agentDefaults).toBe(before);
  });

  it('preserves every ComfyUI workflow through settings export and import', () => {
    const comfyWorkflows: ComfyUIWorkflowCollection = { version: 1, selectedWorkflowId: 'second', workflows: [
      { id: 'first', name: 'First', mediaType: 'image' as const, config: { workflow: { '1': { class_type: 'SaveImage', inputs: { source: ['2', 0] } } } } },
      { id: 'second', name: 'Second', mediaType: 'video' as const, config: { workflow: { '3': { class_type: 'SaveVideo', inputs: { source: ['4', 0] } } } } },
    ] };
    useCustomProvidersStore.setState({ providers: [{
      id: 'local-comfy', label: 'Local Comfy', baseUrl: 'http://127.0.0.1:8188', apiKey: '',
      apiStyle: 'comfyui', mediaType: 'video', models: ['first', 'second'], supportsWebSearch: false,
      extraParams: { auth: { mode: 'none' } }, comfyWorkflows,
    }] });
    const bundle = parseSettingsBundle(serializeSettingsBundle());
    useCustomProvidersStore.setState({ providers: [] });
    applySettingsBundle(bundle, new Set(['providers']));
    expect(useCustomProvidersStore.getState().providers[0]?.comfyWorkflows).toEqual(comfyWorkflows);
    bundle.categories.providers.items = [{ ...useCustomProvidersStore.getState().providers[0],
      comfyWorkflows: { ...comfyWorkflows, selectedWorkflowId: 'missing' } }];
    expect(() => applySettingsBundle(bundle, new Set(['providers']))).toThrow();
    expect(useCustomProvidersStore.getState().providers[0]?.comfyWorkflows).toEqual(comfyWorkflows);
  });

  it.each(['auto', 'zoom', 'pan'] as const)('round-trips all nine mouse gestures and %s wheel mode', (canvasWheelMode) => {
    const canvasMouseBindings = { ...DEFAULT_CANVAS_MOUSE_BINDINGS, leftClick: 'quickCreate', leftDoubleClick: 'fitView',
      leftDrag: 'none', rightClick: 'selectNode', rightDoubleClick: 'quickCreate', rightDrag: 'panCanvas',
      middleClick: 'nodeMenu', middleDoubleClick: 'fitView', middleDrag: 'selectionBox' } as const;
    useSettingsStore.getState().setCanvasMouseBindings(canvasMouseBindings);
    useSettingsStore.getState().setCanvasWheelMode(canvasWheelMode);
    const bundle = parseSettingsBundle(serializeSettingsBundle());
    expect(bundle.categories.general).toMatchObject({ canvasMouseBindings, canvasWheelMode });
    expect(bundle.categories.general).not.toHaveProperty('canvasMouseBindingPreset');
    useSettingsStore.getState().setCanvasMouseBindings(DEFAULT_CANVAS_MOUSE_BINDINGS);
    useSettingsStore.getState().setCanvasWheelMode('auto');
    applySettingsBundle(bundle, new Set(['general']));
    expect(useSettingsStore.getState()).toMatchObject({ canvasMouseBindings, canvasWheelMode, canvasLeftDragMode: 'select' });
  });

  it.each([
    ['canvasLeftDragMode', 'zoom'], ['canvasLeftDragMode', null], ['canvasLeftDragMode', ['select']],
    ['canvasWheelMode', 'select'], ['canvasWheelMode', 1], ['canvasWheelMode', ['auto']],
  ])('rejects invalid canvas enum %s = %j', (field, value) => {
    const bundle = buildSettingsBundle();
    bundle.categories.general[field as string] = value;
    expect(() => applySettingsBundle(bundle, new Set(['general']))).toThrow(/is invalid/);
    expect(useSettingsStore.getState().canvasMouseBindings).toEqual(originalSettings.canvasMouseBindings);
    expect(useSettingsStore.getState().canvasWheelMode).toBe(originalSettings.canvasWheelMode);
  });

  it.each([
    { ...DEFAULT_CANVAS_MOUSE_BINDINGS, rightDrag: 'nodeMenu' },
    { ...DEFAULT_CANVAS_MOUSE_BINDINGS, leftClick: 'panCanvas' },
    { ...DEFAULT_CANVAS_MOUSE_BINDINGS, middleDoubleClick: false },
    { ...DEFAULT_CANVAS_MOUSE_BINDINGS, unknownSlot: 'none' },
  ])('rejects malformed bindings before changing any settings', (bindings) => {
    const bundle = buildSettingsBundle();
    bundle.categories.general.canvasMouseBindings = bindings;
    bundle.categories.general.useUploadFilenameAsNodeTitle = !originalSettings.useUploadFilenameAsNodeTitle;
    expect(() => applySettingsBundle(bundle, new Set(['general']))).toThrow();
    expect(useSettingsStore.getState().canvasMouseBindings).toEqual(originalSettings.canvasMouseBindings);
    expect(useSettingsStore.getState().useUploadFilenameAsNodeTitle).toBe(originalSettings.useUploadFilenameAsNodeTitle);
  });

  it('migrates legacy custom bindings without mutating the imported backup', () => {
    const bundle = buildSettingsBundle();
    const legacy = { canvasMouseBindingPreset: 'custom', canvasMouseBindings: { leftDrag: 'panCanvas', rightDrag: 'none', middleClick: 'nodeMenu' } };
    delete bundle.categories.general.canvasLeftDragMode;
    delete bundle.categories.general.canvasWheelMode;
    Object.assign(bundle.categories.general, legacy);
    bundle.categories.general.useUploadFilenameAsNodeTitle = false;
    const parsed = parseSettingsBundle(JSON.stringify(bundle));
    expect(parsed.categories.general).toMatchObject({ canvasMouseBindings: {
      ...DEFAULT_CANVAS_MOUSE_BINDINGS, rightDrag: 'none', middleClick: 'nodeMenu', middleDrag: 'none',
    } });
    expect(parsed.categories.general).not.toHaveProperty('canvasMouseBindingPreset');
    expect(bundle.categories.general).toMatchObject(legacy);
    applySettingsBundle(bundle, new Set(['general']));
    expect(useSettingsStore.getState()).toMatchObject({ canvasLeftDragMode: 'pan', useUploadFilenameAsNodeTitle: false,
      canvasMouseBindings: { rightDrag: 'none', middleClick: 'nodeMenu', middleDrag: 'none' } });
  });

  it('preserves current gestures when an older backup contains no mouse settings', () => {
    const bundle = buildSettingsBundle();
    delete bundle.categories.general.canvasMouseBindings;
    delete bundle.categories.general.canvasLeftDragMode;
    delete bundle.categories.general.canvasWheelMode;
    bundle.categories.general.useUploadFilenameAsNodeTitle = false;
    const bindings = { ...DEFAULT_CANVAS_MOUSE_BINDINGS, rightDoubleClick: 'fitView' } as const;
    useSettingsStore.getState().setCanvasMouseBindings(bindings);
    useSettingsStore.getState().setCanvasWheelMode('pan');
    applySettingsBundle(bundle, new Set(['general']));
    expect(useSettingsStore.getState()).toMatchObject({ canvasMouseBindings: bindings, canvasWheelMode: 'pan', useUploadFilenameAsNodeTitle: false });
  });

  it('changes only the wheel when that is the only imported mouse field', () => {
    const bundle = buildSettingsBundle();
    delete bundle.categories.general.canvasMouseBindings;
    delete bundle.categories.general.canvasLeftDragMode;
    bundle.categories.general.canvasWheelMode = 'zoom';
    const bindings = { ...DEFAULT_CANVAS_MOUSE_BINDINGS, rightDrag: 'none' } as const;
    useSettingsStore.getState().setCanvasMouseBindings(bindings);
    applySettingsBundle(bundle, new Set(['general']));
    expect(useSettingsStore.getState()).toMatchObject({ canvasMouseBindings: bindings, canvasWheelMode: 'zoom' });
  });

  it('still rejects unknown general fields rather than treating them as retired controls', () => {
    const bundle = buildSettingsBundle();
    bundle.categories.general.canvasMouseUnknown = true;
    expect(() => parseSettingsBundle(JSON.stringify(bundle))).toThrow(/not supported/i);
  });

  it('rejects oversized settings text before JSON parsing', () => {
    expect(() => assertSettingsBundleSize('x'.repeat(SETTINGS_BUNDLE_MAX_BYTES + 1))).toThrow(/16 MB/i);
  });

  it('rejects invalid setting types and provider structures without mutating stores', () => {
    useSettingsStore.setState({ useUploadFilenameAsNodeTitle: true });
    useCustomProvidersStore.setState({ providers: [] });
    const invalidSetting = buildSettingsBundle();
    invalidSetting.categories.general.useUploadFilenameAsNodeTitle = 'yes';
    expect(() => applySettingsBundle(invalidSetting, new Set(['general']))).toThrow(/must be boolean/i);
    expect(useSettingsStore.getState().useUploadFilenameAsNodeTitle).toBe(true);

    const invalidProvider = buildSettingsBundle();
    invalidProvider.schemaVersion = 1;
    invalidProvider.categories.providers = { items: [] };
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

  it('shows field-level before/after values and never previews legacy credentials', () => {
    useSettingsStore.setState({
      useUploadFilenameAsNodeTitle: true,
      apiKeys: { grsai: 'current-secret' },
      agnesApiKey: 'current-agnes',
    });
    const payload = buildSettingsBundle();
    payload.categories.general.useUploadFilenameAsNodeTitle = false;
    const legacy = { ...payload, includesCredentials: true, credentials: {
      providerApiKeys: { grsai: 'incoming-secret' }, agnesApiKey: 'incoming-agnes',
    } };

    const diffs = previewSettingsImport(legacy);
    expect(diffs.find((diff) => diff.category === 'general')?.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: 'useUploadFilenameAsNodeTitle',
        before: 'true',
        after: 'false',
      }),
    ]));
    expect(diffs.find((diff) => diff.category === 'credentials')).toBeUndefined();
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
    const payload = buildSettingsBundle();
    payload.schemaVersion = 1;
    payload.categories.providers = { items: [] };
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
    expect(useChannelStore.getState().channels).toEqual([]);
    expect(snapshotChannelCredentials()).toEqual({});
    expect(usePromptLibraryStore.getState().favoritePrompts).toEqual({});
    expect(useThemeStore.getState().theme).toBe('dark');
  });

  it('round-trips channel refs and API paths without importing credentials or private migration paths', () => {
    const native = profile('native');
    native.operations.chat!.response = { mode: 'async', taskIdPath: 'id', poll: {
      method: 'GET', path: '/tasks/{{taskId}}', intervalSec: 2, timeoutMin: 3,
      success: ['done'], failure: ['failed'], outputs: [{ path: 'result.url', as: 'url' }],
      resultRequest: { method: 'GET', path: '/tasks/{{taskId}}/result' },
    } };
    const credentialRef = { namespace: 'channel' as const, id: native.id };
    createChannel(native, secretToken(credentialRef));
    const issues = [{ key: 'extraParams.cachePath', value: '/Users/private/cache', reason: 'Unsupported' }];
    useChannelStore.setState((state) => ({ channels: state.channels.map((record) => ({ ...record, migrationIssues: issues })) }));
    const original = useChannelStore.getState().channels[0];
    const safe = parseSettingsBundle(serializeSettingsBundle());
    expect(JSON.stringify(safe)).not.toContain('/Users/private');
    expect(safe.categories.providers.channels).toEqual([expect.objectContaining({ profile: native,
      migrationIssues: [expect.objectContaining({ value: '[redacted: nonportable value]', reason: expect.stringContaining('redacted') })],
    })]);
    const bundle = parseSettingsBundle(serializeSettingsBundle());
    expect(bundle.schemaVersion).toBe(2);
    expect(bundle.categories.providers.items).toEqual([]);
    expect(bundle).not.toHaveProperty('credentials');
    expect(bundle.categories.providers.channels).toEqual([expect.objectContaining({ credentialRef })]);
    expect(JSON.stringify(previewSettingsImport(bundle))).not.toMatch(/native-secret|\/Users\/private/);
    useChannelStore.setState({ channels: [] });
    replaceChannelCredentials({});
    applySettingsBundle(bundle, new Set(['providers', 'credentials']));
    expect(useChannelStore.getState().channels).toEqual([
      expect.objectContaining({ ...original, migrationIssues: expect.any(Array), credentialRef }),
    ]);
    expect(getChannelCredential('native')).toBe(secretToken(credentialRef));
    expect(channelPersistenceStorage.getItem('custom-providers-storage')).not.toMatch(/native-secret/);
    applySettingsBundle({ ...bundle, includesCredentials: true, credentials: {
      channelApiKeys: { native: 'incoming-secret' },
    } }, new Set(['providers', 'credentials']));
    expect(getChannelCredential('native')).toBe(secretToken(credentialRef));
  });

  it('migrates v1 HTTP imports, retains unsupported backup data and special adapters, and never executes v2 backups', () => {
    const payload = buildSettingsBundle();
    payload.schemaVersion = 1;
    payload.categories.providers = { items: [{
      id: 'old-http', label: 'Old HTTP', baseUrl: 'https://example.com', endpointPath: '/v1/chat/completions',
      mediaType: 'chat', apiStyle: 'openai-compatible', models: ['model'], supportsWebSearch: false,
      extraParams: { unsupportedVendorOption: { enabled: true } },
    }, {
      id: 'special', label: 'Comfy', baseUrl: 'http://localhost:8188', apiStyle: 'comfyui', models: ['workflow'], supportsWebSearch: false,
    }] };
    applySettingsBundle({ ...payload, includesCredentials: true, credentials: {
      customProviderApiKeys: { 'old-http': 'legacy-secret' },
    } }, new Set(['providers', 'credentials']));
    expect(useChannelStore.getState().channels).toEqual([expect.objectContaining({ origin: 'native', profile: expect.objectContaining({ id: 'old-http' }) })]);
    expect(getChannelCredential('old-http')).not.toBe('legacy-secret');
    expect(useCustomProvidersStore.getState().providers.filter((provider) => !provider.extraParams?.channelProfileId))
      .toEqual([expect.objectContaining({ id: 'special', apiStyle: 'comfyui' })]);
    const bundle = parseSettingsBundle(serializeSettingsBundle());
    expect(bundle.categories.providers.channels).toEqual([expect.objectContaining({
      migrationIssues: useChannelStore.getState().channels[0].migrationIssues
        .map(({ key, kind }) => expect.objectContaining({ key, kind })),
    })]);
    expect(bundle).not.toHaveProperty('credentials');
    expect(JSON.stringify(bundle)).not.toContain('legacy-secret');
    expect(channelPersistenceStorage.getItem('legacy_custom_providers')).not.toContain('legacy-secret');
    expect(buildSettingsBundle().categories.providers.legacyBackupIds).toContain('old-http');
    bundle.categories.providers.channels = [];
    applySettingsBundle(bundle, new Set(['providers', 'credentials']));
    expect(useChannelStore.getState().channels).toEqual([]);
  });

  it('rejects an unknown migration classification in imported settings', () => {
    const bundle = buildSettingsBundle();
    const source = JSON.stringify({ ...bundle, categories: { ...bundle.categories,
      providers: { ...bundle.categories.providers, channels: [{
        profile: profile('invalid-migration-kind'), origin: 'native', createdAt: 1, updatedAt: 1,
        migrationIssues: [{ key: 'vendorOption', value: true, reason: 'Review required', kind: 'invented-kind' }],
      }] },
    } });
    expect(() => parseSettingsBundle(source)).toThrow();
  });

  it('rolls native records, orphan credentials, migration markers, and backups back after a later failure', () => {
    createChannel(profile('existing'), secretToken({ namespace: 'channel', id: 'existing' }));
    replaceChannelCredentials({ ...snapshotChannelCredentials(), orphan: secretToken({ namespace: 'channel', id: 'orphan' }) });
    const channelState = useChannelStore.getState();
    const credentialState = snapshotChannelCredentials();
    const backupState = backupNames.map((name) => channelPersistenceStorage.getItem(name));
    const payload = buildSettingsBundle();
    payload.categories.providers.channels = [{ profile: profile('imported'), origin: 'native', migrationIssues: [], createdAt: 1, updatedAt: 2 }];
    const legacy = { ...payload, includesCredentials: true, credentials: {
      channelApiKeys: { imported: 'imported-secret' },
      legacyProviderBackups: { imported: JSON.stringify({
        id: 'imported', label: 'Imported', baseUrl: 'https://example.com', apiStyle: 'generic-json', models: ['model'],
        supportsWebSearch: false, apiKey: 'imported-secret', extraParams: { cachePath: '/Users/private/cache' },
      }) },
    } };
    payload.categories.appearance.theme = 'light';
    useThemeStore.setState({ setTheme: () => { throw new Error('late failure'); } });
    expect(() => applySettingsBundle(legacy, new Set(['providers', 'credentials', 'appearance']))).toThrow('late failure');
    expect(useChannelStore.getState()).toEqual(channelState);
    expect(snapshotChannelCredentials()).toEqual(credentialState);
    expect(backupNames.map((name) => channelPersistenceStorage.getItem(name))).toEqual(backupState);
    expect(useCustomProvidersStore.getState().providers.every((provider) => provider.extraParams?.channelProfileId === 'existing')).toBe(true);
  });

  it('rejects invalid native profiles and nonportable transport fields without silently stripping them', () => {
    createChannel(profile('native'));
    const payload = buildSettingsBundle();
    const records = payload.categories.providers.channels as { profile: ChannelProfileV2 }[];
    records[0].profile.operations.chat!.template = { cachePath: '/Users/private/cache' };
    expect(() => applySettingsBundle(payload, new Set(['providers']))).toThrow(/absolute path/i);
    records[0].profile = profile('native');
    records[0].profile.headers = { Authorization: 'hardcoded-secret' };
    expect(JSON.stringify(parseSettingsBundle(JSON.stringify(payload)))).not.toContain('hardcoded-secret');
    expect(getChannelCredential('native')).toBe('');
    expect(useChannelStore.getState().channels[0].profile).toEqual(profile('native'));
  });
});
