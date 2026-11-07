import { t } from 'i18next';
import { useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { getChannelCatalogProviders } from '@/features/channels/application/channelCatalog';
import { isAiVideoNode } from '../../domain/canvasNodes';
import { buildVideoModelCatalog, resolveVideoModelConfig, type VideoCatalogEntry, type VideoModelConfigValue } from '../videoModelCatalog';
import { collectInputReferences, normalizeReferenceTokensForSubmission, buildReferenceContextPrompt } from '../graphReferenceResolver';
import { buildCameraPrompt } from '../cameraPromptLibrary';
import { DEFAULT_VIDEO_INPUT_SCHEMA, normalizeVideoInputSchema, getVideoReferenceOverflow, type VideoInputSchema } from '../videoInputSchema';
import { parseDreaminaTransitionSegments, validateDreaminaVideoRequest } from '../dreaminaCapabilities';
import { GenerationInputError } from './types';
function resolveConfigEntry(
  catalog: readonly VideoCatalogEntry[],
  config?: VideoModelConfigValue
): VideoCatalogEntry | undefined {
  return config ? catalog.find((entry) => entry.id === config.entryId) : undefined;
}

function aspectRatioFromPixelResolution(resolution: string): string | null {
  const match = /^(\d{2,5})x(\d{2,5})$/i.exec(resolution.trim());
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const divisor = gcd(width, height);
  return `${Math.round(width / divisor)}:${Math.round(height / divisor)}`;
}
function resolveEntryInputSchema(entry?: VideoCatalogEntry): VideoInputSchema {
  return normalizeVideoInputSchema(entry?.inputSchema, DEFAULT_VIDEO_INPUT_SCHEMA);
}
export function assembleVideoRequest(id: string) {
    const latestCanvasState = useCanvasStore.getState();
    const latestNode = latestCanvasState.nodes.find((candidate) => candidate.id === id);
    if (!latestNode || !isAiVideoNode(latestNode)) throw new GenerationInputError('unsupported', 'Not a video generation node');
    const latestData = latestNode.data;
    const latestPromptDraft = latestData.prompt ?? '';
    const latestSettings = useSettingsStore.getState();
    const latestCatalog = buildVideoModelCatalog(
      getChannelCatalogProviders(),
      latestSettings.dreaminaStatus
    );
    const latestModelConfig = resolveVideoModelConfig(latestCatalog, latestData.modelConfig);
    const latestEntry = resolveConfigEntry(latestCatalog, latestModelConfig);
    const latestReferences = collectInputReferences(id, latestCanvasState.nodes, latestCanvasState.edges);
    const basePrompt = normalizeReferenceTokensForSubmission(latestPromptDraft, latestReferences);
    let sourcePrompt = '';
    if (latestData.selectedPromptPresetId) {
      const selectedPreset = latestSettings.promptPresets.find((preset) => preset.id === latestData.selectedPromptPresetId);
      if (!selectedPreset) {
        const message = t('node.imageEdit.promptPresetMissing');
        throw new GenerationInputError('invalid-input', message);
      }
      sourcePrompt = selectedPreset.prompt.trim();
    }
    let composedPrompt = sourcePrompt && basePrompt
      ? `${sourcePrompt}\n\n${t('node.imageEdit.userSupplementLabel')}${basePrompt}`
      : sourcePrompt || basePrompt;
    const cc = latestData.cameraControl;
    if (cc?.enabled === true) {
      try {
        const cameraPrompt = buildCameraPrompt({
          cameraId: cc.camera,
          lensId: cc.lens,
          focalLengthMm: cc.focalLength,
          apertureF: cc.aperture,
        }, latestSettings);
        if (cameraPrompt) {
          composedPrompt = composedPrompt ? `${composedPrompt}, ${cameraPrompt}` : cameraPrompt;
        }
      } catch {
        // Keep the user's prompt if camera prompt assembly fails.
      }
    }
    const referenceContextPrompt = buildReferenceContextPrompt(latestReferences);
    const prompt = referenceContextPrompt
      ? `${referenceContextPrompt}\n\n${composedPrompt}`
      : composedPrompt;
    if (!prompt) {
      const message = t('node.aiVideo.promptRequired');
      throw new GenerationInputError('empty-prompt', message);
    }
    if (!latestModelConfig || !latestEntry) {
      const message = t('node.aiVideo.noVideoProvider');
      throw new GenerationInputError('missing-model', message);
    }
    if (!latestEntry.usable) {
      const message = latestEntry.notReadyReason ?? t('node.aiVideo.noVideoProvider');
      throw new GenerationInputError('missing-credentials', message);
    }
    const latestInputSchema = resolveEntryInputSchema(latestEntry);
    const latestIncomingImages = latestInputSchema.images.enabled
      ? latestReferences
        .filter((reference) => reference.kind === 'image' && reference.imageUrl)
        .map((reference) => reference.imageUrl as string)
      : [];
    const latestIncomingVideos = latestInputSchema.video.enabled
      ? latestReferences
        .filter((reference) => reference.kind === 'video' && reference.videoUrl)
        .map((reference) => reference.videoUrl as string)
      : [];
    const latestIncomingAudios = latestInputSchema.audio.enabled
      ? latestReferences
        .filter((reference) => reference.kind === 'audio' && reference.audioUrl)
        .map((reference) => reference.audioUrl as string)
      : [];
    const overflow = getVideoReferenceOverflow(latestInputSchema, {
      images: latestIncomingImages.length,
      video: latestIncomingVideos.length,
      audio: latestIncomingAudios.length,
    });
    if (latestData.referenceSlots === undefined && overflow) {
      const message = t(`videoInputModes.limitErrors.${overflow.kind}`, { count: overflow.count, max: overflow.max });
      throw new GenerationInputError('invalid-input', message);
    }
    if (latestData.referenceSlots === undefined && latestIncomingImages.length < latestInputSchema.images.min) {
      const message = `当前模型至少需要 ${latestInputSchema.images.min} 张图片引用。`;
      throw new GenerationInputError('invalid-input', message);
    }
    if (latestData.referenceSlots === undefined && latestIncomingVideos.length < latestInputSchema.video.min) {
      const message = `当前模型至少需要 ${latestInputSchema.video.min} 个视频引用。`;
      throw new GenerationInputError('invalid-input', message);
    }
    if (latestData.referenceSlots === undefined && latestIncomingAudios.length < latestInputSchema.audio.min) {
      const message = `当前模型至少需要 ${latestInputSchema.audio.min} 个音频引用。`;
      throw new GenerationInputError('invalid-input', message);
    }
    const outputAspectRatio =
      aspectRatioFromPixelResolution(latestModelConfig.resolution)
      ?? latestModelConfig.aspectRatio
      ?? '16:9';
    const extraParams = { ...(latestModelConfig.extraParams ?? {}) };
    extraParams.videoInputSchema = latestInputSchema;
    if (latestEntry.id === 'dreamina:multi-frame-video' && latestIncomingImages.length >= 3) {
      const transitions = parseDreaminaTransitionSegments(
        extraParams.dreaminaTransitionSegments ?? extraParams.transitionSegments,
      );
      const expectedCount = latestIncomingImages.length - 1;
      const transitionIssues = validateDreaminaVideoRequest({
        command: 'multiframe2video',
        resolution: latestModelConfig.resolution,
        duration: Number(latestModelConfig.duration) || undefined,
        ratio: latestModelConfig.aspectRatio,
        imageCount: latestIncomingImages.length,
        videoCount: 0,
        audioCount: 0,
        transitions,
      }).filter(({ field }) => field === 'transitions' || field.startsWith('transitions.'));
      if (transitions?.length !== expectedCount || transitionIssues.length > 0) {
        const message = t('node.aiVideo.multiframeIncomplete', { count: expectedCount });
        throw new GenerationInputError('invalid-input', message);
      }
    }

    return {
      prompt,
      latestModelConfig,
      latestEntry,
      latestIncomingImages,
      latestIncomingVideos,
      latestIncomingAudios,
      outputAspectRatio,
      gatewayPayload: {
        prompt,
        model: latestModelConfig.entryId,
        size: latestModelConfig.resolution,
        aspectRatio: latestModelConfig.aspectRatio,
        seconds: Number(latestModelConfig.duration) || undefined,
        referenceImages: latestIncomingImages,
        referenceVideos: latestIncomingVideos,
        referenceAudios: latestIncomingAudios,
        channelModeId: latestData.channelModeId,
        referenceSlots: latestData.referenceSlots,
        extraParams,
      },
    };
}
