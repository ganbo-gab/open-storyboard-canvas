import { lazy, memo, Suspense, useEffect, useMemo, useCallback, useState } from 'react';
import { NodeToolbar as ReactFlowNodeToolbar } from '@xyflow/react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useCanvasStore } from '@/stores/canvasStore';
import { usePanelStateStore } from '@/stores/panelStateStore';
import { useSettingsStore } from '@/stores/settingsStore';
import {
  CANVAS_NODE_TYPES,
  EXPORT_RESULT_NODE_DEFAULT_WIDTH,
  EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
  isExportImageNode,
  isImageEditNode,
  isUploadNode,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';
import { getNodeSelectionToolbarMode } from '@/features/canvas/domain/nodeRegistry';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { showErrorDialog } from '@/features/canvas/application/errorDialog';
import { canvasAiGateway } from '@/features/canvas/application/canvasServices';
import { CURRENT_RUNTIME_SESSION_ID } from '@/features/canvas/application/generationErrorReport';
import { appendGenerationParameterConstraints } from '@/features/canvas/application/generationPromptConstraints';
import {
  getLocalDateStamp,
  resolveDefaultGeneratedImageDisplayName,
  resolveDefaultGeneratedImageFileStem,
  resolveNextGeneratedMediaSequence,
} from '@/features/canvas/application/generatedMediaNaming';
import {
  acquireGenerationSubmitLock,
  generationSubmitLockKey,
} from '@/features/canvas/application/generationSubmitLock';
import {
  resolveImageModelResolution,
} from '@/features/canvas/models';
import { resolveActiveModelForPanel } from '@/features/canvas/application/resolveActiveModelForPanel';
import { MultiAnglePanel } from './MultiAnglePanel';
import { LightingControlPanel } from './LightingControlPanel';
import { MultiFunctionPanel } from './MultiFunctionPanel';
import { PromptPresetPanel } from './PromptPresetPanel';
import type { ModelConfigValue } from './ModelConfigPicker';
import { EditPanel } from './EditPanel';
import { GridSplitPanel } from './GridSplitPanel';
import type { PanoramaGenerateConfig } from './PanoramaPanel';
import {
  dedupeBlueprintReferenceUrls,
  type BlueprintConfig,
} from '@/features/canvas/application/blueprintPrompt';

// Lazy-load the heavy generation panels. PanoramaPanel pulls in
// @photo-sphere-viewer (~106 KB), and BlueprintPanel transitively
// pulls in three.js (~550 KB). Since both panels are conditionally
// rendered (the user has to click an action toolbar button to open
// them), there's no value in loading their chunks on cold start.
const PanoramaPanel = lazy(() =>
  import('./PanoramaPanel').then((m) => ({ default: m.PanoramaPanel })),
);
const BlueprintPanel = lazy(() =>
  import('./BlueprintPanel').then((m) => ({ default: m.BlueprintPanel })),
);
import { NodeActionToolbar } from './NodeActionToolbar';
import { NodeDeleteToolbar } from './NodeDeleteToolbar';
import {
  NODE_TOOLBAR_ALIGN,
  NODE_TOOLBAR_CLASS,
  NODE_TOOLBAR_OFFSET,
  NODE_TOOLBAR_POSITION,
} from './nodeToolbarConfig';
import {
  createWhite2x1DataUrl,
  prepareLocalPanoramaSource,
  selectPanoramaRequestRatio,
} from '@/features/canvas/application/panoramaNormalize';
import type { ResolvedPanelModel } from '@/features/canvas/application/resolveActiveModelForPanel';

const COLLAPSED_ACTION_TOOLBAR_TOGGLE_OFFSET = 8;
const EXPANDED_ACTION_TOOLBAR_OFFSET = NODE_TOOLBAR_OFFSET + 48;

async function setNativeApiKeyIfNeeded(resolved: ResolvedPanelModel): Promise<void> {
  if (resolved.builtinModel && resolved.apiKey) {
    await canvasAiGateway.setApiKey(resolved.providerId, resolved.apiKey);
  }
}

export const SelectedNodeOverlay = memo(() => {
  const { t } = useTranslation();
  const nodes = useCanvasStore((state) => state.nodes);
  const selectedNodeId = useCanvasStore((state) => state.selectedNodeId);
  const addNode = useCanvasStore((state) => state.addNode);
  const addEdge = useCanvasStore((state) => state.addEdge);
  const findNodePosition = useCanvasStore((state) => state.findNodePosition);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const panelState = usePanelStateStore();
  const setPointerOverPanel = usePanelStateStore((state) => state.setPointerOverPanel);
  const closePanel = usePanelStateStore((state) => state.closePanel);
  const appendParameterConstraintsToPrompt = useSettingsStore(
    (state) => state.appendParameterConstraintsToPrompt
  );
  const collapseNodeActionToolbarByDefault = useSettingsStore(
    (state) => state.collapseNodeActionToolbarByDefault
  );
  const [expandedActionToolbarNodeId, setExpandedActionToolbarNodeId] = useState<string | null>(null);

  // Live rect of the toolbar button that opened the panel. Updated every
  // animation frame so the panel follows when the user drags the node around
  // the canvas. Falls back to the rect captured at open-time.
  const [liveButtonRect, setLiveButtonRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    if (!panelState.isOpen || !panelState.anchor) {
      setLiveButtonRect(null);
      return;
    }
    const { nodeId, buttonKey, fallbackRect } = panelState.anchor;
    setLiveButtonRect(fallbackRect);
    let rafId: number | null = null;
    let lastSig = '';
    const tick = () => {
      const selector = `[data-panel-anchor="${nodeId}:${buttonKey}"]`;
      const el = document.querySelector(selector) as HTMLElement | null;
      const rect = el?.getBoundingClientRect() ?? fallbackRect;
      const sig = `${rect.left}|${rect.top}|${rect.width}|${rect.height}`;
      if (sig !== lastSig) {
        lastSig = sig;
        setLiveButtonRect(rect);
      }
      rafId = window.requestAnimationFrame(tick);
    };
    rafId = window.requestAnimationFrame(tick);
    return () => { if (rafId != null) window.cancelAnimationFrame(rafId); };
  }, [panelState.isOpen, panelState.anchor]);

  const selectedNode = useMemo(() => {
    if (!selectedNodeId) {
      return null;
    }

    return nodes.find((node) => node.id === selectedNodeId) ?? null;
  }, [nodes, selectedNodeId]);

  const selectedNodeToolbarMode = selectedNode
    ? getNodeSelectionToolbarMode(selectedNode.type)
    : 'none';
  const selectedNodeSupportsCollapsibleToolbar = Boolean(
    selectedNode
    && (isUploadNode(selectedNode) || isImageEditNode(selectedNode) || isExportImageNode(selectedNode))
  );
  const shouldCollapseActionToolbar =
    collapseNodeActionToolbarByDefault
    && selectedNodeToolbarMode === 'full'
    && selectedNodeSupportsCollapsibleToolbar;
  const isActionToolbarExpanded =
    !shouldCollapseActionToolbar || expandedActionToolbarNodeId === selectedNode?.id;

  const buildDefaultGeneratedImageMetadata = useCallback((sourcePrompt: string) => {
    const generatedSequence = resolveNextGeneratedMediaSequence(
      'image',
      useCanvasStore.getState().nodes
    );
    const generatedDateStamp = getLocalDateStamp();
    return {
      displayName: resolveDefaultGeneratedImageDisplayName(generatedSequence, sourcePrompt),
      sourcePrompt,
      generatedNamingMode: 'default' as const,
      generatedSequence,
      generatedDateStamp,
      generatedFileName: `${resolveDefaultGeneratedImageFileStem(generatedSequence, generatedDateStamp)}.png`,
    };
  }, []);

  useEffect(() => {
    setExpandedActionToolbarNodeId(null);
  }, [collapseNodeActionToolbarByDefault, selectedNode?.id]);

  useEffect(() => {
    if (
      !shouldCollapseActionToolbar
      || !selectedNode
      || isActionToolbarExpanded
      || panelState.anchor?.nodeId !== selectedNode.id
    ) {
      return;
    }
    closePanel();
  }, [
    closePanel,
    isActionToolbarExpanded,
    panelState.anchor?.nodeId,
    selectedNode,
    shouldCollapseActionToolbar,
  ]);

  const handleToggleActionToolbar = useCallback(() => {
    if (!selectedNode) {
      return;
    }
    const isCurrentlyExpanded = expandedActionToolbarNodeId === selectedNode.id;
    if (isCurrentlyExpanded && panelState.anchor?.nodeId === selectedNode.id) {
      closePanel();
    }
    setExpandedActionToolbarNodeId(isCurrentlyExpanded ? null : selectedNode.id);
  }, [closePanel, expandedActionToolbarNodeId, panelState.anchor?.nodeId, selectedNode]);

  const actionToolbarToggleLabel = isActionToolbarExpanded
    ? t('nodeToolbar.collapseToolbar')
    : t('nodeToolbar.expandToolbar');

  useEffect(() => {
    if (!panelState.isOpen || !panelState.anchor) {
      return;
    }
    const anchorNode = nodes.find((node) => node.id === panelState.anchor?.nodeId);
    if (!anchorNode || getNodeSelectionToolbarMode(anchorNode.type) !== 'full') {
      closePanel();
    }
  }, [closePanel, nodes, panelState.anchor, panelState.isOpen]);

  const selectedNodeImageData = useMemo(() => {
    const data = selectedNode?.data as { imageUrl?: string | null; previewImageUrl?: string | null; aspectRatio?: string } | undefined;
    return {
      rawReferenceImage: data?.imageUrl || data?.previewImageUrl || undefined,
      previewImageUrl: data?.imageUrl || data?.previewImageUrl
        ? resolveImageDisplayUrl(data.imageUrl || data.previewImageUrl || '')
        : undefined,
      aspectRatio: data?.aspectRatio || '1:1',
    };
  }, [selectedNode]);

  const handleCopyPrompt = useCallback(async (prompt: string) => {
    if (!prompt.trim()) {
      await showErrorDialog('当前未生成可复制的提示词', '错误');
      return;
    }
    await navigator.clipboard.writeText(prompt);
  }, []);

  const handleSubmitPrompt = useCallback(async (prompt: string) => {
    if (!selectedNode) {
      await showErrorDialog('未选中可提交的节点', '错误');
      return;
    }
    if (!prompt.trim()) {
      await showErrorDialog('当前参数尚未生成有效提示词', '错误');
      return;
    }
    if (!selectedNodeImageData.rawReferenceImage) {
      await showErrorDialog('当前节点没有可作为参考的图片', '错误');
      return;
    }

    const releaseSubmitLock = acquireGenerationSubmitLock(
      generationSubmitLockKey(selectedNode.id, `overlay-${panelState.type ?? 'edit'}`)
    );
    if (!releaseSubmitLock) {
      return;
    }

    try {
    // Pick the model the user chose in whichever panel is currently open
    // (each panel persists its own `lastModelConfigByPanel[panelKey]` entry
    // via ModelConfigPicker). Fall back to edit when the active panel type
    // doesn't have an obvious key mapping.
    const panelKey = panelState.type ?? 'edit';
    const resolved = resolveActiveModelForPanel(panelKey);
    if (resolved.resolvedByFallback && !resolved.usable) {
      await showErrorDialog(t('promptPresetPanel.errors.noModel'), t('common.error'));
      return;
    }
    if (resolved.builtinModel && !resolved.apiKey) {
      await showErrorDialog(`「${resolved.providerLabel}」模型缺少 API Key，请先在设置中配置`, '错误');
      return;
    }
    if ((resolved.entryId.startsWith('custom:') || resolved.entryId.startsWith('agnes:')) && resolved.requiresApiKey && !resolved.apiKey) {
      await showErrorDialog(`服务商「${resolved.providerLabel}」未填写 API Key`, '错误');
      return;
    }

    await setNativeApiKeyIfNeeded(resolved);

    // Compute size + resolveRequest for built-in models; custom / dreamina
    // entries bypass those and use the panel-selected ratio directly.
    const sizeForGateway = resolved.builtinModel
      ? resolveImageModelResolution(resolved.builtinModel, resolved.builtinModel.defaultResolution).value
      : '2K';
    const generationDurationMs = resolved.builtinModel?.expectedDurationMs ?? 60000;
    const requestModel = resolved.builtinModel
      ? resolved.builtinModel.resolveRequest({ referenceImageCount: 1 }).requestModel
      : resolved.modelForGateway;
    const ratioForGateway = resolved.ratio === 'auto'
      ? selectedNodeImageData.aspectRatio
      : resolved.ratio;

    const generationStartedAt = Date.now();
    const promptSource = prompt.trim();
    const newNodePosition = findNodePosition(
      selectedNode.id,
      EXPORT_RESULT_NODE_DEFAULT_WIDTH,
      EXPORT_RESULT_NODE_LAYOUT_HEIGHT
    );
    const newNodeId = addNode(CANVAS_NODE_TYPES.exportImage, newNodePosition, {
      isGenerating: true,
      generationStartedAt,
      generationDurationMs,
      resultKind: 'generic',
      ...buildDefaultGeneratedImageMetadata(promptSource),
      aspectRatio: selectedNodeImageData.aspectRatio,
    });
    addEdge(selectedNode.id, newNodeId);

    try {
      const promptForRequest = appendGenerationParameterConstraints(prompt.trim(), {
        enabled: appendParameterConstraintsToPrompt,
        aspectRatio: ratioForGateway,
        resolution: sizeForGateway,
        count: 1,
      });
      const jobId = await canvasAiGateway.submitGenerateImageJob({
        prompt: promptForRequest,
        model: requestModel,
        size: sizeForGateway,
        aspectRatio: ratioForGateway,
        referenceImages: [selectedNodeImageData.rawReferenceImage],
        extraParams: { ...resolved.extraParams },
      });
      updateNodeData(newNodeId, {
        generationJobId: jobId,
        generationSourceType: 'imageEdit',
        generationProviderId: resolved.providerId,
        generationClientSessionId: CURRENT_RUNTIME_SESSION_ID,
      });
      panelState.closePanel();
    } catch (error) {
      updateNodeData(newNodeId, {
        isGenerating: false,
        generationStartedAt: null,
        generationElapsedMs: Math.max(0, Date.now() - generationStartedAt),
        generationJobId: null,
        generationProviderId: null,
        generationClientSessionId: null,
        generationError: error instanceof Error ? error.message : '提交生成任务失败',
      });
      await showErrorDialog(error instanceof Error ? error.message : '提交生成任务失败', '错误');
    }
    } finally {
      releaseSubmitLock();
    }
  }, [appendParameterConstraintsToPrompt, buildDefaultGeneratedImageMetadata, selectedNode, selectedNodeImageData, findNodePosition, addNode, addEdge, updateNodeData, panelState, t]);

  const handleSubmitPromptPreset = useCallback(async (presetId: string, modelConfig: ModelConfigValue) => {
    if (!selectedNode) {
      await showErrorDialog(t('promptPresetPanel.errors.noSelectedNode'), t('common.error'));
      return;
    }

    const preset = useSettingsStore.getState().promptPresets.find((item) => item.id === presetId);
    if (!preset) {
      await showErrorDialog(t('node.imageEdit.promptPresetMissing'), t('common.error'));
      return;
    }

    const prompt = preset.prompt.trim();
    if (!prompt) {
      await showErrorDialog(t('node.imageEdit.promptRequired'), t('common.error'));
      return;
    }
    if (!selectedNodeImageData.rawReferenceImage) {
      await showErrorDialog(t('promptPresetPanel.errors.missingSourceImage'), t('common.error'));
      return;
    }
    if (!modelConfig.entryId) {
      await showErrorDialog(t('promptPresetPanel.errors.noModel'), t('common.error'));
      return;
    }

    const resolved = resolveActiveModelForPanel('promptPreset', modelConfig);
    if (resolved.resolvedByFallback && !resolved.usable) {
      await showErrorDialog(t('promptPresetPanel.errors.noModel'), t('common.error'));
      return;
    }
    if ((resolved.entryId.startsWith('custom:') || resolved.entryId.startsWith('agnes:')) && resolved.requiresApiKey && !resolved.apiKey) {
      await showErrorDialog(
        t('promptPresetPanel.errors.missingCustomApiKey', { provider: resolved.providerLabel }),
        t('common.error'),
      );
      return;
    }
    if (resolved.builtinModel && !resolved.apiKey) {
      await showErrorDialog(
        t('promptPresetPanel.errors.missingBuiltinApiKey', { provider: resolved.providerLabel }),
        t('common.error'),
      );
      return;
    }
    if (resolved.entryId === 'dreamina:upscale') {
      await showErrorDialog(t('promptPresetPanel.errors.unsupportedUpscaleModel'), t('common.error'));
      return;
    }
    if (resolved.entryId === 'dreamina:3.0' || resolved.entryId === 'dreamina:3.1') {
      await showErrorDialog(t('promptPresetPanel.errors.unsupportedImageReferenceModel'), t('common.error'));
      return;
    }

    const releaseSubmitLock = acquireGenerationSubmitLock(
      generationSubmitLockKey(selectedNode.id, `overlay-prompt-preset-${presetId}`)
    );
    if (!releaseSubmitLock) {
      return;
    }

    try {
    await setNativeApiKeyIfNeeded(resolved);

    const ratioForGateway = resolved.ratio === 'auto'
      ? selectedNodeImageData.aspectRatio
      : resolved.ratio;
    const sizeForGateway = resolved.builtinModel
      ? resolveImageModelResolution(resolved.builtinModel, resolved.builtinModel.defaultResolution).value
      : '2K';
    const generationDurationMs = resolved.builtinModel?.expectedDurationMs ?? 60000;
    const generationStartedAt = Date.now();
    const newNodePosition = findNodePosition(
      selectedNode.id,
      EXPORT_RESULT_NODE_DEFAULT_WIDTH,
      EXPORT_RESULT_NODE_LAYOUT_HEIGHT
    );
    const newNodeId = addNode(CANVAS_NODE_TYPES.exportImage, newNodePosition, {
      isGenerating: true,
      generationStartedAt,
      generationDurationMs,
      resultKind: 'generic',
      ...buildDefaultGeneratedImageMetadata(preset.prompt),
      aspectRatio: ratioForGateway,
    });
    addEdge(selectedNode.id, newNodeId);
    setSelectedNode(newNodeId);

    try {
      const requestModel = resolved.builtinModel
        ? resolved.builtinModel.resolveRequest({ referenceImageCount: 1 }).requestModel
        : resolved.modelForGateway;
      const promptForRequest = appendGenerationParameterConstraints(prompt, {
        enabled: appendParameterConstraintsToPrompt,
        aspectRatio: ratioForGateway,
        resolution: sizeForGateway,
        count: 1,
      });
      const jobId = await canvasAiGateway.submitGenerateImageJob({
        prompt: promptForRequest,
        model: requestModel,
        size: sizeForGateway,
        aspectRatio: ratioForGateway,
        referenceImages: [selectedNodeImageData.rawReferenceImage],
        extraParams: { ...resolved.extraParams },
      });
      updateNodeData(newNodeId, {
        generationJobId: jobId,
        generationSourceType: 'imageEdit',
        generationProviderId: resolved.providerId,
        generationClientSessionId: CURRENT_RUNTIME_SESSION_ID,
      });
      panelState.closePanel();
    } catch (error) {
      const message = error instanceof Error ? error.message : t('promptPresetPanel.errors.submitFailed');
      updateNodeData(newNodeId, {
        isGenerating: false,
        generationStartedAt: null,
        generationElapsedMs: Math.max(0, Date.now() - generationStartedAt),
        generationJobId: null,
        generationProviderId: null,
        generationClientSessionId: null,
        generationError: message,
      });
      await showErrorDialog(message, t('common.error'));
    }
    } finally {
      releaseSubmitLock();
    }
  }, [
    addEdge,
    addNode,
    findNodePosition,
    panelState,
    selectedNode,
    selectedNodeImageData,
    setSelectedNode,
    appendParameterConstraintsToPrompt,
    t,
    updateNodeData,
  ]);

  /**
   * Panorama submission: creates a dedicated panoramaNode (not a flat exportImage),
   * prefers 2:1 / 4:1 when the selected provider supports it, then falls back
   * to the closest supported wide ratio. In "smart 2:1 mode" it injects a 2:1
   * white base image as the i2i reference to nudge the model into panoramic
   * framing. The node stores `projection` so the PanoramaNode viewer knows
   * whether to crop to 2:1 (spherical) or 4:1 (cylindrical).
   */
  const handleSubmitPanorama = useCallback(async (prompt: string, config: PanoramaGenerateConfig) => {
    if (!selectedNode) {
      await showErrorDialog('未选中可提交的节点', '错误');
      return;
    }
    if (!prompt.trim() && config.sourceMode !== 'image') {
      await showErrorDialog('全景图提示词为空', '错误');
      return;
    }

    const releaseSubmitLock = acquireGenerationSubmitLock(
      generationSubmitLockKey(selectedNode.id, `overlay-panorama-${config.sourceMode}`)
    );
    if (!releaseSubmitLock) {
      return;
    }

    try {
    const resultTitle = `全景 · ${prompt.trim().slice(0, 20) || (config.sourceMode === 'image' ? '图生全景' : '未命名')}`;
    const panoramaSourceMode = config.sourceMode === 'image' ? 'image' : 'text';
    const panoNodePosition = findNodePosition(selectedNode.id, 560, 340);

    if (config.sourceMode === 'image') {
      if (!config.directImageUrl) {
        await showErrorDialog(t('directorStudio.importErrors.missingSource'), t('common.error'));
        return;
      }
      try {
        const prepared = await prepareLocalPanoramaSource(
          config.directImageUrl,
          config.projection,
          resolveImageDisplayUrl(config.directImageUrl)
        );
        const directNodeId = addNode(CANVAS_NODE_TYPES.panorama, panoNodePosition, {
          displayName: resultTitle,
          imageUrl: prepared.imageUrl,
          previewImageUrl: prepared.imageUrl,
          aspectRatio: prepared.aspectRatio,
          sourceMode: panoramaSourceMode,
          sourcePrompt: prompt,
          sourceImageUrl: config.directImageUrl,
          projection: config.projection,
          isGenerating: false,
          generationStartedAt: null,
          generationJobId: null,
          generationProviderId: null,
          generationClientSessionId: null,
          generationError: null,
        });
        addEdge(selectedNode.id, directNodeId);
        panelState.closePanel();
      } catch (error) {
        await showErrorDialog(error instanceof Error ? error.message : t('directorStudio.importErrors.missingSource'), t('common.error'));
      }
      return;
    }

    const resolved = resolveActiveModelForPanel('panorama');
    if (resolved.resolvedByFallback && !resolved.usable) {
      await showErrorDialog(t('directorStudio.importErrors.noModel'), t('common.error'));
      return;
    }
    if (resolved.builtinModel && !resolved.apiKey) {
      await showErrorDialog(`「${resolved.providerLabel}」模型缺少 API Key，请先在设置中配置`, '错误');
      return;
    }
    if ((resolved.entryId.startsWith('custom:') || resolved.entryId.startsWith('agnes:')) && resolved.requiresApiKey && !resolved.apiKey) {
      await showErrorDialog(`服务商「${resolved.providerLabel}」未填写 API Key`, '错误');
      return;
    }

    await setNativeApiKeyIfNeeded(resolved);
    const sizeForGateway = resolved.builtinModel
      ? resolveImageModelResolution(resolved.builtinModel, resolved.builtinModel.defaultResolution).value
      : '2K';
    const panoramaRequestRatio = selectPanoramaRequestRatio(resolved.supportedRatios, config.projection);
    const generationDurationMs = resolved.builtinModel?.expectedDurationMs ?? 60000;
    const generationStartedAt = Date.now();

    const newNodeId = addNode(CANVAS_NODE_TYPES.panorama, panoNodePosition, {
      displayName: resultTitle,
      imageUrl: null,
      previewImageUrl: null,
      aspectRatio: panoramaRequestRatio,
      sourceMode: panoramaSourceMode,
      sourcePrompt: prompt,
      projection: config.projection,
      isGenerating: true,
      generationStartedAt,
      generationDurationMs,
    });
    addEdge(selectedNode.id, newNodeId);

    // Resolve reference images for the gateway.
    // - smart text mode: prepend a 2:1 white base so i2i is forced into panoramic thinking.
    // - pure text mode without smart: no references (gateway will fall back to text2image).
    const referenceImages: string[] = [];
    if (config.smartBase) {
      referenceImages.push(createWhite2x1DataUrl(2048));
    }
    config.referenceImages.forEach((image) => {
      if (image.url) referenceImages.push(image.url);
    });
    if (referenceImages.length === 0 && selectedNodeImageData.rawReferenceImage) {
      referenceImages.push(selectedNodeImageData.rawReferenceImage);
    }

    try {
      const requestModel = resolved.builtinModel
        ? resolved.builtinModel.resolveRequest({ referenceImageCount: referenceImages.length }).requestModel
        : resolved.modelForGateway;
      const promptForRequest = appendGenerationParameterConstraints(prompt.trim(), {
        enabled: appendParameterConstraintsToPrompt,
        aspectRatio: panoramaRequestRatio,
        resolution: sizeForGateway,
        count: 1,
      });
      const jobId = await canvasAiGateway.submitGenerateImageJob({
        prompt: promptForRequest,
        model: requestModel,
        size: sizeForGateway,
        aspectRatio: panoramaRequestRatio,
        referenceImages: referenceImages.length > 0 ? referenceImages : undefined,
        extraParams: { ...resolved.extraParams },
      });
      updateNodeData(newNodeId, {
        generationJobId: jobId,
        generationSourceType: 'imageEdit',
        generationProviderId: resolved.providerId,
        generationClientSessionId: CURRENT_RUNTIME_SESSION_ID,
      });
      panelState.closePanel();
    } catch (error) {
      updateNodeData(newNodeId, {
        isGenerating: false,
        generationStartedAt: null,
        generationElapsedMs: Math.max(0, Date.now() - generationStartedAt),
        generationJobId: null,
        generationProviderId: null,
        generationClientSessionId: null,
        generationError: error instanceof Error ? error.message : '提交全景生成任务失败',
      });
      await showErrorDialog(error instanceof Error ? error.message : '提交全景生成任务失败', '错误');
    }
    } finally {
      releaseSubmitLock();
    }
  }, [appendParameterConstraintsToPrompt, buildDefaultGeneratedImageMetadata, selectedNode, selectedNodeImageData, findNodePosition, addNode, addEdge, updateNodeData, panelState]);

  /**
   * Blueprint submission. Spatial layout + identity references are packaged into
   * the prompt already (buildBlueprintPrompt), so we just submit an image-edit
   * job using the blueprint's reference images as the reference stack. When the
   * user picked flat mode without references we fall back to the selected
   * node's image; when they picked panorama mode we prepend the selected node
   * (assumed to be the panorama base).
   */
  const handleSubmitBlueprint = useCallback(async (prompt: string, config: BlueprintConfig) => {
    if (!selectedNode) {
      await showErrorDialog(t('directorStudio.overlay.noSelectedNode'), t('common.error'));
      return;
    }
    if (!prompt.trim()) {
      await showErrorDialog(t('directorStudio.overlay.emptyPrompt'), t('common.error'));
      return;
    }

    const releaseSubmitLock = acquireGenerationSubmitLock(
      generationSubmitLockKey(selectedNode.id, 'overlay-blueprint')
    );
    if (!releaseSubmitLock) {
      return;
    }

    try {
    const resolved = resolveActiveModelForPanel('blueprint');
    if (resolved.resolvedByFallback && !resolved.usable) {
      await showErrorDialog(t('directorStudio.overlay.noModel'), t('common.error'));
      return;
    }
    if (resolved.builtinModel && !resolved.apiKey) {
      await showErrorDialog(
        t('directorStudio.overlay.missingBuiltinApiKey', { provider: resolved.providerLabel }),
        t('common.error'),
      );
      return;
    }
    if ((resolved.entryId.startsWith('custom:') || resolved.entryId.startsWith('agnes:')) && resolved.requiresApiKey && !resolved.apiKey) {
      await showErrorDialog(
        t('directorStudio.overlay.missingCustomApiKey', { provider: resolved.providerLabel }),
        t('common.error'),
      );
      return;
    }
    await setNativeApiKeyIfNeeded(resolved);
    const sizeForGateway = resolved.builtinModel
      ? resolveImageModelResolution(resolved.builtinModel, resolved.builtinModel.defaultResolution).value
      : '2K';
    const generationDurationMs = resolved.builtinModel?.expectedDurationMs ?? 60000;
    const generationStartedAt = Date.now();
    const newNodePosition = findNodePosition(selectedNode.id, EXPORT_RESULT_NODE_DEFAULT_WIDTH, EXPORT_RESULT_NODE_LAYOUT_HEIGHT);
    const newNodeId = addNode(CANVAS_NODE_TYPES.exportImage, newNodePosition, {
      isGenerating: true,
      generationStartedAt,
      generationDurationMs,
      resultKind: 'generic',
      ...buildDefaultGeneratedImageMetadata(prompt),
      aspectRatio: selectedNodeImageData.aspectRatio,
    });
    addEdge(selectedNode.id, newNodeId);

    // Assemble reference images (panorama base + per-item identity refs + fallback).
    const referenceImages: string[] = [];
    if (config.mode === 'panorama' && selectedNodeImageData.rawReferenceImage) {
      referenceImages.push(selectedNodeImageData.rawReferenceImage);
    }
    config.referenceImages.forEach((r) => {
      if (r.url) referenceImages.push(r.url);
    });
    if (referenceImages.length === 0 && selectedNodeImageData.rawReferenceImage) {
      referenceImages.push(selectedNodeImageData.rawReferenceImage);
    }
    const dedupedReferenceImages = dedupeBlueprintReferenceUrls(referenceImages);

    try {
      const requestModel = resolved.builtinModel
        ? resolved.builtinModel.resolveRequest({ referenceImageCount: dedupedReferenceImages.length }).requestModel
        : resolved.modelForGateway;
      const ratioForGateway = resolved.ratio === 'auto'
        ? selectedNodeImageData.aspectRatio
        : resolved.ratio;
      const promptForRequest = appendGenerationParameterConstraints(prompt.trim(), {
        enabled: appendParameterConstraintsToPrompt,
        aspectRatio: ratioForGateway,
        resolution: sizeForGateway,
        count: 1,
      });
      const jobId = await canvasAiGateway.submitGenerateImageJob({
        prompt: promptForRequest,
        model: requestModel,
        size: sizeForGateway,
        aspectRatio: ratioForGateway,
        referenceImages: dedupedReferenceImages.length > 0 ? dedupedReferenceImages : undefined,
        extraParams: { ...resolved.extraParams },
      });
      updateNodeData(newNodeId, {
        generationJobId: jobId,
        generationSourceType: 'imageEdit',
        generationProviderId: resolved.providerId,
        generationClientSessionId: CURRENT_RUNTIME_SESSION_ID,
      });
      panelState.closePanel();
    } catch (error) {
      updateNodeData(newNodeId, {
        isGenerating: false,
        generationStartedAt: null,
        generationElapsedMs: Math.max(0, Date.now() - generationStartedAt),
        generationJobId: null,
        generationProviderId: null,
        generationClientSessionId: null,
        generationError: error instanceof Error ? error.message : t('directorStudio.overlay.submitFailed'),
      });
      await showErrorDialog(
        error instanceof Error ? error.message : t('directorStudio.overlay.submitFailed'),
        t('common.error'),
      );
    }
    } finally {
      releaseSubmitLock();
    }
  }, [appendParameterConstraintsToPrompt, buildDefaultGeneratedImageMetadata, selectedNode, selectedNodeImageData, findNodePosition, addNode, addEdge, updateNodeData, panelState, t]);


  if (!selectedNode) {
    return null;
  }

  return (
    <>
      {selectedNodeToolbarMode === 'full' && shouldCollapseActionToolbar && (
        <ReactFlowNodeToolbar
          nodeId={selectedNode.id}
          isVisible
          position={NODE_TOOLBAR_POSITION}
          align={NODE_TOOLBAR_ALIGN}
          offset={COLLAPSED_ACTION_TOOLBAR_TOGGLE_OFFSET}
          className={NODE_TOOLBAR_CLASS}
        >
          <button
            type="button"
            className="pointer-events-auto inline-flex h-7 items-center gap-1 rounded-full border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-menu-bg)] px-2.5 text-[11px] font-medium text-text-dark shadow-lg backdrop-blur transition-colors hover:border-[var(--canvas-node-border-hover)] hover:bg-[var(--canvas-node-menu-hover)]"
            onClick={(event) => {
              event.stopPropagation();
              handleToggleActionToolbar();
            }}
            title={actionToolbarToggleLabel}
          >
            {isActionToolbarExpanded ? (
              <ChevronUp className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
            {t('nodeToolbar.toolbarToggle')}
          </button>
        </ReactFlowNodeToolbar>
      )}
      {selectedNodeToolbarMode === 'full' && isActionToolbarExpanded && (
        <NodeActionToolbar
          node={selectedNode}
          offset={shouldCollapseActionToolbar ? EXPANDED_ACTION_TOOLBAR_OFFSET : undefined}
        />
      )}
      {selectedNodeToolbarMode === 'deleteOnly' && (
        <NodeDeleteToolbar nodeId={selectedNode.id} node={selectedNode} />
      )}

      {/* Global panel rendering — works for all node types */}
      {panelState.isOpen && panelState.anchor && liveButtonRect && (
        <div
          onMouseEnter={() => setPointerOverPanel(true)}
          onMouseLeave={() => setPointerOverPanel(false)}
        >
          {panelState.type === 'multiAngle' && (
            <MultiAnglePanel
              isOpen={true}
              onClose={() => panelState.closePanel()}
              onApply={(_options, prompt) => {
                void handleSubmitPrompt(prompt);
              }}
              onCopyPrompt={(prompt) => {
                void handleCopyPrompt(prompt);
              }}
              buttonRect={liveButtonRect}
              previewImageUrl={selectedNodeImageData.previewImageUrl}
            />
          )}
          {panelState.type === 'lighting' && (
            <LightingControlPanel
              isOpen={true}
              onClose={() => panelState.closePanel()}
              onApply={(_options, prompt) => {
                void handleSubmitPrompt(prompt);
              }}
              onCopyPrompt={(prompt) => {
                void handleCopyPrompt(prompt);
              }}
              buttonRect={liveButtonRect}
              previewImageUrl={selectedNodeImageData.previewImageUrl}
            />
          )}
          {panelState.type === 'multiFunction' && (
            <MultiFunctionPanel
              isOpen={true}
              onClose={() => panelState.closePanel()}
              onApply={(prompt) => {
                void handleSubmitPrompt(prompt);
              }}
              buttonRect={liveButtonRect}
            />
          )}
          {panelState.type === 'promptPreset' && (
            <PromptPresetPanel
              isOpen={true}
              onClose={() => panelState.closePanel()}
              onGenerate={(presetId, modelConfig) => handleSubmitPromptPreset(presetId, modelConfig)}
              buttonRect={liveButtonRect}
              previewImageUrl={selectedNodeImageData.previewImageUrl}
            />
          )}
          {panelState.type === 'edit' && (
            <EditPanel
              node={{ id: panelState.anchor.nodeId } as CanvasNode}
              isOpen={true}
              onClose={() => panelState.closePanel()}
              buttonRect={liveButtonRect}
            />
          )}
          {panelState.type === 'gridSplit' && (
            <GridSplitPanel
              node={{ id: panelState.anchor.nodeId } as CanvasNode}
              isOpen={true}
              onClose={() => panelState.closePanel()}
              buttonRect={liveButtonRect}
            />
          )}
          {panelState.type === 'panorama' && (
            <Suspense fallback={null}>
              <PanoramaPanel
                isOpen={true}
                onClose={() => panelState.closePanel()}
                onGenerate={(prompt, config) => {
                  void handleSubmitPanorama(prompt, config);
                }}
                onCopyPrompt={(prompt) => {
                  void handleCopyPrompt(prompt);
                }}
                buttonRect={liveButtonRect}
                previewImageUrl={selectedNodeImageData.previewImageUrl}
              />
            </Suspense>
          )}
          {panelState.type === 'blueprint' && (
            <Suspense fallback={null}>
              <BlueprintPanel
                isOpen={true}
                onClose={() => panelState.closePanel()}
                onGenerate={(prompt, config) => {
                  void handleSubmitBlueprint(prompt, config);
                }}
                onCopyPrompt={(prompt) => {
                  void handleCopyPrompt(prompt);
                }}
                buttonRect={liveButtonRect}
                previewImageUrl={selectedNodeImageData.previewImageUrl}
              />
            </Suspense>
          )}
        </div>
      )}
    </>
  );
});

SelectedNodeOverlay.displayName = 'SelectedNodeOverlay';
