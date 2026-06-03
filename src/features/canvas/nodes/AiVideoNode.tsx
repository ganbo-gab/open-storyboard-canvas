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
import { AlertTriangle, Check, ChevronDown, Settings2, Sparkles, Video } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  CANVAS_NODE_TYPES,
  EXPORT_RESULT_NODE_DEFAULT_WIDTH,
  EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
  isAiVideoNode,
  type AiVideoNodeData,
} from '@/features/canvas/domain/canvasNodes';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { graphImageResolver } from '@/features/canvas/application/graphImageResolver';
import {
  parseInputImageSignature,
  selectInputImageSignature,
} from '@/features/canvas/application/canvasGraphSelectors';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { resolveErrorContent, showErrorDialog } from '@/features/canvas/application/errorDialog';
import {
  DEFAULT_GENERATED_VIDEO_DISPLAY_NAME,
} from '@/features/canvas/application/generatedMediaNaming';
import {
  CURRENT_RUNTIME_SESSION_ID,
  createReferenceImagePlaceholders,
  getRuntimeDiagnostics,
  type GenerationDebugContext,
} from '@/features/canvas/application/generationErrorReport';
import {
  buildVideoModelCatalog,
  resolveVideoModelConfig,
  useVideoModelCatalog,
  type VideoCatalogEntry,
  type VideoModelConfigValue,
} from '@/features/canvas/application/videoModelCatalog';
import { canvasVideoGateway } from '@/features/canvas/application/canvasServices';
import { CanvasNodeImage } from '@/features/canvas/ui/CanvasNodeImage';
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from '@/features/canvas/ui/NodeHeader';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import {
  NODE_CONTROL_CHIP_CLASS,
  NODE_CONTROL_ICON_CLASS,
  NODE_CONTROL_PRIMARY_BUTTON_CLASS,
} from '@/features/canvas/ui/nodeControlStyles';
import { UiButton } from '@/components/ui';
import { useCanvasStore } from '@/stores/canvasStore';
import { useCustomProvidersStore } from '@/stores/customProvidersStore';
import { useSettingsStore } from '@/stores/settingsStore';

type AiVideoNodeProps = NodeProps & {
  id: string;
  data: AiVideoNodeData;
  selected?: boolean;
};

const AI_VIDEO_NODE_MIN_WIDTH = 520;
const AI_VIDEO_NODE_MIN_HEIGHT = 260;
const AI_VIDEO_NODE_DEFAULT_WIDTH = 680;
const AI_VIDEO_NODE_DEFAULT_HEIGHT = 360;
const AI_VIDEO_NODE_MAX_WIDTH = 1400;
const AI_VIDEO_NODE_MAX_HEIGHT = 1000;
const PROMPT_COMMIT_DELAY_MS = 650;
const VIDEO_GENERATION_PROGRESS_DURATION_MS = 15 * 60 * 1000;

function findReferenceTokens(prompt: string, maxImageCount: number): Array<{ token: string; start: number }> {
  const matches: Array<{ token: string; start: number }> = [];
  const regex = /@?图(\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(prompt)) !== null) {
    const imageIndex = Number(match[1]);
    if (imageIndex >= 1 && imageIndex <= maxImageCount) {
      matches.push({ token: match[0], start: match.index });
    }
  }
  return matches;
}

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
        className="relative z-0 text-white [text-shadow:0.24px_0_currentColor,-0.24px_0_currentColor] before:absolute before:-inset-x-[4px] before:-inset-y-[1px] before:-z-10 before:rounded-[7px] before:bg-accent/55 before:content-['']"
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

  const incomingImageSignature = useCanvasStore((state) =>
    selectInputImageSignature(id, state.nodes, state.edges)
  );
  const incomingImages = useMemo(
    () => parseInputImageSignature(incomingImageSignature),
    [incomingImageSignature]
  );
  const incomingImageItems = useMemo(
    () => incomingImages.map((imageUrl, index) => ({
      imageUrl,
      displayUrl: resolveImageDisplayUrl(imageUrl),
      label: `图${index + 1}`,
    })),
    [incomingImages]
  );
  const incomingViewerList = useMemo(
    () => incomingImages.map((imageUrl) => resolveImageDisplayUrl(imageUrl)),
    [incomingImages]
  );

  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const addNode = useCanvasStore((state) => state.addNode);
  const addEdge = useCanvasStore((state) => state.addEdge);
  const findNodePosition = useCanvasStore((state) => state.findNodePosition);
  const catalog = useVideoModelCatalog();
  const resolvedModelConfig = useMemo(
    () => resolveVideoModelConfig(catalog, data.modelConfig),
    [catalog, data.modelConfig]
  );
  const selectedEntry = useMemo(
    () => resolveConfigEntry(catalog, resolvedModelConfig),
    [catalog, resolvedModelConfig]
  );
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

  const insertReferenceToken = useCallback((index: number) => {
    const marker = `图${index + 1}`;
    const textarea = promptRef.current;
    const current = promptDraftRef.current;
    const cursor = textarea?.selectionStart ?? current.length;
    const prefix = cursor > 0 && !/\s/.test(current[cursor - 1]) ? ' ' : '';
    const suffix = current[cursor] && !/\s/.test(current[cursor]) ? ' ' : '';
    const nextPrompt = `${current.slice(0, cursor)}${prefix}${marker}${suffix}${current.slice(cursor)}`;
    const nextCursor = cursor + prefix.length + marker.length + suffix.length;
    setPromptDraft(nextPrompt);
    flushPromptDraft(nextPrompt);
    setReferencePickerOpen(false);
    requestAnimationFrame(() => {
      promptRef.current?.focus();
      promptRef.current?.setSelectionRange(nextCursor, nextCursor);
      syncPromptHighlightScroll();
    });
  }, [flushPromptDraft, syncPromptHighlightScroll]);

  const handleConfigChange = useCallback((patch: Partial<VideoModelConfigValue>) => {
    const base = resolvedModelConfig ?? resolveVideoModelConfig(catalog, null);
    if (!base) return;
    updateNodeData(id, { modelConfig: { ...base, ...patch } });
  }, [catalog, id, resolvedModelConfig, updateNodeData]);

  const closeOpenPopovers = useCallback(() => {
    setProviderOpen(false);
    setModelOpen(false);
    setParamsOpen(false);
    setReferencePickerOpen(false);
  }, []);

  useEffect(() => {
    if (!providerOpen && !modelOpen && !paramsOpen && !referencePickerOpen) {
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
  }, [closeOpenPopovers, modelOpen, paramsOpen, providerOpen, referencePickerOpen]);

  const handleGenerate = useCallback(async () => {
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
    const prompt = latestPromptDraft.replace(/@(?=图\d+)/g, '').trim();
    const latestIncomingImages = graphImageResolver.collectInputImages(
      id,
      latestCanvasState.nodes,
      latestCanvasState.edges
    );

    if (!prompt) {
      const message = t('node.aiVideo.promptRequired');
      setError(message);
      void showErrorDialog(message, t('common.error'));
      return;
    }
    if (!latestModelConfig || !latestEntry) {
      const message = t('node.aiVideo.noVideoProvider');
      setError(message);
      void showErrorDialog(message, t('common.error'));
      return;
    }
    if (!latestEntry.usable) {
      const message = latestEntry.notReadyReason ?? t('node.aiVideo.noVideoProvider');
      setError(message);
      void showErrorDialog(message, t('common.error'));
      return;
    }

    const generationStartedAt = Date.now();
    const generationDurationMs = VIDEO_GENERATION_PROGRESS_DURATION_MS;
    const outputAspectRatio =
      aspectRatioFromPixelResolution(latestModelConfig.resolution)
      ?? latestModelConfig.aspectRatio
      ?? '16:9';
    const newNodePosition = findNodePosition(
      id,
      EXPORT_RESULT_NODE_DEFAULT_WIDTH,
      EXPORT_RESULT_NODE_LAYOUT_HEIGHT
    );
    const resultNodeId = addNode(
      CANVAS_NODE_TYPES.video,
      newNodePosition,
      {
        isGenerating: true,
        generationStartedAt,
        generationDurationMs,
        displayName: DEFAULT_GENERATED_VIDEO_DISPLAY_NAME,
        aspectRatio: outputAspectRatio,
        durationSeconds: Number(latestModelConfig.duration) || null,
        sourcePrompt: prompt,
        sourceReferenceCount: latestIncomingImages.length,
      }
    );
    addEdge(id, resultNodeId);
    setError(null);

    const runtimeDiagnostics = await getRuntimeDiagnostics();
    const generationDebugContext: GenerationDebugContext = {
      sourceType: 'aiVideo',
      providerId: latestEntry.providerId,
      requestModel: latestEntry.modelId,
      requestSize: latestModelConfig.resolution,
      prompt,
      extraParams: {
        duration: latestModelConfig.duration,
        resolution: latestModelConfig.resolution,
        aspectRatio: latestModelConfig.aspectRatio,
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

    try {
      const jobId = await canvasVideoGateway.submitGenerateVideoJob({
        prompt,
        model: latestModelConfig.entryId,
        size: latestModelConfig.resolution,
        aspectRatio: latestModelConfig.aspectRatio,
        seconds: Number(latestModelConfig.duration) || undefined,
        referenceImages: latestIncomingImages,
        extraParams: latestModelConfig.extraParams,
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
      updateNodeData(resultNodeId, {
        isGenerating: false,
        generationStartedAt: null,
        generationJobId: null,
        generationError: resolvedError.message,
        generationErrorDetails: resolvedError.details ?? null,
        generationDebugContext,
      });
    }
  }, [
    addEdge,
    addNode,
    data,
    findNodePosition,
    flushPromptDraft,
    id,
    resolvedModelConfig,
    t,
    updateNodeData,
  ]);

  const handlePromptKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === '@' && incomingImages.length > 0) {
      event.preventDefault();
      setReferencePickerOpen(true);
      setProviderOpen(false);
      setModelOpen(false);
      setParamsOpen(false);
      return;
    }
    if (event.key === 'Escape' && referencePickerOpen) {
      event.preventDefault();
      setReferencePickerOpen(false);
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      void handleGenerate();
    }
  }, [handleGenerate, incomingImages.length, referencePickerOpen]);

  const handlePickProvider = useCallback((providerLabel: string) => {
    const entry = entriesByProvider.get(providerLabel)?.find((candidate) => candidate.usable);
    if (!entry) return;
    updateNodeData(id, {
      modelConfig: {
        entryId: entry.id,
        duration: entry.supportedDurations[0] ?? '4',
        resolution: entry.supportedResolutions[0] ?? '1280x720',
        aspectRatio: entry.supportedAspectRatios[0] ?? '16:9',
        extraParams: resolvedModelConfig?.extraParams ?? {},
      },
    });
    setProviderOpen(false);
  }, [entriesByProvider, id, resolvedModelConfig?.extraParams, updateNodeData]);

  const handlePickModel = useCallback((entry: VideoCatalogEntry) => {
    if (!entry.usable) return;
    updateNodeData(id, {
      modelConfig: {
        entryId: entry.id,
        duration: resolvedModelConfig?.duration && entry.supportedDurations.includes(resolvedModelConfig.duration)
          ? resolvedModelConfig.duration
          : entry.supportedDurations[0] ?? '4',
        resolution: resolvedModelConfig?.resolution && entry.supportedResolutions.includes(resolvedModelConfig.resolution)
          ? resolvedModelConfig.resolution
          : entry.supportedResolutions[0] ?? '1280x720',
        aspectRatio: resolvedModelConfig?.aspectRatio && entry.supportedAspectRatios.includes(resolvedModelConfig.aspectRatio)
          ? resolvedModelConfig.aspectRatio
          : entry.supportedAspectRatios[0] ?? '16:9',
        extraParams: resolvedModelConfig?.extraParams ?? {},
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
        editable
        onTitleChange={(nextTitle) => updateNodeData(id, { displayName: nextTitle })}
      />

      <div className="image-box relative min-h-0 flex-1 rounded-lg border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-field-bg)] p-2">
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
              promptDraftRef.current = nextValue;
              setPromptDraft(nextValue);
              schedulePromptCommit(nextValue);
            }}
            onBlur={() => flushPromptDraft()}
            onKeyDown={handlePromptKeyDown}
            onScroll={syncPromptHighlightScroll}
            onMouseDown={(event) => event.stopPropagation()}
            placeholder={t('node.aiVideo.promptPlaceholder')}
            className="ui-scrollbar nodrag nowheel relative z-10 h-full w-full resize-none overflow-y-auto overflow-x-hidden border-none bg-transparent px-1 py-0.5 text-sm leading-6 text-transparent caret-text-dark outline-none placeholder:text-text-muted/80 focus:border-transparent whitespace-pre-wrap break-words"
            style={{ scrollbarGutter: 'stable' }}
          />
        </div>

        {referencePickerOpen && incomingImageItems.length > 0 && (
          <div
            className="nowheel absolute left-3 top-3 z-30 w-[140px] overflow-hidden rounded-xl border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-menu-bg)] shadow-xl"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="ui-scrollbar nowheel max-h-[220px] overflow-y-auto">
              {incomingImageItems.map((item, index) => (
                <button
                  key={`${item.imageUrl}-${index}`}
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    insertReferenceToken(index);
                  }}
                  className="flex w-full items-center gap-2 border border-transparent bg-transparent px-2 py-2 text-left text-sm text-text-dark transition-colors hover:border-[var(--canvas-node-field-border)] hover:bg-[var(--canvas-node-menu-hover)]"
                >
                  <CanvasNodeImage
                    src={item.displayUrl}
                    alt={item.label}
                    viewerSourceUrl={resolveImageDisplayUrl(item.imageUrl)}
                    viewerImageList={incomingViewerList}
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
        <div className="relative min-w-0 max-w-[120px] shrink">
          <UiButton
            onClick={(event) => {
              event.stopPropagation();
              setProviderOpen((open) => !open);
              setModelOpen(false);
              setParamsOpen(false);
              setReferencePickerOpen(false);
            }}
            variant="muted"
            className={`w-full ${NODE_CONTROL_CHIP_CLASS}`}
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

        <div className="relative min-w-0 max-w-[140px] shrink">
          <UiButton
            onClick={(event) => {
              event.stopPropagation();
              setModelOpen((open) => !open);
              setProviderOpen(false);
              setParamsOpen(false);
              setReferencePickerOpen(false);
            }}
            variant="muted"
            className={`w-full ${NODE_CONTROL_CHIP_CLASS}`}
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
          <div className="relative shrink-0">
            <UiButton
              onClick={(event) => {
                event.stopPropagation();
                setParamsOpen((open) => !open);
                setProviderOpen(false);
                setModelOpen(false);
                setReferencePickerOpen(false);
              }}
              variant="muted"
              className={`shrink-0 ${NODE_CONTROL_CHIP_CLASS}`}
              title={`${t('node.aiVideo.duration')} / ${t('node.aiVideo.resolution')} / ${t('node.aiVideo.aspectRatio')}`}
            >
              <Settings2 className={NODE_CONTROL_ICON_CLASS} />
              <span className="min-w-0 truncate">
                {resolvedModelConfig.duration}s · {resolvedModelConfig.resolution} · {resolvedModelConfig.aspectRatio}
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
                </div>
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

        {incomingImages.length > 0 && (
          <UiButton
            onClick={(event) => {
              event.stopPropagation();
              setReferencePickerOpen((open) => !open);
              setProviderOpen(false);
              setModelOpen(false);
              setParamsOpen(false);
            }}
            variant="muted"
            className={`shrink-0 ${NODE_CONTROL_CHIP_CLASS}`}
          >
            <span>{incomingImages.length}图</span>
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
    </div>
  );
});

AiVideoNode.displayName = 'AiVideoNode';
