import {
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
  memo,
  useMemo,
  useState,
  useCallback,
  useEffect,
  useRef,
} from 'react';
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { Sparkles, Video } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  AUTO_REQUEST_ASPECT_RATIO,
  CANVAS_NODE_TYPES,
  EXPORT_RESULT_NODE_DEFAULT_WIDTH,
  EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
  isImageEditNode,
  type ImageEditNodeData,
  type ImageSize,
  type CameraControlOptions,
} from '@/features/canvas/domain/canvasNodes';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from '@/features/canvas/ui/NodeHeader';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { canvasAiGateway } from '@/features/canvas/application/canvasServices';
import { graphImageResolver } from '@/features/canvas/application/graphImageResolver';
import {
  parseInputImageSignature,
  selectInputImageSignature,
} from '@/features/canvas/application/canvasGraphSelectors';
import { resolveErrorContent, showErrorDialog } from '@/features/canvas/application/errorDialog';
import {
  detectAspectRatio,
  prepareNodeImageFromFile,
  resolveImageDisplayUrl,
} from '@/features/canvas/application/imageData';
import { resolveClipboardImageFile } from '@/features/canvas/hooks/useCanvasShortcuts';
import { appendGenerationParameterConstraints } from '@/features/canvas/application/generationPromptConstraints';
import {
  buildGenerationErrorReport,
  CURRENT_RUNTIME_SESSION_ID,
  createReferenceImagePlaceholders,
  getRuntimeDiagnostics,
  type GenerationDebugContext,
} from '@/features/canvas/application/generationErrorReport';
import {
  findReferenceTokens,
  insertReferenceToken,
  removeTextRange,
  resolveReferenceAwareDeleteRange,
} from '@/features/canvas/application/referenceTokenEditing';
import {
  DEFAULT_IMAGE_MODEL_ID,
  getImageModel,
  resolveImageModelResolution,
} from '@/features/canvas/models';
import { useImageModelCatalog } from '@/features/canvas/application/modelCatalog';
import { GRSAI_NANO_BANANA_PRO_MODEL_ID } from '@/features/canvas/models/image/grsai/nanoBananaPro';
import {
  NODE_CONTROL_CHIP_CLASS,
  NODE_CONTROL_ICON_CLASS,
  NODE_CONTROL_PRIMARY_BUTTON_CLASS,
} from '@/features/canvas/ui/nodeControlStyles';
import { ModelConfigPicker } from '@/features/canvas/ui/ModelConfigPicker';
import { resolveActiveModelForPanel } from '@/features/canvas/application/resolveActiveModelForPanel';
import { CameraControlPanel } from '@/features/canvas/ui/CameraControlPanel';
import { buildCameraPrompt } from '@/features/canvas/application/cameraPromptLibrary';
import {
  MULTI_FUNCTION_ITEMS,
  buildMultiFunctionPromptFromSettings,
  type MultiFunctionType,
} from '@/features/canvas/ui/MultiFunctionPanel';
import { CanvasNodeImage } from '@/features/canvas/ui/CanvasNodeImage';
import { UiButton } from '@/components/ui';
import { useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';

type ImageEditNodeProps = NodeProps & {
  id: string;
  data: ImageEditNodeData;
  selected?: boolean;
};

interface AspectRatioChoice {
  value: string;
  label: string;
}

interface PickerAnchor {
  left: number;
  top: number;
}

const PICKER_FALLBACK_ANCHOR: PickerAnchor = { left: 8, top: 8 };
const PICKER_Y_OFFSET_PX = 20;
const IMAGE_EDIT_NODE_MIN_WIDTH = 520;
const IMAGE_EDIT_NODE_MIN_HEIGHT = 260;
const IMAGE_EDIT_NODE_MAX_WIDTH = 1400;
const IMAGE_EDIT_NODE_MAX_HEIGHT = 1000;
const IMAGE_EDIT_NODE_DEFAULT_WIDTH = 680;
const IMAGE_EDIT_NODE_DEFAULT_HEIGHT = 380;
const TEXT_DRAFT_COMMIT_DELAY_MS = 650;
const PASTED_REFERENCE_NODE_OFFSET_X = 280;

function getTextareaCaretOffset(
  textarea: HTMLTextAreaElement,
  caretIndex: number
): PickerAnchor {
  const mirror = document.createElement('div');
  const computed = window.getComputedStyle(textarea);
  const mirrorStyle = mirror.style;

  mirrorStyle.position = 'absolute';
  mirrorStyle.visibility = 'hidden';
  mirrorStyle.pointerEvents = 'none';
  mirrorStyle.whiteSpace = 'pre-wrap';
  mirrorStyle.overflowWrap = 'break-word';
  mirrorStyle.wordBreak = 'break-word';
  mirrorStyle.boxSizing = computed.boxSizing;
  mirrorStyle.width = `${textarea.clientWidth}px`;
  mirrorStyle.font = computed.font;
  mirrorStyle.lineHeight = computed.lineHeight;
  mirrorStyle.letterSpacing = computed.letterSpacing;
  mirrorStyle.padding = computed.padding;
  mirrorStyle.border = computed.border;
  mirrorStyle.textTransform = computed.textTransform;
  mirrorStyle.textIndent = computed.textIndent;

  mirror.textContent = textarea.value.slice(0, caretIndex);

  const marker = document.createElement('span');
  marker.textContent = textarea.value.slice(caretIndex, caretIndex + 1) || ' ';
  mirror.appendChild(marker);

  document.body.appendChild(mirror);

  const left = marker.offsetLeft - textarea.scrollLeft;
  const top = marker.offsetTop - textarea.scrollTop;

  document.body.removeChild(mirror);

  return {
    left: Math.max(0, left),
    top: Math.max(0, top),
  };
}

function resolvePickerAnchor(
  container: HTMLDivElement | null,
  textarea: HTMLTextAreaElement,
  caretIndex: number
): PickerAnchor {
  if (!container) {
    return PICKER_FALLBACK_ANCHOR;
  }

  const containerRect = container.getBoundingClientRect();
  const textareaRect = textarea.getBoundingClientRect();
  const caretOffset = getTextareaCaretOffset(textarea, caretIndex);

  return {
    left: Math.max(0, textareaRect.left - containerRect.left + caretOffset.left),
    top: Math.max(0, textareaRect.top - containerRect.top + caretOffset.top + PICKER_Y_OFFSET_PX),
  };
}

function renderPromptWithHighlights(prompt: string, maxImageCount: number): ReactNode {
  if (!prompt) {
    return ' ';
  }

  const segments: ReactNode[] = [];
  let lastIndex = 0;
  const referenceTokens = findReferenceTokens(prompt, maxImageCount);
  for (const token of referenceTokens) {
    const matchStart = token.start;
    const matchText = token.token;

    if (matchStart > lastIndex) {
      segments.push(
        <span key={`plain-${lastIndex}`}>{prompt.slice(lastIndex, matchStart)}</span>
      );
    }

    segments.push(
      <span
        key={`ref-${matchStart}`}
        className="relative z-0 text-white [text-shadow:0.24px_0_currentColor,-0.24px_0_currentColor] before:absolute before:-inset-x-[4px] before:-inset-y-[1px] before:-z-10 before:rounded-[7px] before:bg-accent/55 before:content-['']"
      >
        {matchText}
      </span>
    );

    lastIndex = matchStart + matchText.length;
  }

  if (lastIndex < prompt.length) {
    segments.push(<span key={`plain-${lastIndex}`}>{prompt.slice(lastIndex)}</span>);
  }

  return segments;
}

function buildAiResultNodeTitle(prompt: string, fallbackTitle: string): string {
  const normalizedPrompt = prompt.trim();
  if (!normalizedPrompt) {
    return fallbackTitle;
  }

  return normalizedPrompt;
}

function normalizePromptForSourceComparison(prompt: string): string {
  return prompt.replace(/\r\n/g, '\n').trim();
}

export const ImageEditNode = memo(({ id, data, selected, width, height }: ImageEditNodeProps) => {
  const { t } = useTranslation();
  const updateNodeInternals = useUpdateNodeInternals();
  const [error, setError] = useState<string | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const imageBoxRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const promptHighlightRef = useRef<HTMLDivElement>(null);
  const [promptDraft, setPromptDraft] = useState(() => data.prompt ?? '');
  const promptDraftRef = useRef(promptDraft);
  const [showImagePicker, setShowImagePicker] = useState(false);
  const [pickerCursor, setPickerCursor] = useState<number | null>(null);
  const [pickerActiveIndex, setPickerActiveIndex] = useState(0);
  const [pickerAnchor, setPickerAnchor] = useState<PickerAnchor>(PICKER_FALLBACK_ANCHOR);
  const [showCameraControl, setShowCameraControl] = useState(false);
  const [generateCount, setGenerateCount] = useState(1);
  const [showCountPicker, setShowCountPicker] = useState(false);
  const [customCount, setCustomCount] = useState('');
  const countPickerRef = useRef<HTMLDivElement>(null);
  const promptCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCommittedPromptRef = useRef(data.prompt ?? '');

  const incomingImageSignature = useCanvasStore((state) =>
    selectInputImageSignature(id, state.nodes, state.edges)
  );
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const addNode = useCanvasStore((state) => state.addNode);
  const findNodePosition = useCanvasStore((state) => state.findNodePosition);
  const addEdge = useCanvasStore((state) => state.addEdge);
  const apiKeys = useSettingsStore((state) => state.apiKeys);
  const grsaiNanoBananaProModel = useSettingsStore((state) => state.grsaiNanoBananaProModel);

  const incomingImages = useMemo(
    () => parseInputImageSignature(incomingImageSignature),
    [incomingImageSignature]
  );

  const incomingImageItems = useMemo(
    () =>
      incomingImages.map((imageUrl, index) => ({
        imageUrl,
        displayUrl: resolveImageDisplayUrl(imageUrl),
        label: `图${index + 1}`,
      })),
    [incomingImages]
  );
  const incomingImageViewerList = useMemo(
    () => incomingImageItems.map((item) => resolveImageDisplayUrl(item.imageUrl)),
    [incomingImageItems]
  );
  const catalog = useImageModelCatalog();
  const firstUsableCatalogEntry = useMemo(() => catalog.find((entry) => entry.usable), [catalog]);
  const nodeModelConfig = data.modelConfig ?? (firstUsableCatalogEntry
    ? {
      entryId: firstUsableCatalogEntry.id,
      ratio: firstUsableCatalogEntry.supportedRatios[0] ?? 'auto',
      extraParams: {},
    }
    : undefined);

  const selectedModel = useMemo(() => {
    const modelId = data.model ?? DEFAULT_IMAGE_MODEL_ID;
    return getImageModel(modelId);
  }, [data.model]);
  const providerApiKey = apiKeys[selectedModel.providerId] ?? '';
  const effectiveExtraParams = useMemo(
    () => ({
      ...(data.extraParams ?? {}),
      ...(selectedModel.id === GRSAI_NANO_BANANA_PRO_MODEL_ID
        ? { grsai_pro_model: grsaiNanoBananaProModel }
        : {}),
    }),
    [data.extraParams, grsaiNanoBananaProModel, selectedModel.id]
  );

  const selectedResolution = useMemo(
    () => resolveImageModelResolution(selectedModel, data.size, { extraParams: effectiveExtraParams }),
    [data.size, effectiveExtraParams, selectedModel]
  );

  const aspectRatioOptions = useMemo<AspectRatioChoice[]>(
    () => [{
      value: AUTO_REQUEST_ASPECT_RATIO,
      label: t('modelParams.autoAspectRatio'),
    }, ...selectedModel.aspectRatios],
    [selectedModel.aspectRatios, t]
  );

  const selectedAspectRatio = useMemo(
    () =>
      aspectRatioOptions.find((item) => item.value === data.requestAspectRatio) ??
      aspectRatioOptions[0],
    [aspectRatioOptions, data.requestAspectRatio]
  );

  const requestResolution = selectedModel.resolveRequest({
    referenceImageCount: incomingImages.length,
  });
  const supportedAspectRatioValues = useMemo(
    () => selectedModel.aspectRatios.map((item) => item.value),
    [selectedModel.aspectRatios]
  );

  const resolvedTitle = useMemo(
    () => resolveNodeDisplayName(CANVAS_NODE_TYPES.imageEdit, data),
    [data]
  );

  const resolvedWidth = Math.max(IMAGE_EDIT_NODE_MIN_WIDTH, Math.round(width ?? IMAGE_EDIT_NODE_DEFAULT_WIDTH));
  const resolvedHeight = Math.max(IMAGE_EDIT_NODE_MIN_HEIGHT, Math.round(height ?? IMAGE_EDIT_NODE_DEFAULT_HEIGHT));

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, resolvedHeight, resolvedWidth, updateNodeInternals]);

  const clearPromptCommitTimer = useCallback(() => {
    if (promptCommitTimerRef.current) {
      clearTimeout(promptCommitTimerRef.current);
      promptCommitTimerRef.current = null;
    }
  }, []);

  const flushPromptDraft = useCallback((nextPrompt = promptDraftRef.current) => {
    clearPromptCommitTimer();
    promptDraftRef.current = nextPrompt;
    if (Object.is(lastCommittedPromptRef.current, nextPrompt)) {
      return;
    }
    lastCommittedPromptRef.current = nextPrompt;
    updateNodeData(id, { prompt: nextPrompt });
  }, [clearPromptCommitTimer, id, updateNodeData]);

  const schedulePromptDraftCommit = useCallback((nextPrompt: string) => {
    promptDraftRef.current = nextPrompt;
    clearPromptCommitTimer();
    if (Object.is(lastCommittedPromptRef.current, nextPrompt)) {
      return;
    }
    promptCommitTimerRef.current = setTimeout(() => {
      promptCommitTimerRef.current = null;
      const latestPrompt = promptDraftRef.current;
      if (Object.is(lastCommittedPromptRef.current, latestPrompt)) {
        return;
      }
      lastCommittedPromptRef.current = latestPrompt;
      updateNodeData(id, { prompt: latestPrompt });
    }, TEXT_DRAFT_COMMIT_DELAY_MS);
  }, [clearPromptCommitTimer, id, updateNodeData]);

  useEffect(() => {
    const externalPrompt = data.prompt ?? '';
    lastCommittedPromptRef.current = externalPrompt;
    if (externalPrompt !== promptDraftRef.current) {
      clearPromptCommitTimer();
      promptDraftRef.current = externalPrompt;
      setPromptDraft(externalPrompt);
    }
  }, [clearPromptCommitTimer, data.prompt, id]);

  useEffect(() => {
    return () => {
      if (promptCommitTimerRef.current) {
        clearTimeout(promptCommitTimerRef.current);
        promptCommitTimerRef.current = null;
      }
      const latestPrompt = promptDraftRef.current;
      if (!Object.is(lastCommittedPromptRef.current, latestPrompt)) {
        lastCommittedPromptRef.current = latestPrompt;
        updateNodeData(id, { prompt: latestPrompt });
      }
    };
  }, [id, updateNodeData]);

  const handleCameraControlApply = useCallback((cameraControl: CameraControlOptions, _cameraPrompt: string) => {
    // Only persist the structured options on the node — the camera prompt is
    // NOT injected into the user's prompt textbox (it would pollute what the
    // user sees/types). The prompt is assembled at submit time from
    // `data.cameraControl` via `buildCameraPrompt(...)` inside SelectedNodeOverlay.
    updateNodeData(id, { cameraControl });
  }, [id, updateNodeData]);

  useEffect(() => {
    if (data.model !== selectedModel.id) {
      updateNodeData(id, { model: selectedModel.id });
    }

    if (data.size !== selectedResolution.value) {
      updateNodeData(id, { size: selectedResolution.value as ImageSize });
    }

    if (data.requestAspectRatio !== selectedAspectRatio.value) {
      updateNodeData(id, { requestAspectRatio: selectedAspectRatio.value });
    }
  }, [
    data.model,
    data.requestAspectRatio,
    data.size,
    id,
    selectedAspectRatio.value,
    selectedModel.id,
    selectedResolution.value,
    updateNodeData,
  ]);

  useEffect(() => {
    if (!data.modelConfig && nodeModelConfig) {
      updateNodeData(id, { modelConfig: nodeModelConfig });
    }
  }, [data.modelConfig, id, nodeModelConfig, updateNodeData]);

  useEffect(() => {
    if (incomingImages.length === 0) {
      setShowImagePicker(false);
      setPickerCursor(null);
      setPickerActiveIndex(0);
      return;
    }

    setPickerActiveIndex((previous) => Math.min(previous, incomingImages.length - 1));
  }, [incomingImages.length]);

  useEffect(() => {
    const handleOutside = (event: MouseEvent) => {
      if (rootRef.current?.contains(event.target as globalThis.Node)) {
        return;
      }

      setShowImagePicker(false);
      setPickerCursor(null);
      setShowCountPicker(false);
    };

    document.addEventListener('mousedown', handleOutside, true);
    return () => {
      document.removeEventListener('mousedown', handleOutside, true);
    };
  }, []);

  useEffect(() => {
    const handleCountPickerOutside = (event: MouseEvent) => {
      if (countPickerRef.current?.contains(event.target as globalThis.Node)) {
        return;
      }
      setShowCountPicker(false);
    };

    if (showCountPicker) {
      document.addEventListener('mousedown', handleCountPickerOutside, true);
      return () => {
        document.removeEventListener('mousedown', handleCountPickerOutside, true);
      };
    }
  }, [showCountPicker]);

  const handleGenerate = useCallback(async () => {
    const currentPromptDraft = promptDraftRef.current;
    flushPromptDraft(currentPromptDraft);
    const latestCanvasState = useCanvasStore.getState();
    const latestNode = latestCanvasState.nodes.find((candidate) => candidate.id === id);
    const latestData = latestNode && isImageEditNode(latestNode) ? latestNode.data : data;
    const latestSettings = useSettingsStore.getState();
    const latestIncomingImages = graphImageResolver.collectInputImages(
      id,
      latestCanvasState.nodes,
      latestCanvasState.edges
    );
    let basePrompt = currentPromptDraft.replace(/@(?=图\d+)/g, '').trim();

    const selectedPresetId = latestData.selectedPromptPresetId ?? null;
    const selectedFunctionChip = selectedPresetId ? null : latestData.selectedFunctionChip ?? null;
    if (selectedPresetId && latestData.selectedFunctionChip) {
      updateNodeData(id, { selectedFunctionChip: null });
    }

    let sourcePrompt = '';
    if (selectedPresetId) {
      const selectedPreset = latestSettings.promptPresets.find((preset) => preset.id === selectedPresetId);
      if (!selectedPreset) {
        const errorMessage = t('node.imageEdit.promptPresetMissing');
        setError(errorMessage);
        void showErrorDialog(errorMessage, t('common.error'));
        return;
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
      setError(errorMessage);
      void showErrorDialog(errorMessage, t('common.error'));
      return;
    }
    if (!basePrompt && sourcePrompt && latestIncomingImages.length === 0) {
      const errorMessage = t('node.imageEdit.referenceRequiredForPromptSource');
      setError(errorMessage);
      void showErrorDialog(errorMessage, t('common.error'));
      return;
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
    if (resolved.entryId.startsWith('custom:') && resolved.requiresApiKey && !resolved.apiKey) {
      const msg = `自定义服务商「${resolved.providerLabel}」未填写 API Key`;
      setError(msg);
      void showErrorDialog(msg, t('common.error'));
      return;
    }
    if (!resolved.entryId.startsWith('dreamina:') && !resolved.entryId.startsWith('custom:')) {
      // Fallback: no custom provider configured and no Dreamina login. Prompt
      // the user to set one up in 我的配置.
      const msg = '请先在「设置 → 我的配置」里添加至少一个服务商，或在「Dreamina」里登录 CLI 后再生成。';
      setError(msg);
      void showErrorDialog(msg, t('common.error'));
      return;
    }

    const effectiveCount = customCount ? Math.min(10, Math.max(1, parseInt(customCount, 10) || 1)) : generateCount;
    const batchId = effectiveCount > 1 ? `batch-${Date.now()}` : undefined;
    const generationDurationMs = 60000;
    const generationStartedAt = Date.now();
    const resultNodeTitle = buildAiResultNodeTitle(prompt, t('node.imageEdit.resultTitle'));
    const runtimeDiagnostics = await getRuntimeDiagnostics();
    setError(null);
    setShowCountPicker(false);

    if (resolved.builtinModel && resolved.apiKey) {
      await canvasAiGateway.setApiKey(resolved.providerId, resolved.apiKey);
    }

    // Aspect ratio: honour the picker's choice directly. "auto" falls back to
    // the source image's ratio (or 1:1 if none), and for custom/Dreamina we
    // just pass it through — adapters handle 'auto' themselves.
    let resolvedRequestAspectRatio = resolved.ratio;
    if (resolvedRequestAspectRatio === 'auto') {
      if (latestIncomingImages.length > 0) {
        try {
          const sourceAspectRatio = await detectAspectRatio(latestIncomingImages[0]);
          resolvedRequestAspectRatio = sourceAspectRatio;
        } catch {
          resolvedRequestAspectRatio = '1:1';
        }
      } else {
        resolvedRequestAspectRatio = '1:1';
      }
    }

    const requestSize = '2K';
    const effectiveExtraParamsRecord = effectiveExtraParams as Record<string, unknown>;
    const requestResolutionLabel =
      resolved.extraParams?.['resolutionType'] ??
      resolved.extraParams?.['size'] ??
      effectiveExtraParamsRecord['resolutionType'] ??
      effectiveExtraParamsRecord['size'] ??
      selectedResolution.value ??
      requestSize;
    const promptForRequest = appendGenerationParameterConstraints(prompt, {
      enabled: latestSettings.appendParameterConstraintsToPrompt,
      aspectRatio: resolvedRequestAspectRatio,
      resolution: requestResolutionLabel,
      count: effectiveCount,
    });

    for (let i = 0; i < effectiveCount; i++) {
      const newNodePosition = findNodePosition(
        id,
        EXPORT_RESULT_NODE_DEFAULT_WIDTH,
        EXPORT_RESULT_NODE_LAYOUT_HEIGHT
      );
      const nodeTitle = effectiveCount > 1 ? `${resultNodeTitle} (${i + 1}/${effectiveCount})` : resultNodeTitle;
      const newNodeId = addNode(
        CANVAS_NODE_TYPES.exportImage,
        newNodePosition,
        {
          isGenerating: true,
          generationStartedAt,
          generationDurationMs,
          resultKind: 'generic',
          displayName: nodeTitle,
          batchId,
          batchIndex: i,
          batchTotal: effectiveCount,
        }
      );
      addEdge(id, newNodeId);

      try {
        const jobId = await canvasAiGateway.submitGenerateImageJob({
          prompt: promptForRequest,
          model: resolved.modelForGateway,
          size: requestSize,
          aspectRatio: resolvedRequestAspectRatio,
          referenceImages: latestIncomingImages,
          extraParams: { ...effectiveExtraParams, ...resolved.extraParams },
        });
        const generationDebugContext: GenerationDebugContext = {
          sourceType: 'imageEdit',
          providerId: resolved.providerId,
          requestModel: resolved.modelForGateway,
          requestSize,
          requestAspectRatio: resolvedRequestAspectRatio,
          prompt: promptForRequest,
          extraParams: { ...effectiveExtraParams, ...resolved.extraParams },
          referenceImageCount: latestIncomingImages.length,
          referenceImagePlaceholders: createReferenceImagePlaceholders(latestIncomingImages.length),
          appVersion: runtimeDiagnostics.appVersion,
          osName: runtimeDiagnostics.osName,
          osVersion: runtimeDiagnostics.osVersion,
          osBuild: runtimeDiagnostics.osBuild,
          userAgent: runtimeDiagnostics.userAgent,
        };
        updateNodeData(newNodeId, {
          generationJobId: jobId,
          generationSourceType: 'imageEdit',
          generationProviderId: resolved.providerId,
          generationClientSessionId: CURRENT_RUNTIME_SESSION_ID,
          generationDebugContext,
        });
      } catch (generationError) {
        const resolvedError = resolveErrorContent(generationError, t('ai.error'));
        const generationDebugContext: GenerationDebugContext = {
          sourceType: 'imageEdit',
          providerId: resolved.providerId,
          requestModel: resolved.modelForGateway,
          requestSize,
          requestAspectRatio: resolvedRequestAspectRatio,
          prompt: promptForRequest,
          extraParams: { ...effectiveExtraParams, ...resolved.extraParams },
          referenceImageCount: latestIncomingImages.length,
          referenceImagePlaceholders: createReferenceImagePlaceholders(latestIncomingImages.length),
          appVersion: runtimeDiagnostics.appVersion,
          osName: runtimeDiagnostics.osName,
          osVersion: runtimeDiagnostics.osVersion,
          osBuild: runtimeDiagnostics.osBuild,
          userAgent: runtimeDiagnostics.userAgent,
        };
        const reportText = buildGenerationErrorReport({
          errorMessage: resolvedError.message,
          errorDetails: resolvedError.details,
          context: generationDebugContext,
        });
        setError(resolvedError.message);
        void showErrorDialog(
          resolvedError.message,
          t('common.error'),
          resolvedError.details,
          reportText
        );
        updateNodeData(newNodeId, {
          isGenerating: false,
          generationStartedAt: null,
          generationJobId: null,
          generationProviderId: null,
          generationClientSessionId: null,
          generationError: resolvedError.message,
          generationErrorDetails: resolvedError.details ?? null,
          generationDebugContext,
        });
      }
    }
  }, [
    addNode,
    addEdge,
    data,
    providerApiKey,
    findNodePosition,
    flushPromptDraft,
    effectiveExtraParams,
    id,
    nodeModelConfig,
    requestResolution.requestModel,
    selectedAspectRatio.value,
    selectedModel.id,
    selectedModel.expectedDurationMs,
    selectedModel.providerId,
    selectedResolution.value,
    supportedAspectRatioValues,
    t,
    updateNodeData,
    generateCount,
    customCount,
  ]);

  const syncPromptHighlightScroll = () => {
    if (!promptRef.current || !promptHighlightRef.current) {
      return;
    }

    promptHighlightRef.current.scrollTop = promptRef.current.scrollTop;
    promptHighlightRef.current.scrollLeft = promptRef.current.scrollLeft;
  };

  const insertImageReference = useCallback((imageIndex: number) => {
    const marker = `@图${imageIndex + 1}`;
    const currentPrompt = promptDraftRef.current;
    const cursor = pickerCursor ?? currentPrompt.length;
    const { nextText: nextPrompt, nextCursor } = insertReferenceToken(currentPrompt, cursor, marker);

    setPromptDraft(nextPrompt);
    flushPromptDraft(nextPrompt);
    setShowImagePicker(false);
    setPickerCursor(null);
    setPickerActiveIndex(0);

    requestAnimationFrame(() => {
      promptRef.current?.focus();
      promptRef.current?.setSelectionRange(nextCursor, nextCursor);
      syncPromptHighlightScroll();
    });
  }, [flushPromptDraft, pickerCursor]);

  const handlePromptPaste = useCallback(
    async (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
      const imageFile = resolveClipboardImageFile(event.nativeEvent);
      if (!imageFile) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const textarea = event.currentTarget;
      const cursor = textarea.selectionStart ?? promptDraftRef.current.length;

      try {
        const prepared = await prepareNodeImageFromFile(imageFile);
        const latestNode = useCanvasStore
          .getState()
          .nodes.find((candidate) => candidate.id === id);
        const basePosition = latestNode?.position ?? { x: 0, y: 0 };
        const uploadNodeId = addNode(
          CANVAS_NODE_TYPES.upload,
          {
            x: basePosition.x - PASTED_REFERENCE_NODE_OFFSET_X,
            y: basePosition.y,
          },
          {
            imageUrl: prepared.imageUrl,
            previewImageUrl: prepared.previewImageUrl,
            aspectRatio: prepared.aspectRatio || '1:1',
            sourceFileName: imageFile.name,
          }
        );
        addEdge(uploadNodeId, id);

        const marker = `@图${incomingImages.length + 1}`;
        const currentPrompt = promptDraftRef.current;
        const { nextText: nextPrompt, nextCursor } = insertReferenceToken(
          currentPrompt,
          cursor,
          marker
        );
        setPromptDraft(nextPrompt);
        flushPromptDraft(nextPrompt);
        setShowImagePicker(false);
        setPickerCursor(null);
        setPickerActiveIndex(0);

        requestAnimationFrame(() => {
          promptRef.current?.focus();
          promptRef.current?.setSelectionRange(nextCursor, nextCursor);
          syncPromptHighlightScroll();
        });
      } catch (pasteError) {
        const resolvedError = resolveErrorContent(pasteError, t('common.error'));
        void showErrorDialog(
          resolvedError.message,
          t('common.error'),
          resolvedError.details
        );
      }
    },
    [addEdge, addNode, flushPromptDraft, id, incomingImages.length, t]
  );

  const handlePromptKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Backspace' || event.key === 'Delete') {
      const currentPrompt = promptDraftRef.current;
      const selectionStart = event.currentTarget.selectionStart ?? currentPrompt.length;
      const selectionEnd = event.currentTarget.selectionEnd ?? selectionStart;
      const deletionDirection = event.key === 'Backspace' ? 'backward' : 'forward';
      const deleteRange = resolveReferenceAwareDeleteRange(
        currentPrompt,
        selectionStart,
        selectionEnd,
        deletionDirection,
        incomingImages.length
      );
      if (deleteRange) {
        event.preventDefault();
        const { nextText, nextCursor } = removeTextRange(currentPrompt, deleteRange);
        setPromptDraft(nextText);
        flushPromptDraft(nextText);
        requestAnimationFrame(() => {
          promptRef.current?.focus();
          promptRef.current?.setSelectionRange(nextCursor, nextCursor);
          syncPromptHighlightScroll();
        });
        return;
      }
    }

    if (showImagePicker && incomingImages.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setPickerActiveIndex((previous) => (previous + 1) % incomingImages.length);
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setPickerActiveIndex((previous) =>
          previous === 0 ? incomingImages.length - 1 : previous - 1
        );
        return;
      }

      if (event.key === 'Enter') {
        event.preventDefault();
        insertImageReference(pickerActiveIndex);
        return;
      }
    }

    if (event.key === '@' && incomingImages.length > 0) {
      event.preventDefault();
      const cursor = event.currentTarget.selectionStart ?? promptDraftRef.current.length;
      setPickerAnchor(resolvePickerAnchor(rootRef.current, event.currentTarget, cursor));
      setPickerCursor(cursor);
      setShowImagePicker(true);
      setPickerActiveIndex(0);
      return;
    }

    if (event.key === 'Escape' && showImagePicker) {
      event.preventDefault();
      setShowImagePicker(false);
      setPickerCursor(null);
      setPickerActiveIndex(0);
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      void handleGenerate();
    }
  };

  return (
    <div
      ref={rootRef}
      className={`
        group relative flex h-full flex-col overflow-visible rounded-[var(--node-radius)] border bg-[var(--canvas-node-bg)] p-2 shadow-[var(--canvas-node-shadow)] transition-colors duration-150
        ${selected
          ? 'border-accent shadow-[0_0_0_1px_rgba(59,130,246,0.32)]'
          : 'border-[var(--canvas-node-border)] hover:border-[var(--canvas-node-border-hover)]'}
      `}
      style={{ width: `${resolvedWidth}px`, height: `${resolvedHeight}px` }}
      onClick={() => setSelectedNode(id)}
    >
      <NodeHeader
        className={NODE_HEADER_FLOATING_POSITION_CLASS}
        icon={<Sparkles className="h-4 w-4" />}
        titleText={resolvedTitle}
        editable
        onTitleChange={(nextTitle) => updateNodeData(id, { displayName: nextTitle })}
      />

      <div ref={imageBoxRef} className="image-box relative min-h-0 flex-1 rounded-lg border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-field-bg)] p-2">
        <div className="relative h-full min-h-0">
          <div
            ref={promptHighlightRef}
            aria-hidden="true"
            className="ui-scrollbar pointer-events-none absolute inset-0 overflow-y-auto overflow-x-hidden text-sm leading-6 text-text-dark"
            style={{ scrollbarGutter: 'stable' }}
          >
            <div className="min-h-full whitespace-pre-wrap break-words px-1 py-0.5">
              {renderPromptWithHighlights(promptDraft, incomingImages.length)}
            </div>
          </div>

          <textarea
            ref={promptRef}
            value={promptDraft}
            onChange={(event) => {
              const nextValue = event.target.value;
              setPromptDraft(nextValue);
              promptDraftRef.current = nextValue;
              schedulePromptDraftCommit(nextValue);
            }}
            onBlur={() => flushPromptDraft()}
            onKeyDown={handlePromptKeyDown}
            onPaste={handlePromptPaste}
            onScroll={syncPromptHighlightScroll}
            onMouseDown={(event) => event.stopPropagation()}
            placeholder={t('node.imageEdit.promptPlaceholder')}
            className="ui-scrollbar nodrag nowheel relative z-10 h-full w-full resize-none overflow-y-auto overflow-x-hidden border-none bg-transparent px-1 py-0.5 text-sm leading-6 text-transparent caret-text-dark outline-none placeholder:text-text-muted/80 focus:border-transparent whitespace-pre-wrap break-words"
            style={{ scrollbarGutter: 'stable' }}
          />
        </div>

        {showImagePicker && incomingImageItems.length > 0 && (
          <div
            className="nowheel absolute z-30 w-[120px] overflow-hidden rounded-xl border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-menu-bg)] shadow-xl"
            style={{ left: pickerAnchor.left, top: pickerAnchor.top }}
            onMouseDown={(event) => event.stopPropagation()}
            onWheelCapture={(event) => event.stopPropagation()}
          >
            <div
              className="ui-scrollbar nowheel max-h-[180px] overflow-y-auto"
              onWheelCapture={(event) => event.stopPropagation()}
            >
              {incomingImageItems.map((item, index) => (
                <button
                  key={`${item.imageUrl}-${index}`}
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    insertImageReference(index);
                  }}
                  onMouseEnter={() => setPickerActiveIndex(index)}
                  className={`flex w-full items-center gap-2 border border-transparent bg-transparent px-2 py-2 text-left text-sm text-text-dark transition-colors hover:border-[var(--canvas-node-field-border)] hover:bg-[var(--canvas-node-menu-hover)] ${pickerActiveIndex === index
                      ? 'border-accent/35 bg-[var(--canvas-node-menu-active)]'
                      : ''
                    }`}
                >
                  <CanvasNodeImage
                    src={item.displayUrl}
                    alt={item.label}
                    viewerSourceUrl={resolveImageDisplayUrl(item.imageUrl)}
                    viewerImageList={incomingImageViewerList}
                    className="h-8 w-8 rounded object-cover"
                    draggable={false}
                  />
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="mt-2 flex min-w-0 shrink-0 flex-nowrap items-center gap-1">
        {/*
         * AI 图片节点现在走「自主服务商时代」：只显示用户在「我的配置」里
         * 添加的供应商 + 已登录的即梦 CLI。内置 KIE / FAL / GRSAI 不再直接
         * 出现在选择器里，用户要用这些请作为 custom provider 添加。
         */}
        <ModelConfigPicker
          panelKey="aiImageNode"
          className="flex-1"
          value={nodeModelConfig}
          onChange={(modelConfig) => updateNodeData(id, { modelConfig })}
        />

        <UiButton
          onClick={(event) => {
            event.stopPropagation();
            setShowCameraControl(true);
          }}
          variant={data.cameraControl?.enabled === true ? 'primary' : 'muted'}
          className={`shrink-0 ${NODE_CONTROL_CHIP_CLASS}`}
        >
          <Video className={NODE_CONTROL_ICON_CLASS} />
          {t('cameraControl.title')}
        </UiButton>

        <div className="relative">
          <UiButton
            onClick={(event) => {
              event.stopPropagation();
              setShowCountPicker(!showCountPicker);
            }}
            variant="muted"
            className={`shrink-0 !inline-flex !flex-row !items-center !justify-center ${NODE_CONTROL_CHIP_CLASS}`}
          >
            <span className="shrink-0">{customCount || generateCount}张</span>
            <span className="ml-0.5 shrink-0 text-[10px] opacity-70">▾</span>
          </UiButton>

          {showCountPicker && (
            <div
              ref={countPickerRef}
              className="nowheel absolute bottom-full right-0 z-50 mb-1 w-[120px] overflow-hidden rounded-xl border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-menu-bg)] shadow-xl"
              onMouseDown={(event) => event.stopPropagation()}
            >
              {[1, 2, 3, 4].map((count) => (
                <button
                  key={count}
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    setGenerateCount(count);
                    setCustomCount('');
                    setShowCountPicker(false);
                  }}
                  className={`flex w-full items-center px-3 py-2 text-left text-sm text-text-dark transition-colors hover:bg-[var(--canvas-node-menu-hover)] ${
                    generateCount === count && !customCount ? 'bg-[var(--canvas-node-menu-active)]' : ''
                  }`}
                >
                  {count}
                </button>
              ))}
              <div className="border-t border-[var(--canvas-node-divider)]">
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                  }}
                  className="flex w-full items-center px-3 py-2 text-left text-sm text-text-dark transition-colors hover:bg-[var(--canvas-node-menu-hover)]"
                >
                  {t('node.imageEdit.customCount')}
                </button>
                <div className="px-3 py-2">
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={customCount}
                    onChange={(event) => {
                      setCustomCount(event.target.value);
                    }}
                    onClick={(event) => event.stopPropagation()}
                    placeholder="1-10"
                    className="w-full rounded-md border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-field-bg)] px-2 py-1 text-sm text-text-dark outline-none focus:border-accent"
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        <UiButton
          onClick={(event) => {
            event.stopPropagation();
            void handleGenerate();
          }}
          variant="primary"
          className={`shrink-0 ${NODE_CONTROL_PRIMARY_BUTTON_CLASS}`}
        >
          <Sparkles className={NODE_CONTROL_ICON_CLASS} strokeWidth={2.8} />
          {t('canvas.generate')}
        </UiButton>
      </div>

      {error && <div className="mt-1 shrink-0 text-xs text-red-400">{error}</div>}

      <Handle
        type="target"
        id="target"
        position={Position.Left}
        className="!h-2 !w-2 !border-surface-dark !bg-accent"
      />
      <Handle
        type="source"
        id="source"
        position={Position.Right}
        className="!h-2 !w-2 !border-surface-dark !bg-accent"
      />
      <NodeResizeHandle
        minWidth={IMAGE_EDIT_NODE_MIN_WIDTH}
        minHeight={IMAGE_EDIT_NODE_MIN_HEIGHT}
        maxWidth={IMAGE_EDIT_NODE_MAX_WIDTH}
        maxHeight={IMAGE_EDIT_NODE_MAX_HEIGHT}
      />

      <CameraControlPanel
        isOpen={showCameraControl}
        onClose={() => setShowCameraControl(false)}
        cameraControl={data.cameraControl}
        onApply={handleCameraControlApply}
      />
    </div>
  );
});

ImageEditNode.displayName = 'ImageEditNode';
