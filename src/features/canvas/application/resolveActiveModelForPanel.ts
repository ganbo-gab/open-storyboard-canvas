import {
  DEFAULT_IMAGE_MODEL_ID,
  getModelProvider,
  getImageModel,
  listImageModels,
  type ImageModelDefinition,
} from '@/features/canvas/models';
import {
  buildImageModelCatalog,
  type CatalogEntry,
} from '@/features/canvas/application/modelCatalog';
import {
  customProviderAllowsMissingApiKey,
  hasConfiguredCustomProvider,
} from '@/features/canvas/application/providerAvailability';
import type { CustomProviderConfig } from '@/stores/customProvidersStore';
import { isImageCustomProvider, useCustomProvidersStore } from '@/stores/customProvidersStore';
import { useSettingsStore } from '@/stores/settingsStore';

export interface PanelModelConfigValue {
  entryId: string;
  ratio: string;
  extraParams?: Record<string, unknown>;
}

export interface ResolvedPanelModel {
  /** The compound catalog entry id, e.g. `builtin:kie/nano-banana-2` /
   *  `custom:<providerId>:<modelId>` / `dreamina:text2image`. */
  entryId: string;
  /** The model id passed to `canvasAiGateway.submitGenerateImageJob`. For
   *  builtin entries this is the bare id (matches the Rust adapter keys);
   *  for custom / dreamina it's the compound id (the gateway dispatches by
   *  prefix inside `tauriAiGateway`). */
  modelForGateway: string;
  providerId: string;
  providerLabel: string;
  /** The aspect ratio the user picked in the panel picker ("auto" maps to
   *  whatever the underlying adapter treats as unconstrained). */
  ratio: string;
  /** The built-in `ImageModelDefinition` when the selection points at a
   *  built-in model; null for custom / dreamina (those don't need the rich
   *  object because the gateway bypasses `getImageModel`). */
  builtinModel: ImageModelDefinition | null;
  /** The API key needed to call this model — provider-scoped. Empty string
   *  when none is required / set. */
  apiKey: string;
  /** False for Dreamina and explicit no-auth custom providers. */
  requiresApiKey: boolean;
  /** True when the selected provider/model can be submitted right now. */
  usable: boolean;
  /** True when an unusable/missing stored selection was replaced. */
  resolvedByFallback: boolean;
  /** Opaque bag of panel-persisted extra params (e.g. `{ webSearch: true }`
   *  from the ModelConfigPicker "参数" popover). Callers merge it into the
   *  request's `extra_params`. */
  extraParams: Record<string, unknown>;
  /** Ratios advertised by the selected model/provider, when known. */
  supportedRatios: string[];
}

function normalizeRatioValue(value: unknown): string {
  const text = String(value ?? '').trim();
  return /^(auto|smart|智能|自动)$/i.test(text) ? 'auto' : text;
}

function normalizeSupportedRatios(input: unknown, fallback: string[]): string[] {
  if (!Array.isArray(input)) return fallback;
  const ratios = input
    .map((item) => normalizeRatioValue(item))
    .filter(Boolean);
  return ratios.length > 0 ? Array.from(new Set(ratios)) : fallback;
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeEntryRatio(
  entry: Pick<CatalogEntry, 'supportedRatios'>,
  requestedRatio: string,
): string {
  const supported = entry.supportedRatios.map((ratio) => normalizeRatioValue(ratio)).filter(Boolean);
  if (supported.includes(requestedRatio)) return requestedRatio;
  if (supported.includes('auto')) return 'auto';
  return supported[0] ?? 'auto';
}

function resolveBuiltinModel(
  modelId: string,
  ratio: string,
  extraParams: Record<string, unknown>,
  resolvedByFallback: boolean,
): ResolvedPanelModel {
  const settings = useSettingsStore.getState();
  const model = getImageModel(modelId);
  const apiKey = settings.apiKeys[model.providerId] ?? '';
  const provider = getModelProvider(model.providerId);
  return {
    entryId: `builtin:${model.id}`,
    modelForGateway: model.id,
    providerId: model.providerId,
    providerLabel: provider.label || provider.name || model.providerId,
    ratio,
    builtinModel: model,
    apiKey,
    requiresApiKey: true,
    usable: hasText(apiKey),
    resolvedByFallback,
    extraParams,
    supportedRatios: model.aspectRatios.map((item) => item.value),
  };
}

function parseCustomEntryId(entryId: string): { providerId: string; modelId: string } | null {
  const rest = entryId.slice('custom:'.length);
  const separatorIndex = rest.indexOf(':');
  if (separatorIndex <= 0) return null;
  return {
    providerId: rest.slice(0, separatorIndex),
    modelId: rest.slice(separatorIndex + 1),
  };
}

function resolveCustomModel(
  entryId: string,
  ratio: string,
  extraParams: Record<string, unknown>,
  customProviders: readonly CustomProviderConfig[],
  catalog: readonly CatalogEntry[],
  resolvedByFallback: boolean,
): ResolvedPanelModel {
  const parsed = parseCustomEntryId(entryId);
  const providerId = parsed?.providerId ?? '';
  const cfg = customProviders.find((provider) => provider.id === providerId);
  const isImageProvider = cfg ? isImageCustomProvider(cfg) : false;
  const catalogEntry = catalog.find((entry) => entry.id === entryId);
  const allowsMissingApiKey = cfg ? customProviderAllowsMissingApiKey(cfg) : false;
  const supportedRatios = catalogEntry?.supportedRatios ?? normalizeSupportedRatios(
    cfg?.extraParams?.supportedRatios,
    ['auto', '16:9', '1:1']
  );
  return {
    entryId,
    modelForGateway: entryId,
    providerId,
    providerLabel: cfg?.label ?? providerId,
    ratio,
    builtinModel: null,
    apiKey: cfg?.apiKey ?? '',
    requiresApiKey: !allowsMissingApiKey,
    usable: isImageProvider && (catalogEntry?.usable ?? (cfg ? hasConfiguredCustomProvider(cfg) : false)),
    resolvedByFallback,
    extraParams,
    supportedRatios,
  };
}

function resolveDreaminaModel(
  entryId: string,
  ratio: string,
  extraParams: Record<string, unknown>,
  catalog: readonly CatalogEntry[],
  resolvedByFallback: boolean,
): ResolvedPanelModel {
  const catalogEntry = catalog.find((entry) => entry.id === entryId);
  return {
    entryId,
    modelForGateway: entryId,
    providerId: 'dreamina',
    providerLabel: '即梦 CLI',
    ratio,
    builtinModel: null,
    // Dreamina CLI uses local login session, no API key handshake needed.
    apiKey: '',
    requiresApiKey: false,
    usable: catalogEntry?.usable ?? false,
    resolvedByFallback,
    extraParams,
    supportedRatios: catalogEntry?.supportedRatios ?? ['auto', '16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
  };
}

function resolveAgnesModel(
  entryId: string,
  ratio: string,
  extraParams: Record<string, unknown>,
  catalog: readonly CatalogEntry[],
  resolvedByFallback: boolean,
): ResolvedPanelModel {
  const settings = useSettingsStore.getState();
  const catalogEntry = catalog.find((entry) => entry.id === entryId);
  return {
    entryId,
    modelForGateway: entryId,
    providerId: 'agnes',
    providerLabel: 'Agnes',
    ratio,
    builtinModel: null,
    apiKey: settings.agnesApiKey,
    requiresApiKey: true,
    usable: hasText(settings.agnesApiKey) && (catalogEntry?.usable ?? false),
    resolvedByFallback,
    extraParams,
    supportedRatios: catalogEntry?.supportedRatios ?? ['auto', '16:9', '9:16', '1:1', '4:3', '3:4'],
  };
}

function resolvePanelModelConfig(
  config: PanelModelConfigValue,
  customProviders: readonly CustomProviderConfig[],
  catalog: readonly CatalogEntry[],
  resolvedByFallback: boolean,
): ResolvedPanelModel {
  const entryId = config.entryId;
  const ratio = normalizeRatioValue(config.ratio) || 'auto';
  const extraParams = config.extraParams ?? {};

  if (entryId.startsWith('builtin:')) {
    return resolveBuiltinModel(
      entryId.slice('builtin:'.length),
      ratio,
      extraParams,
      resolvedByFallback
    );
  }

  if (entryId.startsWith('dreamina:')) {
    return resolveDreaminaModel(entryId, ratio, extraParams, catalog, resolvedByFallback);
  }

  if (entryId.startsWith('agnes:image:')) {
    return resolveAgnesModel(entryId, ratio, extraParams, catalog, resolvedByFallback);
  }

  if (entryId.startsWith('custom:')) {
    return resolveCustomModel(entryId, ratio, extraParams, customProviders, catalog, resolvedByFallback);
  }

  // Unknown prefix: preserve the old behavior as the last-resort candidate,
  // but let the caller's fallback pass replace it first when possible.
  return resolveBuiltinModel(DEFAULT_IMAGE_MODEL_ID, ratio, extraParams, resolvedByFallback);
}

function pickFirstConfiguredBuiltinModel(): ImageModelDefinition | null {
  const apiKeys = useSettingsStore.getState().apiKeys;
  return listImageModels().find((model) => hasText(apiKeys[model.providerId])) ?? null;
}

/**
 * Pull the last-used model config for a given panel from settings, fall back
 * to the first usable configured provider/model, and expand it into everything a panel
 * submit handler (`SelectedNodeOverlay.handleSubmitPrompt`, etc.) needs to
 * call `canvasAiGateway.submitGenerateImageJob` + `setApiKey`.
 *
 * Keeping this resolution in one place lets every panel honour the user's
 * per-panel pick (ModelConfigPicker writes to
 * `settingsStore.lastModelConfigByPanel[panelKey]`) instead of hard-coding
 * DEFAULT_IMAGE_MODEL_ID.
 */
export function resolveActiveModelForPanel(
  panelKey: string,
  override?: PanelModelConfigValue | null,
): ResolvedPanelModel {
  const settings = useSettingsStore.getState();
  const customProviders = useCustomProvidersStore.getState().providers;
  const catalog = buildImageModelCatalog({
    customProviders,
    dreaminaStatus: settings.dreaminaStatus,
    agnesApiKey: settings.agnesApiKey,
  });
  const requested = override ?? settings.lastModelConfigByPanel?.[panelKey] ?? null;
  const requestedResolved = requested
    ? resolvePanelModelConfig(requested, customProviders, catalog, false)
    : null;

  if (requestedResolved?.usable) {
    return requestedResolved;
  }

  const firstUsableCatalogEntry = catalog.find((entry) => entry.usable);
  if (firstUsableCatalogEntry) {
    const requestedRatio = normalizeRatioValue(requested?.ratio ?? 'auto') || 'auto';
    const ratio = normalizeEntryRatio(firstUsableCatalogEntry, requestedRatio);
    return resolvePanelModelConfig(
      {
        entryId: firstUsableCatalogEntry.id,
        ratio,
      },
      customProviders,
      catalog,
      true
    );
  }

  const firstConfiguredBuiltin = pickFirstConfiguredBuiltinModel();
  if (firstConfiguredBuiltin) {
    return resolveBuiltinModel(
      firstConfiguredBuiltin.id,
      normalizeRatioValue(requested?.ratio ?? 'auto') || 'auto',
      {},
      true
    );
  }

  if (requestedResolved) {
    return requestedResolved;
  }

  return resolveBuiltinModel(
    DEFAULT_IMAGE_MODEL_ID,
    'auto',
    {},
    true
  );
}
