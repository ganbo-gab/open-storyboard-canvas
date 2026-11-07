import { t } from 'i18next';
import { useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { getChannelCatalogProviders } from '@/features/channels/application/channelCatalog';
import { isImageEditNode } from '../../domain/canvasNodes';
import { buildImageModelCatalog } from '../modelCatalog';
import { buildReferenceContextPrompt, collectInputReferences, normalizeReferenceTokensForSubmission } from '../graphReferenceResolver';
import { detectAspectRatio } from '../imageData';
import { appendGenerationParameterConstraints } from '../generationPromptConstraints';
import { normalizeImageRequestGeometry } from '../imageRequestGeometry';
import { DEFAULT_IMAGE_MODEL_ID, getImageModel, resolveImageModelResolution } from '../../models';
import { GRSAI_NANO_BANANA_PRO_MODEL_ID } from '../../models/image/grsai/nanoBananaPro';
import { resolveActiveModelForPanel } from '../resolveActiveModelForPanel';
import { buildCameraPrompt } from '../cameraPromptLibrary';
import { resolvePromptTemplateText, type PromptTemplateId, type PromptTemplateSettingsSnapshot } from '../promptTemplates';
import { GenerationInputError, type GenerationRequestOptions } from './types';
import { resolveNativeChannelModel } from '@/features/channels/application/channelService';

const MULTI_FUNCTION_ITEMS = ['multiCameraGrid', 'plotDeduction', 'continuousStoryboard', 'lightingCorrection', 'characterThreeView', 'predictNext', 'predictPrevious'].map(id => ({ id }));
type MultiFunctionType = string;
function buildMultiFunctionPromptFromSettings(id: string, settings: PromptTemplateSettingsSnapshot): string {
  return MULTI_FUNCTION_ITEMS.some(item => item.id === id) ? resolvePromptTemplateText(`multiFunction.${id}` as PromptTemplateId, settings) : '';
}
function normalizePromptForSourceComparison(prompt: string): string { return prompt.replace(/\r\n/g, '\n').trim(); }

export async function assembleImageRequest(id: string, options: GenerationRequestOptions = {}) {
    const latestCanvasState = useCanvasStore.getState();
    const latestNode = latestCanvasState.nodes.find((candidate) => candidate.id === id);
    if (!latestNode || !isImageEditNode(latestNode)) throw new GenerationInputError('unsupported', 'Not an image generation node');
    const latestData = latestNode.data;
    const currentPromptDraft = latestData.prompt ?? '';
    const selectedModel = getImageModel(latestData.model ?? DEFAULT_IMAGE_MODEL_ID);
    const effectiveExtraParams = { ...(latestData.extraParams ?? {}), ...(selectedModel.id === GRSAI_NANO_BANANA_PRO_MODEL_ID ? { grsai_pro_model: useSettingsStore.getState().grsaiNanoBananaProModel } : {}) };
    const selectedResolution = resolveImageModelResolution(selectedModel, latestData.size, { extraParams: effectiveExtraParams });
    const firstEntry = buildImageModelCatalog({ customProviders: getChannelCatalogProviders(), dreaminaStatus: useSettingsStore.getState().dreaminaStatus }).find(entry => entry.usable);
    const nodeModelConfig = firstEntry ? {entryId: firstEntry.id, ratio: firstEntry.supportedRatios[0] ?? 'auto', extraParams: {}} : null;
    const latestSettings = useSettingsStore.getState();
    const latestReferences = collectInputReferences(id, latestCanvasState.nodes, latestCanvasState.edges);
    const referenceContextPrompt = buildReferenceContextPrompt(latestReferences);
    const latestIncomingImages = latestReferences
      .filter((reference) => reference.kind === 'image' && reference.imageUrl)
      .map((reference) => reference.imageUrl as string);
    let basePrompt = normalizeReferenceTokensForSubmission(currentPromptDraft, latestReferences);

    const selectedPresetId = latestData.selectedPromptPresetId ?? null;
    const selectedFunctionChip = selectedPresetId ? null : latestData.selectedFunctionChip ?? null;

    let sourcePrompt = '';
    if (selectedPresetId) {
      const selectedPreset = latestSettings.promptPresets.find((preset) => preset.id === selectedPresetId);
      if (!selectedPreset) {
        const errorMessage = t('node.imageEdit.promptPresetMissing');
        throw new GenerationInputError('invalid-input', errorMessage);
      }
      sourcePrompt = selectedPreset.prompt.trim();
    } else if (selectedFunctionChip) {
      sourcePrompt = buildMultiFunctionPromptFromSettings(
        selectedFunctionChip as MultiFunctionType,
        latestSettings
      ).trim();
    }

    if (sourcePrompt && basePrompt) {
      const normalizedBasePrompt = normalizePromptForSourceComparison(basePrompt);
      const knownSourcePrompts = [
        sourcePrompt,
        ...latestSettings.promptPresets.map((preset) => preset.prompt),
        ...MULTI_FUNCTION_ITEMS.map((item) =>
          buildMultiFunctionPromptFromSettings(item.id, latestSettings)
        ),
      ];
      const basePromptIsStaleSourcePrompt = knownSourcePrompts.some((promptSource) =>
        normalizePromptForSourceComparison(promptSource) === normalizedBasePrompt
      );
      if (basePromptIsStaleSourcePrompt) {
        basePrompt = '';
      }
    }

    if (!basePrompt && !sourcePrompt) {
      const errorMessage = t('node.imageEdit.promptRequired');
      throw new GenerationInputError('empty-prompt', errorMessage);
    }
    if (!basePrompt && sourcePrompt && latestIncomingImages.length === 0 && !Object.values(latestData.referenceSlots ?? {}).some((sources) => sources.length > 0)) {
      const errorMessage = t('node.imageEdit.referenceRequiredForPromptSource');
      throw new GenerationInputError('empty-prompt', errorMessage);
    }

    // Append the cinematography prompt at submit time (not into the user's
    // textbox — see handleCameraControlApply).
    let prompt = sourcePrompt && basePrompt
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
        if (cameraPrompt) prompt = `${prompt}, ${cameraPrompt}`;
      } catch { /* fall back to current prompt */ }
    }

    // Resolve the panel-configured model (custom provider / Dreamina CLI) that
    // the user picked via <ModelConfigPicker /> on this exact node. Built-in
    // models no longer surface in the picker, so we go through the gateway's
    // dispatch instead of the old `selectedModel.resolveRequest(...)` path.
    const latestNodeModelConfig = latestData.modelConfig ?? nodeModelConfig ?? null;
    const resolved = resolveActiveModelForPanel('aiImageNode', latestNodeModelConfig);
    if ((resolved.entryId.startsWith('custom:') || resolved.entryId.startsWith('agnes:')) && resolved.requiresApiKey && !resolved.apiKey) {
      const msg = `服务商「${resolved.providerLabel}」未填写 API Key`;
      throw new GenerationInputError('missing-credentials', msg);
    }
    if (!resolved.entryId.startsWith('dreamina:') && !resolved.entryId.startsWith('custom:') && !resolved.entryId.startsWith('agnes:')) {
      // Fallback: no custom provider configured and no Dreamina login. Prompt
      // the user to set one up in 我的配置.
      const msg = '请先在「设置 → 我的配置」里添加至少一个服务商，或在「Dreamina」里登录 CLI 后再生成。';
      throw new GenerationInputError('missing-model', msg);
    }
    if (!resolved.usable) throw new GenerationInputError('missing-model', '当前模型不可用');

    const effectiveCount = Math.min(10, Math.max(1, Math.floor(options.count ?? 1) || 1));


    let referenceAspectRatio: string | undefined;
    if (resolved.ratio === 'auto') {
      if (latestIncomingImages.length > 0) {
        try {
          referenceAspectRatio = await detectAspectRatio(latestIncomingImages[0]);
        } catch {
          referenceAspectRatio = undefined;
        }
      }
    }

    const effectiveExtraParamsRecord = effectiveExtraParams as Record<string, unknown>;
    const requestResolutionLabel =
      resolved.extraParams?.['resolutionType'] ??
      resolved.extraParams?.['size'] ??
      effectiveExtraParamsRecord['resolutionType'] ??
      effectiveExtraParamsRecord['size'] ??
      selectedResolution.value ??
      '2K';
    const geometry = normalizeImageRequestGeometry({
      selectedResolution: requestResolutionLabel,
      selectedAspectRatio: resolved.ratio,
      referenceAspectRatio,
      supportedAspectRatios: resolved.supportedRatios,
      fallbackResolution: '2K',
    });
    const requestSize = geometry.requestSize;
    const resolvedRequestAspectRatio = geometry.requestAspectRatio;
    const promptWithReferenceContext = referenceContextPrompt
      ? `${referenceContextPrompt}\n\n${prompt}`
      : prompt;
    const promptForRequest = appendGenerationParameterConstraints(promptWithReferenceContext, {
      enabled: latestSettings.appendParameterConstraintsToPrompt,
      aspectRatio: geometry.promptAspectRatio,
      resolution: geometry.resolutionLabel,
      count: effectiveCount,
    });

    const extraParams = {
      ...effectiveExtraParams,
      ...resolved.extraParams,
      resolutionType: geometry.resolutionLabel,
    };
    const nativeMode = resolveNativeChannelModel(resolved.modelForGateway)?.model.modes;
    return {
      promptForRequest,
      requestSize,
      resolvedRequestAspectRatio,
      latestIncomingImages,
      effectiveCount,
      resolved,
      gatewayPayload: {
        prompt: promptForRequest,
        model: resolved.modelForGateway,
        size: nativeMode ? '' : requestSize,
        aspectRatio: nativeMode ? '' : resolvedRequestAspectRatio,
        referenceImages: latestIncomingImages,
        channelModeId: latestData.channelModeId,
        referenceSlots: latestData.referenceSlots,
        extraParams,
      },
    };
}
