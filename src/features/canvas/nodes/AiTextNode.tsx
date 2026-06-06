import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { AlertTriangle, Bug, Check, ChevronDown, Copy, LoaderCircle, MoreHorizontal, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  CANVAS_NODE_TYPES,
  type AiTextNodeData,
} from '@/features/canvas/domain/canvasNodes';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import {
  buildAiTextUserPrompt,
  buildOpenAiChatPayload,
  collectAiTextInputs,
  computeAiTextInputHash,
} from '@/features/canvas/application/aiText/helpers';
import { collectInputReferences } from '@/features/canvas/application/graphReferenceResolver';
import { resolveErrorContent, showErrorDialog } from '@/features/canvas/application/errorDialog';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import {
  buildGenerationErrorReport,
  createReferenceImagePlaceholders,
  getRuntimeDiagnostics,
} from '@/features/canvas/application/generationErrorReport';
import { insertReferenceToken } from '@/features/canvas/application/referenceTokenEditing';
import { clearBrowserTextSelection } from '@/features/canvas/application/textSelection';
import { useChatModelCatalog, type ChatCatalogEntry } from '@/features/canvas/application/chatModelCatalog';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { submitCustomChatCompletion } from '@/features/canvas/infrastructure/customProviderGateway';
import { CanvasNodeImage } from '@/features/canvas/ui/CanvasNodeImage';
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from '@/features/canvas/ui/NodeHeader';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import {
  NODE_CONTROL_CHIP_CLASS,
  NODE_CONTROL_ICON_CLASS,
  NODE_CONTROL_PRIMARY_BUTTON_CLASS,
} from '@/features/canvas/ui/nodeControlStyles';
import { UiButton, UiChipButton, UiModal } from '@/components/ui';
import { useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';

type AiTextNodeProps = NodeProps & {
  id: string;
  data: AiTextNodeData;
  selected?: boolean;
};

interface TextProviderOption {
  id: string;
  label: string;
  models: ChatCatalogEntry[];
}

const AI_TEXT_NODE_MIN_WIDTH = 520;
const AI_TEXT_NODE_MIN_HEIGHT = 280;
const AI_TEXT_NODE_DEFAULT_WIDTH = 680;
const AI_TEXT_NODE_DEFAULT_HEIGHT = 380;
const AI_TEXT_NODE_MAX_WIDTH = 1200;
const AI_TEXT_NODE_MAX_HEIGHT = 1000;
const MAX_VISIBLE_AGENT_CHIPS = 5;

function serializeDebugJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function TextNodeIcon({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex items-center justify-center text-sm font-semibold ${className}`}>
      T
    </span>
  );
}

function waitForPreviewDelay(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 260);
  });
}

function groupChatCatalogByProvider(entries: ChatCatalogEntry[]): TextProviderOption[] {
  const grouped = new Map<string, TextProviderOption>();
  entries.forEach((entry) => {
    const existing = grouped.get(entry.providerId);
    if (existing) {
      existing.models.push(entry);
      return;
    }
    grouped.set(entry.providerId, {
      id: entry.providerId,
      label: entry.providerLabel,
      models: [entry],
    });
  });
  return Array.from(grouped.values());
}

export const AiTextNode = memo(({ id, data, selected, width, height }: AiTextNodeProps) => {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);
  const addNode = useCanvasStore((state) => state.addNode);
  const addEdge = useCanvasStore((state) => state.addEdge);
  const findNodePosition = useCanvasStore((state) => state.findNodePosition);
  const textAgents = useSettingsStore((state) => state.textAgents);
  const showNodePayloadPreview = useSettingsStore((state) => state.showNodePayloadPreview);
  const enableAiTextStreaming = useSettingsStore((state) => state.enableAiTextStreaming);
  const chatCatalog = useChatModelCatalog();

  const [providerOpen, setProviderOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [agentOverflowOpen, setAgentOverflowOpen] = useState(false);
  const [payloadDebugText, setPayloadDebugText] = useState<string | null>(null);
  const [payloadDebugCopied, setPayloadDebugCopied] = useState(false);
  const [notice, setNotice] = useState('');
  const [runningAgentId, setRunningAgentId] = useState<string | null>(null);
  const [referencePickerOpen, setReferencePickerOpen] = useState(false);
  const promptDraftRef = useRef(data.prompt ?? '');
  const promptCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [promptDraft, setPromptDraft] = useState(() => data.prompt ?? '');

  const resolvedTitle = resolveNodeDisplayName(CANVAS_NODE_TYPES.aiText, data);
  const resolvedWidth = Math.max(AI_TEXT_NODE_MIN_WIDTH, Math.round(width ?? AI_TEXT_NODE_DEFAULT_WIDTH));
  const resolvedHeight = Math.max(AI_TEXT_NODE_MIN_HEIGHT, Math.round(height ?? AI_TEXT_NODE_DEFAULT_HEIGHT));

  const enabledAgents = useMemo(
    () => textAgents.filter((agent) => agent.enabled),
    [textAgents]
  );

  const selectedAgent = useMemo(
    () => enabledAgents.find((agent) => agent.id === data.agentId) ?? enabledAgents[0] ?? null,
    [data.agentId, enabledAgents]
  );

  const providerOptions = useMemo<TextProviderOption[]>(
    () => groupChatCatalogByProvider(chatCatalog),
    [chatCatalog]
  );

  const selectedModelEntry = useMemo(
    () => chatCatalog.find((entry) => entry.id === data.model) ?? null,
    [chatCatalog, data.model]
  );

  const selectedProvider = useMemo(
    () => providerOptions.find((provider) => provider.id === (selectedModelEntry?.providerId ?? data.providerId))
      ?? providerOptions[0]
      ?? null,
    [data.providerId, providerOptions, selectedModelEntry]
  );

  const availableModelOptions = useMemo(() => {
    return selectedProvider?.models ?? [];
  }, [selectedProvider?.models]);

  const visibleAgents = useMemo(
    () => enabledAgents.slice(0, MAX_VISIBLE_AGENT_CHIPS),
    [enabledAgents]
  );

  const overflowAgents = useMemo(
    () => enabledAgents.slice(MAX_VISIBLE_AGENT_CHIPS),
    [enabledAgents]
  );

  const inputParts = useMemo(
    () => collectAiTextInputs(id, nodes, edges, selectedAgent, textAgents),
    [edges, id, nodes, selectedAgent, textAgents]
  );
  const incomingReferenceItems = useMemo(
    () => collectInputReferences(id, nodes, edges).map((reference) => ({
      ...reference,
      displayUrl: reference.kind === 'image' && reference.imageUrl
        ? resolveImageDisplayUrl(reference.imageUrl)
        : reference.kind === 'video' && reference.thumbnailUrl
          ? resolveImageDisplayUrl(reference.thumbnailUrl)
          : null,
    })),
    [edges, id, nodes]
  );
  const incomingImageViewerList = useMemo(
    () => incomingReferenceItems
      .filter((reference) => reference.kind === 'image' && reference.imageUrl)
      .map((reference) => resolveImageDisplayUrl(reference.imageUrl as string)),
    [incomingReferenceItems]
  );

  const currentInputHash = useMemo(
    () => computeAiTextInputHash({
      agentId: selectedAgent?.id ?? data.agentId ?? null,
      providerId: selectedProvider?.id ?? data.providerId ?? null,
      model: selectedModelEntry?.id ?? data.model,
      agentPrompt: selectedAgent?.prompt ?? '',
      userPrompt: promptDraft,
      parts: inputParts,
    }),
    [data.agentId, data.model, data.providerId, inputParts, promptDraft, selectedAgent, selectedModelEntry, selectedProvider]
  );

  const isStale = Boolean(data.lastRunInputHash) && data.lastRunInputHash !== currentInputHash;
  const textInputCount = inputParts.filter((part) => part.kind === 'text').length;
  const imageInputCount = inputParts.filter((part) => part.kind === 'image').length;
  const isGeneratingPreview = runningAgentId !== null;

  const clearPromptCommitTimer = useCallback(() => {
    if (promptCommitTimerRef.current) {
      window.clearTimeout(promptCommitTimerRef.current);
      promptCommitTimerRef.current = null;
    }
  }, []);

  const flushPromptDraft = useCallback((nextPrompt = promptDraftRef.current) => {
    clearPromptCommitTimer();
    promptDraftRef.current = nextPrompt;
    if (nextPrompt !== (data.prompt ?? '')) {
      updateNodeData(id, { prompt: nextPrompt });
    }
  }, [clearPromptCommitTimer, data.prompt, id, updateNodeData]);

  const insertGraphReference = useCallback((index: number) => {
    const marker = incomingReferenceItems[index]?.token ?? '';
    if (!marker) {
      return;
    }
    const textarea = promptRef.current;
    const currentPrompt = promptDraftRef.current;
    const cursor = textarea?.selectionStart ?? currentPrompt.length;
    const { nextText, nextCursor } = insertReferenceToken(currentPrompt, cursor, marker);
    promptDraftRef.current = nextText;
    setPromptDraft(nextText);
    flushPromptDraft(nextText);
    setReferencePickerOpen(false);
    requestAnimationFrame(() => {
      promptRef.current?.focus();
      promptRef.current?.setSelectionRange(nextCursor, nextCursor);
    });
  }, [flushPromptDraft, incomingReferenceItems]);

  const schedulePromptDraftCommit = useCallback(() => {
    clearPromptCommitTimer();
    promptCommitTimerRef.current = window.setTimeout(() => {
      promptCommitTimerRef.current = null;
      const latestPrompt = promptDraftRef.current;
      if (latestPrompt !== (data.prompt ?? '')) {
        updateNodeData(id, { prompt: latestPrompt });
      }
    }, 250);
  }, [clearPromptCommitTimer, data.prompt, id, updateNodeData]);

  useEffect(() => {
    const externalPrompt = data.prompt ?? '';
    if (externalPrompt !== promptDraftRef.current) {
      promptDraftRef.current = externalPrompt;
      setPromptDraft(externalPrompt);
    }
  }, [data.prompt]);

  useEffect(() => {
    return () => {
      clearPromptCommitTimer();
    };
  }, [clearPromptCommitTimer]);

  useEffect(() => {
    if (!selectedProvider && providerOptions.length > 0) {
      updateNodeData(id, { providerId: providerOptions[0].id });
      return;
    }

    if (!data.agentId && selectedAgent) {
      updateNodeData(id, { agentId: selectedAgent.id });
    }
  }, [data.agentId, id, providerOptions, selectedAgent, selectedProvider, updateNodeData]);

  useEffect(() => {
    if (chatCatalog.length === 0) {
      return;
    }

    const currentEntry = chatCatalog.find((entry) => entry.id === data.model);
    if (!currentEntry) {
      const nextEntry = chatCatalog[0];
      updateNodeData(id, {
        providerId: nextEntry.providerId,
        model: nextEntry.id,
      });
      return;
    }

    if (data.providerId !== currentEntry.providerId) {
      updateNodeData(id, { providerId: currentEntry.providerId });
    }
  }, [chatCatalog, data.model, data.providerId, id, updateNodeData]);

  useEffect(() => {
    if (!providerOpen && !modelOpen && !agentOverflowOpen && !referencePickerOpen) {
      return;
    }

    const handleOutside = (event: MouseEvent) => {
      if (rootRef.current?.contains(event.target as globalThis.Node)) {
        return;
      }
      setProviderOpen(false);
      setModelOpen(false);
      setAgentOverflowOpen(false);
      setReferencePickerOpen(false);
    };

    document.addEventListener('mousedown', handleOutside, true);
    return () => document.removeEventListener('mousedown', handleOutside, true);
  }, [agentOverflowOpen, modelOpen, providerOpen, referencePickerOpen]);

  const buildPayloadPreview = useCallback(async (agentOverride?: typeof selectedAgent, modelOverride?: ChatCatalogEntry | null) => {
    const agent = agentOverride ?? selectedAgent;
    const entry = modelOverride ?? selectedModelEntry ?? availableModelOptions[0] ?? chatCatalog[0] ?? null;
    const previewParts = collectAiTextInputs(id, nodes, edges, agent, textAgents);
    const previewInputHash = computeAiTextInputHash({
      agentId: agent?.id ?? data.agentId ?? null,
      providerId: entry?.providerId ?? selectedProvider?.id ?? data.providerId ?? null,
      model: entry?.id ?? data.model,
      agentPrompt: agent?.prompt ?? '',
      userPrompt: promptDraftRef.current,
      parts: previewParts,
    });
    const previewComposedPrompt = buildAiTextUserPrompt(previewParts, promptDraftRef.current);
    const payload = await buildOpenAiChatPayload({
      model: entry?.modelId ?? data.model,
      agentPrompt: agent?.prompt ?? '',
      userPrompt: promptDraftRef.current,
      parts: previewParts,
    });

    return {
      provider: entry
        ? {
          id: entry.providerId,
          label: entry.providerLabel,
        }
        : null,
      model: entry
        ? {
          id: entry.id,
          modelId: entry.modelId,
          label: entry.modelLabel,
          supportsMultimodal: entry.supportsMultimodal,
        }
        : null,
      agent: agent
        ? {
          id: agent.id,
          name: agent.name,
        }
        : null,
      inputHash: previewInputHash,
      textPrompt: previewComposedPrompt,
      payload,
    };
  }, [
    data.agentId,
    data.model,
    data.providerId,
    edges,
    id,
    nodes,
    availableModelOptions,
    chatCatalog,
    selectedAgent,
    selectedModelEntry,
    selectedProvider,
    textAgents,
  ]);

  const runAgent = useCallback(async (agentId?: string | null) => {
    const agent = enabledAgents.find((item) => item.id === agentId) ?? selectedAgent ?? enabledAgents[0] ?? null;
    if (!agent) {
      setNotice(t('node.aiText.noAgent'));
      return;
    }
    if (!agent.prompt.trim()) {
      setNotice(t('node.aiText.missingAgentPrompt'));
      return;
    }

    const nextEntry = selectedModelEntry ?? availableModelOptions[0] ?? chatCatalog[0] ?? null;
    if (!nextEntry) {
      setNotice(t('node.aiText.noChatModel'));
      return;
    }
    if (!nextEntry.usable) {
      setNotice(nextEntry.notReadyReason ?? t('node.aiText.modelNotReady'));
      return;
    }
    const generationStartedAt = Date.now();
    let outputNodeId: string | null = null;
    let payloadPreview: Awaited<ReturnType<typeof buildPayloadPreview>> | null = null;

    setRunningAgentId(agent.id);
    setNotice('');
    updateNodeData(id, {
      agentId: agent.id,
      providerId: nextEntry.providerId,
      model: nextEntry.id,
      lastError: null,
    });

    try {
      payloadPreview = await buildPayloadPreview(agent, nextEntry);
      const resultNodeId = addNode(
        CANVAS_NODE_TYPES.textAnnotation,
        findNodePosition(id, 360, 240),
        {
          displayName: t('node.aiText.outputTitle', { name: agent.name }),
          content: '',
          isGenerating: true,
          generationStartedAt,
          generationElapsedMs: null,
          sourceAiNodeId: id,
          sourceAgentId: agent.id,
        }
      );
      outputNodeId = resultNodeId;
      addEdge(id, resultNodeId);
      await waitForPreviewDelay();
      if (enableAiTextStreaming) {
        setNotice(t('node.aiText.streamingFallback'));
      }
      const result = await submitCustomChatCompletion(nextEntry.id, payloadPreview.payload);
      const generationElapsedMs = Math.max(0, Date.now() - generationStartedAt);
      updateNodeData(resultNodeId, {
        content: result.text,
        isGenerating: false,
        generationStartedAt: null,
        generationElapsedMs,
        sourceAiNodeId: id,
        sourceAgentId: agent.id,
      });
      updateNodeData(id, {
        agentId: agent.id,
        providerId: nextEntry.providerId,
        model: nextEntry.id,
        resultNodeId,
        lastPreparedPayload: payloadPreview,
        lastRunInputHash: payloadPreview.inputHash,
        lastOutputType: 'markdown',
        lastError: null,
      });
      setNotice(enableAiTextStreaming
        ? t('node.aiText.generatedWithStreamingFallback')
        : t('node.aiText.generated'));
    } catch (error) {
      const resolvedError = resolveErrorContent(error, t('ai.error'));
      const message = resolvedError.message;
      updateNodeData(id, {
        lastError: message,
      });
      if (outputNodeId) {
        const elapsed = Math.max(0, Date.now() - generationStartedAt);
        updateNodeData(outputNodeId, {
          isGenerating: false,
          generationStartedAt: null,
          generationElapsedMs: elapsed,
        });
      }
      const runtimeDiagnostics = await getRuntimeDiagnostics();
      const reportText = buildGenerationErrorReport({
        errorMessage: message,
        errorDetails: resolvedError.details,
        context: {
          sourceType: 'aiText',
          providerId: nextEntry.providerId,
          requestModel: nextEntry.modelId,
          prompt: buildAiTextUserPrompt(inputParts, promptDraftRef.current),
          referenceImageCount: inputParts.filter((part) => part.kind === 'image').length,
          referenceImagePlaceholders: createReferenceImagePlaceholders(
            inputParts.filter((part) => part.kind === 'image').length
          ),
          extraParams: {
            catalogModelId: nextEntry.id,
            agentId: agent.id,
            payloadPreview,
          },
          ...runtimeDiagnostics,
        },
      });
      void showErrorDialog(message, t('common.error'), resolvedError.details, reportText);
      setNotice(t('node.aiText.generateFailed'));
    } finally {
      setRunningAgentId(null);
    }
  }, [
    addEdge,
    addNode,
    availableModelOptions,
    buildPayloadPreview,
    chatCatalog,
    data.model,
    enableAiTextStreaming,
    enabledAgents,
    findNodePosition,
    id,
    inputParts,
    selectedAgent,
    selectedModelEntry,
    t,
    updateNodeData,
  ]);

  useEffect(() => {
    return canvasEventBus.subscribe('generation-node/trigger', ({ nodeId }) => {
      if (nodeId === id) {
        void runAgent(selectedAgent?.id);
      }
    });
  }, [id, runAgent, selectedAgent?.id]);

  const handlePromptKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) {
      return;
    }
    event.stopPropagation();
    if (event.key === '@' && incomingReferenceItems.length > 0) {
      event.preventDefault();
      setReferencePickerOpen(true);
      setProviderOpen(false);
      setModelOpen(false);
      setAgentOverflowOpen(false);
      return;
    }
    if (event.key === 'Escape' && referencePickerOpen) {
      event.preventDefault();
      setReferencePickerOpen(false);
      return;
    }
    if (event.key === 'Enter' && referencePickerOpen && incomingReferenceItems.length > 0) {
      event.preventDefault();
      insertGraphReference(0);
    }
  }, [incomingReferenceItems.length, insertGraphReference, referencePickerOpen]);

  const copyPayload = async () => {
    if (!payloadDebugText) {
      return;
    }
    await navigator.clipboard.writeText(payloadDebugText);
    setPayloadDebugCopied(true);
    window.setTimeout(() => setPayloadDebugCopied(false), 1200);
  };

  const handleOpenPayloadDebug = useCallback(async () => {
    if (payloadDebugText !== null) {
      setPayloadDebugText(null);
      return;
    }

    try {
      const existingPayload = data.lastPreparedPayload ?? await buildPayloadPreview();
      setPayloadDebugText(serializeDebugJson(existingPayload));
    } catch (debugError) {
      const resolvedError = resolveErrorContent(debugError, t('common.error'));
      void showErrorDialog(
        resolvedError.message,
        t('common.error'),
        resolvedError.details
      );
    }
  }, [buildPayloadPreview, data.lastPreparedPayload, payloadDebugText, t]);

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
        icon={<TextNodeIcon className="h-4 w-4" />}
        titleText={resolvedTitle}
        rightSlot={showNodePayloadPreview ? (
          <button
            type="button"
            data-canvas-no-marquee="true"
            className="nodrag nowheel inline-flex h-6 w-6 items-center justify-center rounded-full border border-[var(--canvas-node-border)] bg-[var(--canvas-node-menu-bg)] text-text-muted shadow-sm transition-colors hover:border-accent/50 hover:bg-[var(--canvas-node-menu-hover)] hover:text-accent"
            title={t('node.aiText.payloadDebug') as string}
            aria-label={t('node.aiText.payloadDebug') as string}
            onClick={(event) => {
              event.stopPropagation();
              void handleOpenPayloadDebug();
            }}
          >
            <Bug className="h-3.5 w-3.5" />
          </button>
        ) : undefined}
        editable
        onTitleChange={(nextTitle) => updateNodeData(id, { displayName: nextTitle })}
      />

      <div className="mb-2 shrink-0 rounded-lg border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-field-bg)] p-2">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              {visibleAgents.map((agent) => {
                const active = selectedAgent?.id === agent.id;
                const running = runningAgentId === agent.id;
                return (
                  <button
                    key={agent.id}
                    type="button"
                    disabled={isGeneratingPreview && !running}
                    className={`inline-flex max-w-[156px] items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-medium text-white transition-colors ${
                      active
                        ? 'border-accent bg-accent shadow-[0_0_0_1px_rgba(59,130,246,0.34)]'
                        : 'border-sky-500/55 bg-sky-500/90 hover:bg-sky-500'
                    } disabled:cursor-not-allowed disabled:opacity-60`}
                    title={agent.name}
                    onClick={(event) => {
                      event.stopPropagation();
                      void runAgent(agent.id);
                    }}
                  >
                    {running ? (
                      <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin" />
                    ) : null}
                    <span className="truncate">{agent.name}</span>
                  </button>
                );
              })}

              {overflowAgents.length > 0 ? (
                <div className="relative shrink-0">
                  <button
                    type="button"
                    className="inline-flex items-center rounded-md border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-button-bg)] px-2 py-1 text-[11px] text-[var(--canvas-node-button-text)] transition-colors hover:border-[var(--canvas-node-border-hover)] hover:bg-[var(--canvas-node-menu-hover)]"
                    title={t('node.aiText.moreAgents') as string}
                    onClick={(event) => {
                      event.stopPropagation();
                      setAgentOverflowOpen((open) => !open);
                      setProviderOpen(false);
                      setModelOpen(false);
                    }}
                  >
                    <MoreHorizontal className="mr-1 h-3 w-3" />
                    +{overflowAgents.length}
                  </button>
                  {agentOverflowOpen ? (
                    <div
                      className="nowheel absolute left-0 top-full z-50 mt-1 w-[220px] overflow-hidden rounded-xl border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-menu-bg)] p-1.5 shadow-xl"
                      onMouseDown={(event) => event.stopPropagation()}
                    >
                      <div className="ui-scrollbar max-h-[220px] overflow-y-auto pr-1">
                        {overflowAgents.map((agent) => {
                          const active = selectedAgent?.id === agent.id;
                          const running = runningAgentId === agent.id;
                          return (
                            <button
                              key={agent.id}
                              type="button"
                              disabled={isGeneratingPreview && !running}
                              className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
                                active
                                  ? 'bg-[var(--canvas-node-menu-active)] text-text-dark'
                                  : 'text-text-dark hover:bg-[var(--canvas-node-menu-hover)]'
                              } disabled:cursor-not-allowed disabled:opacity-60`}
                              onClick={(event) => {
                                event.stopPropagation();
                                void runAgent(agent.id);
                                setAgentOverflowOpen(false);
                              }}
                            >
                              {running ? (
                                <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />
                              ) : active ? (
                                <Check className="h-3.5 w-3.5 shrink-0 text-accent" />
                              ) : null}
                              <span className="min-w-0 truncate">{agent.name}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {enabledAgents.length === 0 ? (
                <span className="text-xs text-text-muted">{t('node.aiText.noAgent')}</span>
              ) : null}
            </div>

            {!Boolean(data.isToolbarCollapsed) && selectedAgent ? (
              <>
                <div className="mt-2 line-clamp-2 whitespace-pre-wrap break-words text-xs leading-5 text-text-muted">
                  {selectedAgent?.prompt?.trim() || t('node.aiText.noAgent')}
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <span className="inline-flex items-center rounded-full border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-button-bg)] px-2 py-0.5 text-[11px] text-text-muted">
                    {t('node.aiText.textInputCount', { count: textInputCount })}
                  </span>
                  <span className="inline-flex items-center rounded-full border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-button-bg)] px-2 py-0.5 text-[11px] text-text-muted">
                    {t('node.aiText.imageInputCount', { count: imageInputCount })}
                  </span>
                  <span className="inline-flex items-center rounded-full border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-button-bg)] px-2 py-0.5 text-[11px] text-text-muted">
                    Hash {currentInputHash}
                  </span>
                </div>
              </>
            ) : null}
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              className="nodrag nowheel inline-flex h-8 w-8 items-center justify-center rounded-[6px] border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-button-bg)] text-text-muted transition-colors hover:border-[var(--canvas-node-border-hover)] hover:bg-[var(--canvas-node-menu-hover)] hover:text-text-dark"
              onClick={(event) => {
                event.stopPropagation();
                updateNodeData(id, { isToolbarCollapsed: !data.isToolbarCollapsed });
              }}
              title={data.isToolbarCollapsed ? t('node.aiText.expandToolbar') as string : t('node.aiText.collapseToolbar') as string}
            >
              <ChevronDown className={`h-4 w-4 transition-transform ${data.isToolbarCollapsed ? '-rotate-90' : 'rotate-0'}`} />
            </button>
          </div>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 rounded-lg border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-field-bg)] p-2">
        <textarea
          ref={promptRef}
          value={promptDraft}
          onChange={(event) => {
            const nextPrompt = event.target.value;
            promptDraftRef.current = nextPrompt;
            setPromptDraft(nextPrompt);
            schedulePromptDraftCommit();
          }}
          onBlur={() => flushPromptDraft()}
          onClick={(event) => event.stopPropagation()}
          onFocus={(event) => event.stopPropagation()}
          onKeyDown={handlePromptKeyDown}
          onKeyUp={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          placeholder={t('node.aiText.promptPlaceholder') as string}
          className="ui-scrollbar nodrag nopan nowheel h-full w-full resize-none border-none bg-transparent px-1 py-0.5 text-sm leading-6 text-text-dark outline-none placeholder:text-text-muted/80"
          spellCheck={false}
        />
        {referencePickerOpen && incomingReferenceItems.length > 0 ? (
          <div
            className="nowheel absolute left-3 top-3 z-30 w-[148px] overflow-hidden rounded-xl border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-menu-bg)] shadow-xl"
            onMouseDown={(event) => event.stopPropagation()}
            onWheelCapture={(event) => event.stopPropagation()}
          >
            <div className="ui-scrollbar nowheel max-h-[220px] overflow-y-auto">
              {incomingReferenceItems.map((item, index) => (
                <button
                  key={`${item.kind}-${item.sourceNodeId}-${index}`}
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    insertGraphReference(index);
                  }}
                  className="flex w-full items-center gap-2 border border-transparent bg-transparent px-2 py-2 text-left text-sm text-text-dark transition-colors hover:border-[var(--canvas-node-field-border)] hover:bg-[var(--canvas-node-menu-hover)]"
                >
                  {item.kind === 'image' && item.displayUrl ? (
                    <CanvasNodeImage
                      src={item.displayUrl}
                      alt={item.label}
                      viewerSourceUrl={resolveImageDisplayUrl(item.imageUrl ?? item.displayUrl)}
                      viewerImageList={incomingImageViewerList}
                      className="h-8 w-8 rounded object-cover"
                      draggable={false}
                    />
                  ) : (
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-[var(--canvas-node-button-bg)] text-[10px] font-semibold text-text-muted">
                      {item.kind === 'video' ? 'V' : 'T'}
                    </span>
                  )}
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <div className="mt-2 flex min-w-0 shrink-0 items-center gap-1">
        <div className="relative min-w-0 max-w-[150px] shrink">
          <UiChipButton
            active={providerOpen}
            className={`w-full ${NODE_CONTROL_CHIP_CLASS}`}
            title={selectedProvider?.label ?? t('node.aiText.selectProvider') as string}
            onClick={(event) => {
              event.stopPropagation();
              setProviderOpen((open) => !open);
              setModelOpen(false);
              setAgentOverflowOpen(false);
            }}
          >
            <TextNodeIcon className={NODE_CONTROL_ICON_CLASS} />
            <span className="min-w-0 truncate">{selectedProvider?.label ?? t('node.aiText.selectProvider')}</span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
          </UiChipButton>
          {providerOpen ? (
            <div
              className="nowheel absolute bottom-full left-0 z-50 mb-1 min-w-[190px] overflow-hidden rounded-xl border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-menu-bg)] p-1.5 shadow-xl"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <div className="ui-scrollbar max-h-[220px] overflow-y-auto pr-1">
                {providerOptions.map((provider) => {
                  const active = selectedProvider?.id === provider.id;
                  return (
                    <button
                      key={provider.id}
                      type="button"
                      className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
                        active
                          ? 'bg-[var(--canvas-node-menu-active)] text-text-dark'
                          : 'text-text-dark hover:bg-[var(--canvas-node-menu-hover)]'
                      }`}
                      onClick={(event) => {
                        event.stopPropagation();
                        updateNodeData(id, {
                          providerId: provider.id,
                          model: provider.models[0]?.id ?? data.model,
                        });
                        setProviderOpen(false);
                      }}
                    >
                      {active ? <Check className="h-3.5 w-3.5 shrink-0 text-accent" /> : null}
                      <span className="min-w-0 truncate">{provider.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>

        <div className="relative min-w-0 max-w-[180px] shrink">
          <UiChipButton
            active={modelOpen}
            className={`w-full ${NODE_CONTROL_CHIP_CLASS}`}
            title={selectedModelEntry?.modelLabel || data.model || t('node.aiText.selectModel') as string}
            onClick={(event) => {
              event.stopPropagation();
              setModelOpen((open) => !open);
              setProviderOpen(false);
              setAgentOverflowOpen(false);
            }}
          >
            <span className="min-w-0 truncate">{selectedModelEntry?.modelLabel || data.model || t('node.aiText.selectModel')}</span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
          </UiChipButton>
          {modelOpen ? (
            <div
              className="nowheel absolute bottom-full left-0 z-50 mb-1 w-[280px] overflow-hidden rounded-xl border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-menu-bg)] p-1.5 shadow-xl"
              onMouseDown={(event) => event.stopPropagation()}
            >
              {availableModelOptions.length === 0 ? (
                <div className="flex items-start gap-2 p-2 text-xs leading-5 text-text-muted">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" />
                  <span>{t('node.aiText.noProviderModels')}</span>
                </div>
              ) : (
                <div className="ui-scrollbar max-h-[240px] overflow-y-auto pr-1">
                  {availableModelOptions.map((model) => {
                    const active = data.model === model.id;
                    return (
                      <button
                        key={model.id}
                        type="button"
                        className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs transition-colors ${
                          active
                            ? 'bg-[var(--canvas-node-menu-active)] text-text-dark'
                            : 'text-text-dark hover:bg-[var(--canvas-node-menu-hover)]'
                        }`}
                        onClick={(event) => {
                          event.stopPropagation();
                          updateNodeData(id, { providerId: model.providerId, model: model.id });
                          setModelOpen(false);
                        }}
                        title={model.description ?? model.modelId}
                      >
                        {active ? <Check className="h-3.5 w-3.5 shrink-0 text-accent" /> : null}
                        <span className="min-w-0 flex-1 truncate">{model.modelLabel}</span>
                        {model.supportsMultimodal ? (
                          <span className="shrink-0 rounded-full border border-accent/40 px-1.5 py-0.5 text-[10px] text-accent">MM</span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ) : null}
        </div>

        <UiButton
          variant="primary"
          className={`ml-auto shrink-0 ${NODE_CONTROL_PRIMARY_BUTTON_CLASS}`}
          disabled={isGeneratingPreview}
          onClick={(event) => {
            event.stopPropagation();
            void runAgent(selectedAgent?.id);
          }}
        >
          {isGeneratingPreview ? (
            <LoaderCircle className={`${NODE_CONTROL_ICON_CLASS} animate-spin`} />
          ) : (
            <Sparkles className={NODE_CONTROL_ICON_CLASS} />
          )}
          {t('node.aiText.generate')}
        </UiButton>
      </div>

      {isStale ? (
        <div className="mt-1 shrink-0 text-xs text-amber-300">{t('node.aiText.staleResult')}</div>
      ) : null}
      {notice ? (
        <div className="mt-1 shrink-0 text-xs text-text-muted">{notice}</div>
      ) : null}
      {data.lastError ? (
        <div className="mt-1 shrink-0 text-xs text-text-muted">{data.lastError}</div>
      ) : null}

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
        onPointerDownCapture={clearBrowserTextSelection}
        className="!h-2 !w-2 !border-surface-dark !bg-accent"
      />
      <NodeResizeHandle
        minWidth={AI_TEXT_NODE_MIN_WIDTH}
        minHeight={AI_TEXT_NODE_MIN_HEIGHT}
        maxWidth={AI_TEXT_NODE_MAX_WIDTH}
        maxHeight={AI_TEXT_NODE_MAX_HEIGHT}
      />

      <UiModal
        isOpen={payloadDebugText !== null}
        title={t('node.aiText.payloadDebugTitle') as string}
        onClose={() => setPayloadDebugText(null)}
        widthClassName="w-[calc(100vw-32px)] max-w-[1200px]"
        containerClassName="!z-[13050]"
        footer={(
          <>
            <UiButton variant="muted" size="sm" onClick={() => setPayloadDebugText(null)}>
              {t('common.close')}
            </UiButton>
            <UiButton variant="primary" size="sm" onClick={() => void copyPayload()}>
              <Copy className="mr-1.5 h-3.5 w-3.5" />
              {payloadDebugCopied ? (
                <>
                  <Check className="mr-1 h-3.5 w-3.5" />
                  {t('nodeToolbar.copied')}
                </>
              ) : t('nodeToolbar.copy')}
            </UiButton>
          </>
        )}
      >
        <pre className="ui-scrollbar nowheel max-h-[60vh] overflow-auto rounded-lg border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-field-bg)] p-3 text-xs leading-5 text-text-dark">
          {payloadDebugText}
        </pre>
      </UiModal>
    </div>
  );
});

AiTextNode.displayName = 'AiTextNode';
