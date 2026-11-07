import { useMemo } from 'react';
import { getComfyUIVideoCapabilities, isLocalH3Workflow, parseComfyUIConfig } from '@/features/canvas/infrastructure/comfyuiGateway';

import {
  isVideoCustomProvider,
  type CustomProviderConfig,
} from '@/stores/customProvidersStore';
import { hasCustomProviderCredential } from '@/features/canvas/application/providerAvailability';
import { useSettingsStore } from '@/stores/settingsStore';
import {
  resolveVideoInputSchemaFromExtraParams,
  type VideoInputSchema,
} from './videoInputSchema';
import {
  DREAMINA_MULTIFRAME_CAPABILITY,
  listDreaminaVideoModels,
  type DreaminaVideoModelCapability,
} from './dreaminaCapabilities';
import { useChannelCatalogProviders, channelModelForProvider, channelParameterValues, resolveChannelCatalogModelId } from '@/features/channels/application/channelCatalog';
import { listModelModes, type ResolvedMode } from '@/features/channels/application/modelModes';
import { RATIO_PARAM_KEYS, SIZE_PARAM_KEYS } from '@/features/channels/domain/profile';
import { readComfyUIWorkflows, type ComfyUIWorkflowDefinition } from '@/features/channels/application/comfyWorkflows';

export interface VideoCatalogEntry {
  id: string;
  providerId: string;
  providerLabel: string;
  modelId: string;
  modelLabel: string;
  defaultExtraParams?: Record<string, unknown>;
  supportedDurations: string[];
  supportedResolutions: string[];
  supportedAspectRatios: string[];
  inputSchema: VideoInputSchema;
  usable: boolean;
  notReadyReason?: string;
  modes?: ResolvedMode[];
  channelModelRef?: { profileId: string; modelId: string };
}

export interface VideoModelConfigValue {
  entryId: string;
  duration: string;
  resolution: string;
  aspectRatio?: string;
  extraParams?: Record<string, unknown>;
}

const DEFAULT_DURATIONS = ['4', '8', '12'];
const DEFAULT_RESOLUTIONS = ['1280x720', '720x1280', '1024x1024'];
const DEFAULT_ASPECT_RATIOS = ['16:9', '9:16', '1:1'];
interface DreaminaProviderStatus {
  loggedIn: boolean;
}

function uniqueStrings(values: unknown, fallback: string[]): string[] {
  if (!Array.isArray(values)) {
    return fallback;
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  values.forEach((value) => {
    const text = String(value ?? '').trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    normalized.push(text);
  });
  return normalized.length > 0 ? normalized : fallback;
}

function resolveModelDescription(
  provider: CustomProviderConfig,
  modelId: string
): string | undefined {
  const descriptions = provider.extraParams?.modelDescriptions;
  if (!descriptions || typeof descriptions !== 'object' || Array.isArray(descriptions)) {
    return undefined;
  }
  const value = (descriptions as Record<string, unknown>)[modelId];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function buildVideoModelCatalog(
  customProviders: readonly CustomProviderConfig[],
  dreaminaStatus?: DreaminaProviderStatus | null
): VideoCatalogEntry[] {
  const entries: VideoCatalogEntry[] = [];
  for (const provider of customProviders) {
    if (provider.apiStyle !== 'comfyui' && !isVideoCustomProvider(provider)) {
      continue;
    }

    let workflows: ComfyUIWorkflowDefinition[] | undefined;
    let workflowError = '';
    if (provider.apiStyle === 'comfyui') {
      try { workflows = readComfyUIWorkflows(provider).workflows; }
      catch (error) {
        if (!isVideoCustomProvider(provider)) continue;
        workflowError = error instanceof Error ? error.message : String(error);
      }
    }
    const models = workflows
      ? workflows.filter((workflow) => workflow.mediaType === 'video').map((workflow) => workflow.id)
      : (provider.models.length > 0 ? provider.models : ['sora-2']);
    const supportedDurations = uniqueStrings(
      provider.extraParams?.supportedDurations,
      DEFAULT_DURATIONS
    );
    const supportedResolutions = uniqueStrings(
      provider.supportedResolutions ?? provider.extraParams?.supportedResolutions,
      DEFAULT_RESOLUTIONS
    );
    const supportedAspectRatios = uniqueStrings(
      provider.extraParams?.supportedRatios,
      DEFAULT_ASPECT_RATIOS
    );
    const hasBaseUrl = Boolean(provider.baseUrl?.trim());
    const hasCredential = hasCustomProviderCredential(provider);

    for (const modelId of models) {
      let comfyCapabilities: ReturnType<typeof getComfyUIVideoCapabilities> | undefined;
      let comfyError = workflowError;
      if (provider.apiStyle === 'comfyui' && !comfyError) {
        try {
          const config = parseComfyUIConfig(provider, modelId);
          comfyCapabilities = getComfyUIVideoCapabilities(config);
          if (config.bindings.duration && !isLocalH3Workflow(config.workflow)) {
            comfyCapabilities.supportedDurations = uniqueStrings(provider.extraParams?.supportedDurations, comfyCapabilities.supportedDurations);
          }
          if (config.bindings.resolution) comfyCapabilities.supportedResolutions = uniqueStrings(provider.supportedResolutions, comfyCapabilities.supportedResolutions);
          if (config.bindings.aspectRatio) comfyCapabilities.supportedAspectRatios = uniqueStrings(provider.extraParams?.supportedRatios, comfyCapabilities.supportedAspectRatios);
        } catch (error) { comfyError = error instanceof Error ? error.message : String(error); }
      }
      const usable = hasBaseUrl && hasCredential && !comfyError;
      const channelModel = channelModelForProvider(provider, modelId);
      const modes = channelModel ? listModelModes(channelModel) : undefined;
      const slots = modes?.[0]?.slots ?? [];
      const limits = (kind: 'image' | 'video' | 'audio') => channelModel?.modes
        ? slots.filter((slot) => slot.kind === kind).reduce((total, slot) => total + slot.max, 0)
        : channelModel?.refs?.[kind] ?? 0;
      const inputSchema = channelModel ? {
        images: { enabled: limits('image') > 0, min: 0, max: limits('image'), roles: ['reference' as const], requireImageHost: false },
        video: { enabled: limits('video') > 0, min: 0, max: limits('video'), field: 'videos' },
        audio: { enabled: limits('audio') > 0, min: 0, max: limits('audio'), field: 'audios' },
      } : resolveVideoInputSchemaFromExtraParams(provider.extraParams, modelId);
      const defaults = provider.extraParams?.defaultRequestParams;
      const imageMode = defaults && typeof defaults === 'object' && !Array.isArray(defaults)
        ? (defaults as Record<string, unknown>).imageMode
        : undefined;
      const defaultExtraParams = typeof imageMode === 'string' && inputSchema.imageModes?.some((mode) => mode === imageMode)
        ? { imageMode }
        : undefined;
      entries.push({
        id: `custom:${provider.id}:${modelId}`,
        providerId: provider.id,
        providerLabel: provider.label,
        modelId,
        modelLabel: channelModel?.label ?? workflows?.find((workflow) => workflow.id === modelId)?.name ?? resolveModelDescription(provider, modelId) ?? modelId,
        supportedDurations: channelParameterValues(channelModel, ['seconds', 'duration']) ?? supportedDurations,
        supportedResolutions: channelParameterValues(channelModel, SIZE_PARAM_KEYS) ?? supportedResolutions,
        supportedAspectRatios: channelParameterValues(channelModel, RATIO_PARAM_KEYS) ?? supportedAspectRatios,
        ...(channelModel ? { modes, channelModelRef: { profileId: String(provider.extraParams?.channelProfileId), modelId } } : {}),
        inputSchema,
        ...(defaultExtraParams ? { defaultExtraParams } : {}),
        ...(comfyCapabilities ?? {}),
        usable,
        notReadyReason: usable
          ? undefined
          : comfyError || (hasBaseUrl ? '请在「我的配置」里填入 API Key' : '请在「我的配置」里填入 API 根地址'),
      });
    }
  }
  if (dreaminaStatus?.loggedIn) {
    const dreaminaProvider = '即梦 CLI';
    const appendDreaminaModels = (
      command: DreaminaVideoModelCapability['command'],
      entryKind: string,
      label: string,
    ) => {
      for (const capability of listDreaminaVideoModels(command)) {
        entries.push({
          id: `dreamina:${entryKind}:${capability.model}`,
          providerId: 'dreamina',
          providerLabel: dreaminaProvider,
          modelId: capability.model,
          modelLabel: `${label} · ${capability.model}`,
          defaultExtraParams: { modelVersion: capability.model },
          supportedDurations: [...capability.durations],
          supportedResolutions: [...capability.resolutions],
          supportedAspectRatios: [...capability.aspectRatios],
          inputSchema: capability.inputSchema,
          usable: true,
        });
      }
    };

    appendDreaminaModels('multimodal2video', 'all-reference-video', '全能参考成片');
    appendDreaminaModels('text2video', 'text-video', '文生视频');
    appendDreaminaModels('image2video', 'image-video', '图生视频');
    appendDreaminaModels('frames2video', 'frames-video', '首尾帧成片');
    entries.push({
      id: 'dreamina:multi-frame-video',
      providerId: 'dreamina',
      providerLabel: dreaminaProvider,
      modelId: 'multi-frame-video',
      modelLabel: '多帧成片 · 智能多图',
      supportedDurations: [...DREAMINA_MULTIFRAME_CAPABILITY.durations],
      supportedResolutions: [...DREAMINA_MULTIFRAME_CAPABILITY.resolutions],
      supportedAspectRatios: [...DREAMINA_MULTIFRAME_CAPABILITY.aspectRatios],
      inputSchema: DREAMINA_MULTIFRAME_CAPABILITY.inputSchema,
      usable: true,
    });
  }
  return entries;
}

export function useVideoModelCatalog(): VideoCatalogEntry[] {
  const customProviders = useChannelCatalogProviders();
  const dreaminaStatus = useSettingsStore((state) => state.dreaminaStatus);
  return useMemo(
    () => buildVideoModelCatalog(customProviders, dreaminaStatus),
    [customProviders, dreaminaStatus]
  );
}

export function resolveVideoModelConfig(
  catalog: readonly VideoCatalogEntry[],
  current?: VideoModelConfigValue | null
): VideoModelConfigValue | undefined {
  const currentEntry = current
    ? catalog.find((entry) => entry.id === resolveChannelCatalogModelId(current.entryId) && entry.usable)
    : undefined;
  if (current?.entryId.startsWith('dreamina:') && !currentEntry) {
    return undefined;
  }
  const entry = currentEntry ?? catalog.find((candidate) => candidate.usable);
  if (!entry) {
    return undefined;
  }
  const defaultDuration = entry.supportedDurations[0] ?? DEFAULT_DURATIONS[0];
  const duration = current?.duration && entry.supportedDurations.includes(current.duration)
    ? current.duration
    : defaultDuration;
  const resolution = current?.resolution && entry.supportedResolutions.includes(current.resolution)
    ? current.resolution
    : entry.supportedResolutions[0] ?? DEFAULT_RESOLUTIONS[0];
  const aspectRatio = current?.aspectRatio && entry.supportedAspectRatios.includes(current.aspectRatio)
    ? current.aspectRatio
    : entry.supportedAspectRatios[0] ?? DEFAULT_ASPECT_RATIOS[0];
  return {
    entryId: entry.id,
    duration,
    resolution,
    aspectRatio,
    extraParams: {
      ...(entry.defaultExtraParams ?? {}),
      ...(current?.extraParams ?? {}),
    },
  };
}
