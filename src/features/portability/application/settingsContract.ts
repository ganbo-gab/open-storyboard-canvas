import type { CustomProviderConfig } from '@/stores/customProvidersStore';
import {
  SETTINGS_BUNDLE_MAX_BYTES,
  type SettingsBundlePayload,
} from './types';
import { isPlainRecord, validateSettingsBundle } from './validation';

const SENSITIVE_KEY_PATTERN = /(?:api[-_]?key|token|password|secret|session|authorization|cookie|credential|dreamina)/i;
const SENSITIVE_HEADER_PATTERN = /^(?:authorization|proxy-authorization|x-api-key|cookie|set-cookie)$/i;
const API_ENDPOINT_PATH_KEY_PATTERN = /(?:endpoint|content|status|result).*path$/i;
const DANGEROUS_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export const GENERAL_FIELDS = [
  'hideProviderGuidePopover',
  'downloadPresetPaths',
  'useUploadFilenameAsNodeTitle',
  'storyboardGenKeepStyleConsistent',
  'storyboardGenDisableTextInImage',
  'storyboardGenAutoInferEmptyFrame',
  'ignoreAtTagWhenCopyingAndGenerating',
  'appendParameterConstraintsToPrompt',
  'collapseNodeActionToolbarByDefault',
  'showNodePayloadPreview',
  'enableAiTextStreaming',
  'enableStoryboardGenGridPreviewShortcut',
  'showStoryboardGenAdvancedRatioControls',
  'useLegacyPanoramaControlDirection',
  'panoramaControlSensitivity',
  'canvasMouseBindingPreset',
  'canvasMouseBindings',
  'enableCanvasWasdPan',
  'canvasWasdPanSensitivity',
  'canvasEdgeRoutingMode',
  'autoCheckAppUpdateOnLaunch',
  'enableUpdateDialog',
] as const;

export const APPEARANCE_FIELDS = ['uiRadiusPreset', 'themeTonePreset', 'accentColor'] as const;
export const PROMPT_FIELDS = [
  'promptDefaultLanguage',
  'promptTemplateOverrides',
  'promptPresets',
  'textAgents',
  'multiAnglePromptTemplate',
  'lightingPromptTemplate',
] as const;
export const MODEL_FIELDS = [
  'grsaiNanoBananaProModel',
  'lastModelConfigByPanel',
  'audioGenerationSettings',
] as const;

const SETTINGS_CATEGORIES = new Set([
  'general',
  'appearance',
  'prompts',
  'models',
  'providers',
  'imageHosting',
]);
const GENERAL_BOOLEAN_FIELDS = new Set([
  'hideProviderGuidePopover',
  'useUploadFilenameAsNodeTitle',
  'storyboardGenKeepStyleConsistent',
  'storyboardGenDisableTextInImage',
  'storyboardGenAutoInferEmptyFrame',
  'ignoreAtTagWhenCopyingAndGenerating',
  'appendParameterConstraintsToPrompt',
  'collapseNodeActionToolbarByDefault',
  'showNodePayloadPreview',
  'enableAiTextStreaming',
  'enableStoryboardGenGridPreviewShortcut',
  'showStoryboardGenAdvancedRatioControls',
  'useLegacyPanoramaControlDirection',
  'enableCanvasWasdPan',
  'autoCheckAppUpdateOnLaunch',
  'enableUpdateDialog',
]);
const CANVAS_MOUSE_BINDING_SLOTS = [
  'leftClick',
  'leftDrag',
  'rightClick',
  'rightDrag',
  'middleClick',
  'middleDrag',
] as const;
const CANVAS_MOUSE_ACTIONS = new Set([
  'none',
  'selectNode',
  'panCanvas',
  'selectionBox',
  'nodeMenu',
]);
const PROVIDER_FIELDS = new Set([
  'id',
  'label',
  'mediaType',
  'baseUrl',
  'endpointPath',
  'modelListEndpointPath',
  'httpMethod',
  'apiStyle',
  'models',
  'supportsWebSearch',
  'extraHeaders',
  'queryParams',
  'responseFormat',
  'supportedResolutions',
  'supportedModelVersions',
  'modelMetadata',
  'extraParams',
  'note',
]);

export function isSensitiveSettingsKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

export function isMachineAbsolutePath(value: string, key = ''): boolean {
  const trimmed = value.trim();
  if (/^file:\/\//i.test(trimmed) || /^[a-zA-Z]:[\\/]/.test(trimmed) || /^\\\\[^\\]/.test(trimmed)) {
    return true;
  }
  if (trimmed.startsWith('//') && !trimmed.startsWith('///')) return true;
  if (!trimmed.startsWith('/')) return false;
  return !API_ENDPOINT_PATH_KEY_PATTERN.test(key);
}

function sanitizeUnknown(value: unknown, key = ''): unknown {
  if (isSensitiveSettingsKey(key)) return undefined;
  if (typeof value === 'string') return isMachineAbsolutePath(value, key) ? undefined : value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeUnknown(item)).filter((item) => item !== undefined);
  }
  if (!isPlainRecord(value)) return value;
  const output: Record<string, unknown> = {};
  for (const [childKey, child] of Object.entries(value)) {
    if (SENSITIVE_HEADER_PATTERN.test(childKey)) continue;
    const sanitized = sanitizeUnknown(child, childKey);
    if (sanitized !== undefined) output[childKey] = sanitized;
  }
  return output;
}

export function sanitizeSettingsCategory(value: Record<string, unknown>): Record<string, unknown> {
  return (sanitizeUnknown(value) ?? {}) as Record<string, unknown>;
}

export function assertSettingsBundleSize(raw: string): void {
  if (new TextEncoder().encode(raw).byteLength > SETTINGS_BUNDLE_MAX_BYTES) {
    throw new Error('Settings file exceeds the 16 MB size limit.');
  }
}

function assertKnownFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string
): void {
  const unknownField = Object.keys(value).find((field) => !allowed.has(field));
  if (unknownField) throw new Error(`${path}.${unknownField} is not supported by this settings schema.`);
}

function assertPortableJson(value: unknown, path: string, depth = 0): void {
  if (depth > 64) throw new Error(`${path} exceeds the maximum nesting depth.`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPortableJson(item, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!isPlainRecord(value)) throw new Error(`${path} contains an unsupported value.`);
  for (const [key, child] of Object.entries(value)) {
    if (DANGEROUS_OBJECT_KEYS.has(key)) throw new Error(`${path}.${key} is not allowed.`);
    if (SENSITIVE_HEADER_PATTERN.test(key) || isSensitiveSettingsKey(key)) {
      throw new Error(`${path}.${key} must be stored in the credentials section.`);
    }
    if (typeof child === 'string' && isMachineAbsolutePath(child, key)) {
      throw new Error(`${path}.${key} contains a machine-specific absolute path.`);
    }
    assertPortableJson(child, `${path}.${key}`, depth + 1);
  }
}

function assertStringArray(value: unknown, path: string): asserts value is string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${path} must be a string array.`);
  }
}

export function parseProviderStructures(value: unknown): CustomProviderConfig[] {
  if (!Array.isArray(value)) throw new Error('providers.items must be an array.');
  const seen = new Set<string>();
  return value.map((item, index) => {
    const path = `providers.items[${index}]`;
    if (!isPlainRecord(item)) throw new Error(`${path} must be an object.`);
    assertKnownFields(item, PROVIDER_FIELDS, path);
    for (const field of ['id', 'label', 'baseUrl', 'apiStyle'] as const) {
      if (typeof item[field] !== 'string' || item[field].trim() === '') {
        throw new Error(`${path}.${field} must be a non-empty string.`);
      }
    }
    if (seen.has(item.id as string)) throw new Error(`${path}.id is duplicated.`);
    seen.add(item.id as string);
    if (item.mediaType !== undefined && !['image', 'video', 'chat'].includes(String(item.mediaType))) {
      throw new Error(`${path}.mediaType is invalid.`);
    }
    if (item.httpMethod !== undefined && item.httpMethod !== 'GET' && item.httpMethod !== 'POST') {
      throw new Error(`${path}.httpMethod is invalid.`);
    }
    if (item.responseFormat !== undefined
      && !['openai-images', 'url-array', 'data-url', 'generic'].includes(String(item.responseFormat))) {
      throw new Error(`${path}.responseFormat is invalid.`);
    }
    if (typeof item.supportsWebSearch !== 'boolean') {
      throw new Error(`${path}.supportsWebSearch must be boolean.`);
    }
    assertStringArray(item.models, `${path}.models`);
    for (const field of ['endpointPath', 'modelListEndpointPath', 'note'] as const) {
      if (item[field] !== undefined && typeof item[field] !== 'string') {
        throw new Error(`${path}.${field} must be a string.`);
      }
    }
    for (const field of ['supportedResolutions', 'supportedModelVersions'] as const) {
      if (item[field] !== undefined) assertStringArray(item[field], `${path}.${field}`);
    }
    for (const field of ['extraHeaders', 'queryParams'] as const) {
      const map = item[field];
      if (map !== undefined
        && (!isPlainRecord(map) || !Object.values(map).every((entry) => typeof entry === 'string'))) {
        throw new Error(`${path}.${field} must be a string map.`);
      }
    }
    if (item.modelMetadata !== undefined) {
      if (!isPlainRecord(item.modelMetadata)) throw new Error(`${path}.modelMetadata must be an object.`);
      for (const [modelId, metadata] of Object.entries(item.modelMetadata)) {
        if (!isPlainRecord(metadata)) throw new Error(`${path}.modelMetadata.${modelId} must be an object.`);
        assertKnownFields(
          metadata,
          new Set(['supportsMultimodal', 'contextWindow', 'maxOutputTokens', 'description']),
          `${path}.modelMetadata.${modelId}`
        );
        if (metadata.supportsMultimodal !== undefined && typeof metadata.supportsMultimodal !== 'boolean') {
          throw new Error(`${path}.modelMetadata.${modelId}.supportsMultimodal must be boolean.`);
        }
        for (const field of ['contextWindow', 'maxOutputTokens'] as const) {
          if (metadata[field] !== undefined && metadata[field] !== null
            && (!Number.isSafeInteger(metadata[field]) || Number(metadata[field]) < 0)) {
            throw new Error(`${path}.modelMetadata.${modelId}.${field} must be a non-negative integer.`);
          }
        }
        if (metadata.description !== undefined && metadata.description !== null
          && typeof metadata.description !== 'string') {
          throw new Error(`${path}.modelMetadata.${modelId}.description must be a string.`);
        }
      }
    }
    if (item.extraParams !== undefined && !isPlainRecord(item.extraParams)) {
      throw new Error(`${path}.extraParams must be an object.`);
    }
    assertPortableJson(item, path);
    return { ...(item as unknown as Omit<CustomProviderConfig, 'apiKey'>), apiKey: '' };
  });
}

function validateGeneralCategory(category: Record<string, unknown>): void {
  assertKnownFields(category, new Set(GENERAL_FIELDS), 'general');
  for (const [field, value] of Object.entries(category)) {
    if (GENERAL_BOOLEAN_FIELDS.has(field)) {
      if (typeof value !== 'boolean') throw new Error(`general.${field} must be boolean.`);
    } else if (field === 'downloadPresetPaths') {
      assertStringArray(value, `general.${field}`);
      if (value.some((path) => isMachineAbsolutePath(path, field))) {
        throw new Error(`general.${field} contains a machine-specific absolute path.`);
      }
    } else if (field === 'panoramaControlSensitivity'
      && !['low', 'medium', 'high'].includes(String(value))) {
      throw new Error(`general.${field} is invalid.`);
    } else if (field === 'canvasMouseBindingPreset'
      && !['default', 'traditional', 'custom'].includes(String(value))) {
      throw new Error(`general.${field} is invalid.`);
    } else if (field === 'canvasMouseBindings') {
      if (!isPlainRecord(value)) throw new Error(`general.${field} must be an object.`);
      assertKnownFields(value, new Set(CANVAS_MOUSE_BINDING_SLOTS), `general.${field}`);
      if (CANVAS_MOUSE_BINDING_SLOTS.some((slot) => !CANVAS_MOUSE_ACTIONS.has(String(value[slot])))) {
        throw new Error(`general.${field} contains an invalid action.`);
      }
    } else if (field === 'canvasWasdPanSensitivity') {
      if (!Number.isFinite(value) || Number(value) < 10 || Number(value) > 180) {
        throw new Error(`general.${field} must be between 10 and 180.`);
      }
    } else if (field === 'canvasEdgeRoutingMode'
      && !['spline', 'orthogonal', 'smartOrthogonal'].includes(String(value))) {
      throw new Error(`general.${field} is invalid.`);
    }
  }
}

function validateAppearanceCategory(category: Record<string, unknown>): void {
  assertKnownFields(category, new Set([...APPEARANCE_FIELDS, 'theme']), 'appearance');
  if (category.uiRadiusPreset !== undefined
    && !['compact', 'default', 'large'].includes(String(category.uiRadiusPreset))) {
    throw new Error('appearance.uiRadiusPreset is invalid.');
  }
  if (category.themeTonePreset !== undefined
    && !['neutral', 'warm', 'cool'].includes(String(category.themeTonePreset))) {
    throw new Error('appearance.themeTonePreset is invalid.');
  }
  if (category.accentColor !== undefined
    && (typeof category.accentColor !== 'string' || !/^#[0-9a-f]{6}$/i.test(category.accentColor))) {
    throw new Error('appearance.accentColor is invalid.');
  }
  if (category.theme !== undefined && category.theme !== 'dark' && category.theme !== 'light') {
    throw new Error('appearance.theme is invalid.');
  }
}

function validatePromptsCategory(category: Record<string, unknown>): void {
  assertKnownFields(category, new Set([...PROMPT_FIELDS, 'favoritePrompts']), 'prompts');
  if (category.promptDefaultLanguage !== undefined
    && category.promptDefaultLanguage !== 'zh' && category.promptDefaultLanguage !== 'en') {
    throw new Error('prompts.promptDefaultLanguage is invalid.');
  }
  for (const field of ['multiAnglePromptTemplate', 'lightingPromptTemplate'] as const) {
    if (category[field] !== undefined && typeof category[field] !== 'string') {
      throw new Error(`prompts.${field} must be a string.`);
    }
  }
  if (category.promptTemplateOverrides !== undefined && !isPlainRecord(category.promptTemplateOverrides)) {
    throw new Error('prompts.promptTemplateOverrides must be an object.');
  }
  if (category.promptPresets !== undefined) {
    if (!Array.isArray(category.promptPresets)) throw new Error('prompts.promptPresets must be an array.');
    for (const [index, preset] of category.promptPresets.entries()) {
      if (!isPlainRecord(preset)
        || typeof preset.id !== 'string' || !preset.id.trim()
        || typeof preset.name !== 'string'
        || typeof preset.prompt !== 'string' || !preset.prompt.trim()
        || !Number.isFinite(preset.createdAt)
        || !Number.isFinite(preset.updatedAt)) {
        throw new Error(`prompts.promptPresets[${index}] is invalid.`);
      }
    }
  }
  if (category.textAgents !== undefined) {
    if (!Array.isArray(category.textAgents)) throw new Error('prompts.textAgents must be an array.');
    for (const [index, agent] of category.textAgents.entries()) {
      if (!isPlainRecord(agent)
        || typeof agent.id !== 'string' || !agent.id.trim()
        || typeof agent.prompt !== 'string' || !agent.prompt.trim()) {
        throw new Error(`prompts.textAgents[${index}] is invalid.`);
      }
    }
  }
  if (category.favoritePrompts !== undefined) {
    if (!isPlainRecord(category.favoritePrompts)) throw new Error('prompts.favoritePrompts must be an object.');
    for (const [id, entry] of Object.entries(category.favoritePrompts)) {
      if (!isPlainRecord(entry)
        || entry.id !== id
        || typeof entry.title !== 'string'
        || typeof entry.prompt !== 'string') {
        throw new Error(`prompts.favoritePrompts.${id} is invalid.`);
      }
    }
  }
}

function validateModelsCategory(category: Record<string, unknown>): void {
  assertKnownFields(category, new Set(MODEL_FIELDS), 'models');
  if (category.grsaiNanoBananaProModel !== undefined
    && (typeof category.grsaiNanoBananaProModel !== 'string' || !category.grsaiNanoBananaProModel.trim())) {
    throw new Error('models.grsaiNanoBananaProModel must be a non-empty string.');
  }
  if (category.lastModelConfigByPanel !== undefined) {
    if (!isPlainRecord(category.lastModelConfigByPanel)) {
      throw new Error('models.lastModelConfigByPanel must be an object.');
    }
    for (const [panel, config] of Object.entries(category.lastModelConfigByPanel)) {
      if (!isPlainRecord(config)
        || typeof config.entryId !== 'string'
        || typeof config.ratio !== 'string'
        || (config.extraParams !== undefined && !isPlainRecord(config.extraParams))) {
        throw new Error(`models.lastModelConfigByPanel.${panel} is invalid.`);
      }
    }
  }
  if (category.audioGenerationSettings !== undefined) {
    const audio = category.audioGenerationSettings;
    if (!isPlainRecord(audio)
      || typeof audio.apiBaseUrl !== 'string'
      || !['server', 'segmented'].includes(String(audio.defaultOutputMode))
      || !Number.isFinite(audio.defaultTimeoutMs)
      || !Array.isArray(audio.voices)
      || !Array.isArray(audio.categories)
      || typeof audio.selectedVoiceId !== 'string'
      || !Array.isArray(audio.models)) {
      throw new Error('models.audioGenerationSettings is invalid.');
    }
  }
}

function validateImageHostingCategory(category: Record<string, unknown>): void {
  assertKnownFields(category, new Set(['enabled', 'provider', 'pixhost', 'seedvault']), 'imageHosting');
  if (typeof category.enabled !== 'boolean'
    || !['pixhost', 'seedvault'].includes(String(category.provider))
    || !isPlainRecord(category.pixhost)
    || !isPlainRecord(category.seedvault)) {
    throw new Error('imageHosting is invalid.');
  }
  assertKnownFields(category.pixhost, new Set(['apiBaseUrl', 'contentType', 'maxThumbnailSize']), 'imageHosting.pixhost');
  assertKnownFields(category.seedvault, new Set(['apiBaseUrl', 'strategyId']), 'imageHosting.seedvault');
  if (![category.pixhost.apiBaseUrl, category.pixhost.contentType, category.pixhost.maxThumbnailSize,
    category.seedvault.apiBaseUrl, category.seedvault.strategyId].every((item) => typeof item === 'string')) {
    throw new Error('imageHosting contains an invalid field.');
  }
}

export function validatePortableSettingsPayload(input: unknown): SettingsBundlePayload {
  const payload = validateSettingsBundle(input);
  for (const [categoryName, category] of Object.entries(payload.categories)) {
    if (!SETTINGS_CATEGORIES.has(categoryName)) throw new Error(`Unknown settings category: ${categoryName}`);
    assertPortableJson(category, categoryName);
    if (categoryName === 'general') validateGeneralCategory(category);
    if (categoryName === 'appearance') validateAppearanceCategory(category);
    if (categoryName === 'prompts') validatePromptsCategory(category);
    if (categoryName === 'models') validateModelsCategory(category);
    if (categoryName === 'providers') {
      assertKnownFields(category, new Set(['items']), 'providers');
      parseProviderStructures(category.items);
    }
    if (categoryName === 'imageHosting') validateImageHostingCategory(category);
  }
  return payload;
}
