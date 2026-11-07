import { useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { CANVAS_NODE_TYPES, DEFAULT_ASPECT_RATIO, type StoryboardGenNodeData } from '../../domain/canvasNodes';
import { EXPORT_RESULT_DISPLAY_NAME } from '../../domain/nodeDisplay';
import { collectInputReferences } from '../graphReferenceResolver';
import { detectAspectRatio, parseAspectRatio, resolveImageDisplayUrl } from '../imageData';
import { resolveActiveModelForPanel, type PanelModelConfigValue } from '../resolveActiveModelForPanel';
import { normalizeImageRequestGeometry } from '../imageRequestGeometry';
import { appendGenerationParameterConstraints } from '../generationPromptConstraints';
import { sanitizeStoryboardPromptText, sanitizeStoryboardText } from '../storyboardText';
import { createWhite2x1DataUrl, selectPanoramaRequestRatio, prepareLocalPanoramaSource } from '../panoramaNormalize';
import { resolveImageModelResolution } from '../../models';
import { dedupeBlueprintReferenceUrls } from '../blueprintPrompt';
import { GenerationInputError, type GenerationRequestOptions, type ImageGenerationPlan, type LocalPanoramaPlan } from './types';
import { validateImageModel, pickClosestAspectRatio, generateGridImageDataUrl } from './imageVariants';
import { buildImageModelCatalog } from '../modelCatalog';
import { getChannelCatalogProviders } from '@/features/channels/application/channelCatalog';
import { resolveNativeChannelModel } from '@/features/channels/application/channelService';

export async function assembleStoryboardRequest(id: string, options: GenerationRequestOptions): Promise<ImageGenerationPlan> {
  const state = useCanvasStore.getState();
  const node = state.nodes.find(node => node.id === id);
  if (!node || node.type !== CANVAS_NODE_TYPES.storyboardGen) throw new GenerationInputError('unsupported', 'Not a storyboard node');
  const data = node.data as StoryboardGenNodeData;
  const settings = useSettingsStore.getState();
  const firstEntry = buildImageModelCatalog({customProviders: getChannelCatalogProviders(), dreaminaStatus: settings.dreaminaStatus}).find(entry => entry.usable);
  const nodeModelConfig: PanelModelConfigValue | undefined = data.modelConfig ?? (firstEntry ? {entryId: firstEntry.id, ratio: firstEntry.supportedRatios.includes('auto') ? 'auto' : firstEntry.supportedRatios[0] ?? DEFAULT_ASPECT_RATIO, extraParams: {}} : undefined);
  const resolved = resolveActiveModelForPanel('storyboardGenNode', nodeModelConfig);
  validateImageModel(resolved);
  const references = collectInputReferences(id, state.nodes, state.edges);
  const referenceImages = references.filter(ref => ref.kind === 'image' && ref.imageUrl).map(ref => ref.imageUrl!);
  const rows = Math.max(1, data.gridRows);
  const cols = Math.max(1, data.gridCols);
  const ratioMode = settings.showStoryboardGenAdvancedRatioControls && data.ratioControlMode === 'overall' ? 'overall' : 'cell';
  const selectedRatio = nodeModelConfig?.ratio ?? data.requestAspectRatio ?? 'auto';
  let controlRatio = parseAspectRatio(selectedRatio === 'auto' ? data.aspectRatio || DEFAULT_ASPECT_RATIO : selectedRatio);
  if (selectedRatio === 'auto') {
    controlRatio = 1;
    if (referenceImages[0]) {
      try { controlRatio = Math.max(0.1, parseAspectRatio(await detectAspectRatio(referenceImages[0]))); } catch { /* Same square fallback as the node. */ }
    }
  }
  const supported = resolved.supportedRatios.filter(ratio => ratio !== 'auto');
  const overallRatio = ratioMode === 'overall' ? controlRatio : controlRatio * cols / rows;
  const requestRatio = pickClosestAspectRatio(overallRatio, supported.length ? supported : ['1:1', '16:9', '9:16', '4:3', '3:4', '21:9', '9:21', '3:2', '2:3', '5:4', '4:5']);
  const resolution = String(resolved.extraParams.resolutionType ?? resolved.extraParams.size ?? nodeModelConfig?.extraParams?.resolutionType ?? nodeModelConfig?.extraParams?.size ?? data.size ?? '2K');
  const geometry = normalizeImageRequestGeometry({ selectedResolution: resolution, selectedAspectRatio: resolved.ratio, referenceAspectRatio: requestRatio, supportedAspectRatios: resolved.supportedRatios, fallbackResolution: '2K' });
  const directives = [`生成一张${data.gridRows}×${data.gridCols}的${data.gridRows * data.gridCols}宫格分镜图`];
  if (settings.storyboardGenKeepStyleConsistent) directives.push('图片风格与参考图保持一致');
  if (settings.storyboardGenDisableTextInImage) directives.push('禁止添加描述文本');
  const parts = [`${directives.join('，')}。`];
  data.frames.forEach((frame, index) => {
    const description = sanitizeStoryboardPromptText(frame.description);
    if (description) parts.push(`分镜${index + 1}：${description}`);
    else if (settings.storyboardGenAutoInferEmptyFrame) parts.push(`分镜${index + 1}：依据之前的内容进行推测`);
  });
  const grid = generateGridImageDataUrl(requestRatio, rows, cols, resolution);
  const prompt = appendGenerationParameterConstraints(parts.join('\n'), { enabled: settings.appendParameterConstraintsToPrompt, aspectRatio: geometry.promptAspectRatio, resolution: geometry.resolutionLabel, count: options.count ?? 1 });
  return {
    resolved,
    sourceType: 'storyboardGen' as const,
    resultType: CANVAS_NODE_TYPES.exportImage,
    resultPatch: {
      displayName: EXPORT_RESULT_DISPLAY_NAME.storyboardGenOutput,
      resultKind: 'storyboardGenOutput' as const,
      prompt: '', model: resolved.modelForGateway, size: geometry.requestSize,
      requestAspectRatio: geometry.requestAspectRatio,
      generationStoryboardMetadata: { gridRows: rows, gridCols: cols, frameNotes: data.frames.slice(0, rows * cols).map(frame => sanitizeStoryboardText(frame.description, settings.ignoreAtTagWhenCopyingAndGenerating)) },
    },
    gatewayPayload: { prompt, model: resolved.modelForGateway, size: resolveNativeChannelModel(resolved.modelForGateway)?.model.modes ? '' : geometry.requestSize, aspectRatio: resolveNativeChannelModel(resolved.modelForGateway)?.model.modes ? '' : geometry.requestAspectRatio, channelModeId: data.channelModeId, referenceSlots: data.referenceSlots, referenceImages: [...referenceImages, grid], extraParams: { ...data.extraParams, ...nodeModelConfig?.extraParams, ...resolved.extraParams, resolutionType: geometry.resolutionLabel } },
    gridPreview: options.tool?.id === 'gridPreview' ? grid : undefined,
  };
}

export async function assemblePanelRequest(id: string, options: GenerationRequestOptions): Promise<ImageGenerationPlan | LocalPanoramaPlan> {
  const state = useCanvasStore.getState();
  const node = state.nodes.find(node => node.id === id);
  if (!node) throw new GenerationInputError('unsupported', 'Node does not exist');
  const data = node.data as Record<string, unknown>;
  const tool = options.tool;
  const params = tool?.params ?? {};
  const settings = useSettingsStore.getState();
  const isPanorama = node.type === CANVAS_NODE_TYPES.panorama || tool?.id === 'panorama';
  const projection = params.projection === 'cylindrical' || data.projection === 'cylindrical' ? 'cylindrical' : 'spherical';
  let prompt = tool?.prompt ?? String(data.sourcePrompt ?? data.prompt ?? '');
  const preset = tool?.id === 'promptPreset' ? settings.promptPresets.find(preset => preset.id === params.presetId) : null;
  if (tool?.id === 'promptPreset') {
    if (!preset) throw new GenerationInputError('invalid-input', '提示词预设不存在');
    prompt = preset.prompt;
  }
  const references = collectInputReferences(id, state.nodes, state.edges);
  const ownImage = String(data.imageUrl || data.previewImageUrl || '');
  const sourceImage = String(params.directImageUrl || data.sourceImageUrl || references.find(ref => ref.kind === 'image')?.imageUrl || ownImage || '');
  const sourceMode = params.sourceMode ?? data.sourceMode;
  if (isPanorama && sourceMode === 'image') {
    if (!sourceImage) throw new GenerationInputError('invalid-input', '没有可用的全景源图片');
    const prepared = await prepareLocalPanoramaSource(sourceImage, projection, resolveImageDisplayUrl(sourceImage));
    return { localPanorama: { ...prepared, sourceImageUrl: sourceImage, projection, sourcePrompt: prompt } };
  }
  if (!prompt.trim()) throw new GenerationInputError('empty-prompt', '请输入提示词');
  if (!isPanorama && !ownImage && tool?.id !== 'blueprint') throw new GenerationInputError('invalid-input', '当前节点没有可作为参考的图片');
  const resolved = resolveActiveModelForPanel(isPanorama ? 'panorama' : tool?.id ?? 'edit', params.modelConfig as PanelModelConfigValue | undefined);
  validateImageModel(resolved);
  if (preset && ['dreamina:upscale', 'dreamina:3.0', 'dreamina:3.1'].includes(resolved.entryId)) throw new GenerationInputError('unsupported', '当前模型不支持提示词预设图片引用');
  const fallback = resolved.builtinModel ? resolveImageModelResolution(resolved.builtinModel, resolved.builtinModel.defaultResolution).value : '2K';
  const ratio = isPanorama ? selectPanoramaRequestRatio(resolved.supportedRatios, projection) : resolved.ratio;
  const geometry = normalizeImageRequestGeometry({ selectedResolution: resolved.extraParams.resolutionType ?? resolved.extraParams.size ?? fallback, selectedAspectRatio: ratio, referenceAspectRatio: String(data.aspectRatio ?? '1:1'), supportedAspectRatios: resolved.supportedRatios, fallbackResolution: fallback });
  const images: string[] = [];
  if (isPanorama && (params.smartBase ?? data.smartBase) !== false) images.push(createWhite2x1DataUrl(2048));
  if (tool?.id === 'blueprint' && params.mode === 'panorama' && ownImage) images.push(ownImage);
  if (Array.isArray(params.referenceImages)) {
    params.referenceImages.forEach(image => {
      const url = typeof image === 'string' ? image : image && typeof image === 'object' && 'url' in image ? image.url : null;
      if (typeof url === 'string' && url) images.push(url);
    });
  }
  if (!images.length) {
    if (node.type === CANVAS_NODE_TYPES.panorama && references[0]?.imageUrl) images.push(references[0].imageUrl);
    else if (ownImage) images.push(ownImage);
  }
  const referenceImages = tool?.id === 'blueprint' ? dedupeBlueprintReferenceUrls(images) : images;
  const requestModel = resolved.builtinModel ? resolved.builtinModel.resolveRequest({ referenceImageCount: referenceImages.length }).requestModel : resolved.modelForGateway;
  const promptForRequest = appendGenerationParameterConstraints(prompt.trim(), { enabled: settings.appendParameterConstraintsToPrompt, aspectRatio: geometry.promptAspectRatio, resolution: geometry.resolutionLabel, count: options.count ?? 1 });
  return {
    resolved,
    sourceType: 'imageEdit' as const,
    resultType: isPanorama ? CANVAS_NODE_TYPES.panorama : CANVAS_NODE_TYPES.exportImage,
    resultPatch: isPanorama ? { displayName: `全景 · ${prompt.trim().slice(0, 20) || '未命名'}`, sourceMode: 'text', sourcePrompt: prompt, projection, aspectRatio: ratio } : { aspectRatio: preset ? geometry.requestAspectRatio : String(data.aspectRatio ?? '1:1') },
    gatewayPayload: { prompt: promptForRequest, model: requestModel, size: resolveNativeChannelModel(requestModel)?.model.modes ? '' : geometry.requestSize, aspectRatio: resolveNativeChannelModel(requestModel)?.model.modes ? '' : geometry.requestAspectRatio, referenceImages: referenceImages.length ? referenceImages : undefined, extraParams: { ...resolved.extraParams, resolutionType: geometry.resolutionLabel } },
  };
}
