import { useMemo } from 'react';

import {
  isImageCustomProvider,
  AGNES_PROVIDER_DEFAULTS,
  useCustomProvidersStore,
  type CustomProviderConfig,
} from '@/stores/customProvidersStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { listImageModels, listModelProviders } from '@/features/canvas/models';
import {
  DREAMINA_IMAGE_MODEL_CAPABILITIES,
  DREAMINA_IMAGE_RATIOS,
  DREAMINA_UPSCALE_RESOLUTIONS,
} from './dreaminaCapabilities';
import { hasConfiguredCustomProvider } from './providerAvailability';

/**
 * Unified display-layer catalog of every image-generation target the user can
 * currently pick. Per product direction (fully-custom-provider era), the
 * picker surfaces:
 *   1. Entries defined in 我的配置 (`customProvidersStore`) — one row per
 *      (provider × model), only shown when the provider has an API key or
 *      explicitly declares that no key is required.
 *   2. Dreamina CLI subcommands — only when the local CLI login is active.
 *
 * Built-in KIE / FAL / GRSAI model rows are intentionally NOT surfaced here —
 * users are expected to add them as custom providers in 我的配置. The legacy
 * helpers (`listImageModels`, `listModelProviders`) remain imported so the
 * 内置 · GRSAI card on the settings page keeps working.
 */
export interface CatalogEntry {
  /** Compound id: `custom:<providerId>:<modelId>` | `dreamina:<sub>` | `agnes:image:<modelId>`. */
  id: string;
  kind: 'custom' | 'dreamina' | 'agnes';
  providerId: string;
  providerLabel: string;
  modelId: string;
  modelLabel: string;
  /** Ratios the user marked as supported; may contain 'auto' for smart. */
  supportedRatios: string[];
  /** True when the user can call this entry right now. */
  usable: boolean;
  /** Short reason shown next to the chip when `usable === false`. */
  notReadyReason?: string;
  /** For custom providers: whether user enabled `supportsWebSearch` in 我的配置. */
  supportsWebSearch?: boolean;
  /** Dreamina resolution_type choices per sub-command. Surfaced in
   *  ModelConfigPicker "参数" popover so the user can pick 1k/2k/4k/8k. */
  supportedResolutions?: string[];
  /** Dreamina model_version choices (3.0 / 4.0 / 5.0). For custom
   *  providers this is populated from the user-configured list. */
  supportedModelVersions?: string[];
}

interface DreaminaProviderStatus {
  loggedIn: boolean;
}

interface ImageModelCatalogSnapshot {
  customProviders: readonly CustomProviderConfig[];
  dreaminaStatus?: DreaminaProviderStatus | null;
  agnesApiKey?: string;
}

function normalizeSupportedRatios(rawRatios: unknown, fallback: string[] = ['auto', '16:9']): string[] {
  const source = Array.isArray(rawRatios) && rawRatios.length > 0 ? rawRatios : fallback;
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const rawRatio of source) {
    const text = String(rawRatio ?? '').trim();
    if (!text) continue;
    const ratio = /^(auto|smart|智能|自动)$/i.test(text) ? 'auto' : text;
    if (seen.has(ratio)) continue;
    seen.add(ratio);
    normalized.push(ratio);
  }
  return normalized.length > 0 ? normalized : fallback;
}

export function buildImageModelCatalog({
  customProviders,
  dreaminaStatus,
  agnesApiKey,
}: ImageModelCatalogSnapshot): CatalogEntry[] {
  const entries: CatalogEntry[] = [];

  // 1. Custom providers (我的配置) — one entry per provider × model.
  for (const cfg of customProviders) {
    if (!isImageCustomProvider(cfg)) {
      continue;
    }
    const ratios = normalizeSupportedRatios(
      (cfg.extraParams as { supportedRatios?: unknown } | undefined)?.supportedRatios
    );
    const hasBaseUrl = Boolean(cfg.baseUrl?.trim());
    const hasReadyConfig = hasConfiguredCustomProvider(cfg);
    // Optional extra parameter dimensions the user can surface to the
    // picker (resolution sizes, model versions) — they live on the
    // provider config so each provider can advertise its own values.
    const resolutions = cfg.supportedResolutions;
    const modelVersions = cfg.supportedModelVersions;
    for (const modelId of (cfg.models.length > 0 ? cfg.models : ['default'])) {
      entries.push({
        id: `custom:${cfg.id}:${modelId}`,
        kind: 'custom',
        providerId: cfg.id,
        providerLabel: cfg.label,
        modelId,
        modelLabel: modelId,
        supportedRatios: ratios,
        usable: hasReadyConfig,
        notReadyReason: hasReadyConfig
          ? undefined
          : (hasBaseUrl ? '请在「我的配置」里填入 API Key' : '请在「我的配置」里填入 API 根地址'),
        supportsWebSearch: Boolean(cfg.supportsWebSearch),
        supportedResolutions: (resolutions && resolutions.length > 0) ? resolutions : undefined,
        supportedModelVersions: (modelVersions && modelVersions.length > 0) ? modelVersions : undefined,
      });
    }
  }

  // 2. Dreamina CLI — only when a login session was detected recently.
  //
  // Catalog presents ONE entry per model version rather than per
  // sub-command. The gateway auto-selects text2image vs image2image at
  // submit time based on whether there are reference images. The only
  // exception is "image_upscale" which stays as its own entry because its
  // semantics (no prompt, just HD upscale) are different from generation.
  if (dreaminaStatus?.loggedIn) {
    for (const capability of [...DREAMINA_IMAGE_MODEL_CAPABILITIES].reverse()) {
      const supportsImageInput = capability.commands.includes('image2image');
      entries.push({
        id: `dreamina:${capability.model}`,
        kind: 'dreamina',
        providerId: 'dreamina',
        providerLabel: '即梦 CLI',
        modelId: capability.model,
        modelLabel: `即梦 · ${capability.model}（${supportsImageInput ? '文生图 / 图生图' : '仅文生图'}）`,
        supportedRatios: ['auto', ...DREAMINA_IMAGE_RATIOS],
        usable: true,
        notReadyReason: supportsImageInput ? undefined : '3.x 仅支持文生图；如有参考图请换 4.0+',
        supportedResolutions: [...capability.resolutions],
        // model_version is baked into the entry id; no separate dropdown needed.
        supportedModelVersions: undefined,
      });
    }
    // Upscale is its own entry — it has no prompt, just a single input image.
    entries.push({
      id: `dreamina:upscale`,
      kind: 'dreamina',
      providerId: 'dreamina',
      providerLabel: '即梦 CLI',
      modelId: 'upscale',
      modelLabel: '即梦 · 高清放大',
      supportedRatios: ['auto'],
      usable: true,
      notReadyReason: undefined,
      supportedResolutions: [...DREAMINA_UPSCALE_RESOLUTIONS],
      supportedModelVersions: undefined,
    });
  }

  if (agnesApiKey?.trim()) {
    const supportedRatios = ['auto', '16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '21:9'];
    entries.push(
      {
        id: `agnes:image:${AGNES_PROVIDER_DEFAULTS.models.image21Flash}`,
        kind: 'agnes',
        providerId: 'agnes',
        providerLabel: 'Agnes',
        modelId: AGNES_PROVIDER_DEFAULTS.models.image21Flash,
        modelLabel: 'Agnes Image 2.1 Flash',
        supportedRatios,
        usable: true,
        supportedResolutions: [...AGNES_PROVIDER_DEFAULTS.image21Resolutions],
      },
      {
        id: `agnes:image:${AGNES_PROVIDER_DEFAULTS.models.image20Flash}`,
        kind: 'agnes',
        providerId: 'agnes',
        providerLabel: 'Agnes',
        modelId: AGNES_PROVIDER_DEFAULTS.models.image20Flash,
        modelLabel: 'Agnes Image 2.0 Flash',
        supportedRatios,
        usable: true,
        supportedResolutions: [...AGNES_PROVIDER_DEFAULTS.image20Resolutions],
      }
    );
  }

  return entries;
}

export function useImageModelCatalog(): CatalogEntry[] {
  const customProviders = useCustomProvidersStore((s) => s.providers);
  const dreaminaStatus = useSettingsStore((s) => s.dreaminaStatus);
  const agnesApiKey = useSettingsStore((s) => s.agnesApiKey);
  // Force the hook to still subscribe to apiKeys so we re-render when the
  // user toggles keys (keeps parity with prior behaviour).
  useSettingsStore((s) => s.apiKeys);
  // `listImageModels` / `listModelProviders` remain imported so Vite doesn't
  // prune them and break the settings page that still references them.
  void listImageModels;
  void listModelProviders;

  return useMemo(
    () => buildImageModelCatalog({ customProviders, dreaminaStatus, agnesApiKey }),
    [agnesApiKey, customProviders, dreaminaStatus]
  );
}

/** Human-friendly label for the "智能" ratio sentinel. */
export function formatRatio(r: string): string {
  return r === 'auto' ? '智能' : r;
}
