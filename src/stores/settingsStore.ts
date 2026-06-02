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

export type UiRadiusPreset = 'compact' | 'default' | 'large';
export type ThemeTonePreset = 'neutral' | 'warm' | 'cool';
export type CanvasEdgeRoutingMode = 'spline' | 'orthogonal' | 'smartOrthogonal';
export type PanoramaControlSensitivity = 'low' | 'medium' | 'high';
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

export interface PromptPreset {
  id: string;
  name: string;
  prompt: string;
  createdAt: number;
  updatedAt: number;
}

interface SettingsState {
  isHydrated: boolean;
  apiKeys: ProviderApiKeys;
  grsaiNanoBananaProModel: string;
  hideProviderGuidePopover: boolean;
  downloadPresetPaths: string[];
  useUploadFilenameAsNodeTitle: boolean;
  storyboardGenKeepStyleConsistent: boolean;
  storyboardGenDisableTextInImage: boolean;
  storyboardGenAutoInferEmptyFrame: boolean;
  ignoreAtTagWhenCopyingAndGenerating: boolean;
  appendParameterConstraintsToPrompt: boolean;
  enableStoryboardGenGridPreviewShortcut: boolean;
  showStoryboardGenAdvancedRatioControls: boolean;
  useLegacyPanoramaControlDirection: boolean;
  panoramaControlSensitivity: PanoramaControlSensitivity;
  uiRadiusPreset: UiRadiusPreset;
  themeTonePreset: ThemeTonePreset;
  accentColor: string;
  canvasEdgeRoutingMode: CanvasEdgeRoutingMode;
  autoCheckAppUpdateOnLaunch: boolean;
  enableUpdateDialog: boolean;
  promptDefaultLanguage: PromptLanguage;
  promptTemplateOverrides: PromptTemplateOverrideMap;
  promptPresets: PromptPreset[];
  multiAnglePromptTemplate: string;
  lightingPromptTemplate: string;
  /** Last-seen Dreamina login status; refreshed by the settings screen on demand. */
  dreaminaStatus?: { loggedIn: boolean; credits: number | null; networkDegraded: boolean } | null;
  /** Per-panel memory of the model/provider/ratio picker selection. */
  lastModelConfigByPanel?: Record<string, { entryId: string; ratio: string; extraParams?: Record<string, unknown> } | undefined>;
  setProviderApiKey: (providerId: string, key: string) => void;
  setGrsaiNanoBananaProModel: (model: string) => void;
  setHideProviderGuidePopover: (hide: boolean) => void;
  setDownloadPresetPaths: (paths: string[]) => void;
  setUseUploadFilenameAsNodeTitle: (enabled: boolean) => void;
  setStoryboardGenKeepStyleConsistent: (enabled: boolean) => void;
  setStoryboardGenDisableTextInImage: (enabled: boolean) => void;
  setStoryboardGenAutoInferEmptyFrame: (enabled: boolean) => void;
  setIgnoreAtTagWhenCopyingAndGenerating: (enabled: boolean) => void;
  setAppendParameterConstraintsToPrompt: (enabled: boolean) => void;
  setEnableStoryboardGenGridPreviewShortcut: (enabled: boolean) => void;
  setShowStoryboardGenAdvancedRatioControls: (enabled: boolean) => void;
  setUseLegacyPanoramaControlDirection: (enabled: boolean) => void;
  setPanoramaControlSensitivity: (sensitivity: PanoramaControlSensitivity) => void;
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
      grsaiNanoBananaProModel: DEFAULT_GRSAI_NANO_BANANA_PRO_MODEL,
      hideProviderGuidePopover: false,
      downloadPresetPaths: [],
      useUploadFilenameAsNodeTitle: true,
      storyboardGenKeepStyleConsistent: true,
      storyboardGenDisableTextInImage: true,
      storyboardGenAutoInferEmptyFrame: true,
      ignoreAtTagWhenCopyingAndGenerating: true,
      appendParameterConstraintsToPrompt: false,
      enableStoryboardGenGridPreviewShortcut: false,
      showStoryboardGenAdvancedRatioControls: false,
      useLegacyPanoramaControlDirection: false,
      panoramaControlSensitivity: 'medium',
      uiRadiusPreset: 'default',
      themeTonePreset: 'neutral',
      accentColor: '#3B82F6',
      canvasEdgeRoutingMode: 'spline',
      autoCheckAppUpdateOnLaunch: false,
      enableUpdateDialog: true,
      promptDefaultLanguage: 'zh',
      promptTemplateOverrides: {},
      promptPresets: [],
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
      setEnableStoryboardGenGridPreviewShortcut: (enabled) =>
        set({ enableStoryboardGenGridPreviewShortcut: enabled }),
      setShowStoryboardGenAdvancedRatioControls: (enabled) =>
        set({ showStoryboardGenAdvancedRatioControls: enabled }),
      setUseLegacyPanoramaControlDirection: (enabled) =>
        set({ useLegacyPanoramaControlDirection: enabled }),
      setPanoramaControlSensitivity: (sensitivity) =>
        set({ panoramaControlSensitivity: normalizePanoramaControlSensitivity(sensitivity) }),
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
      version: 14,
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
          ignoreAtTagWhenCopyingAndGenerating?: boolean;
          appendParameterConstraintsToPrompt?: boolean;
          grsaiNanoBananaProModel?: string;
          hideProviderGuidePopover?: boolean;
          canvasEdgeRoutingMode?: CanvasEdgeRoutingMode | string;
          autoCheckAppUpdateOnLaunch?: boolean;
          enableUpdateDialog?: boolean;
          enableStoryboardGenGridPreviewShortcut?: boolean;
          showStoryboardGenAdvancedRatioControls?: boolean;
          useLegacyPanoramaControlDirection?: boolean;
          panoramaControlSensitivity?: PanoramaControlSensitivity | string;
          storyboardGenAutoInferEmptyFrame?: boolean;
          promptDefaultLanguage?: PromptLanguage;
          promptTemplateOverrides?: PromptTemplateOverrideMap;
          promptPresets?: PromptPreset[];
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
        if (Object.keys(migratedApiKeys).length > 0) {
          return {
            ...persistedWithoutPricing,
            isHydrated: true,
            apiKeys: migratedApiKeys,
            ignoreAtTagWhenCopyingAndGenerating,
            appendParameterConstraintsToPrompt,
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
            storyboardGenAutoInferEmptyFrame: state.storyboardGenAutoInferEmptyFrame ?? true,
            promptDefaultLanguage,
            promptTemplateOverrides,
            promptPresets,
            multiAnglePromptTemplate:
              state.multiAnglePromptTemplate?.trim() || DEFAULT_MULTI_ANGLE_PROMPT_TEMPLATE,
            lightingPromptTemplate: migratedLightingTemplate,
          };
        }

        return {
          ...persistedWithoutPricing,
          isHydrated: true,
          apiKeys: state.apiKey ? { ppio: normalizeApiKey(state.apiKey) } : {},
          ignoreAtTagWhenCopyingAndGenerating,
          appendParameterConstraintsToPrompt,
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
          storyboardGenAutoInferEmptyFrame: state.storyboardGenAutoInferEmptyFrame ?? true,
          promptDefaultLanguage,
          promptTemplateOverrides,
          promptPresets,
          multiAnglePromptTemplate:
            state.multiAnglePromptTemplate?.trim() || DEFAULT_MULTI_ANGLE_PROMPT_TEMPLATE,
          lightingPromptTemplate: migratedLightingTemplate,
        };
      },
    }
  )
);
