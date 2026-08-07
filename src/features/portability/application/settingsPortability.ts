import packageMetadata from '../../../../package.json';
import { useCustomProvidersStore, type CustomProviderConfig } from '@/stores/customProvidersStore';
import { usePromptLibraryStore } from '@/stores/promptLibraryStore';
import {
  normalizeAudioGenerationSettings,
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
  sanitizeSettingsCategory,
  validatePortableSettingsPayload,
} from './settingsContract';

export { assertSettingsBundleSize } from './settingsContract';

function pickFields<T extends object, K extends readonly (keyof T)[]>(source: T, fields: K): Pick<T, K[number]> {
  const output = {} as Pick<T, K[number]>;
  for (const field of fields) {
    output[field] = source[field];
  }
  return output;
}

function safeProviderStructure(provider: CustomProviderConfig): Record<string, unknown> {
  const { apiKey: _apiKey, ...structure } = provider;
  return sanitizeSettingsCategory(structure as unknown as Record<string, unknown>);
}

function buildImageHostCategory(): Record<string, unknown> {
  const settings = useSettingsStore.getState().imageHostSettings;
  return {
    enabled: settings.enabled,
    provider: settings.provider,
    pixhost: {
      apiBaseUrl: settings.pixhost.apiBaseUrl,
      contentType: settings.pixhost.contentType,
      maxThumbnailSize: settings.pixhost.maxThumbnailSize,
    },
    seedvault: {
      apiBaseUrl: settings.seedvault.apiBaseUrl,
      strategyId: settings.seedvault.strategyId,
    },
  };
}

export function buildSettingsBundle(includeCredentials: boolean): SettingsBundlePayload {
  const settings = useSettingsStore.getState();
  const providers = useCustomProvidersStore.getState().providers;
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
    providers: { items: providers.map(safeProviderStructure) },
    imageHosting: buildImageHostCategory(),
  };

  const payload: SettingsBundlePayload = {
    format: SETTINGS_BUNDLE_FORMAT,
    schemaVersion: SETTINGS_BUNDLE_SCHEMA_VERSION,
    appVersion: packageMetadata.version,
    createdAt: new Date().toISOString(),
    includesCredentials: includeCredentials,
    categories,
  };

  if (includeCredentials) {
    const customProviderApiKeys = Object.fromEntries(
      providers
        .filter((provider) => provider.apiKey.trim())
        .map((provider) => [provider.id, provider.apiKey])
    );
    payload.credentials = {
      providerApiKeys: { ...settings.apiKeys },
      agnesApiKey: settings.agnesApiKey,
      customProviderApiKeys,
      imageHost: {
        email: settings.imageHostSettings.seedvault.email,
        password: settings.imageHostSettings.seedvault.password,
        token: settings.imageHostSettings.seedvault.token,
      },
    };
  }

  return payload;
}

export function serializeSettingsBundle(includeCredentials: boolean): string {
  const payload = buildSettingsBundle(includeCredentials);
  const serialized = JSON.stringify(payload, null, 2);
  assertSettingsBundleSize(serialized);
  if (!includeCredentials) {
    const issues = scanSensitiveSettingsExport(serialized);
    if (issues.length > 0) {
      throw new Error(`Default settings export failed the security scan: ${issues.join(', ')}`);
    }
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
        && child !== ''
        && child !== false
        && child !== undefined
        && child !== null) {
        issues.push(`${childPath}:credential`);
      }
      visit(child, childPath, key);
    }
  };
  visit(parsed, '');
  return issues;
}

function currentCategorySnapshot(category: string): Record<string, unknown> {
  return buildSettingsBundle(false).categories[category] ?? {};
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
  return {
    kind: 'value',
    text: text.length > 240 ? `${text.slice(0, 237)}...` : text,
  };
}

function configuredCredentialCount(value: unknown): number {
  if (typeof value === 'string') return value.trim() ? 1 : 0;
  if (!isPlainRecord(value)) return 0;
  return Object.values(value).filter((item) => typeof item === 'string' && item.trim()).length;
}

function credentialPreviewValue(value: unknown): SettingsPreviewValue {
  return { kind: 'credential', configuredCount: configuredCredentialCount(value) };
}

function currentCredentialSnapshot(): Record<string, unknown> {
  const settings = useSettingsStore.getState();
  const providers = useCustomProvidersStore.getState().providers;
  return {
    providerApiKeys: settings.apiKeys,
    agnesApiKey: settings.agnesApiKey,
    customProviderApiKeys: Object.fromEntries(
      providers.filter((provider) => provider.apiKey.trim()).map((provider) => [provider.id, provider.apiKey])
    ),
    imageHost: {
      email: settings.imageHostSettings.seedvault.email,
      password: settings.imageHostSettings.seedvault.password,
      token: settings.imageHostSettings.seedvault.token,
    },
  };
}

export function previewSettingsImport(payload: SettingsBundlePayload): SettingsCategoryDiff[] {
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
  if (validated.includesCredentials) {
    const current = currentCredentialSnapshot();
    const incoming = validated.credentials ?? {};
    const credentialFields = ['providerApiKeys', 'agnesApiKey', 'customProviderApiKeys', 'imageHost']
      .filter((field) => Object.prototype.hasOwnProperty.call(incoming, field));
    diffs.push({
      category: 'credentials',
      status: 'conflict',
      changedFields: credentialFields,
      fields: credentialFields.map((field) => ({
        field,
        before: credentialPreviewValue(current[field]),
        after: credentialPreviewValue(incoming[field as keyof typeof incoming]),
        sensitive: true,
      })),
    });
  }
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
  input: SettingsBundlePayload,
  selectedCategories: ReadonlySet<string>
): void {
  const payload = validatePortableSettingsPayload(input);
  const settingsSnapshot = useSettingsStore.getState();
  const providersSnapshot = useCustomProvidersStore.getState();
  const promptLibrarySnapshot = usePromptLibraryStore.getState();
  const themeSnapshot = useThemeStore.getState();
  const partial: Record<string, unknown> = {};
  let providersToApply: CustomProviderConfig[] | null = null;
  const general = payload.categories.general;
  if (selectedCategories.has('general') && general) {
    Object.assign(partial, pickIncoming(general, GENERAL_FIELDS));
  }
  const appearance = payload.categories.appearance;
  if (selectedCategories.has('appearance') && appearance) {
    Object.assign(partial, pickIncoming(appearance, APPEARANCE_FIELDS));
  }
  const prompts = payload.categories.prompts;
  if (selectedCategories.has('prompts') && prompts) {
    Object.assign(partial, pickIncoming(prompts, PROMPT_FIELDS));
  }
  const models = payload.categories.models;
  if (selectedCategories.has('models') && models) {
    Object.assign(partial, pickIncoming(models, MODEL_FIELDS));
    if (models.audioGenerationSettings !== undefined) {
      partial.audioGenerationSettings = normalizeAudioGenerationSettings(models.audioGenerationSettings);
    }
  }

  const providersCategory = payload.categories.providers;
  if (selectedCategories.has('providers') && providersCategory) {
    const apiKeys = payload.includesCredentials && selectedCategories.has('credentials')
      ? payload.credentials?.customProviderApiKeys ?? {}
      : {};
    const providers = parseProviderStructures(providersCategory.items).map((provider) => ({
      ...provider,
      apiKey: apiKeys[provider.id] ?? '',
    }));
    providersToApply = providers;
  }

  const imageHosting = payload.categories.imageHosting;
  if (selectedCategories.has('imageHosting') && imageHosting) {
    const current = useSettingsStore.getState().imageHostSettings;
    const pixhost = isPlainRecord(imageHosting.pixhost) ? imageHosting.pixhost : {};
    const seedvault = isPlainRecord(imageHosting.seedvault) ? imageHosting.seedvault : {};
    const importedCredentials = payload.includesCredentials && selectedCategories.has('credentials')
      ? payload.credentials?.imageHost
      : undefined;
    partial.imageHostSettings = normalizeImageHostSettings({
      ...current,
      ...pickIncoming(imageHosting, ['enabled', 'provider']),
      pixhost: { ...current.pixhost, ...pixhost },
      seedvault: {
        ...current.seedvault,
        ...seedvault,
        ...(importedCredentials ?? {}),
      },
    });
  }

  if (payload.includesCredentials && selectedCategories.has('credentials')) {
    partial.apiKeys = { ...(payload.credentials?.providerApiKeys ?? {}) };
    partial.agnesApiKey = payload.credentials?.agnesApiKey ?? '';
    if (!providersToApply) {
      const customKeys = payload.credentials?.customProviderApiKeys ?? {};
      providersToApply = providersSnapshot.providers.map((provider) => ({
        ...provider,
        apiKey: customKeys[provider.id] ?? provider.apiKey,
      }));
    }
  }
  try {
    if (providersToApply) {
      useCustomProvidersStore.getState().replaceAll(providersToApply);
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
    useCustomProvidersStore.setState(providersSnapshot, true);
    usePromptLibraryStore.setState(promptLibrarySnapshot, true);
    useThemeStore.setState(themeSnapshot, true);
    if (typeof document !== 'undefined') {
      document.documentElement.classList.toggle('dark', themeSnapshot.theme === 'dark');
    }
    throw error;
  }
}
