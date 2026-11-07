import { getChannelCatalogProviders } from '@/features/channels/application/channelCatalog';
import { summarizeModesForAgent, type AgentModeSummary } from '@/features/channels/application/modelModes';
import { buildImageModelCatalog } from '@/features/canvas/application/modelCatalog';
import { buildVideoModelCatalog } from '@/features/canvas/application/videoModelCatalog';
import { useSettingsStore } from '@/stores/settingsStore';

export interface AgentGenerationCatalogItem {
  modelId: string;
  label: string;
  provider: string;
  supportedRatios: string[];
  supportedResolutions: string[];
  supportedDurations?: string[];
  modes?: AgentModeSummary[];
}

/** Same usable declarations as the picker, without credentials or transport configuration. */
export function getAgentGenerationCatalog(): { image: AgentGenerationCatalogItem[]; video: AgentGenerationCatalogItem[] } {
  const providers = getChannelCatalogProviders();
  const dreaminaStatus = useSettingsStore.getState().dreaminaStatus;
  return {
    image: buildImageModelCatalog({ customProviders: providers, dreaminaStatus }).filter((entry) => entry.usable).slice(0, 80)
      .map((entry) => ({ modelId: entry.id, label: entry.modelLabel, provider: entry.providerLabel,
        supportedRatios: entry.supportedRatios, supportedResolutions: entry.supportedResolutions ?? [],
        modes: summarizeModesForAgent(entry.modes) })),
    video: buildVideoModelCatalog(providers, dreaminaStatus).filter((entry) => entry.usable).slice(0, 80)
      .map((entry) => ({ modelId: entry.id, label: entry.modelLabel, provider: entry.providerLabel,
        supportedRatios: entry.supportedAspectRatios, supportedResolutions: entry.supportedResolutions,
        supportedDurations: entry.supportedDurations, modes: summarizeModesForAgent(entry.modes) })),
  };
}
