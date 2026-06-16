import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  DEFAULT_LIGHTING_PROMPT_TEMPLATE,
  DEFAULT_MULTI_ANGLE_PROMPT_TEMPLATE,
  getPromptTemplateDefaultText,
  isPromptLanguage,
  isPromptTemplateId,
  isPromptTemplateLanguagePreference,
  normalizePromptLanguage,
  type PromptLanguage,
  type PromptTemplateId,
  type PromptTemplateLanguagePreference,
  type PromptTemplateOverride,
  type PromptTemplateOverrideMap,
} from '@/features/canvas/application/promptTemplates';
import {
  createDefaultTextAgent,
  normalizeTextAgents,
} from '@/features/canvas/application/aiText/helpers';
import {
  defaultAudioInputSchemaForProviderKind,
  normalizeAudioInputSchema,
} from '@/features/canvas/application/audioInputSchema';
import type { TextAgentConfig } from '@/features/canvas/application/aiText/types';

export type UiRadiusPreset = 'compact' | 'default' | 'large';
export type ThemeTonePreset = 'neutral' | 'warm' | 'cool';
export type CanvasEdgeRoutingMode = 'spline' | 'orthogonal' | 'smartOrthogonal';
export type PanoramaControlSensitivity = 'low' | 'medium' | 'high';
export type CanvasMouseBindingPreset = 'default' | 'traditional' | 'custom';
export type CanvasMouseAction = 'none' | 'selectNode' | 'panCanvas' | 'selectionBox' | 'nodeMenu';
export type CanvasMouseBindingSlot =
  | 'leftClick'
  | 'leftDrag'
  | 'rightClick'
  | 'rightDrag'
  | 'middleClick'
  | 'middleDrag';
export type CanvasMouseBindings = Record<CanvasMouseBindingSlot, CanvasMouseAction>;
export type ImageHostProvider = 'pixhost' | 'seedvault';
export type AudioOutputMode = 'server' | 'segmented';
export type AudioProviderKind = 'local-doubao-tts' | 'gradio-voxcpm';
export type ProviderApiKeys = Record<string, string>;
export const DEFAULT_GRSAI_NANO_BANANA_PRO_MODEL = 'nano-banana-pro';
export {
  DEFAULT_LIGHTING_PROMPT_TEMPLATE,
  DEFAULT_MULTI_ANGLE_PROMPT_TEMPLATE,
};
export type {
  PromptLanguage,
  PromptTemplateId,
  PromptTemplateLanguagePreference,
  PromptTemplateOverride,
};

export const DEFAULT_CANVAS_MOUSE_BINDINGS: CanvasMouseBindings = {
  leftClick: 'selectNode',
  leftDrag: 'panCanvas',
  rightClick: 'nodeMenu',
  rightDrag: 'selectionBox',
  middleClick: 'none',
  middleDrag: 'none',
};

export const TRADITIONAL_CANVAS_MOUSE_BINDINGS: CanvasMouseBindings = {
  leftClick: 'selectNode',
  leftDrag: 'selectionBox',
  rightClick: 'nodeMenu',
  rightDrag: 'none',
  middleClick: 'none',
  middleDrag: 'panCanvas',
};

export interface PromptPreset {
  id: string;
  name: string;
  prompt: string;
  createdAt: number;
  updatedAt: number;
}

export interface ImageHostSettings {
  enabled: boolean;
  provider: ImageHostProvider;
  pixhost: {
    apiBaseUrl: string;
    contentType: string;
    maxThumbnailSize: string;
  };
  seedvault: {
    apiBaseUrl: string;
    email: string;
    password: string;
    token: string;
    strategyId: string;
  };
}

export interface AudioVoiceOption {
  id: string;
  name: string;
  category?: string;
  locale?: string;
  raw?: unknown;
}

export interface AudioVoiceCategory {
  key: string;
  label: string;
}

export interface AudioModelConfig {
  id: string;
  name: string;
  providerKind: AudioProviderKind;
  apiBaseUrl: string;
  endpointPath: string;
  outputMode: AudioOutputMode;
  defaultVoiceId: string;
  timeoutMs: number;
  enabled: boolean;
  extraParams?: Record<string, unknown>;
}

export interface AudioGenerationSettings {
  apiBaseUrl: string;
  defaultOutputMode: AudioOutputMode;
  defaultTimeoutMs: number;
  voices: AudioVoiceOption[];
  categories: AudioVoiceCategory[];
  selectedVoiceId: string;
  lastSyncedAt?: number | null;
  models: AudioModelConfig[];
}

export const DEFAULT_IMAGE_HOST_SETTINGS: ImageHostSettings = {
  enabled: false,
  provider: 'pixhost',
  pixhost: {
    apiBaseUrl: 'https://api.pixhost.to',
    contentType: '0',
    maxThumbnailSize: '420',
  },
  seedvault: {
    apiBaseUrl: 'https://img.seedvault.cn/api/v1',
    email: '',
    password: '',
    token: '',
    strategyId: '',
  },
};

export const DEFAULT_AUDIO_API_BASE_URL = 'http://127.0.0.1:17860';

export const DEFAULT_AUDIO_GENERATION_SETTINGS: AudioGenerationSettings = {
  apiBaseUrl: DEFAULT_AUDIO_API_BASE_URL,
  defaultOutputMode: 'server',
  defaultTimeoutMs: 180000,
  voices: [],
  categories: [
    { key: 'female', label: '女声' },
    { key: 'male', label: '男声' },
    { key: 'accent', label: '口音' },
    { key: 'characters', label: '角色' },
    { key: 'english', label: '英文' },
  ],
  selectedVoiceId: '',
  lastSyncedAt: null,
  models: [
    {
      id: 'local-doubao-tts',
      name: '本地豆包 TTS',
      providerKind: 'local-doubao-tts',
      apiBaseUrl: DEFAULT_AUDIO_API_BASE_URL,
      endpointPath: '/tts',
      outputMode: 'server',
      defaultVoiceId: '',
      timeoutMs: 180000,
      enabled: true,
    },
    {
      id: 'voxcpm-online',
      name: 'VoxCPM 在线 TTS',
      providerKind: 'gradio-voxcpm',
      apiBaseUrl: 'https://voxcpm.modelbest.cn',
      endpointPath: '/gradio_api/call/generate',
      outputMode: 'server',
      defaultVoiceId: '',
      timeoutMs: 180000,
      enabled: true,
      extraParams: {
        audioInputSchema: defaultAudioInputSchemaForProviderKind('gradio-voxcpm'),
        controlInstruction: '自然、清晰、有表现力',
        usePromptText: false,
        promptTextValue: '',
        cfgValue: 2,
        doNormalize: false,
        denoise: false,
        ditSteps: 10,
        userId: 'fp-2fejme4mpcko',
      },
    },
  ],
};

interface SettingsState {
  isHydrated: boolean;
  apiKeys: ProviderApiKeys;
  agnesApiKey: string;
  grsaiNanoBananaProModel: string;
  hideProviderGuidePopover: boolean;
  downloadPresetPaths: string[];
  useUploadFilenameAsNodeTitle: boolean;
  storyboardGenKeepStyleConsistent: boolean;
  storyboardGenDisableTextInImage: boolean;
  storyboardGenAutoInferEmptyFrame: boolean;
  ignoreAtTagWhenCopyingAndGenerating: boolean;
  appendParameterConstraintsToPrompt: boolean;
  collapseNodeActionToolbarByDefault: boolean;
  showNodePayloadPreview: boolean;
  enableAiTextStreaming: boolean;
  enableStoryboardGenGridPreviewShortcut: boolean;
  showStoryboardGenAdvancedRatioControls: boolean;
  useLegacyPanoramaControlDirection: boolean;
  panoramaControlSensitivity: PanoramaControlSensitivity;
  canvasMouseBindingPreset: CanvasMouseBindingPreset;
  canvasMouseBindings: CanvasMouseBindings;
  enableCanvasWasdPan: boolean;
  canvasWasdPanSensitivity: number;
  uiRadiusPreset: UiRadiusPreset;
  themeTonePreset: ThemeTonePreset;
  accentColor: string;
  canvasEdgeRoutingMode: CanvasEdgeRoutingMode;
  autoCheckAppUpdateOnLaunch: boolean;
  enableUpdateDialog: boolean;
  promptDefaultLanguage: PromptLanguage;
  promptTemplateOverrides: PromptTemplateOverrideMap;
  promptPresets: PromptPreset[];
  textAgents: TextAgentConfig[];
  imageHostSettings: ImageHostSettings;
  audioGenerationSettings: AudioGenerationSettings;
  multiAnglePromptTemplate: string;
  lightingPromptTemplate: string;
  /** Last-seen Dreamina login status; refreshed by the settings screen on demand. */
  dreaminaStatus?: { loggedIn: boolean; credits: number | null; networkDegraded: boolean } | null;
  /** Per-panel memory of the model/provider/ratio picker selection. */
  lastModelConfigByPanel?: Record<string, { entryId: string; ratio: string; extraParams?: Record<string, unknown> } | undefined>;
  setProviderApiKey: (providerId: string, key: string) => void;
  setAgnesApiKey: (key: string) => void;
  setGrsaiNanoBananaProModel: (model: string) => void;
  setHideProviderGuidePopover: (hide: boolean) => void;
  setDownloadPresetPaths: (paths: string[]) => void;
  setUseUploadFilenameAsNodeTitle: (enabled: boolean) => void;
  setStoryboardGenKeepStyleConsistent: (enabled: boolean) => void;
  setStoryboardGenDisableTextInImage: (enabled: boolean) => void;
  setStoryboardGenAutoInferEmptyFrame: (enabled: boolean) => void;
  setIgnoreAtTagWhenCopyingAndGenerating: (enabled: boolean) => void;
  setAppendParameterConstraintsToPrompt: (enabled: boolean) => void;
  setCollapseNodeActionToolbarByDefault: (enabled: boolean) => void;
  setShowNodePayloadPreview: (enabled: boolean) => void;
  setEnableAiTextStreaming: (enabled: boolean) => void;
  setEnableStoryboardGenGridPreviewShortcut: (enabled: boolean) => void;
  setShowStoryboardGenAdvancedRatioControls: (enabled: boolean) => void;
  setUseLegacyPanoramaControlDirection: (enabled: boolean) => void;
  setPanoramaControlSensitivity: (sensitivity: PanoramaControlSensitivity) => void;
  setCanvasMouseBindingPreset: (preset: CanvasMouseBindingPreset) => void;
  setCanvasMouseBindings: (bindings: CanvasMouseBindings) => void;
  setCanvasMouseBinding: (slot: CanvasMouseBindingSlot, action: CanvasMouseAction) => void;
  resetCanvasMouseBindingsToPreset: (preset: Exclude<CanvasMouseBindingPreset, 'custom'>) => void;
  setEnableCanvasWasdPan: (enabled: boolean) => void;
  setCanvasWasdPanSensitivity: (sensitivity: number) => void;
  setUiRadiusPreset: (preset: UiRadiusPreset) => void;
  setThemeTonePreset: (preset: ThemeTonePreset) => void;
  setAccentColor: (color: string) => void;
  setCanvasEdgeRoutingMode: (mode: CanvasEdgeRoutingMode) => void;
  setAutoCheckAppUpdateOnLaunch: (enabled: boolean) => void;
  setEnableUpdateDialog: (enabled: boolean) => void;
  setPromptDefaultLanguage: (language: PromptLanguage) => void;
  setPromptTemplateLanguage: (
    id: PromptTemplateId,
    language: PromptTemplateLanguagePreference
  ) => void;
  setPromptTemplateOverride: (
    id: PromptTemplateId,
    template: string,
    language?: PromptTemplateLanguagePreference
  ) => void;
  resetPromptTemplate: (id: PromptTemplateId) => void;
  addPromptPreset: (preset: { name: string; prompt: string }) => PromptPreset | null;
  updatePromptPreset: (id: string, patch: Partial<Pick<PromptPreset, 'name' | 'prompt'>>) => void;
  deletePromptPreset: (id: string) => void;
  addTextAgent: () => TextAgentConfig;
  updateTextAgent: (id: string, patch: Partial<TextAgentConfig>) => void;
  moveTextAgent: (id: string, direction: -1 | 1) => void;
  deleteTextAgent: (id: string) => void;
  setImageHostSettings: (settings: ImageHostSettings) => void;
  setAudioGenerationSettings: (settings: AudioGenerationSettings) => void;
  setMultiAnglePromptTemplate: (template: string) => void;
  setLightingPromptTemplate: (template: string) => void;
  resetMultiAnglePromptTemplate: () => void;
  resetLightingPromptTemplate: () => void;
  setDreaminaStatus: (status: { loggedIn: boolean; credits: number | null; networkDegraded: boolean } | null) => void;
  setPanelModelConfig: (panelKey: string, cfg: { entryId: string; ratio: string; extraParams?: Record<string, unknown> } | undefined) => void;
}

const HEX_COLOR_PATTERN = /^#?[0-9a-fA-F]{6}$/;

function normalizeHexColor(input: string): string {
  const trimmed = input.trim();
  if (!HEX_COLOR_PATTERN.test(trimmed)) {
    return '#3B82F6';
  }
  return trimmed.startsWith('#') ? trimmed.toUpperCase() : `#${trimmed.toUpperCase()}`;
}

function normalizeApiKey(input: string): string {
  return input.trim();
}

function trimTrailingSlash(input: string): string {
  return input.trim().replace(/\/+$/, '');
}

function normalizeUrlSetting(input: unknown, fallback: string): string {
  if (typeof input !== 'string') {
    return fallback;
  }
  const trimmed = trimTrailingSlash(input);
  if (!trimmed) {
    return fallback;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return trimmed;
    }
  } catch {
    return fallback;
  }
  return fallback;
}

function normalizeImageHostProvider(input: unknown): ImageHostProvider {
  return input === 'seedvault' || input === 'pixhost' ? input : 'pixhost';
}

function normalizeAudioOutputMode(input: unknown, fallback: AudioOutputMode): AudioOutputMode {
  return input === 'segmented' || input === 'server' ? input : fallback;
}

function normalizeAudioProviderKind(input: unknown, fallback: AudioProviderKind): AudioProviderKind {
  return input === 'gradio-voxcpm' || input === 'local-doubao-tts' ? input : fallback;
}

function normalizeAudioTimeoutMs(input: unknown, fallback: number): number {
  const numeric = typeof input === 'number' ? input : Number(input);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(600000, Math.max(5000, Math.round(numeric)));
}

function asPlainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeAudioExtraParams(
  input: unknown,
  providerKind: AudioProviderKind
): Record<string, unknown> {
  const record = asPlainRecord(input);
  if (!record) {
    return {
      audioInputSchema: defaultAudioInputSchemaForProviderKind(providerKind),
    };
  }
  return {
    ...record,
    audioInputSchema: normalizeAudioInputSchema(
      record.audioInputSchema,
      defaultAudioInputSchemaForProviderKind(providerKind)
    ),
  };
}

function normalizeAudioVoiceOption(input: unknown): AudioVoiceOption | null {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const raw = input as Partial<AudioVoiceOption> & Record<string, unknown>;
  const id = (
    typeof raw.id === 'string' ? raw.id :
    typeof raw.voiceId === 'string' ? raw.voiceId :
    typeof raw.value === 'string' ? raw.value :
    typeof raw.key === 'string' ? raw.key :
    ''
  ).trim();
  if (!id) {
    return null;
  }

  const name = (
    typeof raw.name === 'string' ? raw.name :
    typeof raw.label === 'string' ? raw.label :
    typeof raw.title === 'string' ? raw.title :
    id
  ).trim() || id;
  const category = typeof raw.category === 'string' && raw.category.trim()
    ? raw.category.trim()
    : undefined;
  const locale = typeof raw.locale === 'string' && raw.locale.trim()
    ? raw.locale.trim()
    : typeof raw.languageCode === 'string' && raw.languageCode.trim()
      ? raw.languageCode.trim()
      : undefined;

  return {
    id,
    name,
    category,
    locale,
    raw: raw.raw ?? input,
  };
}

function normalizeAudioVoiceOptions(input: unknown): AudioVoiceOption[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const seen = new Set<string>();
  const voices: AudioVoiceOption[] = [];
  input.forEach((item) => {
    const voice = normalizeAudioVoiceOption(item);
    if (!voice || seen.has(voice.id)) {
      return;
    }
    seen.add(voice.id);
    voices.push(voice);
  });
  return voices.slice(0, 2000);
}

function normalizeAudioVoiceCategory(input: unknown): AudioVoiceCategory | null {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const raw = input as Partial<AudioVoiceCategory> & Record<string, unknown>;
  const key = (
    typeof raw.key === 'string' ? raw.key :
    typeof raw.id === 'string' ? raw.id :
    typeof raw.value === 'string' ? raw.value :
    ''
  ).trim();
  if (!key) {
    return null;
  }
  const label = (
    typeof raw.label === 'string' ? raw.label :
    typeof raw.name === 'string' ? raw.name :
    key
  ).trim() || key;
  return { key, label };
}

function normalizeAudioVoiceCategories(input: unknown): AudioVoiceCategory[] {
  const fallback = DEFAULT_AUDIO_GENERATION_SETTINGS.categories.map((item) => ({ ...item }));
  if (!Array.isArray(input)) {
    return fallback;
  }
  const seen = new Set<string>();
  const categories: AudioVoiceCategory[] = [];
  input.forEach((item) => {
    const category = normalizeAudioVoiceCategory(item);
    if (!category || seen.has(category.key)) {
      return;
    }
    seen.add(category.key);
    categories.push(category);
  });
  return categories.length > 0 ? categories.slice(0, 200) : fallback;
}

function createAudioModelId(): string {
  return `audio-model-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeAudioModelConfig(
  input: unknown,
  fallback: AudioModelConfig
): AudioModelConfig {
  const raw = input && typeof input === 'object'
    ? input as Partial<AudioModelConfig>
    : {};
  const id = typeof raw.id === 'string' && raw.id.trim()
    ? raw.id.trim()
    : fallback.id || createAudioModelId();
  const name = typeof raw.name === 'string' && raw.name.trim()
    ? raw.name.trim()
    : fallback.name;
  const endpointPath = typeof raw.endpointPath === 'string' && raw.endpointPath.trim()
    ? `/${raw.endpointPath.trim().replace(/^\/+/, '')}`
    : fallback.endpointPath;
  const providerKind = normalizeAudioProviderKind(
    raw.providerKind ?? asPlainRecord(raw.extraParams)?.providerKind,
    fallback.providerKind
  );

  const fallbackExtraParams = asPlainRecord(fallback.extraParams) ?? {};
  const rawExtraParams = asPlainRecord(raw.extraParams) ?? {};
  const mergedExtraParams = {
    ...fallbackExtraParams,
    ...rawExtraParams,
    audioInputSchema: rawExtraParams.audioInputSchema
      ?? fallbackExtraParams.audioInputSchema
      ?? defaultAudioInputSchemaForProviderKind(providerKind),
  };

  return {
    id,
    name,
    providerKind,
    apiBaseUrl: normalizeUrlSetting(raw.apiBaseUrl, fallback.apiBaseUrl),
    endpointPath,
    outputMode: normalizeAudioOutputMode(raw.outputMode, fallback.outputMode),
    defaultVoiceId: typeof raw.defaultVoiceId === 'string' ? raw.defaultVoiceId.trim() : '',
    timeoutMs: normalizeAudioTimeoutMs(raw.timeoutMs, fallback.timeoutMs),
    enabled: raw.enabled !== false,
    extraParams: normalizeAudioExtraParams(mergedExtraParams, providerKind),
  };
}

function normalizeAudioModelConfigs(input: unknown, settingsBaseUrl: string): AudioModelConfig[] {
  const fallbackModels = DEFAULT_AUDIO_GENERATION_SETTINGS.models.map((model) => ({
    ...model,
    apiBaseUrl: model.providerKind === 'local-doubao-tts' ? settingsBaseUrl : model.apiBaseUrl,
  }));
  const seen = new Set<string>();
  const models: AudioModelConfig[] = [];

  fallbackModels.forEach((fallback) => {
    const item = Array.isArray(input)
      ? input.find((candidate) => {
        const record = asPlainRecord(candidate);
        return record?.providerKind === fallback.providerKind || record?.id === fallback.id;
      })
      : undefined;
    const model = normalizeAudioModelConfig(item, fallback);
    model.id = fallback.id;
    model.providerKind = fallback.providerKind;
    if (model.providerKind === 'gradio-voxcpm') {
      model.defaultVoiceId = '';
    }
    seen.add(model.id);
    models.push(model);
  });

  return models.slice(0, 50);
}

export function normalizeAudioGenerationSettings(input: unknown): AudioGenerationSettings {
  const raw = input && typeof input === 'object'
    ? input as Partial<AudioGenerationSettings>
    : {};
  const apiBaseUrl = normalizeUrlSetting(
    raw.apiBaseUrl,
    DEFAULT_AUDIO_GENERATION_SETTINGS.apiBaseUrl
  );
  const voices = normalizeAudioVoiceOptions(raw.voices);
  const selectedVoiceId =
    typeof raw.selectedVoiceId === 'string' && raw.selectedVoiceId.trim()
      ? raw.selectedVoiceId.trim()
      : voices[0]?.id ?? '';

  return {
    apiBaseUrl,
    defaultOutputMode: normalizeAudioOutputMode(
      raw.defaultOutputMode,
      DEFAULT_AUDIO_GENERATION_SETTINGS.defaultOutputMode
    ),
    defaultTimeoutMs: normalizeAudioTimeoutMs(
      raw.defaultTimeoutMs,
      DEFAULT_AUDIO_GENERATION_SETTINGS.defaultTimeoutMs
    ),
    voices,
    categories: normalizeAudioVoiceCategories(raw.categories),
    selectedVoiceId,
    lastSyncedAt:
      typeof raw.lastSyncedAt === 'number' && Number.isFinite(raw.lastSyncedAt)
        ? raw.lastSyncedAt
        : null,
    models: normalizeAudioModelConfigs(raw.models, apiBaseUrl),
  };
}

export function normalizeImageHostSettings(input: unknown): ImageHostSettings {
  const raw = input && typeof input === 'object'
    ? input as Partial<ImageHostSettings>
    : {};
  const rawPixhost = raw.pixhost && typeof raw.pixhost === 'object'
    ? raw.pixhost as Partial<ImageHostSettings['pixhost']>
    : {};
  const rawSeedvault = raw.seedvault && typeof raw.seedvault === 'object'
    ? raw.seedvault as Partial<ImageHostSettings['seedvault']>
    : {};

  return {
    enabled: raw.enabled === true,
    provider: normalizeImageHostProvider(raw.provider),
    pixhost: {
      apiBaseUrl: normalizeUrlSetting(
        rawPixhost.apiBaseUrl,
        DEFAULT_IMAGE_HOST_SETTINGS.pixhost.apiBaseUrl
      ),
      contentType: typeof rawPixhost.contentType === 'string' && rawPixhost.contentType.trim()
        ? rawPixhost.contentType.trim()
        : DEFAULT_IMAGE_HOST_SETTINGS.pixhost.contentType,
      maxThumbnailSize:
        typeof rawPixhost.maxThumbnailSize === 'string' && rawPixhost.maxThumbnailSize.trim()
          ? rawPixhost.maxThumbnailSize.trim()
          : DEFAULT_IMAGE_HOST_SETTINGS.pixhost.maxThumbnailSize,
    },
    seedvault: {
      apiBaseUrl: normalizeUrlSetting(
        rawSeedvault.apiBaseUrl,
        DEFAULT_IMAGE_HOST_SETTINGS.seedvault.apiBaseUrl
      ),
      email: typeof rawSeedvault.email === 'string' ? rawSeedvault.email.trim() : '',
      password: typeof rawSeedvault.password === 'string' ? rawSeedvault.password : '',
      token: typeof rawSeedvault.token === 'string' ? rawSeedvault.token.trim() : '',
      strategyId: typeof rawSeedvault.strategyId === 'string' ? rawSeedvault.strategyId.trim() : '',
    },
  };
}

function normalizeGrsaiNanoBananaProModel(input: string | null | undefined): string {
  const trimmed = (input ?? '').trim().toLowerCase();
  if (trimmed === DEFAULT_GRSAI_NANO_BANANA_PRO_MODEL || trimmed.startsWith('nano-banana-pro-')) {
    return trimmed;
  }
  return DEFAULT_GRSAI_NANO_BANANA_PRO_MODEL;
}

function normalizeCanvasEdgeRoutingMode(
  input: CanvasEdgeRoutingMode | string | null | undefined
): CanvasEdgeRoutingMode {
  if (input === 'orthogonal' || input === 'smartOrthogonal' || input === 'spline') {
    return input;
  }
  return 'spline';
}

function normalizePanoramaControlSensitivity(
  input: PanoramaControlSensitivity | string | null | undefined
): PanoramaControlSensitivity {
  if (input === 'low' || input === 'medium' || input === 'high') {
    return input;
  }
  return 'medium';
}

function normalizeCanvasMouseBindingPreset(
  input: CanvasMouseBindingPreset | string | null | undefined
): CanvasMouseBindingPreset {
  if (input === 'default' || input === 'traditional' || input === 'custom') {
    return input;
  }
  return 'default';
}

function normalizeCanvasMouseAction(
  input: CanvasMouseAction | string | null | undefined,
  fallback: CanvasMouseAction
): CanvasMouseAction {
  if (
    input === 'none' ||
    input === 'selectNode' ||
    input === 'panCanvas' ||
    input === 'selectionBox' ||
    input === 'nodeMenu'
  ) {
    return input;
  }
  return fallback;
}

function cloneCanvasMouseBindings(bindings: CanvasMouseBindings): CanvasMouseBindings {
  return { ...bindings };
}

function bindingsForCanvasMousePreset(
  preset: Exclude<CanvasMouseBindingPreset, 'custom'>
): CanvasMouseBindings {
  return cloneCanvasMouseBindings(
    preset === 'traditional'
      ? TRADITIONAL_CANVAS_MOUSE_BINDINGS
      : DEFAULT_CANVAS_MOUSE_BINDINGS
  );
}

function normalizeCanvasMouseBindings(input: unknown): CanvasMouseBindings {
  const raw = input && typeof input === 'object'
    ? input as Partial<Record<CanvasMouseBindingSlot, CanvasMouseAction | string | null>>
    : {};

  return {
    leftClick: normalizeCanvasMouseAction(raw.leftClick, DEFAULT_CANVAS_MOUSE_BINDINGS.leftClick),
    leftDrag: normalizeCanvasMouseAction(raw.leftDrag, DEFAULT_CANVAS_MOUSE_BINDINGS.leftDrag),
    rightClick: normalizeCanvasMouseAction(raw.rightClick, DEFAULT_CANVAS_MOUSE_BINDINGS.rightClick),
    rightDrag: normalizeCanvasMouseAction(raw.rightDrag, DEFAULT_CANVAS_MOUSE_BINDINGS.rightDrag),
    middleClick: normalizeCanvasMouseAction(raw.middleClick, DEFAULT_CANVAS_MOUSE_BINDINGS.middleClick),
    middleDrag: normalizeCanvasMouseAction(raw.middleDrag, DEFAULT_CANVAS_MOUSE_BINDINGS.middleDrag),
  };
}

function normalizeCanvasWasdPanSensitivity(input: number | string | null | undefined): number {
  const numeric = typeof input === 'number' ? input : Number(input);
  if (!Number.isFinite(numeric)) {
    return 60;
  }
  return Math.min(180, Math.max(10, Math.round(numeric)));
}

export function getPanoramaControlSensitivityMultiplier(
  sensitivity: PanoramaControlSensitivity
): number {
  switch (sensitivity) {
    case 'low':
      return 0.6;
    case 'high':
      return 1.6;
    case 'medium':
    default:
      return 1;
  }
}

function normalizeApiKeys(input: ProviderApiKeys | null | undefined): ProviderApiKeys {
  if (!input) {
    return {};
  }

  return Object.entries(input).reduce<ProviderApiKeys>((acc, [providerId, key]) => {
    const normalizedProviderId = providerId.trim();
    if (!normalizedProviderId) {
      return acc;
    }

    acc[normalizedProviderId] = normalizeApiKey(key);
    return acc;
  }, {});
}

function normalizePromptTemplateOverride(
  id: PromptTemplateId,
  input: unknown,
  promptDefaultLanguage: PromptLanguage
): PromptTemplateOverride | undefined {
  if (!input || typeof input !== 'object') {
    return undefined;
  }

  const raw = input as Partial<PromptTemplateOverride>;
  const language = isPromptTemplateLanguagePreference(raw.language) ? raw.language : undefined;
  const effectiveLanguage = isPromptLanguage(language) ? language : promptDefaultLanguage;
  const template = typeof raw.template === 'string' ? raw.template.trim() : '';
  const defaultTemplate = getPromptTemplateDefaultText(id, effectiveLanguage);
  const next: PromptTemplateOverride = {
    updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt)
      ? raw.updatedAt
      : Date.now(),
  };

  if (language && language !== 'inherit') {
    next.language = language;
  }
  if (template && template !== defaultTemplate) {
    next.template = template;
  }

  return next.language || next.template ? next : undefined;
}

function setOverrideInMap(
  overrides: PromptTemplateOverrideMap | null | undefined,
  id: PromptTemplateId,
  override: PromptTemplateOverride | undefined
): PromptTemplateOverrideMap {
  const next: PromptTemplateOverrideMap = { ...(overrides ?? {}) };
  if (override) {
    next[id] = override;
  } else {
    delete next[id];
  }
  return next;
}

function normalizePromptTemplateOverrides(
  input: unknown,
  promptDefaultLanguage: PromptLanguage,
  legacyTemplates: {
    multiAnglePromptTemplate?: string;
    lightingPromptTemplate?: string;
  } = {}
): PromptTemplateOverrideMap {
  const normalized: PromptTemplateOverrideMap = {};
  if (input && typeof input === 'object') {
    Object.entries(input as Record<string, unknown>).forEach(([id, override]) => {
      if (!isPromptTemplateId(id)) {
        return;
      }
      const normalizedOverride = normalizePromptTemplateOverride(
        id,
        override,
        promptDefaultLanguage
      );
      if (normalizedOverride) {
        normalized[id] = normalizedOverride;
      }
    });
  }

  const legacyMultiAngle = legacyTemplates.multiAnglePromptTemplate?.trim() ?? '';
  if (
    legacyMultiAngle
    && legacyMultiAngle !== DEFAULT_MULTI_ANGLE_PROMPT_TEMPLATE
    && !normalized['multiAngle.default']?.template
  ) {
    normalized['multiAngle.default'] = {
      ...(normalized['multiAngle.default'] ?? { updatedAt: Date.now() }),
      template: legacyMultiAngle,
    };
  }

  const legacyLighting = legacyTemplates.lightingPromptTemplate?.trim() ?? '';
  if (
    legacyLighting
    && legacyLighting !== DEFAULT_LIGHTING_PROMPT_TEMPLATE
    && legacyLighting.includes('{{consistencyPrompt}}')
    && !normalized['lighting.default']?.template
  ) {
    normalized['lighting.default'] = {
      ...(normalized['lighting.default'] ?? { updatedAt: Date.now() }),
      template: legacyLighting,
    };
  }

  return normalized;
}

function normalizePromptPreset(input: unknown): PromptPreset | null {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const raw = input as Partial<PromptPreset>;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
  if (!id || !prompt) {
    return null;
  }

  const name = typeof raw.name === 'string' && raw.name.trim()
    ? raw.name.trim()
    : 'Untitled preset';
  const createdAt = typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt)
    ? raw.createdAt
    : Date.now();
  const updatedAt = typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt)
    ? raw.updatedAt
    : createdAt;

  return { id, name, prompt, createdAt, updatedAt };
}

function normalizePromptPresets(input: unknown): PromptPreset[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const seen = new Set<string>();
  const presets: PromptPreset[] = [];
  input.forEach((item) => {
    const preset = normalizePromptPreset(item);
    if (!preset || seen.has(preset.id)) {
      return;
    }
    seen.add(preset.id);
    presets.push(preset);
  });
  return presets.slice(0, 200);
}

function createPromptPresetId(): string {
  return `prompt-preset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizePromptPresetInput(input: { name: string; prompt: string }): PromptPreset | null {
  const prompt = input.prompt.trim();
  if (!prompt) {
    return null;
  }

  const now = Date.now();
  const name = input.name.trim() || 'Untitled preset';
  return {
    id: createPromptPresetId(),
    name,
    prompt,
    createdAt: now,
    updatedAt: now,
  };
}

export function hasConfiguredApiKey(apiKeys: ProviderApiKeys): boolean {
  return getConfiguredApiKeyCount(apiKeys) > 0;
}

export function getConfiguredApiKeyCount(
  apiKeys: ProviderApiKeys,
  providerIds?: readonly string[]
): number {
  const keysToCount = providerIds
    ? providerIds.map((providerId) => apiKeys[providerId] ?? '')
    : Object.values(apiKeys);

  return keysToCount.reduce((count, key) => {
    return normalizeApiKey(key).length > 0 ? count + 1 : count;
  }, 0);
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      isHydrated: false,
      apiKeys: {},
      agnesApiKey: '',
      grsaiNanoBananaProModel: DEFAULT_GRSAI_NANO_BANANA_PRO_MODEL,
      hideProviderGuidePopover: false,
      downloadPresetPaths: [],
      useUploadFilenameAsNodeTitle: true,
      storyboardGenKeepStyleConsistent: true,
      storyboardGenDisableTextInImage: true,
      storyboardGenAutoInferEmptyFrame: true,
      ignoreAtTagWhenCopyingAndGenerating: true,
      appendParameterConstraintsToPrompt: false,
      collapseNodeActionToolbarByDefault: false,
      showNodePayloadPreview: false,
      enableAiTextStreaming: true,
      enableStoryboardGenGridPreviewShortcut: false,
      showStoryboardGenAdvancedRatioControls: false,
      useLegacyPanoramaControlDirection: false,
      panoramaControlSensitivity: 'medium',
      canvasMouseBindingPreset: 'default',
      canvasMouseBindings: cloneCanvasMouseBindings(DEFAULT_CANVAS_MOUSE_BINDINGS),
      enableCanvasWasdPan: false,
      canvasWasdPanSensitivity: 60,
      uiRadiusPreset: 'default',
      themeTonePreset: 'neutral',
      accentColor: '#3B82F6',
      canvasEdgeRoutingMode: 'spline',
      autoCheckAppUpdateOnLaunch: false,
      enableUpdateDialog: true,
      promptDefaultLanguage: 'zh',
      promptTemplateOverrides: {},
      promptPresets: [],
      textAgents: [],
      imageHostSettings: normalizeImageHostSettings(DEFAULT_IMAGE_HOST_SETTINGS),
      audioGenerationSettings: normalizeAudioGenerationSettings(DEFAULT_AUDIO_GENERATION_SETTINGS),
      multiAnglePromptTemplate: DEFAULT_MULTI_ANGLE_PROMPT_TEMPLATE,
      lightingPromptTemplate: DEFAULT_LIGHTING_PROMPT_TEMPLATE,
      dreaminaStatus: null,
      lastModelConfigByPanel: {},
      setProviderApiKey: (providerId, key) =>
        set((state) => ({
          apiKeys: {
            ...state.apiKeys,
            [providerId]: normalizeApiKey(key),
          },
        })),
      setAgnesApiKey: (key) => set({ agnesApiKey: normalizeApiKey(key) }),
      setGrsaiNanoBananaProModel: (model) =>
        set({
          grsaiNanoBananaProModel: normalizeGrsaiNanoBananaProModel(model),
        }),
      setHideProviderGuidePopover: (hide) => set({ hideProviderGuidePopover: hide }),
      setDownloadPresetPaths: (paths) => {
        const uniquePaths = Array.from(
          new Set(paths.map((path) => path.trim()).filter((path) => path.length > 0))
        ).slice(0, 8);
        set({ downloadPresetPaths: uniquePaths });
      },
      setUseUploadFilenameAsNodeTitle: (enabled) => set({ useUploadFilenameAsNodeTitle: enabled }),
      setStoryboardGenKeepStyleConsistent: (enabled) =>
        set({ storyboardGenKeepStyleConsistent: enabled }),
      setStoryboardGenDisableTextInImage: (enabled) =>
        set({ storyboardGenDisableTextInImage: enabled }),
      setStoryboardGenAutoInferEmptyFrame: (enabled) =>
        set({ storyboardGenAutoInferEmptyFrame: enabled }),
      setIgnoreAtTagWhenCopyingAndGenerating: (enabled) =>
        set({ ignoreAtTagWhenCopyingAndGenerating: enabled }),
      setAppendParameterConstraintsToPrompt: (enabled) =>
        set({ appendParameterConstraintsToPrompt: enabled }),
      setCollapseNodeActionToolbarByDefault: (enabled) =>
        set({ collapseNodeActionToolbarByDefault: enabled }),
      setShowNodePayloadPreview: (enabled) =>
        set({ showNodePayloadPreview: enabled }),
      setEnableAiTextStreaming: (enabled) =>
        set({ enableAiTextStreaming: enabled }),
      setEnableStoryboardGenGridPreviewShortcut: (enabled) =>
        set({ enableStoryboardGenGridPreviewShortcut: enabled }),
      setShowStoryboardGenAdvancedRatioControls: (enabled) =>
        set({ showStoryboardGenAdvancedRatioControls: enabled }),
      setUseLegacyPanoramaControlDirection: (enabled) =>
        set({ useLegacyPanoramaControlDirection: enabled }),
      setPanoramaControlSensitivity: (sensitivity) =>
        set({ panoramaControlSensitivity: normalizePanoramaControlSensitivity(sensitivity) }),
      setCanvasMouseBindingPreset: (preset) => {
        const normalizedPreset = normalizeCanvasMouseBindingPreset(preset);
        set((state) => ({
          canvasMouseBindingPreset: normalizedPreset,
          canvasMouseBindings: normalizedPreset === 'custom'
            ? normalizeCanvasMouseBindings(state.canvasMouseBindings)
            : bindingsForCanvasMousePreset(normalizedPreset),
        }));
      },
      setCanvasMouseBindings: (bindings) =>
        set({
          canvasMouseBindingPreset: 'custom',
          canvasMouseBindings: normalizeCanvasMouseBindings(bindings),
        }),
      setCanvasMouseBinding: (slot, action) =>
        set((state) => ({
          canvasMouseBindingPreset: 'custom',
          canvasMouseBindings: {
            ...normalizeCanvasMouseBindings(state.canvasMouseBindings),
            [slot]: normalizeCanvasMouseAction(action, DEFAULT_CANVAS_MOUSE_BINDINGS[slot]),
          },
        })),
      resetCanvasMouseBindingsToPreset: (preset) =>
        set({
          canvasMouseBindingPreset: preset,
          canvasMouseBindings: bindingsForCanvasMousePreset(preset),
        }),
      setEnableCanvasWasdPan: (enabled) => set({ enableCanvasWasdPan: enabled }),
      setCanvasWasdPanSensitivity: (sensitivity) =>
        set({ canvasWasdPanSensitivity: normalizeCanvasWasdPanSensitivity(sensitivity) }),
      setUiRadiusPreset: (uiRadiusPreset) => set({ uiRadiusPreset }),
      setThemeTonePreset: (themeTonePreset) => set({ themeTonePreset }),
      setAccentColor: (color) => set({ accentColor: normalizeHexColor(color) }),
      setCanvasEdgeRoutingMode: (canvasEdgeRoutingMode) =>
        set({ canvasEdgeRoutingMode: normalizeCanvasEdgeRoutingMode(canvasEdgeRoutingMode) }),
      setAutoCheckAppUpdateOnLaunch: (enabled) => set({ autoCheckAppUpdateOnLaunch: enabled }),
      setEnableUpdateDialog: (enabled) => set({ enableUpdateDialog: enabled }),
      setPromptDefaultLanguage: (language) =>
        set({ promptDefaultLanguage: normalizePromptLanguage(language, 'zh') }),
      setPromptTemplateLanguage: (id, language) =>
        set((state) => {
          const existing = state.promptTemplateOverrides[id];
          const override = normalizePromptTemplateOverride(
            id,
            {
              ...existing,
              language,
              updatedAt: Date.now(),
            },
            state.promptDefaultLanguage
          );
          return {
            promptTemplateOverrides: setOverrideInMap(
              state.promptTemplateOverrides,
              id,
              override
            ),
          };
        }),
      setPromptTemplateOverride: (id, template, language) =>
        set((state) => {
          const existing = state.promptTemplateOverrides[id];
          const override = normalizePromptTemplateOverride(
            id,
            {
              ...existing,
              language: language ?? existing?.language,
              template,
              updatedAt: Date.now(),
            },
            state.promptDefaultLanguage
          );
          const nextState: Partial<SettingsState> = {
            promptTemplateOverrides: setOverrideInMap(
              state.promptTemplateOverrides,
              id,
              override
            ),
          };
          if (id === 'multiAngle.default') {
            nextState.multiAnglePromptTemplate =
              override?.template ?? DEFAULT_MULTI_ANGLE_PROMPT_TEMPLATE;
          }
          if (id === 'lighting.default') {
            nextState.lightingPromptTemplate = override?.template ?? DEFAULT_LIGHTING_PROMPT_TEMPLATE;
          }
          return nextState;
        }),
      resetPromptTemplate: (id) =>
        set((state) => {
          const nextState: Partial<SettingsState> = {
            promptTemplateOverrides: setOverrideInMap(state.promptTemplateOverrides, id, undefined),
          };
          if (id === 'multiAngle.default') {
            nextState.multiAnglePromptTemplate = DEFAULT_MULTI_ANGLE_PROMPT_TEMPLATE;
          }
          if (id === 'lighting.default') {
            nextState.lightingPromptTemplate = DEFAULT_LIGHTING_PROMPT_TEMPLATE;
          }
          return nextState;
        }),
      addPromptPreset: (presetInput) => {
        const preset = normalizePromptPresetInput(presetInput);
        if (!preset) {
          return null;
        }
        set((state) => ({
          promptPresets: [preset, ...state.promptPresets].slice(0, 200),
        }));
        return preset;
      },
      updatePromptPreset: (id, patch) =>
        set((state) => ({
          promptPresets: state.promptPresets.map((preset) => {
            if (preset.id !== id) {
              return preset;
            }
            const name = patch.name !== undefined ? patch.name.trim() : preset.name;
            const prompt = patch.prompt !== undefined ? patch.prompt.trim() : preset.prompt;
            if (!prompt) {
              return preset;
            }
            return {
              ...preset,
              name: name || 'Untitled preset',
              prompt,
              updatedAt: Date.now(),
            };
          }),
        })),
      deletePromptPreset: (id) =>
        set((state) => ({
          promptPresets: state.promptPresets.filter((preset) => preset.id !== id),
        })),
      addTextAgent: () => {
        const agent = createDefaultTextAgent();
        set((state) => ({
          textAgents: [agent, ...state.textAgents].slice(0, 200),
        }));
        return agent;
      },
      updateTextAgent: (id, patch) =>
        set((state) => ({
          textAgents: state.textAgents.map((agent) => {
            if (agent.id !== id) {
              return agent;
            }
            return {
              ...agent,
              ...patch,
              id: agent.id,
              createdAt: agent.createdAt,
              updatedAt: Date.now(),
            };
          }),
        })),
      moveTextAgent: (id, direction) =>
        set((state) => {
          const fromIndex = state.textAgents.findIndex((agent) => agent.id === id);
          const toIndex = fromIndex + direction;
          if (
            fromIndex < 0
            || toIndex < 0
            || toIndex >= state.textAgents.length
            || fromIndex === toIndex
          ) {
            return {};
          }
          const textAgents = [...state.textAgents];
          const [agent] = textAgents.splice(fromIndex, 1);
          textAgents.splice(toIndex, 0, {
            ...agent,
            updatedAt: Date.now(),
          });
          return { textAgents };
        }),
      deleteTextAgent: (id) =>
        set((state) => ({
          textAgents: state.textAgents.filter((agent) => agent.id !== id),
        })),
      setImageHostSettings: (settings) =>
        set({ imageHostSettings: normalizeImageHostSettings(settings) }),
      setAudioGenerationSettings: (settings) =>
        set({ audioGenerationSettings: normalizeAudioGenerationSettings(settings) }),
      setMultiAnglePromptTemplate: (template) =>
        set((state) => {
          const nextTemplate = template.trim() || DEFAULT_MULTI_ANGLE_PROMPT_TEMPLATE;
          const override = normalizePromptTemplateOverride(
            'multiAngle.default',
            {
              ...state.promptTemplateOverrides['multiAngle.default'],
              template: nextTemplate,
              updatedAt: Date.now(),
            },
            state.promptDefaultLanguage
          );
          return {
            multiAnglePromptTemplate: nextTemplate,
            promptTemplateOverrides: setOverrideInMap(
              state.promptTemplateOverrides,
              'multiAngle.default',
              override
            ),
          };
        }),
      setLightingPromptTemplate: (template) =>
        set((state) => {
          const nextTemplate = (() => {
            const trimmed = template.trim();
            if (!trimmed) return DEFAULT_LIGHTING_PROMPT_TEMPLATE;
            return trimmed;
          })();
          const override = normalizePromptTemplateOverride(
            'lighting.default',
            {
              ...state.promptTemplateOverrides['lighting.default'],
              template: nextTemplate,
              updatedAt: Date.now(),
            },
            state.promptDefaultLanguage
          );
          return {
            lightingPromptTemplate: nextTemplate,
            promptTemplateOverrides: setOverrideInMap(
              state.promptTemplateOverrides,
              'lighting.default',
              override
            ),
          };
        }),
      resetMultiAnglePromptTemplate: () =>
        set((state) => ({
          multiAnglePromptTemplate: DEFAULT_MULTI_ANGLE_PROMPT_TEMPLATE,
          promptTemplateOverrides: setOverrideInMap(
            state.promptTemplateOverrides,
            'multiAngle.default',
            undefined
          ),
        })),
      resetLightingPromptTemplate: () =>
        set((state) => ({
          lightingPromptTemplate: DEFAULT_LIGHTING_PROMPT_TEMPLATE,
          promptTemplateOverrides: setOverrideInMap(
            state.promptTemplateOverrides,
            'lighting.default',
            undefined
          ),
        })),
      setDreaminaStatus: (status) => set({ dreaminaStatus: status }),
      setPanelModelConfig: (panelKey, cfg) =>
        set((state) => ({
          lastModelConfigByPanel: {
            ...(state.lastModelConfigByPanel ?? {}),
            [panelKey]: cfg,
          },
        })),
    }),
    {
      name: 'settings-storage',
      version: 20,
      onRehydrateStorage: () => {
        return (_state, error) => {
          if (error) {
            console.error('failed to hydrate settings storage', error);
          }
          useSettingsStore.setState({ isHydrated: true });
        };
      },
      migrate: (persistedState: unknown) => {
        const state = (persistedState ?? {}) as {
          apiKey?: string;
          apiKeys?: ProviderApiKeys;
          agnesApiKey?: string;
          ignoreAtTagWhenCopyingAndGenerating?: boolean;
          appendParameterConstraintsToPrompt?: boolean;
          collapseNodeActionToolbarByDefault?: boolean;
          showNodePayloadPreview?: boolean;
          enableAiTextStreaming?: boolean;
          grsaiNanoBananaProModel?: string;
          hideProviderGuidePopover?: boolean;
          canvasEdgeRoutingMode?: CanvasEdgeRoutingMode | string;
          autoCheckAppUpdateOnLaunch?: boolean;
          enableUpdateDialog?: boolean;
          enableStoryboardGenGridPreviewShortcut?: boolean;
          showStoryboardGenAdvancedRatioControls?: boolean;
          useLegacyPanoramaControlDirection?: boolean;
          panoramaControlSensitivity?: PanoramaControlSensitivity | string;
          canvasMouseBindingPreset?: CanvasMouseBindingPreset | string;
          canvasMouseBindings?: CanvasMouseBindings;
          enableCanvasWasdPan?: boolean;
          canvasWasdPanSensitivity?: number | string;
          storyboardGenAutoInferEmptyFrame?: boolean;
          promptDefaultLanguage?: PromptLanguage;
          promptTemplateOverrides?: PromptTemplateOverrideMap;
          promptPresets?: PromptPreset[];
          textAgents?: TextAgentConfig[];
          imageHostSettings?: ImageHostSettings;
          audioGenerationSettings?: AudioGenerationSettings;
          multiAnglePromptTemplate?: string;
          lightingPromptTemplate?: string;
        };
        const persistedWithoutPricing = { ...((persistedState ?? {}) as Record<string, unknown>) };
        delete persistedWithoutPricing.showNodePrice;
        delete persistedWithoutPricing.priceDisplayCurrencyMode;
        delete persistedWithoutPricing.usdToCnyRate;
        delete persistedWithoutPricing.preferDiscountedPrice;
        delete persistedWithoutPricing.grsaiCreditTierId;

        const migratedApiKeys = normalizeApiKeys(state.apiKeys);
        const ignoreAtTagWhenCopyingAndGenerating =
          state.ignoreAtTagWhenCopyingAndGenerating ?? true;
        const appendParameterConstraintsToPrompt =
          state.appendParameterConstraintsToPrompt ?? false;
        const collapseNodeActionToolbarByDefault =
          state.collapseNodeActionToolbarByDefault ?? false;
        const showNodePayloadPreview = state.showNodePayloadPreview ?? false;
        const enableAiTextStreaming = state.enableAiTextStreaming ?? true;
        const migratedLightingTemplate = (() => {
          const trimmed = state.lightingPromptTemplate?.trim() ?? '';
          if (!trimmed) return DEFAULT_LIGHTING_PROMPT_TEMPLATE;
          // v12+ templates must include {{consistencyPrompt}}. Reset legacy templates.
          if (!trimmed.includes('{{consistencyPrompt}}')) return DEFAULT_LIGHTING_PROMPT_TEMPLATE;
          return trimmed;
        })();
        const promptDefaultLanguage = normalizePromptLanguage(state.promptDefaultLanguage, 'zh');
        const promptTemplateOverrides = normalizePromptTemplateOverrides(
          state.promptTemplateOverrides,
          promptDefaultLanguage,
          {
            multiAnglePromptTemplate: state.multiAnglePromptTemplate,
            lightingPromptTemplate: migratedLightingTemplate,
          }
        );
        const promptPresets = normalizePromptPresets(state.promptPresets);
        const canvasMouseBindingPreset = normalizeCanvasMouseBindingPreset(
          state.canvasMouseBindingPreset
        );
        const canvasMouseBindings = canvasMouseBindingPreset === 'custom'
          ? normalizeCanvasMouseBindings(state.canvasMouseBindings)
          : bindingsForCanvasMousePreset(canvasMouseBindingPreset);
        const textAgents = normalizeTextAgents(state.textAgents);
        const imageHostSettings = normalizeImageHostSettings(state.imageHostSettings);
        const audioGenerationSettings = normalizeAudioGenerationSettings(state.audioGenerationSettings);
        if (Object.keys(migratedApiKeys).length > 0) {
          return {
            ...persistedWithoutPricing,
            isHydrated: true,
            apiKeys: migratedApiKeys,
            agnesApiKey: normalizeApiKey(state.agnesApiKey ?? ''),
            ignoreAtTagWhenCopyingAndGenerating,
            appendParameterConstraintsToPrompt,
            collapseNodeActionToolbarByDefault,
            showNodePayloadPreview,
            enableAiTextStreaming,
            grsaiNanoBananaProModel: normalizeGrsaiNanoBananaProModel(
              state.grsaiNanoBananaProModel
            ),
            hideProviderGuidePopover: state.hideProviderGuidePopover ?? false,
            canvasEdgeRoutingMode: normalizeCanvasEdgeRoutingMode(state.canvasEdgeRoutingMode),
            autoCheckAppUpdateOnLaunch: state.autoCheckAppUpdateOnLaunch ?? false,
            enableUpdateDialog: state.enableUpdateDialog ?? true,
            enableStoryboardGenGridPreviewShortcut:
              state.enableStoryboardGenGridPreviewShortcut ?? false,
            showStoryboardGenAdvancedRatioControls:
              state.showStoryboardGenAdvancedRatioControls ?? false,
            useLegacyPanoramaControlDirection:
              state.useLegacyPanoramaControlDirection ?? false,
            panoramaControlSensitivity: normalizePanoramaControlSensitivity(
              state.panoramaControlSensitivity
            ),
            canvasMouseBindingPreset,
            canvasMouseBindings,
            enableCanvasWasdPan: state.enableCanvasWasdPan ?? false,
            canvasWasdPanSensitivity: normalizeCanvasWasdPanSensitivity(
              state.canvasWasdPanSensitivity
            ),
            storyboardGenAutoInferEmptyFrame: state.storyboardGenAutoInferEmptyFrame ?? true,
            promptDefaultLanguage,
            promptTemplateOverrides,
            promptPresets,
            textAgents,
            imageHostSettings,
            audioGenerationSettings,
            multiAnglePromptTemplate:
              state.multiAnglePromptTemplate?.trim() || DEFAULT_MULTI_ANGLE_PROMPT_TEMPLATE,
            lightingPromptTemplate: migratedLightingTemplate,
          };
        }

        return {
          ...persistedWithoutPricing,
          isHydrated: true,
          apiKeys: state.apiKey ? { ppio: normalizeApiKey(state.apiKey) } : {},
          agnesApiKey: normalizeApiKey(state.agnesApiKey ?? ''),
          ignoreAtTagWhenCopyingAndGenerating,
          appendParameterConstraintsToPrompt,
          collapseNodeActionToolbarByDefault,
          showNodePayloadPreview,
          enableAiTextStreaming,
          grsaiNanoBananaProModel: normalizeGrsaiNanoBananaProModel(
            state.grsaiNanoBananaProModel
          ),
          hideProviderGuidePopover: state.hideProviderGuidePopover ?? false,
          canvasEdgeRoutingMode: normalizeCanvasEdgeRoutingMode(state.canvasEdgeRoutingMode),
          autoCheckAppUpdateOnLaunch: state.autoCheckAppUpdateOnLaunch ?? false,
          enableUpdateDialog: state.enableUpdateDialog ?? true,
          enableStoryboardGenGridPreviewShortcut:
            state.enableStoryboardGenGridPreviewShortcut ?? false,
          showStoryboardGenAdvancedRatioControls:
            state.showStoryboardGenAdvancedRatioControls ?? false,
          useLegacyPanoramaControlDirection:
            state.useLegacyPanoramaControlDirection ?? false,
          panoramaControlSensitivity: normalizePanoramaControlSensitivity(
            state.panoramaControlSensitivity
          ),
          canvasMouseBindingPreset,
          canvasMouseBindings,
          enableCanvasWasdPan: state.enableCanvasWasdPan ?? false,
          canvasWasdPanSensitivity: normalizeCanvasWasdPanSensitivity(
            state.canvasWasdPanSensitivity
          ),
          storyboardGenAutoInferEmptyFrame: state.storyboardGenAutoInferEmptyFrame ?? true,
          promptDefaultLanguage,
          promptTemplateOverrides,
          promptPresets,
          textAgents,
          imageHostSettings,
          audioGenerationSettings,
          multiAnglePromptTemplate:
            state.multiAnglePromptTemplate?.trim() || DEFAULT_MULTI_ANGLE_PROMPT_TEMPLATE,
          lightingPromptTemplate: migratedLightingTemplate,
        };
      },
    }
  )
);
