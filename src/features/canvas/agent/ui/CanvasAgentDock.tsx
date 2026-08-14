import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Bot, ExternalLink, ShieldCheck, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useChatModelCatalog } from '@/features/canvas/application/chatModelCatalog';
import { useImageModelCatalog } from '@/features/canvas/application/modelCatalog';
import { useVideoModelCatalog } from '@/features/canvas/application/videoModelCatalog';
import { buildCanvasAssetCatalog } from '@/features/canvas/application/canvasAssetCatalog';
import { canvasNavigationFacade } from '@/features/canvas/application/canvasNavigationFacade';
import { openSettingsDialog } from '@/features/settings/settingsEvents';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { createAgentCanvasMediaInput } from '../application/agentMediaResolver';
import { classifyCanvasAgentFailure } from '../application/agentFailurePolicy';
import {
  acquireCanvasAgentTurn,
  releaseCanvasAgentTurn,
  type CanvasAgentTurnGate,
} from '../application/agentTurnGate';
import { buildAgentPlanDraft, compileAgentPlanMessage, type AgentPlanDraft } from '../application/agentPlan';
import { rollbackAgentCanvasReceipt } from '../application/agentCanvasRollback';
import {
  getCanvasAgentSessionMessages,
  listPendingCanvasAgentApprovals,
  listCanvasAgentSessions,
  resolveCanvasAgentApproval,
  runCanvasAgentTurn,
} from '../application/canvasAgentController';
import type { CanvasAgentToolEvent } from '../infrastructure/sdkRuntime';
import type {
  AgentSessionMediaReferenceView,
  AgentTurnMediaInput,
} from '../domain/agentModel';
import { CanvasAgentAttachmentPicker } from './CanvasAgentAttachmentPicker';
import { CanvasAgentComposer } from './CanvasAgentComposer';
import { CanvasAgentFeedViewport } from './CanvasAgentFeedViewport';
import { CanvasAgentHeader } from './CanvasAgentHeader';
import { ExternalAgentConnectionPanel } from './ExternalAgentConnectionPanel';
import { buildExternalCanvasMcpManifest } from '../application/externalAgentToolManifest';
import {
  executionReceiptFromAgentOutput,
  generationLocateTargetsFromAgentOutput,
  generationProgressFromAgentOutput,
  nodeIdsFromAgentOutput,
} from './agentFeedProjection';
import {
  CANVAS_AGENT_PANEL_DEFAULT_WIDTH,
  CANVAS_AGENT_PANEL_MAX_WIDTH,
  CANVAS_AGENT_PANEL_MIN_WIDTH,
  isLegacyInferredAgentFailure,
  nextAgentFeedId,
  useCanvasAgentPanelStore,
  type AgentExecutionMode,
  type AgentFeedItem,
} from './agentPanelStore';
import { useCanvasAgentAttachments } from './useCanvasAgentAttachments';

type Props = { projectId: string };

function projectPendingAttachment(
  attachment: AgentTurnMediaInput,
  availability: AgentSessionMediaReferenceView['availability'] = 'available',
): AgentSessionMediaReferenceView {
  return {
    referenceId: `pending:${attachment.assetId}`,
    runId: 'pending',
    assetId: attachment.assetId,
    nodeId: attachment.nodeId,
    title: attachment.title,
    origin: attachment.origin,
    mimeType: attachment.mimeType,
    createdAt: Date.now(),
    availability,
  };
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  ));
}

function readableAgentFailure(error: unknown, t: ReturnType<typeof useTranslation>['t']): string {
  const failure = classifyCanvasAgentFailure(error);
  const message = failure.rawMessage;
  if (failure.kind === 'local-storage') {
    return t('canvasAgent.failureMessages.localStorageFull');
  }
  if (failure.kind === 'provider-quota') {
    return t('canvasAgent.failureMessages.providerQuotaExceeded');
  }
  if (failure.kind === 'provider-rate-limit') {
    return t('canvasAgent.failureMessages.providerRateLimited');
  }
  if (/nodeIds\.length|nodeIds.*required|Missing required.*nodeIds/i.test(message)) {
    return t('canvasAgent.failureMessages.missingNodeSelection');
  }
  if (/canvas\.query.*scope|Invalid query scope|Missing required.*scope/i.test(message)) {
    return t('canvasAgent.failureMessages.invalidQueryScope');
  }
  if (/审批.*失效|已处理|approval.*expired/i.test(message)) {
    return t('canvasAgent.failureMessages.expiredApproval');
  }
  if (/revision.*conflict|项目已切换|参数.*不一致/i.test(message)) {
    return t('canvasAgent.failureMessages.stateChanged');
  }
  return message;
}

export function CanvasAgentDock({ projectId }: Props) {
  const { t } = useTranslation();
  const {
    isOpen,
    projectId: storedProjectId,
    activeView,
    selectedModelId,
    selectedImageModelId,
    selectedVideoModelId,
    executionMode,
    autoModeAcknowledged,
    showCompletedTools,
    panelWidth,
    activeSessionId,
    feed,
    setOpen,
    setProject,
    setActiveView,
    setSelectedModelId,
    setSelectedImageModelId,
    setSelectedVideoModelId,
    setExecutionMode,
    acknowledgeAutoMode,
    setShowCompletedTools,
    setPanelWidth,
    resetPanelWidth,
    setActiveSessionId,
    addFeedItem,
    updateFeedItem,
    clearFeed,
    replaceFeed,
  } = useCanvasAgentPanelStore();
  const catalog = useChatModelCatalog();
  const imageCatalog = useImageModelCatalog();
  const videoCatalog = useVideoModelCatalog();
  const modelEntries = useMemo(
    () => catalog.filter((entry) => entry.usable && entry.supportsTools),
    [catalog],
  );
  const selectedEntry = modelEntries.find((entry) => entry.id === selectedModelId)
    ?? modelEntries[0]
    ?? null;
  const visibleFeed = storedProjectId === projectId
    ? feed.filter((item) => !isLegacyInferredAgentFailure(item))
    : [];
  const projectSessionId = storedProjectId === projectId ? activeSessionId : null;
  const displayedFeed = visibleFeed;
  const pendingCount = visibleFeed.filter(
    (item): item is Extract<AgentFeedItem, { kind: 'approval' }> => (
      item.kind === 'approval'
      && item.status === 'pending'
      && item.expiresAt > Date.now()
    ),
  ).length;
  const hasPendingPlan = visibleFeed.some(
    (item) => item.kind === 'plan' && item.plan.status === 'pending',
  );
  const sessions = activeView === 'history' ? listCanvasAgentSessions(projectId) : [];
  const usableImageModels = useMemo(() => imageCatalog.filter((entry) => entry.usable), [imageCatalog]);
  const usableVideoModels = useMemo(() => videoCatalog.filter((entry) => entry.usable), [videoCatalog]);

  const [draft, setDraft] = useState('');
  const attachmentState = useCanvasAgentAttachments(projectId);
  const { attachments, imageAssets, hasMissingAttachments } = attachmentState;
  const [isRunning, setRunning] = useState(false);
  const [showNewItems, setShowNewItems] = useState(false);
  const [isAutoModeConfirmOpen, setAutoModeConfirmOpen] = useState(false);
  const [isExternalConnectionOpen, setExternalConnectionOpen] = useState(false);
  const [livePanelWidth, setLivePanelWidth] = useState(panelWidth);
  const [isResizing, setResizing] = useState(false);
  const [isCompactViewport, setCompactViewport] = useState(() => (
    typeof window !== 'undefined' && window.matchMedia('(max-width: 1023px)').matches
  ));
  const abortRef = useRef<AbortController | null>(null);
  const executionGateRef = useRef<CanvasAgentTurnGate>({ active: false });
  const launcherRef = useRef<HTMLButtonElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const resizeStartRef = useRef<{ pointerX: number; width: number; currentWidth: number } | null>(null);
  const feedScrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const scrollFrameRef = useRef<number | null>(null);
  const streamTextRef = useRef('');
  const streamReasoningRef = useRef('');
  const streamMessageIdRef = useRef<string | null>(null);
  const streamReasoningIdRef = useRef<string | null>(null);
  const toolFeedIdsRef = useRef(new Map<string, string>());
  const activeStatusIdRef = useRef<string | null>(null);

  const selectedNode = useCanvasStore((canvas) => (
    canvas.selectedNodeId
      ? canvas.nodes.find((node) => node.id === canvas.selectedNodeId) ?? null
      : null
  ));
  const canvasNodes = useCanvasStore((canvas) => canvas.nodes);
  const currentProjectName = useProjectStore((state) => (
    state.currentProjectId === projectId ? state.currentProject?.name ?? null : null
  ));
  const externalConnectionTools = useMemo(() => buildExternalCanvasMcpManifest([
    'canvas', 'diagnostics', 'config', 'asset-read',
  ]).tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    requiresApproval: true,
  })), []);
  const taskCount = useMemo(() => canvasNodes.filter((node) => {
    const data = node.data as Record<string, unknown>;
    return data.isGenerating === true;
  }).length, [canvasNodes]);
  const contextEstimateTokens = useMemo(() => {
    const conversationCharacters = visibleFeed.reduce((total, item) => (
      item.kind === 'message' ? total + item.text.length : total
    ), 0);
    const draftCharacters = draft.length;
    return Math.max(0, Math.ceil((conversationCharacters + draftCharacters) / 3.2) + attachments.length * 900);
  }, [attachments.length, draft.length, visibleFeed]);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 1023px)');
    const updateViewportMode = () => setCompactViewport(mediaQuery.matches);
    updateViewportMode();
    mediaQuery.addEventListener('change', updateViewportMode);
    return () => mediaQuery.removeEventListener('change', updateViewportMode);
  }, []);

  useEffect(() => {
    setProject(projectId);
    const store = useCanvasAgentPanelStore.getState();
    const existing = new Set(store.feed.flatMap((item) => (
      item.kind === 'approval' ? [`${item.runId}:${item.approvalId}`] : []
    )));
    for (const approval of listPendingCanvasAgentApprovals(projectId)) {
      const key = `${approval.runId}:${approval.id}`;
      if (existing.has(key)) continue;
      store.addFeedItem({
        id: nextAgentFeedId('restored-approval'),
        kind: 'approval',
        runId: approval.runId,
        approvalId: approval.id,
        toolName: approval.toolName,
        summary: approval.summary,
        arguments: approval.arguments,
        impact: approval.impact,
        expiresAt: approval.expiresAt,
        status: 'pending',
        createdAt: Date.now(),
      });
    }
  }, [projectId, setProject]);

  useEffect(() => {
    if (!selectedModelId && selectedEntry) setSelectedModelId(selectedEntry.id);
  }, [selectedEntry, selectedModelId, setSelectedModelId]);

  useEffect(() => {
    if (!selectedImageModelId && usableImageModels[0]) setSelectedImageModelId(usableImageModels[0].id);
  }, [selectedImageModelId, setSelectedImageModelId, usableImageModels]);

  useEffect(() => {
    if (!selectedVideoModelId && usableVideoModels[0]) setSelectedVideoModelId(usableVideoModels[0].id);
  }, [selectedVideoModelId, setSelectedVideoModelId, usableVideoModels]);

  useEffect(() => {
    if (!isResizing) setLivePanelWidth(panelWidth);
  }, [isResizing, panelWidth]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    (panel as HTMLElement & { inert?: boolean }).inert = !isOpen;
    if (!isOpen) return;

    const focusTarget = isCompactViewport
      ? closeRef.current
      : panel.querySelector<HTMLElement>('textarea, input') ?? closeRef.current;
    focusTarget?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key !== 'Tab' || !isCompactViewport) return;
      const elements = focusableElements(panel);
      if (!elements.length) return;
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isCompactViewport, isOpen, setOpen]);

  useEffect(() => {
    if (isOpen) return;
    const frame = requestAnimationFrame(() => launcherRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [isOpen]);

  useEffect(() => {
    const scroll = feedScrollRef.current;
    if (!scroll || !stickToBottomRef.current) return;
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
    scrollFrameRef.current = requestAnimationFrame(() => {
      scroll.scrollTo({
        top: scroll.scrollHeight,
        behavior: isRunning ? 'auto' : 'smooth',
      });
      setShowNewItems(false);
      scrollFrameRef.current = null;
    });
    return () => {
      if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
    };
  }, [visibleFeed, isRunning]);

  const onFeedScroll = () => {
    const scroll = feedScrollRef.current;
    if (!scroll) return;
    const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 56;
    stickToBottomRef.current = atBottom;
    if (atBottom) setShowNewItems(false);
  };

  const pushFeed = (item: AgentFeedItem) => {
    addFeedItem(item);
    if (!stickToBottomRef.current) setShowNewItems(true);
  };

  const updateStreamingMessage = (delta: string) => {
    streamTextRef.current += delta;
    const id = streamMessageIdRef.current;
    if (!id) {
      const newId = nextAgentFeedId('assistant-stream');
      streamMessageIdRef.current = newId;
      pushFeed({
        id: newId,
        kind: 'message',
        role: 'assistant',
        text: streamTextRef.current,
        streaming: true,
        createdAt: Date.now(),
      });
      return;
    }
    updateFeedItem(id, { text: streamTextRef.current, streaming: true });
  };

  const updateStreamingReasoning = (delta: string) => {
    streamReasoningRef.current += delta;
    const detail = streamReasoningRef.current;
    const summary = detail.length > 96 ? `${detail.slice(0, 96).trimEnd()}...` : detail;
    const id = streamReasoningIdRef.current;
    if (!id) {
      const newId = nextAgentFeedId('reasoning-stream');
      streamReasoningIdRef.current = newId;
      pushFeed({
        id: newId,
        kind: 'reasoning',
        summary,
        detail,
        createdAt: Date.now(),
      });
      return;
    }
    updateFeedItem(id, { summary, detail });
  };

  const finishStreaming = (finalText?: string) => {
    const id = streamMessageIdRef.current;
    const text = finalText?.trim() || streamTextRef.current.trim();
    if (id) updateFeedItem(id, { text, streaming: false });
    else if (text) {
      pushFeed({
        id: nextAgentFeedId('assistant'),
        kind: 'message',
        role: 'assistant',
        text,
        createdAt: Date.now(),
      });
    }
    streamMessageIdRef.current = null;
    streamReasoningIdRef.current = null;
    streamTextRef.current = '';
    streamReasoningRef.current = '';
  };

  const handleToolEvent = (event: CanvasAgentToolEvent) => {
    const key = event.callId ?? `${event.toolName}-${Date.now()}`;
    const id = toolFeedIdsRef.current.get(key) ?? nextAgentFeedId('tool');
    const status = event.status === 'unknown'
      ? 'unknown' as const
      : event.status === 'warning'
        ? 'warning' as const
      : event.status === 'failed'
      ? 'failed' as const
      : event.status === 'succeeded'
        ? 'succeeded' as const
        : 'executing' as const;
    const generationProgress = generationProgressFromAgentOutput(event.output);
    if (generationProgress && activeStatusIdRef.current) {
      updateFeedItem(activeStatusIdRef.current, {
        text: generationProgress.phase === 'accepted'
          ? t('canvasAgent.generationSubmittedWaiting')
          : t('canvasAgent.generationPolling', {
              attempt: generationProgress.attempt,
              max: generationProgress.maxAttempts,
            }),
      });
    }

    if (!toolFeedIdsRef.current.has(key)) {
      toolFeedIdsRef.current.set(key, id);
      const execution = executionReceiptFromAgentOutput(event.output);
      const generationTargets = generationLocateTargetsFromAgentOutput(event.output);
      pushFeed({
        id,
        kind: 'tool',
        toolName: event.toolName,
        status,
        input: event.input,
        output: event.output,
        error: event.error,
        nodeIds: nodeIdsFromAgentOutput(event.output),
        ...(generationTargets.inputNodeIds.length ? { generationInputNodeIds: generationTargets.inputNodeIds } : {}),
        ...(generationTargets.resultNodeIds.length ? { generationResultNodeIds: generationTargets.resultNodeIds } : {}),
        ...execution,
        startedAt: Date.now(),
        createdAt: Date.now(),
      });
      return;
    }

    const existing = useCanvasAgentPanelStore.getState().feed.find((item) => item.id === id);
    const startedAt = existing?.kind === 'tool' ? existing.startedAt : undefined;
    const execution = executionReceiptFromAgentOutput(event.output);
    const nodeIds = nodeIdsFromAgentOutput(event.output);
    const generationTargets = generationLocateTargetsFromAgentOutput(event.output);
    updateFeedItem(id, {
      status,
      ...(event.input !== undefined ? { input: event.input } : {}),
      ...(event.output !== undefined ? { output: event.output } : {}),
      ...(event.error !== undefined ? { error: event.error } : {}),
      ...(nodeIds.length ? { nodeIds } : {}),
      ...(generationTargets.inputNodeIds.length ? { generationInputNodeIds: generationTargets.inputNodeIds } : {}),
      ...(generationTargets.resultNodeIds.length ? { generationResultNodeIds: generationTargets.resultNodeIds } : {}),
      ...execution,
      durationMs: startedAt ? Date.now() - startedAt : undefined,
    });
  };

  const runtimeReady = Boolean(selectedEntry);

  const addResult = (result: Awaited<ReturnType<typeof runCanvasAgentTurn>>) => {
    setActiveSessionId(result.sessionId);
    if (result.skillSelection.skillIds.length) {
      pushFeed({
        id: nextAgentFeedId('skill'),
        kind: 'skill',
        skillIds: result.skillSelection.skillIds,
        reason: result.skillSelection.reason,
        estimatedTokens: result.skillSelection.estimatedTokens,
        toolCount: result.skillSelection.toolCount,
        mode: result.skillSelection.mode,
        deferredToolCount: result.skillSelection.deferredToolCount,
        createdAt: Date.now(),
      });
    }
    const currentFeed = useCanvasAgentPanelStore.getState().feed;
    result.approvals.forEach((approval) => {
      const existing = currentFeed.find((item): item is Extract<AgentFeedItem, { kind: 'approval' }> => (
        item.kind === 'approval'
        && item.runId === result.runId
        && item.approvalId === approval.id
      ));
      if (existing) {
        if (existing.status !== 'pending') updateFeedItem(existing.id, { status: 'pending', expiresAt: approval.expiresAt });
        return;
      }
      pushFeed({
        id: nextAgentFeedId('approval'),
        kind: 'approval',
        runId: result.runId,
        approvalId: approval.id,
        toolName: approval.toolName,
        summary: approval.summary,
        arguments: approval.arguments,
        impact: approval.impact,
        expiresAt: approval.expiresAt,
        status: 'pending',
        createdAt: Date.now(),
      });
    });
    finishStreaming(result.finalText);
  };

  const diagnosticPrompt = (errorText: string, originalRequest: string) => t('canvasAgent.diagnosticContinuationPrompt', {
    error: errorText,
    request: originalRequest,
  });

  const executeTurn = async (message: string) => {
    if (!message.trim() || !selectedEntry || isRunning || pendingCount > 0) return;
    if (!acquireCanvasAgentTurn(executionGateRef.current)) return;
    const statusId = nextAgentFeedId('status');
    activeStatusIdRef.current = statusId;
    pushFeed({
      id: statusId,
      kind: 'status',
      status: 'running',
      text: t('canvasAgent.thinking'),
      createdAt: Date.now(),
    });
    setRunning(true);
    abortRef.current = new AbortController();
    streamTextRef.current = '';
    streamReasoningRef.current = '';

    try {
      const currentNodes = useCanvasStore.getState().nodes;
      if (attachments.length && !selectedEntry.supportsMultimodal) {
        throw new Error(t('canvasAgent.switchToVisionModelHint'));
      }
      const currentAssets = new Map(
        buildCanvasAssetCatalog(currentNodes)
          .filter((asset) => asset.kind === 'image')
          .map((asset) => [asset.id, asset]),
      );
      const media = attachments.map((attachment) => {
        if (attachment.origin === 'upload') return attachment;
        const asset = currentAssets.get(attachment.assetId);
        if (!asset) throw new Error(t('canvasAgent.missingAttachmentBeforeSend'));
        return createAgentCanvasMediaInput(asset);
      });
      const result = await runCanvasAgentTurn({
        projectId,
        sessionId: projectSessionId ?? undefined,
        model: selectedEntry,
        executionMode,
        generationPreferences: {
          ...(selectedImageEntry ? {
            image: {
              modelId: selectedImageEntry.id,
              supportedRatios: selectedImageEntry.supportedRatios,
              supportedResolutions: selectedImageEntry.supportedResolutions,
            },
          } : {}),
          ...(selectedVideoEntry ? {
            video: {
              modelId: selectedVideoEntry.id,
              supportedRatios: selectedVideoEntry.supportedAspectRatios,
              supportedResolutions: selectedVideoEntry.supportedResolutions,
              supportedDurations: selectedVideoEntry.supportedDurations,
            },
          } : {}),
        },
        message,
        media: media.length ? media : undefined,
        signal: abortRef.current.signal,
        onTextDelta: updateStreamingMessage,
        onReasoningDelta: updateStreamingReasoning,
        onToolEvent: handleToolEvent,
      });
      attachmentState.reset();
      updateFeedItem(statusId, {
        status: 'completed',
        text: result.status === 'awaiting-approval'
          ? t('canvasAgent.awaitingApproval')
          : t('canvasAgent.completed'),
      });
      addResult(result);
    } catch (error) {
      const aborted = error instanceof DOMException && error.name === 'AbortError';
      const failure = classifyCanvasAgentFailure(error);
      const readableError = readableAgentFailure(error, t);
      updateFeedItem(statusId, {
        status: aborted ? 'cancelled' : 'error',
        text: aborted
          ? t('canvasAgent.cancelled')
          : readableError,
        retryMessage: aborted ? undefined : message,
        diagnosticMessage: aborted || !failure.canSelfDiagnose ? undefined : diagnosticPrompt(
          readableError,
          message,
        ),
      });
      finishStreaming();
    } finally {
      activeStatusIdRef.current = null;
      releaseCanvasAgentTurn(executionGateRef.current);
      setRunning(false);
      abortRef.current = null;
    }
  };

  const activeGenerationProgress = useMemo(() => {
    for (let index = displayedFeed.length - 1; index >= 0; index -= 1) {
      const item = displayedFeed[index];
      if (item.kind !== 'tool' || item.status !== 'executing') continue;
      const progress = generationProgressFromAgentOutput(item.output);
      if (progress) return progress;
    }
    return null;
  }, [displayedFeed]);

  const send = async () => {
    const message = draft.trim();
    if (!message || !runtimeReady || isRunning || pendingCount > 0 || hasPendingPlan) return;
    if (attachments.length && !selectedEntry?.supportsMultimodal) {
      attachmentState.setError(t('canvasAgent.switchToVisionModelHint'));
      return;
    }
    if (hasMissingAttachments) {
      attachmentState.setError(t('canvasAgent.missingAttachmentBeforeSend'));
      return;
    }

    setDraft('');
    attachmentState.setError(null);
    stickToBottomRef.current = true;
    toolFeedIdsRef.current.clear();
    pushFeed({
      id: nextAgentFeedId('user'),
      kind: 'message',
      role: 'user',
      text: message,
      attachments: attachments.map((attachment) => projectPendingAttachment(attachment)),
      createdAt: Date.now(),
    });
    const plan = executionMode === 'manual' ? buildAgentPlanDraft(message) : null;
    if (plan) {
      pushFeed({
        id: nextAgentFeedId('plan'),
        kind: 'plan',
        plan,
        createdAt: Date.now(),
      });
      return;
    }
    await executeTurn(message);
  };

  const handlePlanChange = (
    item: Extract<AgentFeedItem, { kind: 'plan' }>,
    plan: AgentPlanDraft,
  ) => updateFeedItem(item.id, { plan });

  const handlePlanConfirm = async (item: Extract<AgentFeedItem, { kind: 'plan' }>) => {
    if (item.plan.status !== 'pending' || isRunning || pendingCount > 0) return;
    const approved = { ...item.plan, status: 'approved' as const };
    updateFeedItem(item.id, { plan: approved });
    await executeTurn(compileAgentPlanMessage(approved));
  };

  const handlePlanCancel = (item: Extract<AgentFeedItem, { kind: 'plan' }>) => {
    if (item.plan.status !== 'pending') return;
    updateFeedItem(item.id, { plan: { ...item.plan, status: 'cancelled' } });
  };

  const resolveApprovalItem = async (
    item: Extract<AgentFeedItem, { kind: 'approval' }>,
    approve: boolean,
    manageRunningState = true,
  ) => {
    if (!selectedEntry || item.status !== 'pending') return false;
    updateFeedItem(item.id, { status: approve ? 'approving' : 'rejecting' });
    if (manageRunningState) {
      setRunning(true);
      abortRef.current = new AbortController();
    }
    const controller = abortRef.current ?? new AbortController();

    try {
      const result = await resolveCanvasAgentApproval({
        runId: item.runId,
        approvalId: item.approvalId,
        approve,
        model: selectedEntry,
        signal: controller.signal,
        onToolEvent: handleToolEvent,
        onTextDelta: updateStreamingMessage,
        onReasoningDelta: updateStreamingReasoning,
      });
      updateFeedItem(item.id, { status: approve ? 'approved' : 'rejected' });
      addResult(result);
      return true;
    } catch (error) {
      const aborted = error instanceof DOMException && error.name === 'AbortError';
      const message = error instanceof Error ? error.message : String(error);
      const readableError = readableAgentFailure(error, t);
      const terminal = /\u5931\u6548|\u5df2\u5904\u7406|expired|conflict|\u4e0d\u4e00\u81f4|\u9879\u76ee\u5df2\u5207\u6362/i.test(message);
      updateFeedItem(item.id, { status: aborted ? 'pending' : terminal ? 'expired' : 'failed' });
      pushFeed({
        id: nextAgentFeedId('approval-error'),
        kind: 'status',
        status: aborted ? 'cancelled' : 'error',
        text: aborted
          ? t('canvasAgent.cancelled')
          : readableError,
        retryMessage: aborted ? undefined : item.summary,
        diagnosticMessage: aborted ? undefined : diagnosticPrompt(readableError, item.summary),
        createdAt: Date.now(),
      });
      finishStreaming();
      return false;
    } finally {
      if (manageRunningState) {
        setRunning(false);
        abortRef.current = null;
      }
    }
  };

  const handleApproval = async (
    item: Extract<AgentFeedItem, { kind: 'approval' }>,
    approve: boolean,
  ) => {
    if (isRunning) return;
    await resolveApprovalItem(item, approve);
  };

  const handleBatchApprovals = async (
    items: Array<Extract<AgentFeedItem, { kind: 'approval' }>>,
    approve: boolean,
  ) => {
    if (!selectedEntry || isRunning || !items.length) return;
    setRunning(true);
    abortRef.current = new AbortController();
    try {
      for (const item of items) {
        if (abortRef.current.signal.aborted) break;
        const latest = useCanvasAgentPanelStore.getState().feed.find((candidate) => candidate.id === item.id);
        if (latest?.kind !== 'approval' || latest.status !== 'pending') continue;
        await resolveApprovalItem(latest, approve, false);
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const loadSession = (sessionId: string) => {
    const messages = getCanvasAgentSessionMessages(sessionId);
    if (!messages.length) return;
    replaceFeed(messages.map((message) => ({
      id: nextAgentFeedId('history'),
      kind: 'message',
      role: message.role,
      text: message.text,
      attachments: message.mediaReferences,
      createdAt: message.createdAt,
    })));
    attachmentState.reset();
    setActiveSessionId(sessionId);
    setActiveView('conversation');
    stickToBottomRef.current = true;
  };

  const startConversation = () => {
    if (isRunning || pendingCount > 0) return;
    clearFeed();
    setActiveView('conversation');
    setDraft('');
    attachmentState.reset();
    toolFeedIdsRef.current.clear();
    requestAnimationFrame(() => panelRef.current?.querySelector('textarea')?.focus());
  };

  const cancelCurrentTurn = () => { abortRef.current?.abort(); };

  const handleExecutionModeChange = (mode: AgentExecutionMode) => {
    if (mode === 'manual') {
      setExecutionMode('manual');
      return;
    }
    if (autoModeAcknowledged) {
      setExecutionMode('auto');
      return;
    }
    setAutoModeConfirmOpen(true);
  };

  const handleResizePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (isCompactViewport) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const currentWidth = panelRef.current?.getBoundingClientRect().width ?? livePanelWidth;
    resizeStartRef.current = { pointerX: event.clientX, width: currentWidth, currentWidth };
    setResizing(true);
  };

  const handleResizePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const start = resizeStartRef.current;
    if (!start || isCompactViewport) return;
    const maximumForViewport = Math.max(
      CANVAS_AGENT_PANEL_MIN_WIDTH,
      Math.min(CANVAS_AGENT_PANEL_MAX_WIDTH, window.innerWidth - 420),
    );
    const nextWidth = Math.max(
      CANVAS_AGENT_PANEL_MIN_WIDTH,
      Math.min(maximumForViewport, start.width + start.pointerX - event.clientX),
    );
    start.currentWidth = nextWidth;
    setLivePanelWidth(nextWidth);
  };

  const finishResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const completedWidth = resizeStartRef.current?.currentWidth;
    resizeStartRef.current = null;
    setResizing(false);
    if (completedWidth !== undefined) setPanelWidth(completedWidth);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const updatePanelWidth = (width: number) => {
    setLivePanelWidth(width);
    setPanelWidth(width);
  };

  const restorePanelWidth = () => {
    resetPanelWidth();
    setLivePanelWidth(CANVAS_AGENT_PANEL_DEFAULT_WIDTH);
  };

  const restoreDraft = (message: string) => {
    setDraft(message);
    setActiveView('conversation');
    requestAnimationFrame(() => panelRef.current?.querySelector('textarea')?.focus());
  };

  const handleLocate = (nodeIds: string[]) => {
    void canvasNavigationFacade.focusNodeIds(nodeIds, { select: true });
    if (window.matchMedia('(max-width: 1023px)').matches) setOpen(false);
  };

  const handleRollback = async (item: Extract<AgentFeedItem, { kind: 'tool' }>) => {
    if (!item.receiptId || item.rolledBackAt) return;
    const result = await rollbackAgentCanvasReceipt(item.receiptId, projectId);
    if (result.ok) {
      updateFeedItem(item.id, { rolledBackAt: Date.now() });
      pushFeed({
        id: nextAgentFeedId('rollback'),
        kind: 'status',
        status: 'completed',
        text: t('canvasAgent.rollbackSuccess'),
        createdAt: Date.now(),
      });
    } else {
      pushFeed({
        id: nextAgentFeedId('rollback-error'),
        kind: 'status',
        status: 'error',
        text: result.message,
        createdAt: Date.now(),
      });
    }
  };

  const openModelSettings = () => openSettingsDialog({ category: 'providersChat' });

  const selectedImageEntry = usableImageModels.find((entry) => entry.id === selectedImageModelId) ?? null;
  const selectedVideoEntry = usableVideoModels.find((entry) => entry.id === selectedVideoModelId) ?? null;
  const desktopDockWidth = `${livePanelWidth}px`;

  return (
    <>
      <button
        ref={launcherRef}
        type="button"
        aria-label={t('canvasAgent.open')}
        title={t('canvasAgent.open')}
        className={`absolute right-3 top-3 z-[12030] inline-flex h-11 w-11 items-center justify-center rounded-[6px] border border-border-dark bg-bg-dark/95 text-text-dark shadow-xl transition-[opacity,transform,background-color] duration-200 hover:bg-text-dark/[0.05] active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 ${
          isOpen ? 'pointer-events-none scale-95 opacity-0' : 'scale-100 opacity-100'
        }`}
        onClick={() => setOpen(true)}
        tabIndex={isOpen ? -1 : 0}
      >
        <Bot className="h-5 w-5" aria-hidden="true" />
        {pendingCount ? (
          <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-amber-400 px-1 text-[10px] font-semibold leading-4 text-black">
            {Math.min(99, pendingCount)}
          </span>
        ) : null}
      </button>

      <div
        aria-hidden="true"
        data-agent-backdrop="true"
        className={`absolute inset-0 z-[12020] bg-black/[0.35] transition-opacity duration-200 lg:hidden ${
          isOpen ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'
        }`}
        onClick={() => setOpen(false)}
      />

      <div
        data-agent-dock-slot="true"
        className={`agent-dock-slot pointer-events-none absolute inset-y-0 right-0 z-[12025] w-full sm:w-[min(100vw,420px)] lg:relative lg:inset-auto lg:z-20 lg:h-full lg:flex-none lg:overflow-hidden ${
          isOpen ? '' : 'lg:w-0'
        }`}
        style={isOpen && !isCompactViewport ? {
          width: desktopDockWidth,
          maxWidth: 'calc(100vw - 420px)',
          transitionProperty: isResizing ? 'none' : undefined,
        } : undefined}
      >
        <aside
          ref={panelRef}
          className={`agent-dock-shell pointer-events-auto absolute inset-y-0 right-0 flex w-full min-w-0 flex-col overflow-hidden border-l border-border-dark bg-bg-dark shadow-2xl lg:translate-x-0 lg:shadow-xl ${
            isOpen
              ? 'translate-x-0 opacity-100'
              : 'pointer-events-none translate-x-full opacity-0 lg:translate-x-0'
          }`}
          style={!isCompactViewport ? { width: desktopDockWidth, maxWidth: 'calc(100vw - 420px)' } : undefined}
          role={isCompactViewport ? 'dialog' : 'complementary'}
          aria-modal={isCompactViewport || undefined}
          aria-label={t('canvasAgent.panel')}
          aria-hidden={!isOpen}
        >
          {!isCompactViewport ? (
            <button
              type="button"
              className="absolute inset-y-0 left-0 z-50 w-2 -translate-x-1/2 cursor-ew-resize touch-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/70"
              aria-label={t('canvasAgent.resizePanel')}
              title={t('canvasAgent.resizePanel')}
              onPointerDown={handleResizePointerDown}
              onPointerMove={handleResizePointerMove}
              onPointerUp={finishResize}
              onPointerCancel={finishResize}
              onDoubleClick={restorePanelWidth}
              onKeyDown={(event) => {
                if (event.key === 'Home' || event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  restorePanelWidth();
                  return;
                }
                if (event.key === 'ArrowLeft') {
                  event.preventDefault();
                  updatePanelWidth(livePanelWidth + (event.shiftKey ? 40 : 10));
                } else if (event.key === 'ArrowRight') {
                  event.preventDefault();
                  updatePanelWidth(livePanelWidth - (event.shiftKey ? 40 : 10));
                }
              }}
            />
          ) : null}

          <CanvasAgentHeader
            selectedEntry={selectedEntry}
            activeView={activeView}
            taskCount={taskCount}
            isRunning={isRunning}
            isReady={runtimeReady}
            activityText={activeGenerationProgress
              ? activeGenerationProgress.phase === 'accepted'
                ? t('canvasAgent.generationSubmitted')
                : t('canvasAgent.generationPollingShort', {
                    attempt: activeGenerationProgress.attempt,
                    max: activeGenerationProgress.maxAttempts,
                  })
              : null}
            showCompletedTools={showCompletedTools}
            onToggleCompletedTools={() => setShowCompletedTools(!showCompletedTools)}
            onNewConversation={startConversation}
            onViewChange={setActiveView}
            onOpenExternalConnection={() => setExternalConnectionOpen(true)}
            onClose={() => setOpen(false)}
            closeRef={closeRef}
          />

        <CanvasAgentFeedViewport
          projectId={projectId}
          activeView={activeView}
          nodes={canvasNodes}
          displayedFeed={displayedFeed}
          sessions={sessions}
          isRunning={isRunning}
          showCompletedTools={showCompletedTools}
          pendingCount={pendingCount}
          showNewItems={showNewItems}
          scrollRef={feedScrollRef}
          onScroll={onFeedScroll}
          onStartConversation={startConversation}
          onLoadSession={loadSession}
          onApproval={(item, approve) => { void handleApproval(item, approve); }}
          onBatchApproval={(items, approve) => { void handleBatchApprovals(items, approve); }}
          onLocate={handleLocate}
          onRestoreDraft={restoreDraft}
          onDiagnose={(message) => { void executeTurn(message); }}
          onPlanChange={handlePlanChange}
          onPlanConfirm={(item) => { void handlePlanConfirm(item); }}
          onPlanCancel={handlePlanCancel}
          onRollback={(tool) => { void handleRollback(tool); }}
          onJumpToLatest={() => {
            stickToBottomRef.current = true;
            setShowNewItems(false);
            feedScrollRef.current?.scrollTo({
              top: feedScrollRef.current.scrollHeight,
              behavior: 'smooth',
            });
          }}
        />

        {activeView !== 'tasks' ? (
        <div className="relative shrink-0">
          {attachmentState.isPickerOpen ? (
            <CanvasAgentAttachmentPicker
              assets={imageAssets}
              selectedAssetIds={attachments
                .filter((attachment) => attachment.origin === 'canvas-asset')
                .map((attachment) => attachment.assetId)}
              attachmentCount={attachments.length}
              selectedNodeId={selectedNode?.id ?? null}
              maxAttachments={attachmentState.maxAttachments}
              isUploading={attachmentState.isUploading}
              error={attachmentState.error}
              onToggle={attachmentState.toggle}
              onAttachSelected={() => attachmentState.attachSelectedNode(selectedNode?.id ?? null)}
              onUpload={(files) => { void attachmentState.upload(files); }}
              onClose={attachmentState.closePicker}
            />
          ) : null}
          <CanvasAgentComposer
            textModels={modelEntries}
            imageModels={usableImageModels}
            videoModels={usableVideoModels}
            selectedTextModel={selectedEntry}
            selectedImageModelId={selectedImageEntry?.id ?? null}
            selectedVideoModelId={selectedVideoEntry?.id ?? null}
            executionMode={executionMode}
            draft={draft}
            attachments={attachments}
            maxAttachments={attachmentState.maxAttachments}
            hasMissingAttachments={hasMissingAttachments}
            isRunning={isRunning}
            hasPendingApproval={pendingCount > 0}
            hasPendingPlan={hasPendingPlan}
            contextEstimateTokens={contextEstimateTokens}
            contextWindow={selectedEntry?.contextWindow}
            onTextModelChange={setSelectedModelId}
            onImageModelChange={setSelectedImageModelId}
            onVideoModelChange={setSelectedVideoModelId}
            onExecutionModeChange={handleExecutionModeChange}
            onDraftChange={setDraft}
            onAttach={attachmentState.openPicker}
            onRemoveAttachment={attachmentState.remove}
            onSend={() => void send()}
            onCancel={() => { void cancelCurrentTurn(); }}
            onSettings={openModelSettings}
          />
        </div>
        ) : null}

        {isAutoModeConfirmOpen ? (
          <div className="absolute inset-0 z-[70] flex items-center justify-center bg-black/35 p-4" role="presentation">
            <section className="agent-view-enter w-full max-w-sm rounded-[12px] border border-[color:var(--ui-border-soft)] bg-[var(--ui-surface-panel)] p-4 shadow-[var(--ui-shadow-panel)]" role="dialog" aria-modal="true" aria-labelledby="canvas-agent-auto-title">
              <div className="flex items-start gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] bg-amber-500/10 text-amber-600 dark:text-amber-300">
                  <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                  <h2 id="canvas-agent-auto-title" className="text-sm font-semibold text-text-dark">{t('canvasAgent.autoModeConfirmTitle')}</h2>
                  <p className="mt-1.5 text-[11px] leading-5 text-text-muted">{t('canvasAgent.autoModeConfirmDescription')}</p>
                </div>
                <button type="button" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] text-text-muted hover:bg-text-dark/[0.055] hover:text-text-dark" aria-label={t('common.close')} onClick={() => setAutoModeConfirmOpen(false)}>
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <button type="button" className="min-h-10 rounded-[7px] px-3 text-xs text-text-muted hover:bg-text-dark/[0.055] hover:text-text-dark" onClick={() => setAutoModeConfirmOpen(false)}>{t('common.cancel')}</button>
                <button type="button" className="inline-flex min-h-10 items-center gap-2 rounded-[7px] bg-text-dark px-3 text-xs font-semibold text-bg-dark" onClick={() => { acknowledgeAutoMode(); setAutoModeConfirmOpen(false); }}>
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  {t('canvasAgent.enableAutoMode')}
                </button>
              </div>
            </section>
          </div>
        ) : null}
        {isExternalConnectionOpen ? (
          <div className="absolute inset-0 z-[70] flex items-center justify-center bg-black/35 p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setExternalConnectionOpen(false); }}>
            <section className="agent-view-enter flex max-h-[min(760px,calc(100vh-32px))] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-[color:var(--ui-border-soft)] bg-[var(--ui-surface-panel)] shadow-[var(--ui-shadow-panel)]" role="dialog" aria-modal="true" aria-label={t('canvasAgent.externalConnection')}>
              <header className="flex min-h-14 items-center justify-between border-b border-border-dark/70 px-4">
                <div><h2 className="text-sm font-semibold text-text-dark">{t('canvasAgent.externalConnection')}</h2><p className="mt-0.5 text-[11px] text-text-muted">{t('canvasAgent.externalConnectionDescription')}</p></div>
                <button type="button" className="flex h-10 w-10 items-center justify-center rounded-lg text-text-muted hover:bg-text-dark/[0.055] hover:text-text-dark" aria-label={t('common.close')} onClick={() => setExternalConnectionOpen(false)}><X className="h-4 w-4" /></button>
              </header>
              <div className="ui-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
                <ExternalAgentConnectionPanel projectId={projectId} projectName={currentProjectName} tools={externalConnectionTools} className="border-0 bg-transparent p-0" />
                <button type="button" className="mt-3 min-h-10 w-full rounded-lg border border-border-dark px-3 text-xs text-text-muted hover:bg-text-dark/[0.05] hover:text-text-dark" onClick={() => openSettingsDialog({ category: 'externalAgents' })}>{t('canvasAgent.openConnectionSettings')}</button>
              </div>
            </section>
          </div>
        ) : null}
        </aside>
      </div>
    </>
  );
}
