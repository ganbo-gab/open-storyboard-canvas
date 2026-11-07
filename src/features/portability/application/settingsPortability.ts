import { importedImageHostSettings } from '@/features/settings/imageHostSettings';
import packageMetadata from '../../../../package.json';
import { useCustomProvidersStore, type CustomProviderConfig } from '@/stores/customProvidersStore';
import {
  useChannelStore,
  migrateLegacyProviders, isSpecialLegacyProvider, type ChannelRecord,
} from '@/features/channels/store/channelStore';
import { channelPersistenceStorage } from '@/features/channels/store/channelPersistence';
import { usePromptLibraryStore } from '@/stores/promptLibraryStore';
import {
  DEFAULT_ACCENT_COLOR,
  normalizeImageHostSettings,
  useSettingsStore,
} from '@/stores/settingsStore';
import { useThemeStore } from '@/stores/themeStore';
import {
  SETTINGS_BUNDLE_FORMAT,
  SETTINGS_BUNDLE_SCHEMA_VERSION,
  type SettingsBundlePayload,
  type SettingsCategoryDiff,
  type SettingsFieldDiff,
  type SettingsPreviewValue,
} from './types';
import { isPlainRecord } from './validation';
import {
  APPEARANCE_FIELDS,
  GENERAL_FIELDS,
  MODEL_FIELDS,
  PROMPT_FIELDS,
  assertSettingsBundleSize,
  isMachineAbsolutePath,
  isSensitiveSettingsKey,
  parseProviderStructures,
  parseChannelRecords,
  sanitizeSettingsCategory,
  validatePortableSettingsPayload,
} from './settingsContract';

import { isPortableCredentialReference, isPortableSecretRef, redactPortableCredentials } from './credentialRedaction';
import { secretRefFromToken, secretToken } from '@/features/secrets/secretStore';
export { assertSettingsBundleSize } from './settingsContract';

function pickFields<T extends object, K extends readonly (keyof T)[]>(source: T, fields: K): Pick<T, K[number]> {
  const output = {} as Pick<T, K[number]>;
  for (const field of fields) {
    output[field] = source[field];
  }
  return output;
}

function safeProviderStructure(provider: CustomProviderConfig): Record<string, unknown> {
  const { apiKey, ...structure } = provider;
  const credentialRef = provider.credentialRef ?? secretRefFromToken(apiKey) ?? undefined;
  return sanitizeSettingsCategory({ ...structure, ...(credentialRef ? { credentialRef } : {}) });
}

function legacyProviderBackups(): CustomProviderConfig[] {
  const source = channelPersistenceStorage.getItem('legacy_custom_providers');
  if (!source) return [];
  return redactPortableCredentials(JSON.parse(source) as CustomProviderConfig[]).map((provider) => ({
    ...provider,
    apiKey: isPortableSecretRef(provider.credentialRef) ? secretToken(provider.credentialRef)
      : typeof provider.apiKey === 'string' && secretRefFromToken(provider.apiKey) ? provider.apiKey : '',
  }));
}

function portableChannelRecord(record: ChannelRecord): ChannelRecord {
  const migrationIssues = redactPortableCredentials(record.migrationIssues).map((issue) => {
    const sanitized = sanitizeSettingsCategory({ value: issue.value });
    const changed = JSON.stringify(sanitized.value) !== JSON.stringify(issue.value);
    return { ...issue, value: sanitized.value ?? '[redacted: nonportable value]',
      reason: changed ? `${issue.reason} [Settings export redacted machine-specific paths.]` : issue.reason };
  });
  return parseChannelRecords([{ ...record, migrationIssues }])[0];
}

function buildImageHostCategory(): Record<string, unknown> {
  const settings = normalizeImageHostSettings(useSettingsStore.getState().imageHostSettings);
  return sanitizeSettingsCategory({ ...settings,
    extraHeaders: Object.fromEntries(Object.entries(settings.extraHeaders).map(([name, value]) => [name, secretRefFromToken(value) ? value : ''])),
  });
}

/** Settings portability never exports vault values or accepts a credential opt-in. */
export function buildSettingsBundle(): SettingsBundlePayload {
  const settings = useSettingsStore.getState();
  const providers = useCustomProvidersStore.getState().providers.filter(isSpecialLegacyProvider);
  const channels = useChannelStore.getState().channels.map(portableChannelRecord);
  const backups = legacyProviderBackups();
  const promptLibrary = usePromptLibraryStore.getState();
  const categories: SettingsBundlePayload['categories'] = {
    general: sanitizeSettingsCategory(pickFields(settings, GENERAL_FIELDS) as Record<string, unknown>),
    appearance: sanitizeSettingsCategory({
      ...pickFields(settings, APPEARANCE_FIELDS),
      theme: useThemeStore.getState().theme,
    }),
    prompts: sanitizeSettingsCategory({
      ...pickFields(settings, PROMPT_FIELDS),
      favoritePrompts: promptLibrary.favoritePrompts,
    }),
    models: sanitizeSettingsCategory(pickFields(settings, MODEL_FIELDS) as Record<string, unknown>),
    providers: { items: providers.map(safeProviderStructure), channels, legacyBackupIds: backups.map((provider) => provider.id) },
    imageHosting: buildImageHostCategory(),
  };

  const payload: SettingsBundlePayload = {
    format: SETTINGS_BUNDLE_FORMAT,
    schemaVersion: SETTINGS_BUNDLE_SCHEMA_VERSION,
    appVersion: packageMetadata.version,
    createdAt: new Date().toISOString(),
    includesCredentials: false,
    categories,
  };


  return payload;
}

export function serializeSettingsBundle(): string {
  const payload = buildSettingsBundle();
  const serialized = JSON.stringify(payload, null, 2);
  assertSettingsBundleSize(serialized);
  const issues = scanSensitiveSettingsExport(serialized);
  if (issues.length > 0) {
    throw new Error(`Settings export failed the security scan: ${issues.join(', ')}`);
  }
  return serialized;
}

export function parseSettingsBundle(raw: string): SettingsBundlePayload {
  assertSettingsBundleSize(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Settings file is not valid JSON.');
  }
  return validatePortableSettingsPayload(parsed);
}

export function scanSensitiveSettingsExport(raw: string): string[] {
  const issues: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return ['invalid-json'];
  }
  const visit = (value: unknown, path: string, key = ''): void => {
    if (isPortableSecretRef(value)) return;
    if (/^categories\.providers\.channels\[\d+\]\.profile$/.test(path)) {
      try { parseChannelRecords([{ profile: value, origin: 'native', migrationIssues: [], createdAt: 0, updatedAt: 0 }]); }
      catch (error) { issues.push(`${path}:${error instanceof Error ? error.message : String(error)}`); }
      return;
    }
    if (typeof value === 'string' && isMachineAbsolutePath(value, key)) {
      issues.push(`${path}:absolute-path`);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`, key));
      return;
    }
    if (!isPlainRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      if (key !== 'includesCredentials'
        && isSensitiveSettingsKey(key)
        && !isPortableCredentialReference(child)
        && child !== ''
        && child !== false
        && child !== undefined
        && child !== null) {
        issues.push(`${childPath}:credential`);
      }
      visit(child, childPath, key);
    }
  };
  if (JSON.stringify(redactPortableCredentials(parsed)) !== JSON.stringify(parsed)) {
    issues.push('credential-data');
  }
  visit(parsed, '');
  return issues;
}

function currentCategorySnapshot(category: string): Record<string, unknown> {
  return buildSettingsBundle().categories[category] ?? {};
}

function changedTopLevelFields(
  current: Record<string, unknown>,
  incoming: Record<string, unknown>
): string[] {
  return Object.keys(incoming).filter((key) => JSON.stringify(current[key]) !== JSON.stringify(incoming[key]));
}

function summarizePreviewValue(value: unknown): SettingsPreviewValue {
  const serialized = JSON.stringify(value);
  const text = serialized === undefined ? 'not set' : serialized;
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}


export function previewSettingsImport(payload: unknown): SettingsCategoryDiff[] {
  const validated = validatePortableSettingsPayload(payload);
  const diffs: SettingsCategoryDiff[] = Object.entries(validated.categories).map(([category, incoming]) => {
    const current = currentCategorySnapshot(category);
    const changedFields = changedTopLevelFields(current, incoming);
    const currentIsEmpty = Object.keys(current).length === 0;
    const fields: SettingsFieldDiff[] = Object.keys(incoming).map((field) => ({
      field,
      before: summarizePreviewValue(current[field]),
      after: summarizePreviewValue(incoming[field]),
    }));
    return {
      category,
      status: changedFields.length === 0 ? 'unchanged' : currentIsEmpty ? 'add' : 'update',
      changedFields,
      fields,
    };
  });
  return diffs;
}

function pickIncoming(
  incoming: Record<string, unknown>,
  fields: readonly string[]
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(incoming, field)) output[field] = incoming[field];
  }
  return output;
}

export function applySettingsBundle(
  input: unknown,
  selectedCategories: ReadonlySet<string>
): void {
  const payload = validatePortableSettingsPayload(input);
  const settingsSnapshot = useSettingsStore.getState();
  const providersSnapshot = useCustomProvidersStore.getState();
  const channelsSnapshot = useChannelStore.getState();
  const backupSnapshot = ['legacy_custom_providers', 'legacy_custom_providers_raw'].map((name) => ({ name, value: channelPersistenceStorage.getItem(name) }));
  const promptLibrarySnapshot = usePromptLibraryStore.getState();
  const themeSnapshot = useThemeStore.getState();
  const partial: Record<string, unknown> = {};
  let providersToApply: CustomProviderConfig[] | null = null;
  let channelsToApply: ChannelRecord[] | null = null;
  const general = payload.categories.general;
  if (selectedCategories.has('general') && general) {
    Object.assign(partial, pickIncoming(general, GENERAL_FIELDS));
  }
  const appearance = payload.categories.appearance;
  if (selectedCategories.has('appearance') && appearance) {
    Object.assign(partial, pickIncoming(appearance, APPEARANCE_FIELDS));
    // Bundles from before color themes carry only an accent color; a non-default one stays custom.
    if (typeof appearance.accentColor === 'string' && appearance.accentSource === undefined) {
      partial.accentSource = appearance.accentColor.toUpperCase() === DEFAULT_ACCENT_COLOR ? 'theme' : 'custom';
    }
  }
  const prompts = payload.categories.prompts;
  if (selectedCategories.has('prompts') && prompts) {
    Object.assign(partial, pickIncoming(prompts, PROMPT_FIELDS));
  }
  const models = payload.categories.models;
  if (selectedCategories.has('models') && models) {
    Object.assign(partial, pickIncoming(models, MODEL_FIELDS));
  }

  const providersCategory = payload.categories.providers;
  if (selectedCategories.has('providers') && providersCategory) {
    providersToApply = parseProviderStructures(providersCategory.items);
    channelsToApply = payload.schemaVersion === 2 ? parseChannelRecords(providersCategory.channels) : [];
  }

  const imageHosting = payload.categories.imageHosting;
  if (selectedCategories.has('imageHosting') && imageHosting) {
    partial.imageHostSettings = importedImageHostSettings(imageHosting);
  }

  try {
    if (payload.schemaVersion === 1 && providersToApply && selectedCategories.has('providers')) {
      const backups = new Map(legacyProviderBackups().map((provider) => [provider.id, provider]));
      for (const provider of providersToApply) backups.set(provider.id, provider);
      channelPersistenceStorage.setItem('legacy_custom_providers', JSON.stringify([...backups.values()]));
    }
    if (channelsToApply) {
      const incomingIds = new Set(channelsToApply.map(({ profile }) => profile.id));
      const legacyIds = payload.schemaVersion === 1 ? new Set(providersToApply?.map((provider) => provider.id)) : new Set<string>();
      useChannelStore.setState({ channels: channelsToApply,
        migratedLegacyIds: [...new Set([...channelsSnapshot.migratedLegacyIds, ...legacyProviderBackups().map((provider) => provider.id), ...incomingIds])]
          .filter((id) => !legacyIds.has(id)) });
    }
    if (payload.schemaVersion === 1 && providersToApply && selectedCategories.has('providers')) migrateLegacyProviders(providersToApply);
    if (providersToApply) {
      useCustomProvidersStore.setState({ providers: providersToApply });
    }
    if (selectedCategories.has('prompts') && isPlainRecord(prompts?.favoritePrompts)) {
      usePromptLibraryStore.setState({ favoritePrompts: prompts.favoritePrompts as never });
    }
    useSettingsStore.setState(partial as Partial<ReturnType<typeof useSettingsStore.getState>>);
    if (selectedCategories.has('appearance')
      && (appearance?.theme === 'dark' || appearance?.theme === 'light')) {
      useThemeStore.getState().setTheme(appearance.theme);
    }
  } catch (error) {
    useSettingsStore.setState(settingsSnapshot, true);
    for (const { name, value } of backupSnapshot) {
      if (value === null) channelPersistenceStorage.removeItem(name); else channelPersistenceStorage.setItem(name, value);
    }
    useChannelStore.setState(channelsSnapshot, true);
    useCustomProvidersStore.setState(providersSnapshot, true);
    usePromptLibraryStore.setState(promptLibrarySnapshot, true);
    useThemeStore.setState(themeSnapshot, true);
    if (typeof document !== 'undefined') {
      document.documentElement.classList.toggle('dark', themeSnapshot.theme === 'dark');
    }
    throw error;
  }
}
