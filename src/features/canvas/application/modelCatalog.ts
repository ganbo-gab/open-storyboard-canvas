import { useMemo } from 'react';

import {
  isImageCustomProvider,
  type CustomProviderConfig,
} from '@/stores/customProvidersStore';
import { useSettingsStore } from '@/stores/settingsStore';
import {
  DREAMINA_IMAGE_MODEL_CAPABILITIES,
  DREAMINA_IMAGE_RATIOS,
  DREAMINA_UPSCALE_RESOLUTIONS,
} from './dreaminaCapabilities';
import { hasConfiguredCustomProvider } from './providerAvailability';
import { useChannelCatalogProviders, channelModelForProvider, channelParameterValues } from '@/features/channels/application/channelCatalog';
import { listModelModes, type ResolvedMode } from '@/features/channels/application/modelModes';
import { RATIO_PARAM_KEYS, SIZE_PARAM_KEYS } from '@/features/channels/domain/profile';
import { readComfyUIWorkflows, type ComfyUIWorkflowDefinition } from '@/features/channels/application/comfyWorkflows';

/** HTTP models come from channel profiles; independent local adapters keep their own catalogs. */
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
  modes?: ResolvedMode[];
  channelModelRef?: { profileId: string; modelId: string };
}

interface DreaminaProviderStatus {
  loggedIn: boolean;
}

interface ImageModelCatalogSnapshot {
  customProviders: readonly CustomProviderConfig[];
  dreaminaStatus?: DreaminaProviderStatus | null;
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
}: ImageModelCatalogSnapshot): CatalogEntry[] {
  const entries: CatalogEntry[] = [];

  // 1. Custom providers (我的配置) — one entry per provider × model.
  for (const cfg of customProviders) {
    if (cfg.apiStyle !== 'comfyui' && !isImageCustomProvider(cfg)) {
      continue;
    }
    let workflows: ComfyUIWorkflowDefinition[] | undefined;
    let workflowError: string | undefined;
    if (cfg.apiStyle === 'comfyui') {
      try { workflows = readComfyUIWorkflows(cfg).workflows; }
      catch (error) {
        if (!isImageCustomProvider(cfg)) continue;
        workflowError = error instanceof Error ? error.message : String(error);
      }
    }
    const ratios = normalizeSupportedRatios(
      cfg.extraParams?.supportedRatios
    );
    const hasBaseUrl = Boolean(cfg.baseUrl?.trim());
    const hasReadyConfig = hasConfiguredCustomProvider(cfg) && !workflowError;
    // Optional extra parameter dimensions the user can surface to the
    // picker (resolution sizes, model versions) — they live on the
    // provider config so each provider can advertise its own values.
    const resolutions = cfg.supportedResolutions;
    const modelVersions = cfg.supportedModelVersions;
    const models = workflows
      ? workflows.filter((workflow) => workflow.mediaType === 'image').map((workflow) => workflow.id)
      : (cfg.models.length > 0 ? cfg.models : ['default']);
    for (const modelId of models) {
      const channelModel = channelModelForProvider(cfg, modelId);
      entries.push({
        id: `custom:${cfg.id}:${modelId}`,
        kind: 'custom',
        providerId: cfg.id,
        providerLabel: cfg.label,
        modelId,
        modelLabel: channelModel?.label ?? workflows?.find((workflow) => workflow.id === modelId)?.name ?? modelId,
        supportedRatios: channelParameterValues(channelModel, RATIO_PARAM_KEYS) ?? ratios,
        usable: hasReadyConfig,
        notReadyReason: hasReadyConfig
          ? undefined
          : workflowError ?? (hasBaseUrl ? '请在「我的配置」里填入 API Key' : '请在「我的配置」里填入 API 根地址'),
        supportsWebSearch: Boolean(cfg.supportsWebSearch),
        supportedResolutions: channelParameterValues(channelModel, SIZE_PARAM_KEYS) ?? ((resolutions && resolutions.length > 0) ? resolutions : undefined),
        supportedModelVersions: channelParameterValues(channelModel, ['modelVersion']) ?? ((modelVersions && modelVersions.length > 0) ? modelVersions : undefined),
        ...(channelModel ? { modes: listModelModes(channelModel), channelModelRef: { profileId: String(cfg.extraParams?.channelProfileId), modelId } } : {}),
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


  return entries;
}

export function useImageModelCatalog(): CatalogEntry[] {
  const customProviders = useChannelCatalogProviders();
  const dreaminaStatus = useSettingsStore((s) => s.dreaminaStatus);

  return useMemo(
    () => buildImageModelCatalog({ customProviders, dreaminaStatus }),
    [customProviders, dreaminaStatus]
  );
}

/** Human-friendly label for the "智能" ratio sentinel. */
export function formatRatio(r: string): string {
  return r === 'auto' ? '智能' : r;
}
