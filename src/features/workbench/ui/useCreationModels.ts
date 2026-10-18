import { useImageModelCatalog } from "@/features/canvas/application/modelCatalog";
import { useVideoModelCatalog } from "@/features/canvas/application/videoModelCatalog";
import { useChatModelCatalog } from "@/features/canvas/application/chatModelCatalog";
import { useSettingsStore } from "@/stores/settingsStore";
import type { WorkbenchKind } from "../domain/types";

export interface CreationModel {
  id: string;
  label: string;
  provider: string;
  usable: boolean;
  reason?: string;
  ratios: string[];
  resolutions: string[];
  durations: string[];
}
export function useCreationModels(kind: WorkbenchKind): CreationModel[] {
  const images = useImageModelCatalog();
  const videos = useVideoModelCatalog();
  const chats = useChatModelCatalog();
  const audio = useSettingsStore(
    (state) => state.audioGenerationSettings.models,
  );
  if (kind === "image")
    return images.map((item) => ({
      id: item.id,
      label: item.modelLabel,
      provider: item.providerLabel,
      usable: item.usable,
      reason: item.notReadyReason,
      ratios: item.supportedRatios,
      resolutions: item.supportedResolutions ?? [],
      durations: [],
    }));
  if (kind === "video")
    return videos.map((item) => ({
      id: item.id,
      label: item.modelLabel,
      provider: item.providerLabel,
      usable: item.usable,
      reason: item.notReadyReason,
      ratios: item.supportedAspectRatios,
      resolutions: item.supportedResolutions,
      durations: item.supportedDurations,
    }));
  if (kind === "chat")
    return chats.map((item) => ({
      id: item.id,
      label: item.modelLabel,
      provider: item.providerLabel,
      usable: item.usable,
      reason: item.notReadyReason,
      ratios: [],
      resolutions: [],
      durations: [],
    }));
  return audio
    .filter((item) => item.enabled)
    .map((item) => ({
      id: item.id,
      label: item.name,
      provider: item.providerKind,
      usable: true,
      ratios: [],
      resolutions: [],
      durations: [],
    }));
}
