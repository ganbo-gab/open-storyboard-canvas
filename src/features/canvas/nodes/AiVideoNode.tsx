import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { AlertTriangle, Bug, Camera, Check, ChevronDown, ChevronRight, Copy, Sparkles, Video, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  type CameraControlOptions,
  CANVAS_NODE_TYPES,
  EXPORT_RESULT_NODE_DEFAULT_WIDTH,
  EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
  isAiVideoNode,
  type AiVideoNodeData,
} from '@/features/canvas/domain/canvasNodes';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import {
  parseInputImageSignature,
  parseInputReferenceSignature,
  selectInputImageSignature,
  selectInputReferenceSignature,
} from '@/features/canvas/application/canvasGraphSelectors';
import {
  buildReferenceContextPrompt,
  collectInputReferences,
} from '@/features/canvas/application/graphReferenceResolver';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { resolveErrorContent, showErrorDialog } from '@/features/canvas/application/errorDialog';
import {
  CURRENT_RUNTIME_SESSION_ID,
  createReferenceImagePlaceholders,
  getRuntimeDiagnostics,
  type GenerationDebugContext,
} from '@/features/canvas/application/generationErrorReport';
import {
  acquireGenerationSubmitLock,
  generationSubmitLockKey,
} from '@/features/canvas/application/generationSubmitLock';
import {
  findReferenceTokens,
  insertReferenceToken as insertReferenceTokenText,
  removeTextRange,
  resolveReferenceAwareDeleteRange,
} from '@/features/canvas/application/referenceTokenEditing';
import {
  buildVideoModelCatalog,
  resolveVideoModelConfig,
  useVideoModelCatalog,
  type VideoCatalogEntry,
  type VideoModelConfigValue,
} from '@/features/canvas/application/videoModelCatalog';
import {
  DEFAULT_VIDEO_INPUT_SCHEMA,
  normalizeVideoInputSchema,
  type VideoInputSchema,
} from '@/features/canvas/application/videoInputSchema';
import {
  buildVideoGenerationDebugPreview,
  canvasEventBus,
  canvasVideoGateway,
} from '@/features/canvas/application/canvasServices';
import {
  getLocalDateStamp,
  resolveDefaultGeneratedVideoDisplayName,
  resolveDefaultGeneratedVideoFileStem,
  resolveNextGeneratedMediaSequence,
} from '@/features/canvas/application/generatedMediaNaming';
import { CanvasNodeImage } from '@/features/canvas/ui/CanvasNodeImage';
import { CameraControlPanel } from '@/features/canvas/ui/CameraControlPanel';
import { buildCameraPrompt } from '@/features/canvas/application/cameraPromptLibrary';
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from '@/features/canvas/ui/NodeHeader';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import {
  NODE_CONTROL_CHIP_CLASS,
  NODE_CONTROL_ICON_CLASS,
  NODE_CONTROL_PRIMARY_BUTTON_CLASS,
} from '@/features/canvas/ui/nodeControlStyles';
import { UiButton, UiModal } from '@/components/ui';
import { useCanvasStore } from '@/stores/canvasStore';
import { useCustomProvidersStore } from '@/stores/customProvidersStore';
import { useSettingsStore } from '@/stores/settingsStore';

type AiVideoNodeProps = NodeProps & {
  id: string;
  data: AiVideoNodeData;
  selected?: boolean;
};

const AI_VIDEO_NODE_MIN_WIDTH = 560;
const AI_VIDEO_NODE_MIN_HEIGHT = 260;
const AI_VIDEO_NODE_DEFAULT_WIDTH = 680;
const AI_VIDEO_NODE_DEFAULT_HEIGHT = 360;
const AI_VIDEO_NODE_MAX_WIDTH = 1400;
const AI_VIDEO_NODE_MAX_HEIGHT = 1000;
const PROMPT_COMMIT_DELAY_MS = 650;
const VIDEO_GENERATION_PROGRESS_DURATION_MS = 15 * 60 * 1000;
const PICKER_FALLBACK_ANCHOR = { left: 8, top: 8 };
const PICKER_Y_OFFSET_PX = 20;
const REFERENCE_PICKER_WIDTH_PX = 150;
const FUNCTION_PICKER_WIDTH_PX = 280;
const PROMPT_PRESET_GROUP_ID = '__prompt_presets__';
const INLINE_REFERENCE_SEPARATOR = '，';
const AI_VIDEO_SELECTOR_CHIP_CLASS =
  'border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-button-bg)] text-text-dark shadow-sm hover:border-[var(--canvas-node-border-hover)] hover:bg-[var(--canvas-node-menu-hover)]';
const AI_VIDEO_COMPACT_ICON_CHIP_CLASS =
  '!w-6 !px-0 border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-button-bg)] text-text-dark shadow-sm hover:border-[var(--canvas-node-border-hover)] hover:bg-[var(--canvas-node-menu-hover)]';

function renderPromptWithHighlights(prompt: string, maxImageCount: number): ReactNode {
  if (!prompt) return ' ';
  const segments: ReactNode[] = [];
  let lastIndex = 0;
  for (const token of findReferenceTokens(prompt, maxImageCount)) {
    if (token.start > lastIndex) {
      segments.push(<span key={`plain-${lastIndex}`}>{prompt.slice(lastIndex, token.start)}</span>);
    }
    segments.push(
      <span
        key={`ref-${token.start}`}
        className="inline rounded-[5px] bg-accent/45 font-medium text-white [box-decoration-break:clone] [-webkit-box-decoration-break:clone] [text-shadow:0.24px_0_currentColor,-0.24px_0_currentColor]"
      >
        {token.token}
      </span>
    );
    lastIndex = token.start + token.token.length;
  }
  if (lastIndex < prompt.length) {
    segments.push(<span key={`plain-${lastIndex}`}>{prompt.slice(lastIndex)}</span>);
  }
  return segments;
}

function getTextareaCaretOffset(
  textarea: HTMLTextAreaElement,
  caretIndex: number
): { left: number; top: number } {
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
): { left: number; top: number } {
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

function serializeDebugJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function defaultDurationForVideoEntry(entry: VideoCatalogEntry): string {
  if (entry.providerId === 'agnes' && entry.supportedDurations.includes('5')) {
    return '5';
  }
  return entry.supportedDurations[0] ?? '4';
}

function resolveAgnesVideoMode(extraParams: Record<string, unknown> | undefined): 'keyframes' | null {
  const raw = extraParams?.agnesVideoMode ?? extraParams?.videoMode ?? extraParams?.mode;
  return typeof raw === 'string' && raw.toLowerCase() === 'keyframes' ? 'keyframes' : null;
}

function resolveEntryInputSchema(entry?: VideoCatalogEntry): VideoInputSchema {
  return normalizeVideoInputSchema(entry?.inputSchema, DEFAULT_VIDEO_INPUT_SCHEMA);
}

function describeVideoInputSchema(schema: VideoInputSchema): string {
  const parts: string[] = [];
  if (schema.images.enabled) {
    const imagePart = schema.images.max > 0
      ? `图 ${schema.images.min}-${schema.images.max}`
      : '图 0';
    parts.push(schema.images.requireImageHost ? `${imagePart} URL` : imagePart);
  }
  if (schema.video.enabled) {
    parts.push(`视频 ${schema.video.min}-${schema.video.max}`);
  }
  if (schema.audio.enabled) {
    parts.push(`音频 ${schema.audio.min}-${schema.audio.max}`);
  }
  return parts.length > 0 ? parts.join(' / ') : '无引用';
}

function describeCompactVideoInputSchema(schema: VideoInputSchema): string {
  const parts: string[] = [];
  if (schema.images.enabled) {
    const imagePart = `图${Math.max(0, schema.images.max)}`;
    parts.push(schema.images.requireImageHost ? `${imagePart}URL` : imagePart);
  }
  if (schema.video.enabled) {
    parts.push(`视频${Math.max(0, schema.video.max)}`);
  }
  if (schema.audio.enabled) {
    parts.push(`音频${Math.max(0, schema.audio.max)}`);
  }
  return parts.length > 0 ? parts.join('/') : '无';
}

function describeReferenceForPrompt(reference: { kind: string; token: string; title: string }): string {
  const title = reference.title.trim() || reference.token;
  if (reference.kind === 'image') {
    return `${reference.token}是${title}`;
  }
  if (reference.kind === 'audio') {
    return `${reference.token}是${title}的声音`;
  }
  if (reference.kind === 'video') {
    return `${reference.token}是参考视频`;
  }
  return `${reference.token}是${title}`;
}

function appendMissingReferenceDescriptions(
  prompt: string,
  references: Array<{ kind: string; token: string; title: string }>
): string {
  const additions = references
    .map(describeReferenceForPrompt)
    .filter((line) => line && !prompt.includes(line));
  if (additions.length === 0) {
    return prompt;
  }
  const trimmedPrompt = prompt.trimEnd();
  const inlineAdditions = additions.join(INLINE_REFERENCE_SEPARATOR);
  const suffix = inlineAdditions.endsWith(INLINE_REFERENCE_SEPARATOR) ? '' : INLINE_REFERENCE_SEPARATOR;
  if (!trimmedPrompt) {
    return `${inlineAdditions}${suffix}`;
  }
  const connector = /[，,、。；;：:\s]$/.test(trimmedPrompt) ? '' : INLINE_REFERENCE_SEPARATOR;
  return `${trimmedPrompt}${connector}${inlineAdditions}${suffix}`;
}

interface VideoGenerationRequestAssembly {
  prompt: string;
  latestModelConfig: VideoModelConfigValue;
  latestEntry: VideoCatalogEntry;
  latestIncomingImages: string[];
  latestIncomingVideos: string[];
  latestIncomingAudios: string[];
  outputAspectRatio: string;
  gatewayPayload: {
    prompt: string;
    model: string;
    size: string;
    aspectRatio?: string;
    seconds?: number;
    referenceImages: string[];
    referenceVideos: string[];
    referenceAudios: string[];
    extraParams?: Record<string, unknown>;
  };
}

export const AiVideoNode = memo(({ id, data, selected, width, height }: AiVideoNodeProps) => {
  const { t } = useTranslation();
  const updateNodeInternals = useUpdateNodeInternals();
  const rootRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const promptHighlightRef = useRef<HTMLDivElement>(null);
  const promptCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCommittedPromptRef = useRef(data.prompt ?? '');
  const [promptDraft, setPromptDraft] = useState(() => data.prompt ?? '');
  const promptDraftRef = useRef(promptDraft);
  const [error, setError] = useState<string | null>(null);
  const [providerOpen, setProviderOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [paramsOpen, setParamsOpen] = useState(false);
  const [referencePickerOpen, setReferencePickerOpen] = useState(false);
  const [referencePickerAnchor, setReferencePickerAnchor] = useState(PICKER_FALLBACK_ANCHOR);
  const [referencePickerCursor, setReferencePickerCursor] = useState<number | null>(null);
  const [referencePickerActiveIndex, setReferencePickerActiveIndex] = useState(0);
  const [showFunctionPicker, setShowFunctionPicker] = useState(false);
  const [functionPickerAnchor, setFunctionPickerAnchor] = useState(PICKER_FALLBACK_ANCHOR);
  const [functionPickerActiveIndex, setFunctionPickerActiveIndex] = useState(0);
  const [showCameraControl, setShowCameraControl] = useState(false);
  const [payloadDebugText, setPayloadDebugText] = useState<string | null>(null);
  const [payloadDebugCopied, setPayloadDebugCopied] = useState(false);

  const incomingImageSignature = useCanvasStore((state) =>
    selectInputImageSignature(id, state.nodes, state.edges)
  );
  const incomingReferenceSignature = useCanvasStore((state) =>
    selectInputReferenceSignature(id, state.nodes, state.edges)
  );
  const incomingImages = useMemo(
    () => parseInputImageSignature(incomingImageSignature),
    [incomingImageSignature]
  );
  const incomingReferences = useMemo(
    () => parseInputReferenceSignature(incomingReferenceSignature),
    [incomingReferenceSignature]
  );
  const incomingViewerList = useMemo(
    () => incomingImages.map((imageUrl) => resolveImageDisplayUrl(imageUrl)),
    [incomingImages]
  );
  const incomingReferenceItems = useMemo(
    () => incomingReferences.map((reference) => ({
      ...reference,
      displayUrl: reference.kind === 'image' && reference.imageUrl
        ? resolveImageDisplayUrl(reference.imageUrl)
        : reference.kind === 'video' && reference.thumbnailUrl
          ? resolveImageDisplayUrl(reference.thumbnailUrl)
          : null,
    })),
    [incomingReferences]
  );
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const addNode = useCanvasStore((state) => state.addNode);
  const addEdge = useCanvasStore((state) => state.addEdge);
  const findNodePosition = useCanvasStore((state) => state.findNodePosition);
  const catalog = useVideoModelCatalog();
  const showNodePayloadPreview = useSettingsStore((state) => state.showNodePayloadPreview);
  const promptPresets = useSettingsStore((state) => state.promptPresets);
  const resolvedModelConfig = useMemo(
    () => resolveVideoModelConfig(catalog, data.modelConfig),
    [catalog, data.modelConfig]
  );
  const selectedEntry = useMemo(
    () => resolveConfigEntry(catalog, resolvedModelConfig),
    [catalog, resolvedModelConfig]
  );
  const currentInputSchema = useMemo(
    () => resolveEntryInputSchema(selectedEntry),
    [selectedEntry]
  );
  const schemaIncomingImageItems = useMemo(
    () => currentInputSchema.images.enabled
      ? incomingReferenceItems
        .filter((reference) => reference.kind === 'image' && reference.imageUrl)
        .slice(0, currentInputSchema.images.max)
      : [],
    [currentInputSchema.images.enabled, currentInputSchema.images.max, incomingReferenceItems]
  );
  const schemaReferencePickerItems = useMemo(
    () => incomingReferenceItems.filter((reference) => {
      if (reference.kind === 'image') return currentInputSchema.images.enabled;
      if (reference.kind === 'video') return currentInputSchema.video.enabled;
      if (reference.kind === 'audio') return currentInputSchema.audio.enabled;
      return true;
    }),
    [currentInputSchema.audio.enabled, currentInputSchema.images.enabled, currentInputSchema.video.enabled, incomingReferenceItems]
  );
  const functionPickerItems = useMemo(() => (
    promptPresets.length > 0
      ? [{
        kind: 'presetGroup' as const,
        id: PROMPT_PRESET_GROUP_ID,
        label: t('nodeToolbar.promptPreset') as string,
        description: t('nodeToolbar.promptPresetMenuTitle') as string,
        icon: Sparkles,
      }]
      : []
  ), [promptPresets.length, t]);
  const selectedPresetLabel = useMemo(() => {
    if (!data.selectedPromptPresetId) {
      return null;
    }
    return promptPresets.find((preset) => preset.id === data.selectedPromptPresetId)?.name ?? null;
  }, [data.selectedPromptPresetId, promptPresets]);
  const isAgnesVideoModel = selectedEntry?.providerId === 'agnes';
  const agnesVideoMode = resolveAgnesVideoMode(resolvedModelConfig?.extraParams);
  const entriesByProvider = useMemo(() => {
    const map = new Map<string, VideoCatalogEntry[]>();
    for (const entry of catalog) {
      const bucket = map.get(entry.providerLabel) ?? [];
      bucket.push(entry);
      map.set(entry.providerLabel, bucket);
    }
    return map;
  }, [catalog]);
  const modelsForSelectedProvider = useMemo(
    () => selectedEntry ? (entriesByProvider.get(selectedEntry.providerLabel) ?? []) : [],
    [entriesByProvider, selectedEntry]
  );
  const resolvedTitle = useMemo(
    () => resolveNodeDisplayName(CANVAS_NODE_TYPES.aiVideo, data),
    [data]
  );
  const resolvedWidth = Math.max(AI_VIDEO_NODE_MIN_WIDTH, Math.round(width ?? AI_VIDEO_NODE_DEFAULT_WIDTH));
  const resolvedHeight = Math.max(AI_VIDEO_NODE_MIN_HEIGHT, Math.round(height ?? AI_VIDEO_NODE_DEFAULT_HEIGHT));

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, resolvedHeight, resolvedWidth, updateNodeInternals]);

  useEffect(() => {
    if (!data.modelConfig && resolvedModelConfig) {
      updateNodeData(id, { modelConfig: resolvedModelConfig });
    }
  }, [data.modelConfig, id, resolvedModelConfig, updateNodeData]);

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

  const schedulePromptCommit = useCallback((nextPrompt: string) => {
    promptDraftRef.current = nextPrompt;
    clearPromptCommitTimer();
    if (Object.is(lastCommittedPromptRef.current, nextPrompt)) {
      return;
    }
    promptCommitTimerRef.current = setTimeout(() => {
      promptCommitTimerRef.current = null;
      const latest = promptDraftRef.current;
      if (Object.is(lastCommittedPromptRef.current, latest)) {
        return;
      }
      lastCommittedPromptRef.current = latest;
      updateNodeData(id, { prompt: latest });
    }, PROMPT_COMMIT_DELAY_MS);
  }, [clearPromptCommitTimer, id, updateNodeData]);

  useEffect(() => {
    const externalPrompt = data.prompt ?? '';
    lastCommittedPromptRef.current = externalPrompt;
    if (externalPrompt !== promptDraftRef.current) {
      clearPromptCommitTimer();
      promptDraftRef.current = externalPrompt;
      setPromptDraft(externalPrompt);
    }
  }, [clearPromptCommitTimer, data.prompt]);

  useEffect(() => {
    return () => {
      if (promptCommitTimerRef.current) {
        clearTimeout(promptCommitTimerRef.current);
      }
      const latest = promptDraftRef.current;
      if (!Object.is(lastCommittedPromptRef.current, latest)) {
        updateNodeData(id, { prompt: latest });
      }
    };
  }, [id, updateNodeData]);

  const syncPromptHighlightScroll = useCallback(() => {
    if (!promptRef.current || !promptHighlightRef.current) return;
    promptHighlightRef.current.scrollTop = promptRef.current.scrollTop;
    promptHighlightRef.current.scrollLeft = promptRef.current.scrollLeft;
  }, []);

  useEffect(() => {
    if (incomingReferences.length === 0) {
      return;
    }
    const nextPrompt = appendMissingReferenceDescriptions(promptDraftRef.current, incomingReferences);
    if (nextPrompt === promptDraftRef.current) {
      return;
    }
    promptDraftRef.current = nextPrompt;
    setPromptDraft(nextPrompt);
    flushPromptDraft(nextPrompt);
    requestAnimationFrame(syncPromptHighlightScroll);
  }, [flushPromptDraft, incomingReferenceSignature, incomingReferences, syncPromptHighlightScroll]);

  const insertReferenceToken = useCallback((index: number) => {
    const marker = schemaReferencePickerItems[index]?.token ?? '';
    if (!marker) {
      return;
    }
    const textarea = promptRef.current;
    const current = promptDraftRef.current;
    const cursor = referencePickerCursor ?? textarea?.selectionStart ?? current.length;
    const { nextText: nextPrompt, nextCursor } = insertReferenceTokenText(current, cursor, marker);
    setPromptDraft(nextPrompt);
    flushPromptDraft(nextPrompt);
    setReferencePickerOpen(false);
    setReferencePickerCursor(null);
    setReferencePickerActiveIndex(0);
    requestAnimationFrame(() => {
      promptRef.current?.focus();
      promptRef.current?.setSelectionRange(nextCursor, nextCursor);
      syncPromptHighlightScroll();
    });
  }, [flushPromptDraft, referencePickerCursor, schemaReferencePickerItems, syncPromptHighlightScroll]);

  const selectPromptPresetFromPicker = useCallback((presetId: string) => {
    updateNodeData(id, { selectedPromptPresetId: presetId });
    setShowFunctionPicker(false);
    setFunctionPickerActiveIndex(0);
    requestAnimationFrame(() => {
      promptRef.current?.focus();
      syncPromptHighlightScroll();
    });
  }, [id, syncPromptHighlightScroll, updateNodeData]);

  const selectFunctionPickerItem = useCallback((index: number) => {
    const item = functionPickerItems[index];
    if (!item) return;
    const firstPreset = promptPresets[0];
    if (firstPreset) {
      selectPromptPresetFromPicker(firstPreset.id);
    }
  }, [functionPickerItems, promptPresets, selectPromptPresetFromPicker]);

  const clearSelectedPromptPreset = useCallback(() => {
    updateNodeData(id, { selectedPromptPresetId: null });
  }, [id, updateNodeData]);

  const handleCameraControlApply = useCallback((cameraControl: CameraControlOptions) => {
    updateNodeData(id, { cameraControl });
  }, [id, updateNodeData]);

  const handleConfigChange = useCallback((patch: Partial<VideoModelConfigValue>) => {
    const base = resolvedModelConfig ?? resolveVideoModelConfig(catalog, null);
    if (!base) return;
    updateNodeData(id, { modelConfig: { ...base, ...patch } });
  }, [catalog, id, resolvedModelConfig, updateNodeData]);

  const handleAgnesVideoModeChange = useCallback((mode: 'multi' | 'keyframes') => {
    const base = resolvedModelConfig ?? resolveVideoModelConfig(catalog, null);
    if (!base) return;
    const nextExtraParams = { ...(base.extraParams ?? {}) };
    if (mode === 'keyframes') {
      nextExtraParams.agnesVideoMode = 'keyframes';
    } else {
      delete nextExtraParams.agnesVideoMode;
      delete nextExtraParams.videoMode;
      delete nextExtraParams.mode;
    }
    updateNodeData(id, {
      modelConfig: {
        ...base,
        extraParams: nextExtraParams,
      },
    });
  }, [catalog, id, resolvedModelConfig, updateNodeData]);

  const closeOpenPopovers = useCallback(() => {
    setProviderOpen(false);
    setModelOpen(false);
    setParamsOpen(false);
    setReferencePickerOpen(false);
    setReferencePickerCursor(null);
    setShowFunctionPicker(false);
  }, []);

  useEffect(() => {
    if (!providerOpen && !modelOpen && !paramsOpen && !referencePickerOpen && !showFunctionPicker) {
      return;
    }
    const handleOutside = (event: MouseEvent) => {
      if (rootRef.current?.contains(event.target as globalThis.Node)) {
        return;
      }
      closeOpenPopovers();
    };
    document.addEventListener('mousedown', handleOutside, true);
    return () => document.removeEventListener('mousedown', handleOutside, true);
  }, [closeOpenPopovers, modelOpen, paramsOpen, providerOpen, referencePickerOpen, showFunctionPicker]);

  const assembleVideoGenerationRequest = useCallback((): VideoGenerationRequestAssembly | null => {
    const latestPromptDraft = promptDraftRef.current;
    flushPromptDraft(latestPromptDraft);
    const latestCanvasState = useCanvasStore.getState();
    const latestNode = latestCanvasState.nodes.find((candidate) => candidate.id === id);
    const latestData = latestNode && isAiVideoNode(latestNode) ? latestNode.data : data;
    const latestSettings = useSettingsStore.getState();
    const latestCatalog = buildVideoModelCatalog(
      useCustomProvidersStore.getState().providers,
      latestSettings.agnesApiKey
    );
    const latestModelConfig = resolveVideoModelConfig(latestCatalog, latestData.modelConfig ?? resolvedModelConfig);
    const latestEntry = resolveConfigEntry(latestCatalog, latestModelConfig);
    const basePrompt = latestPromptDraft.replace(/@(?=(?:图|视频|音频|文本)\d+)/g, '').trim();
    let sourcePrompt = '';
    if (latestData.selectedPromptPresetId) {
      const selectedPreset = latestSettings.promptPresets.find((preset) => preset.id === latestData.selectedPromptPresetId);
      if (!selectedPreset) {
        const message = t('node.imageEdit.promptPresetMissing');
        setError(message);
        void showErrorDialog(message, t('common.error'));
        return null;
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
    const latestReferences = collectInputReferences(id, latestCanvasState.nodes, latestCanvasState.edges);
    const referenceContextPrompt = buildReferenceContextPrompt(latestReferences);
    const prompt = referenceContextPrompt
      ? `${referenceContextPrompt}\n\n${composedPrompt}`
      : composedPrompt;
    if (!prompt) {
      const message = t('node.aiVideo.promptRequired');
      setError(message);
      void showErrorDialog(message, t('common.error'));
      return null;
    }
    if (!latestModelConfig || !latestEntry) {
      const message = t('node.aiVideo.noVideoProvider');
      setError(message);
      void showErrorDialog(message, t('common.error'));
      return null;
    }
    if (!latestEntry.usable) {
      const message = latestEntry.notReadyReason ?? t('node.aiVideo.noVideoProvider');
      setError(message);
      void showErrorDialog(message, t('common.error'));
      return null;
    }
    const latestInputSchema = resolveEntryInputSchema(latestEntry);
    const latestIncomingImages = latestInputSchema.images.enabled
      ? latestReferences
        .filter((reference) => reference.kind === 'image' && reference.imageUrl)
        .map((reference) => reference.imageUrl as string)
        .slice(0, latestInputSchema.images.max)
      : [];
    const latestIncomingVideos = latestInputSchema.video.enabled
      ? latestReferences
        .filter((reference) => reference.kind === 'video' && reference.videoUrl)
        .map((reference) => reference.videoUrl as string)
        .slice(0, latestInputSchema.video.max)
      : [];
    const latestIncomingAudios = latestInputSchema.audio.enabled
      ? latestReferences
        .filter((reference) => reference.kind === 'audio' && reference.audioUrl)
        .map((reference) => reference.audioUrl as string)
        .slice(0, latestInputSchema.audio.max)
      : [];
    if (latestIncomingImages.length < latestInputSchema.images.min) {
      const message = `当前模型至少需要 ${latestInputSchema.images.min} 张图片引用。`;
      setError(message);
      void showErrorDialog(message, t('common.error'));
      return null;
    }
    if (latestIncomingVideos.length < latestInputSchema.video.min) {
      const message = `当前模型至少需要 ${latestInputSchema.video.min} 个视频引用。`;
      setError(message);
      void showErrorDialog(message, t('common.error'));
      return null;
    }
    if (latestIncomingAudios.length < latestInputSchema.audio.min) {
      const message = `当前模型至少需要 ${latestInputSchema.audio.min} 个音频引用。`;
      setError(message);
      void showErrorDialog(message, t('common.error'));
      return null;
    }
    const outputAspectRatio =
      aspectRatioFromPixelResolution(latestModelConfig.resolution)
      ?? latestModelConfig.aspectRatio
      ?? '16:9';
    const extraParams = { ...(latestModelConfig.extraParams ?? {}) };
    extraParams.videoInputSchema = latestInputSchema;

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
        extraParams,
      },
    };
  }, [data, flushPromptDraft, id, resolvedModelConfig, t]);

  const handleGenerate = useCallback(async () => {
    const releaseSubmitLock = acquireGenerationSubmitLock(
      generationSubmitLockKey(id, 'ai-video-node')
    );
    if (!releaseSubmitLock) {
      return;
    }
    let resultNodeId: string | null = null;
    let generationStartedAt = Date.now();
    let generationDebugContext: GenerationDebugContext | null = null;
    try {
      const assembled = assembleVideoGenerationRequest();
      if (!assembled) {
        return;
      }
      const {
        prompt,
        latestModelConfig,
        latestEntry,
        latestIncomingImages,
        latestIncomingVideos,
        latestIncomingAudios,
        outputAspectRatio,
        gatewayPayload,
      } = assembled;
      generationStartedAt = Date.now();
      const generationDurationMs = VIDEO_GENERATION_PROGRESS_DURATION_MS;
      const generatedSequence = resolveNextGeneratedMediaSequence(
        'video',
        useCanvasStore.getState().nodes
      );
      const generatedDateStamp = getLocalDateStamp();
      const newNodePosition = findNodePosition(
        id,
        EXPORT_RESULT_NODE_DEFAULT_WIDTH,
        EXPORT_RESULT_NODE_LAYOUT_HEIGHT
      );
      resultNodeId = addNode(
        CANVAS_NODE_TYPES.video,
        newNodePosition,
        {
          isGenerating: true,
          generationStartedAt,
          generationDurationMs,
          displayName: resolveDefaultGeneratedVideoDisplayName(generatedSequence, prompt),
          generatedNamingMode: 'default',
          generatedSequence,
          generatedDateStamp,
          generatedFileName: `${resolveDefaultGeneratedVideoFileStem(generatedSequence, generatedDateStamp)}.mp4`,
          aspectRatio: outputAspectRatio,
          durationSeconds: Number(latestModelConfig.duration) || null,
          sourcePrompt: prompt,
          sourceReferenceCount: latestIncomingImages.length,
        }
      );
      addEdge(id, resultNodeId);
      setError(null);

      const runtimeDiagnostics = await getRuntimeDiagnostics();
      generationDebugContext = {
        sourceType: 'aiVideo',
        providerId: latestEntry.providerId,
        requestModel: latestEntry.modelId,
        requestSize: latestModelConfig.resolution,
        prompt,
        extraParams: {
          duration: latestModelConfig.duration,
          resolution: latestModelConfig.resolution,
          aspectRatio: latestModelConfig.aspectRatio,
          referenceVideoCount: latestIncomingVideos.length,
          referenceAudioCount: latestIncomingAudios.length,
          ...(latestModelConfig.extraParams ?? {}),
        },
        referenceImageCount: latestIncomingImages.length,
        referenceImagePlaceholders: createReferenceImagePlaceholders(latestIncomingImages.length),
        appVersion: runtimeDiagnostics.appVersion,
        osName: runtimeDiagnostics.osName,
        osVersion: runtimeDiagnostics.osVersion,
        osBuild: runtimeDiagnostics.osBuild,
        userAgent: runtimeDiagnostics.userAgent,
      };

      const jobId = await canvasVideoGateway.submitGenerateVideoJob({
        ...gatewayPayload,
      });
      updateNodeData(resultNodeId, {
        generationJobId: jobId,
        generationProviderId: latestEntry.providerId,
        generationClientSessionId: CURRENT_RUNTIME_SESSION_ID,
        generationDebugContext,
      });
    } catch (submitError) {
      const resolvedError = resolveErrorContent(submitError, t('ai.error'));
      setError(resolvedError.message);
      void showErrorDialog(
        resolvedError.message,
        t('common.error'),
        resolvedError.details
      );
      if (resultNodeId) {
        updateNodeData(resultNodeId, {
          isGenerating: false,
          generationStartedAt: null,
          generationElapsedMs: Math.max(0, Date.now() - generationStartedAt),
          generationJobId: null,
          generationError: resolvedError.message,
          generationErrorDetails: resolvedError.details ?? null,
          generationDebugContext,
        });
      }
    } finally {
      releaseSubmitLock();
    }
  }, [
    addEdge,
    addNode,
    assembleVideoGenerationRequest,
    data,
    findNodePosition,
    id,
    t,
    updateNodeData,
  ]);

  const handleOpenPayloadDebug = useCallback(async () => {
    try {
      const assembled = assembleVideoGenerationRequest();
      if (!assembled) {
        return;
      }
      const preview = await buildVideoGenerationDebugPreview(assembled.gatewayPayload);
      setPayloadDebugText(serializeDebugJson({
        gatewayRequest: preview.gatewayRequest,
        route: preview.route,
        providerRequest: preview.providerRequest ?? null,
      }));
      setPayloadDebugCopied(false);
    } catch (debugError) {
      const resolvedError = resolveErrorContent(debugError, t('ai.error'));
      setError(resolvedError.message);
      void showErrorDialog(
        resolvedError.message,
        t('common.error'),
        resolvedError.details,
      );
    }
  }, [assembleVideoGenerationRequest, t]);

  const handleCopyPayloadDebug = useCallback(async () => {
    if (!payloadDebugText) {
      return;
    }
    try {
      await navigator.clipboard.writeText(payloadDebugText);
      setPayloadDebugCopied(true);
      window.setTimeout(() => setPayloadDebugCopied(false), 1600);
    } catch (copyError) {
      const resolvedError = resolveErrorContent(copyError, t('nodeToolbar.copyFailed'));
      void showErrorDialog(resolvedError.message, t('common.error'), resolvedError.details);
    }
  }, [payloadDebugText, t]);

  useEffect(() => {
    return canvasEventBus.subscribe('generation-node/trigger', ({ nodeId }) => {
      if (nodeId !== id) {
        return;
      }
      void handleGenerate();
    });
  }, [handleGenerate, id]);

  const handlePromptKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Backspace' || event.key === 'Delete') {
      const currentPrompt = promptDraftRef.current;
      const selectionStart = event.currentTarget.selectionStart ?? currentPrompt.length;
      const selectionEnd = event.currentTarget.selectionEnd ?? selectionStart;
      const deleteRange = resolveReferenceAwareDeleteRange(
        currentPrompt,
        selectionStart,
        selectionEnd,
        event.key === 'Backspace' ? 'backward' : 'forward',
        incomingReferences.length
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
      if (
        event.key === 'Backspace'
        && !currentPrompt.trim()
        && selectedPresetLabel
        && selectionStart === 0
        && selectionEnd === 0
      ) {
        event.preventDefault();
        clearSelectedPromptPreset();
        return;
      }
    }

    if (showFunctionPicker && functionPickerItems.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setFunctionPickerActiveIndex((previous) => (previous + 1) % functionPickerItems.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setFunctionPickerActiveIndex((previous) =>
          previous === 0 ? functionPickerItems.length - 1 : previous - 1
        );
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        selectFunctionPickerItem(functionPickerActiveIndex);
        return;
      }
    }

    if (referencePickerOpen && schemaReferencePickerItems.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setReferencePickerActiveIndex((previous) => (previous + 1) % schemaReferencePickerItems.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setReferencePickerActiveIndex((previous) =>
          previous === 0 ? schemaReferencePickerItems.length - 1 : previous - 1
        );
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        insertReferenceToken(referencePickerActiveIndex);
        return;
      }
    }

    if (event.key === '/' && functionPickerItems.length > 0) {
      event.preventDefault();
      const cursor = event.currentTarget.selectionStart ?? promptDraftRef.current.length;
      const anchor = resolvePickerAnchor(rootRef.current, event.currentTarget, cursor);
      setFunctionPickerAnchor({
        left: Math.max(8, Math.min(anchor.left, resolvedWidth - FUNCTION_PICKER_WIDTH_PX - 8)),
        top: anchor.top,
      });
      setShowFunctionPicker(true);
      setFunctionPickerActiveIndex(0);
      setReferencePickerOpen(false);
      setReferencePickerCursor(null);
      return;
    }

    if (event.key === '@' && schemaReferencePickerItems.length > 0) {
      event.preventDefault();
      const cursor = event.currentTarget.selectionStart ?? promptDraftRef.current.length;
      const anchor = resolvePickerAnchor(rootRef.current, event.currentTarget, cursor);
      setReferencePickerAnchor({
        left: Math.max(8, Math.min(anchor.left, resolvedWidth - REFERENCE_PICKER_WIDTH_PX - 8)),
        top: Math.max(8, anchor.top),
      });
      setReferencePickerCursor(cursor);
      setReferencePickerOpen(true);
      setReferencePickerActiveIndex(0);
      setProviderOpen(false);
      setModelOpen(false);
      setParamsOpen(false);
      setShowFunctionPicker(false);
      return;
    }
    if (event.key === 'Escape' && (referencePickerOpen || showFunctionPicker)) {
      event.preventDefault();
      setReferencePickerOpen(false);
      setReferencePickerCursor(null);
      setReferencePickerActiveIndex(0);
      setShowFunctionPicker(false);
      setFunctionPickerActiveIndex(0);
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      void handleGenerate();
    }
  }, [
    clearSelectedPromptPreset,
    flushPromptDraft,
    functionPickerActiveIndex,
    functionPickerItems.length,
    handleGenerate,
    incomingReferences.length,
    insertReferenceToken,
    referencePickerActiveIndex,
    referencePickerOpen,
    resolvedWidth,
    schemaReferencePickerItems.length,
    selectFunctionPickerItem,
    selectedPresetLabel,
    showFunctionPicker,
    syncPromptHighlightScroll,
  ]);

  const handlePickProvider = useCallback((providerLabel: string) => {
    const entry = entriesByProvider.get(providerLabel)?.find((candidate) => candidate.usable);
    if (!entry) return;
    updateNodeData(id, {
      modelConfig: {
        entryId: entry.id,
        duration: defaultDurationForVideoEntry(entry),
        resolution: entry.supportedResolutions[0] ?? '1280x720',
        aspectRatio: entry.supportedAspectRatios[0] ?? '16:9',
        extraParams: {},
      },
    });
    setProviderOpen(false);
  }, [entriesByProvider, id, updateNodeData]);

  const handlePickModel = useCallback((entry: VideoCatalogEntry) => {
    if (!entry.usable) return;
    updateNodeData(id, {
      modelConfig: {
        entryId: entry.id,
        duration: resolvedModelConfig?.duration && entry.supportedDurations.includes(resolvedModelConfig.duration)
          ? resolvedModelConfig.duration
          : defaultDurationForVideoEntry(entry),
        resolution: resolvedModelConfig?.resolution && entry.supportedResolutions.includes(resolvedModelConfig.resolution)
          ? resolvedModelConfig.resolution
          : entry.supportedResolutions[0] ?? '1280x720',
        aspectRatio: resolvedModelConfig?.aspectRatio && entry.supportedAspectRatios.includes(resolvedModelConfig.aspectRatio)
          ? resolvedModelConfig.aspectRatio
          : entry.supportedAspectRatios[0] ?? '16:9',
        extraParams: {},
      },
    });
    setModelOpen(false);
  }, [id, resolvedModelConfig, updateNodeData]);

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
        icon={<Video className="h-4 w-4" />}
        titleText={resolvedTitle}
        rightSlot={showNodePayloadPreview ? (
          <button
            type="button"
            data-canvas-no-marquee="true"
            className="nodrag nowheel inline-flex h-6 w-6 items-center justify-center rounded-full border border-[var(--canvas-node-border)] bg-[var(--canvas-node-menu-bg)] text-text-muted shadow-sm transition-colors hover:border-accent/50 hover:bg-[var(--canvas-node-menu-hover)] hover:text-accent"
            title={t('node.aiVideo.payloadDebug')}
            aria-label={t('node.aiVideo.payloadDebug')}
            onClick={(event) => {
              event.stopPropagation();
              if (payloadDebugText !== null) {
                setPayloadDebugText(null);
                return;
              }
              void handleOpenPayloadDebug();
            }}
          >
            <Bug className="h-3.5 w-3.5" />
          </button>
        ) : undefined}
        editable
        onTitleChange={(nextTitle) => updateNodeData(id, { displayName: nextTitle })}
      />

      <div className="image-box relative min-h-0 flex-1 rounded-lg border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-field-bg)] p-2">
        <div className="relative h-full min-h-0">
          {selectedPresetLabel && (
            <div className="absolute left-1 top-1 z-20 flex max-w-[calc(100%-8px)] items-center gap-1 rounded-md border border-accent/35 bg-accent/18 px-2 py-1 text-xs text-accent shadow-sm">
              <Sparkles className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{selectedPresetLabel}</span>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  clearSelectedPromptPreset();
                  promptRef.current?.focus();
                }}
                className="ml-0.5 rounded p-0.5 text-accent/80 hover:bg-accent/20 hover:text-accent"
                title={t('nodeToolbar.promptPreset') as string}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )}
          <div
            ref={promptHighlightRef}
            aria-hidden="true"
            className="ui-scrollbar pointer-events-none absolute inset-0 overflow-y-auto overflow-x-hidden text-sm leading-6 text-text-dark"
            style={{ scrollbarGutter: 'stable' }}
          >
            <div className={`min-h-full whitespace-pre-wrap break-words px-1 py-0.5 ${selectedPresetLabel ? 'pt-8' : ''}`}>
              {renderPromptWithHighlights(promptDraft, incomingReferences.length)}
            </div>
          </div>
          <textarea
            ref={promptRef}
            value={promptDraft}
            onChange={(event) => {
              const nextValue = event.target.value;
              promptDraftRef.current = nextValue;
              setPromptDraft(nextValue);
              schedulePromptCommit(nextValue);
            }}
            onBlur={() => flushPromptDraft()}
            onKeyDown={handlePromptKeyDown}
            onScroll={syncPromptHighlightScroll}
            onMouseDown={(event) => event.stopPropagation()}
            placeholder={t('node.aiVideo.promptPlaceholder')}
            className={`ui-scrollbar nodrag nowheel relative z-10 h-full w-full resize-none overflow-y-auto overflow-x-hidden border-none bg-transparent px-1 py-0.5 text-sm leading-6 text-transparent caret-text-dark outline-none placeholder:text-text-muted/80 focus:border-transparent whitespace-pre-wrap break-words ${selectedPresetLabel ? 'pt-8' : ''}`}
            style={{ scrollbarGutter: 'stable' }}
          />
        </div>

        {referencePickerOpen && schemaReferencePickerItems.length > 0 && (
          <div
            className="nowheel absolute z-30 w-[150px] overflow-hidden rounded-xl border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-menu-bg)] shadow-xl"
            style={{ left: referencePickerAnchor.left, top: referencePickerAnchor.top }}
            onMouseDown={(event) => event.stopPropagation()}
            onWheelCapture={(event) => event.stopPropagation()}
          >
            <div className="ui-scrollbar nowheel max-h-[220px] overflow-y-auto" onWheelCapture={(event) => event.stopPropagation()}>
              {schemaReferencePickerItems.map((item, index) => (
                <button
                  key={`${item.kind}-${item.sourceNodeId}-${index}`}
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    insertReferenceToken(index);
                  }}
                  onMouseEnter={() => setReferencePickerActiveIndex(index)}
                  className={`flex w-full items-center gap-2 border border-transparent bg-transparent px-2 py-2 text-left text-sm text-text-dark transition-colors hover:border-[var(--canvas-node-field-border)] hover:bg-[var(--canvas-node-menu-hover)] ${
                    referencePickerActiveIndex === index
                      ? 'border-accent/35 bg-[var(--canvas-node-menu-active)]'
                      : ''
                  }`}
                >
                  {item.kind === 'image' && item.displayUrl ? (
                    <CanvasNodeImage
                      src={item.displayUrl}
                      alt={item.label}
                      viewerSourceUrl={resolveImageDisplayUrl(item.imageUrl ?? item.displayUrl)}
                      viewerImageList={incomingViewerList}
                      className="h-8 w-8 rounded object-cover"
                      draggable={false}
                    />
                  ) : (
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-[var(--canvas-node-button-bg)] text-[10px] font-semibold text-text-muted">
                      {item.kind === 'video' ? 'V' : item.kind === 'audio' ? 'A' : 'T'}
                    </span>
                  )}
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {showFunctionPicker && functionPickerItems.length > 0 && (
          <div
            className="nowheel absolute z-40 w-[280px] overflow-visible rounded-xl border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-menu-bg)] p-1.5 shadow-2xl"
            style={{ left: functionPickerAnchor.left, top: functionPickerAnchor.top }}
            onMouseDown={(event) => event.stopPropagation()}
            onWheelCapture={(event) => event.stopPropagation()}
          >
            <div className="px-2 py-1 text-[11px] font-medium text-text-muted">
              输入 / 选择提示词预设
            </div>
            <div className="ui-scrollbar nowheel max-h-[260px] overflow-y-auto pr-1">
              {functionPickerItems.map((item, index) => {
                const Icon = item.icon;
                const active = functionPickerActiveIndex === index;
                const selected = Boolean(data.selectedPromptPresetId);
                return (
                  <button
                    key={`${item.kind}-${item.id}`}
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      selectFunctionPickerItem(index);
                    }}
                    onMouseEnter={() => setFunctionPickerActiveIndex(index)}
                    className={`flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left text-sm transition-colors ${
                      active
                        ? 'bg-[var(--canvas-node-menu-active)] text-text-dark'
                        : 'text-text-dark hover:bg-[var(--canvas-node-menu-hover)]'
                    }`}
                    title={item.description}
                  >
                    <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{item.label}</span>
                      <span className="mt-0.5 block truncate text-[11px] text-text-muted">
                        我的提示词预设
                      </span>
                    </span>
                    {selected && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />}
                    {item.kind === 'presetGroup' && <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-muted" />}
                  </button>
                );
              })}
            </div>
            {functionPickerItems[functionPickerActiveIndex]?.kind === 'presetGroup' && (
              <div
                className="nowheel absolute left-[calc(100%+8px)] w-[240px] overflow-hidden rounded-xl border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-menu-bg)] p-1.5 shadow-2xl"
                style={{ top: `${Math.min(44 + functionPickerActiveIndex * 58, 150)}px` }}
                onMouseDown={(event) => event.stopPropagation()}
                onWheelCapture={(event) => event.stopPropagation()}
              >
                <div className="px-2 py-1 text-[11px] font-medium text-text-muted">
                  我的提示词预设
                </div>
                <div className="ui-scrollbar nowheel max-h-[220px] overflow-y-auto pr-1">
                {promptPresets.map((preset) => {
                  const presetSelected = data.selectedPromptPresetId === preset.id;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      className={`flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left text-sm transition-colors ${
                        presetSelected
                          ? 'bg-[var(--canvas-node-menu-active)] text-text-dark'
                          : 'text-text-dark hover:bg-[var(--canvas-node-menu-hover)]'
                      }`}
                      title={preset.prompt}
                      onClick={(event) => {
                        event.stopPropagation();
                        selectPromptPresetFromPicker(preset.id);
                      }}
                    >
                      <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{preset.name}</span>
                        <span className="mt-0.5 block truncate text-[11px] text-text-muted">我的提示词预设</span>
                      </span>
                      {presetSelected && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />}
                    </button>
                  );
                })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="mt-2 flex min-w-0 shrink-0 items-center gap-1 overflow-visible">
        <div className="flex min-w-0 flex-1 items-center gap-0.5">
          <div className="relative min-w-0 max-w-[92px] shrink">
            <UiButton
              onClick={(event) => {
                event.stopPropagation();
                setProviderOpen((open) => !open);
                setModelOpen(false);
                setParamsOpen(false);
                setReferencePickerOpen(false);
                setReferencePickerCursor(null);
                setShowFunctionPicker(false);
              }}
              variant="muted"
              className={`w-full justify-start ${NODE_CONTROL_CHIP_CLASS} ${AI_VIDEO_SELECTOR_CHIP_CLASS}`}
              title={selectedEntry?.providerLabel ?? t('node.aiVideo.noModel')}
            >
              <Video className={NODE_CONTROL_ICON_CLASS} />
              <span className="min-w-0 truncate">{selectedEntry?.providerLabel ?? t('node.aiVideo.noModel')}</span>
              <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
            </UiButton>
            {providerOpen && (
              <div
                className="nowheel absolute bottom-full left-0 z-50 mb-1 min-w-[170px] overflow-hidden rounded-xl border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-menu-bg)] p-1.5 shadow-xl"
                onMouseDown={(event) => event.stopPropagation()}
              >
                {catalog.length === 0 ? (
                  <div className="flex items-start gap-2 p-2 text-xs leading-5 text-text-muted">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" />
                    <span>{t('node.aiVideo.noVideoProvider')}</span>
                  </div>
                ) : (
                  <div className="ui-scrollbar max-h-[220px] overflow-y-auto pr-1">
                    {Array.from(entriesByProvider.keys()).map((providerLabel) => {
                      const active = selectedEntry?.providerLabel === providerLabel;
                      return (
                        <button
                          key={providerLabel}
                          type="button"
                          className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
                            active
                              ? 'bg-[var(--canvas-node-menu-active)] text-text-dark'
                              : 'text-text-dark hover:bg-[var(--canvas-node-menu-hover)]'
                          }`}
                          onClick={(event) => {
                            event.stopPropagation();
                            handlePickProvider(providerLabel);
                          }}
                        >
                          {active && <Check className="h-3.5 w-3.5 shrink-0 text-accent" />}
                          <span className="min-w-0 truncate">{providerLabel}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>

        <div className="relative min-w-0 max-w-[124px] shrink">
          <UiButton
            onClick={(event) => {
              event.stopPropagation();
              setModelOpen((open) => !open);
              setProviderOpen(false);
              setParamsOpen(false);
              setReferencePickerOpen(false);
              setReferencePickerCursor(null);
              setShowFunctionPicker(false);
            }}
            variant="muted"
            className={`w-full justify-start ${NODE_CONTROL_CHIP_CLASS} ${AI_VIDEO_SELECTOR_CHIP_CLASS}`}
            title={selectedEntry?.modelLabel ?? t('node.aiVideo.noModel')}
          >
            <span className="min-w-0 truncate">{selectedEntry?.modelLabel ?? t('node.aiVideo.noModel')}</span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
          </UiButton>
          {modelOpen && (
            <div
              className="nowheel absolute bottom-full left-0 z-50 mb-1 w-[280px] overflow-hidden rounded-xl border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-menu-bg)] p-1.5 shadow-xl"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <div className="ui-scrollbar max-h-[240px] overflow-y-auto pr-1">
                {(modelsForSelectedProvider.length > 0 ? modelsForSelectedProvider : catalog).map((entry) => {
                  const active = resolvedModelConfig?.entryId === entry.id;
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      disabled={!entry.usable}
                      className={`flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left text-xs transition-colors ${
                        active
                          ? 'bg-[var(--canvas-node-menu-active)] text-text-dark'
                          : 'text-text-dark hover:bg-[var(--canvas-node-menu-hover)]'
                      } disabled:cursor-not-allowed disabled:opacity-55`}
                      title={entry.notReadyReason ?? entry.modelLabel}
                      onClick={(event) => {
                        event.stopPropagation();
                        handlePickModel(entry);
                      }}
                    >
                      <Video className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{entry.modelLabel}</span>
                        <span className="mt-0.5 block truncate text-[11px] text-text-muted">
                          {entry.usable ? entry.modelId : entry.notReadyReason}
                        </span>
                      </span>
                      {active && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {resolvedModelConfig && selectedEntry && (
          <div className="relative min-w-0 max-w-[96px] shrink">
            <UiButton
              onClick={(event) => {
                event.stopPropagation();
                setParamsOpen((open) => !open);
                setProviderOpen(false);
                setModelOpen(false);
                setReferencePickerOpen(false);
                setReferencePickerCursor(null);
                setShowFunctionPicker(false);
              }}
              variant="muted"
              className={`w-full justify-start ${NODE_CONTROL_CHIP_CLASS}`}
              title={`${t('node.aiVideo.duration')} / ${t('node.aiVideo.resolution')} / ${t('node.aiVideo.aspectRatio')}`}
            >
              <span className="min-w-0 truncate">
                {resolvedModelConfig.duration}s·{resolvedModelConfig.resolution}·{resolvedModelConfig.aspectRatio}
              </span>
              <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
            </UiButton>
            {paramsOpen && (
              <div
                className="nowheel absolute bottom-full right-0 z-50 mb-1 w-[300px] space-y-2 rounded-xl border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-menu-bg)] p-2 shadow-xl"
                onMouseDown={(event) => event.stopPropagation()}
              >
                <div>
                  <div className="mb-1 text-[10px] text-text-muted">{t('node.aiVideo.duration')}</div>
                  {isAgnesVideoModel ? (
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <input
                          type="range"
                          min={1}
                          max={18}
                          step={1}
                          value={Math.min(18, Math.max(1, Number(resolvedModelConfig.duration) || 5))}
                          onChange={(event) => handleConfigChange({ duration: event.target.value })}
                          className="nodrag nowheel h-5 min-w-0 flex-1 accent-accent"
                        />
                        <span className="w-10 text-right text-[11px] font-medium text-text-dark">
                          {resolvedModelConfig.duration}s
                        </span>
                      </div>
                      <div className="text-[10px] leading-4 text-text-muted">
                        {t('node.aiVideo.agnesDurationHint')}
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {selectedEntry.supportedDurations.map((duration) => {
                        const active = resolvedModelConfig.duration === duration;
                        return (
                          <button
                            key={duration}
                            type="button"
                            onClick={() => handleConfigChange({ duration })}
                            className={`rounded-md border px-2 py-1 text-[11px] transition-colors ${
                              active
                                ? 'border-accent/60 bg-accent/15 text-accent'
                                : 'border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-button-bg)] text-[var(--canvas-node-button-text)] hover:border-[var(--canvas-node-border-hover)] hover:bg-[var(--canvas-node-menu-hover)]'
                            }`}
                          >
                            {duration}s
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
                {isAgnesVideoModel && schemaIncomingImageItems.length > 1 && (
                  <div>
                    <div className="mb-1 text-[10px] text-text-muted">{t('node.aiVideo.agnesMode')}</div>
                    <div className="grid grid-cols-2 gap-1">
                      {([
                        ['multi', t('node.aiVideo.agnesModeMulti')],
                        ['keyframes', t('node.aiVideo.agnesModeKeyframes')],
                      ] as const).map(([mode, label]) => {
                        const active = mode === 'keyframes' ? agnesVideoMode === 'keyframes' : agnesVideoMode !== 'keyframes';
                        return (
                          <button
                            key={mode}
                            type="button"
                            onClick={() => handleAgnesVideoModeChange(mode)}
                            className={`rounded-md border px-2 py-1 text-[11px] transition-colors ${
                              active
                                ? 'border-accent/60 bg-accent/15 text-accent'
                                : 'border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-button-bg)] text-[var(--canvas-node-button-text)] hover:border-[var(--canvas-node-border-hover)] hover:bg-[var(--canvas-node-menu-hover)]'
                            }`}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
                <div>
                  <div className="mb-1 text-[10px] text-text-muted">{t('node.aiVideo.aspectRatio')}</div>
                  <div className="flex flex-wrap gap-1">
                    {selectedEntry.supportedAspectRatios.map((aspectRatio) => {
                      const active = resolvedModelConfig.aspectRatio === aspectRatio;
                      return (
                        <button
                          key={aspectRatio}
                          type="button"
                          onClick={() => handleConfigChange({ aspectRatio })}
                          className={`rounded-md border px-2 py-1 text-[11px] transition-colors ${
                            active
                              ? 'border-accent/60 bg-accent/15 text-accent'
                              : 'border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-button-bg)] text-[var(--canvas-node-button-text)] hover:border-[var(--canvas-node-border-hover)] hover:bg-[var(--canvas-node-menu-hover)]'
                          }`}
                        >
                          {aspectRatio}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div>
                  <div className="mb-1 text-[10px] text-text-muted">{t('node.aiVideo.resolution')}</div>
                  <div className="flex flex-wrap gap-1">
                    {selectedEntry.supportedResolutions.map((resolution) => {
                      const active = resolvedModelConfig.resolution === resolution;
                      return (
                        <button
                          key={resolution}
                          type="button"
                          onClick={() => handleConfigChange({ resolution })}
                          className={`rounded-md border px-2 py-1 text-[11px] transition-colors ${
                            active
                              ? 'border-accent/60 bg-accent/15 text-accent'
                              : 'border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-button-bg)] text-[var(--canvas-node-button-text)] hover:border-[var(--canvas-node-border-hover)] hover:bg-[var(--canvas-node-menu-hover)]'
                          }`}
                        >
                          {resolution}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {selectedEntry && (
          <UiButton
            variant="muted"
            className={`min-w-[92px] max-w-[132px] shrink-0 justify-start ${NODE_CONTROL_CHIP_CLASS}`}
            title={describeVideoInputSchema(currentInputSchema)}
          >
            <span className="min-w-0 truncate">{describeCompactVideoInputSchema(currentInputSchema)}</span>
          </UiButton>
        )}
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <UiButton
            onClick={(event) => {
              event.stopPropagation();
              setShowCameraControl(true);
            }}
            variant={data.cameraControl?.enabled === true ? 'primary' : 'muted'}
            className={`shrink-0 ${NODE_CONTROL_CHIP_CLASS} ${data.cameraControl?.enabled === true ? '' : AI_VIDEO_COMPACT_ICON_CHIP_CLASS}`}
            title={t('cameraControl.title') as string}
            aria-label={t('cameraControl.title') as string}
          >
            <Camera className={NODE_CONTROL_ICON_CLASS} />
          </UiButton>

        {schemaReferencePickerItems.length > 0 && (
          <UiButton
            onClick={(event) => {
              event.stopPropagation();
              setReferencePickerOpen((open) => !open);
              setReferencePickerAnchor({ left: 12, top: 12 });
              setReferencePickerCursor(promptDraftRef.current.length);
              setReferencePickerActiveIndex(0);
              setProviderOpen(false);
              setModelOpen(false);
              setParamsOpen(false);
              setShowFunctionPicker(false);
            }}
            variant="muted"
            className={`shrink-0 ${NODE_CONTROL_CHIP_CLASS}`}
          >
            <span>{t('node.aiVideo.referenceCount', { count: schemaReferencePickerItems.length })}</span>
          </UiButton>
        )}
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
        minWidth={AI_VIDEO_NODE_MIN_WIDTH}
        minHeight={AI_VIDEO_NODE_MIN_HEIGHT}
        maxWidth={AI_VIDEO_NODE_MAX_WIDTH}
        maxHeight={AI_VIDEO_NODE_MAX_HEIGHT}
      />

      <UiModal
        isOpen={payloadDebugText !== null}
        title={t('node.imageEdit.payloadDebugTitle')}
        onClose={() => setPayloadDebugText(null)}
        widthClassName="w-[min(760px,calc(100vw-32px))]"
        containerClassName="!z-[13050]"
        footer={(
          <>
            <UiButton
              variant="muted"
              size="sm"
              onClick={() => setPayloadDebugText(null)}
            >
              {t('common.close')}
            </UiButton>
            <UiButton
              variant="primary"
              size="sm"
              onClick={() => void handleCopyPayloadDebug()}
            >
              <Copy className="mr-1.5 h-3.5 w-3.5" />
              {payloadDebugCopied ? t('nodeToolbar.copied') : t('nodeToolbar.copy')}
            </UiButton>
          </>
        )}
      >
        <div className="space-y-2">
          <div className="text-xs text-text-muted">
            {t('node.imageEdit.payloadDebugHint')}
          </div>
          <pre
            className="ui-scrollbar nowheel max-h-[60vh] overflow-auto rounded-lg border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-field-bg)] p-3 text-xs leading-5 text-text-dark"
            onWheelCapture={(event) => event.stopPropagation()}
            onTouchMoveCapture={(event) => event.stopPropagation()}
          >
            {payloadDebugText}
          </pre>
        </div>
      </UiModal>

      <CameraControlPanel
        isOpen={showCameraControl}
        onClose={() => setShowCameraControl(false)}
        cameraControl={data.cameraControl}
        onApply={handleCameraControlApply}
      />
    </div>
  );
});

AiVideoNode.displayName = 'AiVideoNode';
