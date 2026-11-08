import { DEFAULT_CANVAS_MOUSE_BINDINGS, canvasMouseBindingsSchema, canvasLeftDragModeForBindings, normalizeCanvasMousePreferences, type CanvasMouseBindings, type CanvasLeftDragMode, type CanvasWheelMode } from '@/features/settings/canvasMouseSettings';
export { DEFAULT_CANVAS_MOUSE_BINDINGS, TRADITIONAL_CANVAS_MOUSE_BINDINGS } from '@/features/settings/canvasMouseSettings';
export type { CanvasMouseBindings, CanvasMouseBindingSlot, CanvasMouseAction, CanvasMouseClickAction, CanvasMouseDragAction, CanvasMouseBindingPreset, CanvasLeftDragMode, CanvasWheelMode } from '@/features/settings/canvasMouseSettings';
import { DEFAULT_IMAGE_HOST_SETTINGS, normalizeImageHostSettings, imageHostConfigurationError, retireImageHostStorage, type ImageHostSettings } from '@/features/settings/imageHostSettings';
import { normalizeWorkspacePreferences, type WorkspacePreferences } from '@/features/settings/workspacePreferences';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { z } from 'zod';
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
import type { TextAgentConfig } from '@/features/canvas/application/aiText/types';
import { createSecretStorage, protectCredentials } from '@/features/secrets/credentialMigration';
import { credentialState, secretRefFromToken, secretStore, secretToken, type SecretRef } from '@/features/secrets/secretStore';
import { channelPersistenceStorage } from '@/features/channels/store/channelPersistence';

const settingsCredentialStorage = createSecretStorage(retireImageHostStorage(channelPersistenceStorage), 'settings');
// Retired audio adapters never reappear through same-version hydration or migrations.
const persistedSettingsSchema = z.record(z.string(), z.unknown()).transform(({ audioGenerationSettings: _retiredAudio, ...settings }) => settings);

export const agentDefaultSettingsSchema = z.object({
  modelId: z.string().trim().min(1).nullable(),
  executionMode: z.enum(['manual', 'auto', 'full']),
}).strict();
export type AgentDefaultSettings = z.infer<typeof agentDefaultSettingsSchema>;
const persistedAgentDefaultsSchema = z.object({
  modelId: agentDefaultSettingsSchema.shape.modelId.catch(null),
  executionMode: agentDefaultSettingsSchema.shape.executionMode.catch('manual'),
}).catch({ modelId: null, executionMode: 'manual' });

/** Old or invalid settings never opt a user into automatic execution. */
export function normalizeAgentDefaults(value: unknown): AgentDefaultSettings {
  return persistedAgentDefaultsSchema.parse(value);
}

/** Explicit per-conversation selections win; defaults apply only to absent fields. */
export function resolveAgentDefaults(overrides: Partial<AgentDefaultSettings> = {}): AgentDefaultSettings {
  const defaults = useSettingsStore.getState().agentDefaults;
  return agentDefaultSettingsSchema.parse({
    modelId: overrides.modelId === undefined ? defaults.modelId : overrides.modelId,
    executionMode: overrides.executionMode ?? defaults.executionMode,
  });
}

export type UiRadiusPreset = 'compact' | 'default' | 'large';
/** Color themes; each retints the neutral layers and supplies its own accent (see src/index.css). */
export const THEME_TONE_PRESETS = ['neutral', 'warm', 'cool', 'celadon', 'dusk', 'forest', 'rose', 'ocean'] as const;
export type ThemeTonePreset = (typeof THEME_TONE_PRESETS)[number];
const themeTonePresetSchema = z.enum(THEME_TONE_PRESETS);
/** `theme` follows the color theme's accent; `custom` applies `accentColor`. */
export type AccentSource = 'theme' | 'custom';
const accentSourceSchema = z.enum(['theme', 'custom']);
export const DEFAULT_ACCENT_COLOR = '#3B82F6';
export type CanvasEdgeRoutingMode = 'spline' | 'orthogonal' | 'smartOrthogonal';
export type PanoramaControlSensitivity = 'low' | 'medium' | 'high';
export type ProviderApiKeys = Record<string, string>;
export type GenerationNetworkRoute = 'system' | 'direct' | 'custom-proxy';
export interface GenerationNetworkSettings {
  route: GenerationNetworkRoute;
  customProxyUrl: string;
}
export const DEFAULT_GENERATION_NETWORK_SETTINGS: GenerationNetworkSettings = {
  route: 'system',
  customProxyUrl: '',
};
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

export interface PromptPreset {
  id: string;
  name: string;
  prompt: string;
  createdAt: number;
  updatedAt: number;
}

export { DEFAULT_IMAGE_HOST_SETTINGS, normalizeImageHostSettings, type ImageHostSettings } from '@/features/settings/imageHostSettings';

export interface DreaminaStatusSnapshot {
  installed: boolean;
  loggedIn: boolean;
  loginState: 'logged_in' | 'logged_out' | 'unknown';
  credits: number | null;
  networkDegraded: boolean;
  resolvedPath: string | null;
  version: string | null;
  commit: string | null;
  buildTime: string | null;
  vipLevel: string | null;
  accountError: string | null;
  sessionsAvailable: boolean;
  sessionError: string | null;
}

interface SettingsState {
  isHydrated: boolean;
  apiKeys: ProviderApiKeys;
  agnesApiKey: string;
  grsaiNanoBananaProModel: string;
  hideProviderGuidePopover: boolean;
  downloadPresetPaths: string[];
  knowledgeVaultPath: string | null;
  agentDefaults: AgentDefaultSettings;
  workspacePreferences: WorkspacePreferences;
  setWorkspacePreferences: (patch: Partial<WorkspacePreferences>) => void;
  useUploadFilenameAsNodeTitle: boolean;
  storyboardGenKeepStyleConsistent: boolean;
  storyboardGenDisableTextInImage: boolean;
  storyboardGenAutoInferEmptyFrame: boolean;
  ignoreAtTagWhenCopyingAndGenerating: boolean;
  appendParameterConstraintsToPrompt: boolean;
  collapseNodeActionToolbarByDefault: boolean;
  showNodePayloadPreview: boolean;
  generationNetworkSettings: GenerationNetworkSettings;
  enableAiTextStreaming: boolean;
  enableStoryboardGenGridPreviewShortcut: boolean;
  showStoryboardGenAdvancedRatioControls: boolean;
  useLegacyPanoramaControlDirection: boolean;
  panoramaControlSensitivity: PanoramaControlSensitivity;
  canvasMouseBindings: CanvasMouseBindings;
  canvasLeftDragMode: CanvasLeftDragMode;
  canvasWheelMode: CanvasWheelMode;
  enableCanvasWasdPan: boolean;
  canvasWasdPanSensitivity: number;
  uiRadiusPreset: UiRadiusPreset;
  themeTonePreset: ThemeTonePreset;
  accentColor: string;
  accentSource: AccentSource;
  canvasEdgeRoutingMode: CanvasEdgeRoutingMode;
  autoCheckAppUpdateOnLaunch: boolean;
  enableUpdateDialog: boolean;
  promptDefaultLanguage: PromptLanguage;
  promptTemplateOverrides: PromptTemplateOverrideMap;
  promptPresets: PromptPreset[];
  textAgents: TextAgentConfig[];
  imageHostSettings: ImageHostSettings;
  multiAnglePromptTemplate: string;
  lightingPromptTemplate: string;
  /** Last-seen non-sensitive Dreamina runtime diagnostics. */
  dreaminaStatus?: DreaminaStatusSnapshot | null;
  /** Dreamina session used by every generation command. Session 0 is always valid. */
  dreaminaDefaultSessionId: number;
  /** Per-panel memory of the model/provider/ratio picker selection. */
  lastModelConfigByPanel?: Record<string, { entryId: string; ratio: string; extraParams?: Record<string, unknown> } | undefined>;
  setProviderApiKey: (providerId: string, key: string) => Promise<void>;
  setAgnesApiKey: (key: string) => Promise<void>;
  setGrsaiNanoBananaProModel: (model: string) => void;
  setHideProviderGuidePopover: (hide: boolean) => void;
  setDownloadPresetPaths: (paths: string[]) => void;
  setKnowledgeVaultPath: (path: string | null) => void;
  setAgentDefaults: (patch: Partial<AgentDefaultSettings>) => void;
  setUseUploadFilenameAsNodeTitle: (enabled: boolean) => void;
  setStoryboardGenKeepStyleConsistent: (enabled: boolean) => void;
  setStoryboardGenDisableTextInImage: (enabled: boolean) => void;
  setStoryboardGenAutoInferEmptyFrame: (enabled: boolean) => void;
  setIgnoreAtTagWhenCopyingAndGenerating: (enabled: boolean) => void;
  setAppendParameterConstraintsToPrompt: (enabled: boolean) => void;
  setCollapseNodeActionToolbarByDefault: (enabled: boolean) => void;
  setShowNodePayloadPreview: (enabled: boolean) => void;
  setGenerationNetworkSettings: (settings: GenerationNetworkSettings) => void;
  setEnableAiTextStreaming: (enabled: boolean) => void;
  setEnableStoryboardGenGridPreviewShortcut: (enabled: boolean) => void;
  setShowStoryboardGenAdvancedRatioControls: (enabled: boolean) => void;
  setUseLegacyPanoramaControlDirection: (enabled: boolean) => void;
  setPanoramaControlSensitivity: (sensitivity: PanoramaControlSensitivity) => void;
  setCanvasMouseBindings: (bindings: CanvasMouseBindings) => void;
  setCanvasLeftDragMode: (mode: CanvasLeftDragMode) => void;
  setCanvasWheelMode: (mode: CanvasWheelMode) => void;
  setEnableCanvasWasdPan: (enabled: boolean) => void;
  setCanvasWasdPanSensitivity: (sensitivity: number) => void;
  setUiRadiusPreset: (preset: UiRadiusPreset) => void;
  setThemeTonePreset: (preset: ThemeTonePreset) => void;
  setAccentColor: (color: string) => void;
  setAccentSource: (source: AccentSource) => void;
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
  setImageHostSettings: (settings: ImageHostSettings) => Promise<void>;
  setMultiAnglePromptTemplate: (template: string) => void;
  setLightingPromptTemplate: (template: string) => void;
  resetMultiAnglePromptTemplate: () => void;
  resetLightingPromptTemplate: () => void;
  setDreaminaStatus: (status: DreaminaStatusSnapshot | null) => void;
  setDreaminaDefaultSessionId: (sessionId: number) => void;
  setPanelModelConfig: (panelKey: string, cfg: { entryId: string; ratio: string; extraParams?: Record<string, unknown> } | undefined) => void;
}

const HEX_COLOR_PATTERN = /^#?[0-9a-fA-F]{6}$/;

function normalizeHexColor(input: string): string {
  const trimmed = input.trim();
  if (!HEX_COLOR_PATTERN.test(trimmed)) {
    return DEFAULT_ACCENT_COLOR;
  }
  return trimmed.startsWith('#') ? trimmed.toUpperCase() : `#${trimmed.toUpperCase()}`;
}

function normalizeApiKey(input: string): string {
  return input.trim();
}

export function normalizeKnowledgeVaultPath(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const path = input.trim();
  return path && !path.includes('\0') && (path.startsWith('/') || /^[a-z]:[\\/]/i.test(path) || path.startsWith('\\\\')) ? path : null;
}

function normalizeDreaminaSessionId(input: unknown): number {
  const sessionId = typeof input === 'number' ? input : Number(input);
  return Number.isSafeInteger(sessionId) && sessionId >= 0 ? sessionId : 0;
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

export function normalizeGenerationNetworkSettings(input: unknown): GenerationNetworkSettings {
  const record = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Partial<GenerationNetworkSettings>
    : {};
  const route = record.route === 'direct' || record.route === 'custom-proxy'
    ? record.route
    : 'system';
  return {
    route,
    customProxyUrl: typeof record.customProxyUrl === 'string'
      ? record.customProxyUrl.trim()
      : '',
  };
}

function normalizePanoramaControlSensitivity(
  input: PanoramaControlSensitivity | string | null | undefined
): PanoramaControlSensitivity {
  if (input === 'low' || input === 'medium' || input === 'high') {
    return input;
  }
  return 'medium';
}

function normalizeCanvasLeftDragMode(input: unknown): CanvasLeftDragMode {
  if (input === 'select' || input === 'pan') {
    return input;
  }
  return 'select';
}

function normalizeCanvasWheelMode(input: unknown): CanvasWheelMode {
  if (input === 'auto' || input === 'zoom' || input === 'pan') {
    return input;
  }
  return 'auto';
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
    const ref = secretRefFromToken(key);
    return (ref ? credentialState(ref) === 'present' : normalizeApiKey(key).length > 0) ? count + 1 : count;
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
      knowledgeVaultPath: null,
      agentDefaults: normalizeAgentDefaults(undefined),
      workspacePreferences: normalizeWorkspacePreferences(undefined),
      setWorkspacePreferences: (patch) => set((state) => ({ workspacePreferences: normalizeWorkspacePreferences({ ...state.workspacePreferences, ...patch }) })),
      useUploadFilenameAsNodeTitle: true,
      storyboardGenKeepStyleConsistent: true,
      storyboardGenDisableTextInImage: true,
      storyboardGenAutoInferEmptyFrame: true,
      ignoreAtTagWhenCopyingAndGenerating: true,
      appendParameterConstraintsToPrompt: false,
      collapseNodeActionToolbarByDefault: false,
      showNodePayloadPreview: false,
      generationNetworkSettings: { ...DEFAULT_GENERATION_NETWORK_SETTINGS },
      enableAiTextStreaming: true,
      enableStoryboardGenGridPreviewShortcut: false,
      showStoryboardGenAdvancedRatioControls: false,
      useLegacyPanoramaControlDirection: false,
      panoramaControlSensitivity: 'medium',
      canvasMouseBindings: { ...DEFAULT_CANVAS_MOUSE_BINDINGS },
      canvasLeftDragMode: 'pan',
      canvasWheelMode: 'auto',
      enableCanvasWasdPan: false,
      canvasWasdPanSensitivity: 60,
      uiRadiusPreset: 'default',
      themeTonePreset: 'neutral',
      accentColor: DEFAULT_ACCENT_COLOR,
      accentSource: 'theme',
      canvasEdgeRoutingMode: 'spline',
      autoCheckAppUpdateOnLaunch: false,
      enableUpdateDialog: true,
      promptDefaultLanguage: 'zh',
      promptTemplateOverrides: {},
      promptPresets: [],
      textAgents: [],
      imageHostSettings: normalizeImageHostSettings(DEFAULT_IMAGE_HOST_SETTINGS),
      multiAnglePromptTemplate: DEFAULT_MULTI_ANGLE_PROMPT_TEMPLATE,
      lightingPromptTemplate: DEFAULT_LIGHTING_PROMPT_TEMPLATE,
      dreaminaStatus: null,
      dreaminaDefaultSessionId: 0,
      lastModelConfigByPanel: {},
      setProviderApiKey: async (providerId, key) => {
        const ref: SecretRef = secretRefFromToken(key) ?? { namespace: 'settings', id: `provider:${providerId}` };
        if (key) {
          if (!secretRefFromToken(key)) await secretStore.set(ref, normalizeApiKey(key));
          else await secretStore.has(ref);
        } else {
          const previous = secretRefFromToken(useSettingsStore.getState().apiKeys[providerId] ?? '');
          if (previous) await secretStore.delete(previous);
        }
        set((state) => ({ apiKeys: { ...state.apiKeys, [providerId]: key ? secretToken(ref) : '' } }));
      },
      setAgnesApiKey: async (key) => {
        const ref: SecretRef = secretRefFromToken(key) ?? { namespace: 'settings', id: 'agnesApiKey' };
        if (key) {
          if (!secretRefFromToken(key)) await secretStore.set(ref, normalizeApiKey(key));
          else await secretStore.has(ref);
        } else {
          const previous = secretRefFromToken(useSettingsStore.getState().agnesApiKey);
          if (previous) await secretStore.delete(previous);
        }
        set({ agnesApiKey: key ? secretToken(ref) : '' });
      },
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
      setKnowledgeVaultPath: (path) => set({ knowledgeVaultPath: normalizeKnowledgeVaultPath(path) }),
      setAgentDefaults: (patch) => set((state) => ({ agentDefaults: agentDefaultSettingsSchema.parse({ ...state.agentDefaults, ...patch }) })),
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
      setGenerationNetworkSettings: (settings) =>
        set({
          generationNetworkSettings: {
            route: settings.route,
            customProxyUrl: settings.customProxyUrl.trim(),
          },
        }),
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
      setCanvasMouseBindings: (input) => {
        const canvasMouseBindings = canvasMouseBindingsSchema.parse(input);
        set({ canvasMouseBindings, canvasLeftDragMode: canvasLeftDragModeForBindings(canvasMouseBindings) });
      },
      setCanvasLeftDragMode: (mode) => set((state) => {
        const normalized = normalizeCanvasLeftDragMode(mode);
        return { canvasLeftDragMode: normalized,
          canvasMouseBindings: { ...state.canvasMouseBindings, leftDrag: normalized === 'pan' ? 'panCanvas' : 'selectionBox' } };
      }),
      setCanvasWheelMode: (mode) =>
        set({ canvasWheelMode: normalizeCanvasWheelMode(mode) }),
      setEnableCanvasWasdPan: (enabled) => set({ enableCanvasWasdPan: enabled }),
      setCanvasWasdPanSensitivity: (sensitivity) =>
        set({ canvasWasdPanSensitivity: normalizeCanvasWasdPanSensitivity(sensitivity) }),
      setUiRadiusPreset: (uiRadiusPreset) => set({ uiRadiusPreset }),
      setThemeTonePreset: (themeTonePreset) => set({ themeTonePreset }),
      setAccentColor: (color) => set({ accentColor: normalizeHexColor(color), accentSource: 'custom' }),
      setAccentSource: (accentSource) => set({ accentSource }),
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
      setImageHostSettings: async (settings) => {
        const normalized = normalizeImageHostSettings(settings);
        const error = normalized.enabled ? imageHostConfigurationError(normalized) : null;
        if (error) throw new Error(error);
        const safe = await protectCredentials(normalized, 'image-host', 'custom');
        set({ imageHostSettings: safe });
      },
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
      setDreaminaDefaultSessionId: (sessionId) => set({
        dreaminaDefaultSessionId: normalizeDreaminaSessionId(sessionId),
      }),
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
      version: 26,
      storage: createJSONStorage(() => settingsCredentialStorage),
      merge: (persistedState, currentState) => {
        const persisted = persistedSettingsSchema.safeParse(persistedState);
        const data = persisted.success ? persisted.data : {};
        const tone = themeTonePresetSchema.safeParse(data.themeTonePreset);
        const accentSource = accentSourceSchema.safeParse(data.accentSource);
        // Before color themes existed every user had an explicit accent; only a changed one stays custom.
        const persistedAccent = typeof data.accentColor === 'string' ? normalizeHexColor(data.accentColor) : null;
        const { canvasMouseBindingPreset: _legacyMousePreset, ...settings } = data;
        const hasMouseBindings = ['canvasMouseBindings', 'canvasMouseBindingPreset', 'canvasLeftDragMode'].some((field) => Object.hasOwn(data, field));
        const mousePreferences = normalizeCanvasMousePreferences({
          canvasWheelMode: currentState.canvasWheelMode, ...data,
          ...(!hasMouseBindings ? { canvasMouseBindings: currentState.canvasMouseBindings } : {}),
        });
        return { ...currentState, ...settings,
          ...mousePreferences,
          themeTonePreset: tone.success ? tone.data : currentState.themeTonePreset,
          accentSource: accentSource.success
            ? accentSource.data
            : persistedAccent && persistedAccent !== DEFAULT_ACCENT_COLOR ? 'custom' : 'theme',
          imageHostSettings: normalizeImageHostSettings(data.imageHostSettings),
          workspacePreferences: normalizeWorkspacePreferences(data.workspacePreferences),
          agentDefaults: normalizeAgentDefaults(data.agentDefaults) };
      },
      onRehydrateStorage: () => {
        return (_state, error) => {
          if (error) {
            console.error('failed to hydrate settings storage');
          }
          queueMicrotask(() => {
            useSettingsStore.setState({ isHydrated: true });
          });
        };
      },
      migrate: (persistedState: unknown) => {
        const state = (persistedState ?? {}) as {
          apiKey?: string;
          knowledgeVaultPath?: unknown;
          agentDefaults?: unknown;
          apiKeys?: ProviderApiKeys;
          agnesApiKey?: string;
          ignoreAtTagWhenCopyingAndGenerating?: boolean;
          appendParameterConstraintsToPrompt?: boolean;
          collapseNodeActionToolbarByDefault?: boolean;
          showNodePayloadPreview?: boolean;
          generationNetworkSettings?: GenerationNetworkSettings;
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
          canvasLeftDragMode?: unknown;
          canvasWheelMode?: unknown;
          enableCanvasWasdPan?: boolean;
          canvasWasdPanSensitivity?: number | string;
          storyboardGenAutoInferEmptyFrame?: boolean;
          promptDefaultLanguage?: PromptLanguage;
          promptTemplateOverrides?: PromptTemplateOverrideMap;
          promptPresets?: PromptPreset[];
          textAgents?: TextAgentConfig[];
          imageHostSettings?: ImageHostSettings;
          multiAnglePromptTemplate?: string;
          lightingPromptTemplate?: string;
          dreaminaDefaultSessionId?: number;
        };
        const persistedWithoutPricing = { ...(persistedSettingsSchema.safeParse(persistedState).data ?? {}) };
        delete persistedWithoutPricing.showNodePrice;
        delete persistedWithoutPricing.priceDisplayCurrencyMode;
        delete persistedWithoutPricing.usdToCnyRate;
        delete persistedWithoutPricing.preferDiscountedPrice;
        delete persistedWithoutPricing.grsaiCreditTierId;
        delete persistedWithoutPricing.canvasMouseBindingPreset;

        const migratedApiKeys = normalizeApiKeys(state.apiKeys);
        const ignoreAtTagWhenCopyingAndGenerating =
          state.ignoreAtTagWhenCopyingAndGenerating ?? true;
        const appendParameterConstraintsToPrompt =
          state.appendParameterConstraintsToPrompt ?? false;
        const collapseNodeActionToolbarByDefault =
          state.collapseNodeActionToolbarByDefault ?? false;
        const showNodePayloadPreview = state.showNodePayloadPreview ?? false;
        const generationNetworkSettings = normalizeGenerationNetworkSettings(
          state.generationNetworkSettings
        );
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
        const mousePreferences = normalizeCanvasMousePreferences(persistedState);
        const textAgents = normalizeTextAgents(state.textAgents);
        const imageHostSettings = normalizeImageHostSettings(state.imageHostSettings);
        if (Object.keys(migratedApiKeys).length > 0) {
          return {
            ...persistedWithoutPricing,
            isHydrated: true,
            knowledgeVaultPath: normalizeKnowledgeVaultPath(state.knowledgeVaultPath),
            agentDefaults: normalizeAgentDefaults(state.agentDefaults),
            apiKeys: migratedApiKeys,
            agnesApiKey: normalizeApiKey(state.agnesApiKey ?? ''),
            ignoreAtTagWhenCopyingAndGenerating,
            appendParameterConstraintsToPrompt,
            collapseNodeActionToolbarByDefault,
            showNodePayloadPreview,
            generationNetworkSettings,
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
            ...mousePreferences,
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
            multiAnglePromptTemplate:
              state.multiAnglePromptTemplate?.trim() || DEFAULT_MULTI_ANGLE_PROMPT_TEMPLATE,
            lightingPromptTemplate: migratedLightingTemplate,
            dreaminaDefaultSessionId: normalizeDreaminaSessionId(state.dreaminaDefaultSessionId),
          };
        }

        return {
          ...persistedWithoutPricing,
          isHydrated: true,
          knowledgeVaultPath: normalizeKnowledgeVaultPath(state.knowledgeVaultPath),
          agentDefaults: normalizeAgentDefaults(state.agentDefaults),
          apiKeys: state.apiKey ? { ppio: normalizeApiKey(state.apiKey) } : {},
          agnesApiKey: normalizeApiKey(state.agnesApiKey ?? ''),
          ignoreAtTagWhenCopyingAndGenerating,
          appendParameterConstraintsToPrompt,
          collapseNodeActionToolbarByDefault,
          showNodePayloadPreview,
          generationNetworkSettings,
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
          ...mousePreferences,
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
          multiAnglePromptTemplate:
            state.multiAnglePromptTemplate?.trim() || DEFAULT_MULTI_ANGLE_PROMPT_TEMPLATE,
          lightingPromptTemplate: migratedLightingTemplate,
          dreaminaDefaultSessionId: normalizeDreaminaSessionId(state.dreaminaDefaultSessionId),
        };
      },
    }
  )
);
