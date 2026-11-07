import { useAgentContextUsage, estimateAgentTextTokens } from '../application/agentContextUsage';
import { resolveChannelCatalogModelId } from '@/features/channels/application/channelCatalog';
import { useSettingsStore } from '@/stores/settingsStore';
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { isTauri } from '@tauri-apps/api/core';
import { Bot, ExternalLink, ShieldCheck, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTopBarActionsSlot } from '@/components/topBarSlot';
import { UiButton, UiIconButton } from '@/components/ui';
import { agentTurnLimitText, readableAgentFailure } from '@/features/agents/ui/agentFailureText';
import { useAgentTurnSelection } from '@/features/agents/ui/useAgentTurnSelection';
import { useImageModelCatalog } from '@/features/canvas/application/modelCatalog';
import { useVideoModelCatalog } from '@/features/canvas/application/videoModelCatalog';
import { summarizeModesForAgent } from '@/features/channels/application/modelModes';
import { buildCanvasAssetCatalog } from '@/features/canvas/application/canvasAssetCatalog';
import { canvasNavigationFacade } from '@/features/canvas/application/canvasNavigationFacade';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { selectCanvasContentNodes } from '@/features/canvas/application/canvasContentSelector';
import { openSettingsDialog } from '@/features/settings/settingsEvents';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { createAgentCanvasMediaInput } from '../application/agentMediaResolver';
import { mergeTurnMedia, useAgentComposerAssist } from '@/features/agents/ui/useAgentComposerAssist';
import { classifyCanvasAgentFailure } from '../application/agentFailurePolicy';
import { AgentTurnLimitError } from '../application/agentTurnSafety';
import {
  acquireCanvasAgentTurn,
  releaseCanvasAgentTurn,
  type CanvasAgentTurnGate,
} from '../application/agentTurnGate';
import { buildAgentPlanDraft, compileAgentPlanMessage, type AgentPlanDraft } from '../application/agentPlan';
import { rollbackAgentCanvasReceipt, rollbackAgentTurn } from '../application/agentCanvasRollback';
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
  CanvasAgentRuntimeId,
} from '../domain/agentModel';
import { CanvasAgentAttachmentPicker } from './CanvasAgentAttachmentPicker';
import { CanvasAgentComposer } from './CanvasAgentComposer';
import { CanvasAgentFeedViewport } from './CanvasAgentFeedViewport';
import { CanvasAgentHeader } from './CanvasAgentHeader';
import { CanvasAgentRuntimePicker } from './CanvasAgentRuntimePicker';
import { useExternalAgentRuntime } from './useExternalAgentRuntime';
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
  type AgentFeedItem,
} from './agentPanelStore';
import { useCanvasAgentAttachments } from './useCanvasAgentAttachments';
import { isCanvasAgentRunCurrent } from './agentRunOwnership';

type Props = { projectId: string };
type TurnExtras = { explicitSkillIds: string[]; media: AgentTurnMediaInput[] };

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

export function CanvasAgentDock({ projectId }: Props) {
  const { t } = useTranslation();
  const resizePanels = useSettingsStore((state) => state.workspacePreferences.resizePanels);
  const {
    isOpen,
    projectId: storedProjectId,
    activeView,
    selectedImageModelId,
    selectedVideoModelId,
    showCompletedTools,
    panelWidth,
    activeSessionId,
    feed,
    externalSessions,
    setOpen,
    setProject,
    setActiveView,
    setSelectedImageModelId,
    setSelectedVideoModelId,
    setShowCompletedTools,
    setPanelWidth,
    resetPanelWidth,
    setActiveSessionId,
    addFeedItem,
    updateFeedItem,
    clearFeed,
    replaceFeed,
  } = useCanvasAgentPanelStore();
  const imageCatalog = useImageModelCatalog();
  const videoCatalog = useVideoModelCatalog();
  const visibleFeed = storedProjectId === projectId
    ? feed.filter((item) => !isLegacyInferredAgentFailure(item))
    : [];
  const projectSessionId = storedProjectId === projectId ? activeSessionId : null;
  const [isRunning, setRunning] = useState(false);
  /** Explicit pick for this turn > saved conversation > global defaults; never the first catalog entry. */
  const selection = useAgentTurnSelection(projectSessionId, String(isRunning));
  const selectedEntry = selection.model;
  const executionMode = selection.executionMode;
  const externalSupported = isTauri();
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
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const assist = useAgentComposerAssist({ scope: 'canvas', projectId, text: draft, setText: setDraft, textareaRef: composerTextareaRef });
  /** Skills and resolved `@` media chosen for the message that a manual-mode plan will execute later. */
  const pendingTurnExtrasRef = useRef<TurnExtras | null>(null);
  const attachmentPickerRef = useRef({ open: false, close: () => {} });
  attachmentPickerRef.current = {
    open: attachmentState.isPickerOpen,
    close: attachmentState.closePicker,
  };
  const { attachments, imageAssets, hasMissingAttachments } = attachmentState;
  const [selectedRuntimeId, setSelectedRuntimeId] = useState<CanvasAgentRuntimeId>('builtin');
  const preparingMessageRef = useRef(false);
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
  const visibleProjectIdRef = useRef(projectId);
  const previousProjectIdRef = useRef(projectId);
  const runEpochRef = useRef(0);
  visibleProjectIdRef.current = projectId;
  const launcherRef = useRef<HTMLButtonElement | null>(null);
  // The launcher sits in the app top bar (one bar for the window), portaled into its actions slot.
  const topBarSlot = useTopBarActionsSlot();
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
  const externalPlanIdRef = useRef<string | null>(null);
  const externalPlanTextRef = useRef('');
  const toolFeedIdsRef = useRef(new Map<string, string>());
  const activeStatusIdRef = useRef<string | null>(null);

  const selectedNodeId = useCanvasStore((canvas) => canvas.selectedNodeId);
  // A closed dock has no live geometry to paint; metadata/tasks still update immediately.
  const canvasNodes = useCanvasStore((canvas) => isOpen ? canvas.nodes : selectCanvasContentNodes(canvas.nodes));
  const currentProjectName = useProjectStore((state) => (
    state.currentProjectId === projectId ? state.currentProject?.name ?? null : null
  ));
  const externalConnectionTools = useMemo(() => buildExternalCanvasMcpManifest([
    'canvas', 'diagnostics', 'config', 'asset-read',
  ]).tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
    requiresApproval: true,
  })), []);
  const taskCount = useMemo(() => canvasNodes.filter((node) => {
    const data = node.data as Record<string, unknown>;
    return data.isGenerating === true;
  }).length, [canvasNodes]);
  const contextUsage = useAgentContextUsage(projectSessionId);
  const contextEstimateTokens = contextUsage?.modelId === selectedEntry?.id ? contextUsage?.usedTokens ?? 0 : 0;


  const attachNodesRef = useRef(attachmentState.attachNodes);
  attachNodesRef.current = attachmentState.attachNodes;
  useEffect(() => canvasEventBus.subscribe('agent/attach-nodes', ({ nodeIds }) => {
    setOpen(true);
    setActiveView('conversation');
    attachNodesRef.current(nodeIds);
  }), [setActiveView, setOpen]);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 1023px)');
    const updateViewportMode = () => setCompactViewport(mediaQuery.matches);
    updateViewportMode();
    mediaQuery.addEventListener('change', updateViewportMode);
    return () => mediaQuery.removeEventListener('change', updateViewportMode);
  }, []);

  useEffect(() => {
    if (previousProjectIdRef.current !== projectId) {
      previousProjectIdRef.current = projectId;
      runEpochRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
      releaseCanvasAgentTurn(executionGateRef.current);
      setRunning(false);
      setAutoModeConfirmOpen(false);
      setExternalConnectionOpen(false);
      streamMessageIdRef.current = null;
      streamReasoningIdRef.current = null;
      activeStatusIdRef.current = null;
      toolFeedIdsRef.current.clear();
    }
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

  useEffect(() => () => {
    runEpochRef.current += 1;
    abortRef.current?.abort();
  }, []);

  useEffect(() => {
    if (!isResizing) setLivePanelWidth(panelWidth);
  }, [isResizing, panelWidth]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    (panel as HTMLElement & { inert?: boolean }).inert = !isOpen;
    if (!isOpen) return;

    const focusTarget = isAutoModeConfirmOpen || isExternalConnectionOpen
      ? panel.querySelector<HTMLElement>('[role="dialog"] button')
      : isCompactViewport
        ? closeRef.current
        : panel.querySelector<HTMLElement>('textarea, input') ?? closeRef.current;
    focusTarget?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (isExternalConnectionOpen) {
          setExternalConnectionOpen(false);
          return;
        }
        if (isAutoModeConfirmOpen) {
          setAutoModeConfirmOpen(false);
          return;
        }
        if (attachmentPickerRef.current.open) {
          attachmentPickerRef.current.close();
          return;
        }
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
  }, [isAutoModeConfirmOpen, isCompactViewport, isExternalConnectionOpen, isOpen, setOpen]);

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

  const isCurrentRun = (ownerEpoch: number) => isCanvasAgentRunCurrent({
    ownerProjectId: projectId,
    visibleProjectId: visibleProjectIdRef.current,
    storedProjectId: useCanvasAgentPanelStore.getState().projectId,
    ownerEpoch,
    currentEpoch: runEpochRef.current,
  });

  const pushFeed = (item: AgentFeedItem) => {
    if (visibleProjectIdRef.current !== projectId || useCanvasAgentPanelStore.getState().projectId !== projectId) return;
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
    externalPlanIdRef.current = null;
    externalPlanTextRef.current = '';
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

  const externalRuntime = useExternalAgentRuntime({
    enabled: isOpen || isRunning || pendingCount > 0,
    projectId,
    selectedRuntimeId,
    selectedSession: selectedRuntimeId === 'builtin' ? null : externalSessions[projectId]?.[selectedRuntimeId] ?? null,
    attachments,
    projectContext: { brief: currentProjectName ? `Project: ${currentProjectName}` : '', pinnedNodeIds: [], updatedAt: 0 },
    isRunning,
    pendingCount,
    setRunning,
    resetAttachments: attachmentState.reset,
    pushFeed,
    updateFeedItem,
    updateStreamingMessage,
    updateStreamingReasoning,
    updateStreamingPlan: delta => {
      externalPlanTextRef.current += delta;
      if (externalPlanIdRef.current) updateFeedItem(externalPlanIdRef.current, { detail: externalPlanTextRef.current });
      else {
        externalPlanIdRef.current = nextAgentFeedId('external-plan');
        pushFeed({ id: externalPlanIdRef.current, kind: 'reasoning', summary: t('canvasAgent.runtime.plan'), detail: externalPlanTextRef.current, createdAt: Date.now() });
      }
    },
    resetStreaming: () => {
      streamTextRef.current = ''; streamReasoningRef.current = '';
      streamMessageIdRef.current = null; streamReasoningIdRef.current = null;
      externalPlanTextRef.current = ''; externalPlanIdRef.current = null;
    },
    finishStreaming,
    handleToolEvent,
  });
  const runtimeReady = selectedRuntimeId === 'builtin' ? Boolean(selectedEntry)
    : externalRuntime.isListening && externalRuntime.diagnostics[selectedRuntimeId]?.availability === 'ready';
  const externalRuntimeLabel = selectedRuntimeId === 'builtin' ? undefined : t(`canvasAgent.runtime.${selectedRuntimeId}`);

  const addResult = (result: Awaited<ReturnType<typeof runCanvasAgentTurn>>) => {
    if (visibleProjectIdRef.current !== projectId || useCanvasAgentPanelStore.getState().projectId !== projectId) return;
    setActiveSessionId(result.sessionId);
    // A resumed approval returns to the same run. Its first status row must
    // stop saying "waiting for confirmation" after the last tool completes.
    useCanvasAgentPanelStore.getState().feed.forEach((item) => {
      if (item.kind === 'status' && item.runId === result.runId && !item.withdrawnAt) {
        updateFeedItem(item.id, { status: 'completed', text: result.status === 'awaiting-approval'
          ? t('canvasAgent.awaitingApproval') : t('canvasAgent.completed') });
      }
    });
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

  /**
   * Turn safety stopped the run (24 tool calls / 10-minute deadline). It can fire while approvals
   * wait after the call returned: expire those cards and say why. An in-flight call reports the
   * same error through its own catch, so only post a status when nothing is in flight.
   */
  const handleTurnStopped = (error: AgentTurnLimitError) => {
    useCanvasAgentPanelStore.getState().feed.forEach((item) => {
      if (item.kind === 'approval' && !item.runtimeId && ['pending', 'approving', 'rejecting'].includes(item.status)) {
        updateFeedItem(item.id, { status: 'expired' });
      }
    });
    if (abortRef.current) return;
    pushFeed({ id: nextAgentFeedId('turn-stopped'), kind: 'status', status: 'error', text: agentTurnLimitText(error, t), createdAt: Date.now() });
    finishStreaming();
  };

  const executeTurn = async (message: string, extras?: TurnExtras) => {
    if (selectedRuntimeId !== 'builtin') {
      if (!runtimeReady || isRunning || pendingCount > 0) return;
      const skillIds = await externalRuntime.executeTurn(message, selectedRuntimeId, extras ?? { explicitSkillIds: [], media: [] });
      if (skillIds) assist.markSent(skillIds);
      return;
    }
    if (!message.trim() || !selectedEntry || isRunning || pendingCount > 0) return;
    if (!acquireCanvasAgentTurn(executionGateRef.current)) return;
    const runEpoch = ++runEpochRef.current;
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
    const controller = new AbortController();
    abortRef.current = controller;
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
      const media = mergeTurnMedia(attachments.map((attachment) => {
        if (attachment.origin === 'upload') return attachment;
        const asset = currentAssets.get(attachment.assetId);
        if (!asset) throw new Error(t('canvasAgent.missingAttachmentBeforeSend'));
        return createAgentCanvasMediaInput(asset);
      }), extras?.media ?? []);
      if (media.length && !selectedEntry.supportsMultimodal) {
        throw new Error(t('canvasAgent.switchToVisionModelHint'));
      }
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
              modes: summarizeModesForAgent(selectedImageEntry.modes),
            },
          } : {}),
          ...(selectedVideoEntry ? {
            video: {
              modelId: selectedVideoEntry.id,
              supportedRatios: selectedVideoEntry.supportedAspectRatios,
              supportedResolutions: selectedVideoEntry.supportedResolutions,
              supportedDurations: selectedVideoEntry.supportedDurations,
              modes: summarizeModesForAgent(selectedVideoEntry.modes),
            },
          } : {}),
        },
        message,
        scope: 'canvas',
        ...(extras?.explicitSkillIds.length ? { explicitSkillIds: extras.explicitSkillIds } : {}),
        media: media.length ? media : undefined,
        signal: controller.signal,
        onRunStarted: ({ sessionId }) => { if (isCurrentRun(runEpoch)) setActiveSessionId(sessionId); },
        onRetry: (notice) => { if (isCurrentRun(runEpoch)) updateFeedItem(statusId, { text: t('ui.agent.retrying', { attempt: notice.attempt, total: notice.maxRetries }) }); },
        onTextDelta: (delta) => { if (isCurrentRun(runEpoch)) updateStreamingMessage(delta); },
        onReasoningDelta: (delta) => { if (isCurrentRun(runEpoch)) updateStreamingReasoning(delta); },
        onToolEvent: (event) => { if (isCurrentRun(runEpoch)) handleToolEvent(event); },
        onTurnStopped: handleTurnStopped,
      });
      if (!isCurrentRun(runEpoch)) return;
      assist.markSent(result.skillSelection.skillIds);
      attachmentState.reset();
      updateFeedItem(statusId, {
        status: 'completed',
        runId: result.runId,
        text: result.status === 'awaiting-approval'
          ? t('canvasAgent.awaitingApproval')
          : t('canvasAgent.completed'),
      });
      addResult(result);
    } catch (error) {
      if (!isCurrentRun(runEpoch)) return;
      const aborted = error instanceof DOMException && error.name === 'AbortError';
      const failure = classifyCanvasAgentFailure(error);
      const readableError = readableAgentFailure(error, t);
      updateFeedItem(statusId, {
        status: aborted ? 'cancelled' : 'error',
        text: aborted
          ? t('canvasAgent.cancelled')
          : readableError,
        retryMessage: aborted ? undefined : message,
        errorDetail: aborted ? undefined : failure.rawMessage,
        diagnosticMessage: aborted || !failure.canSelfDiagnose ? undefined : diagnosticPrompt(
          readableError,
          message,
        ),
      });
      finishStreaming();
    } finally {
      if (isCurrentRun(runEpoch)) {
        activeStatusIdRef.current = null;
        releaseCanvasAgentTurn(executionGateRef.current);
        setRunning(false);
        if (abortRef.current === controller) abortRef.current = null;
      }
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
    if (!message || !runtimeReady || isRunning || pendingCount > 0 || hasPendingPlan || preparingMessageRef.current) return;
    if (selectedRuntimeId === 'builtin' && attachments.length && !selectedEntry?.supportsMultimodal) {
      attachmentState.setError(t('canvasAgent.switchToVisionModelHint'));
      return;
    }
    if (hasMissingAttachments) {
      attachmentState.setError(t('canvasAgent.missingAttachmentBeforeSend'));
      return;
    }
    preparingMessageRef.current = true;
    const ownerEpoch = runEpochRef.current;
    try {
      let extras: TurnExtras;
      let turnMessage: string;
      try {
        const prepared = await assist.prepare(message);
        extras = { explicitSkillIds: assist.explicitSkillIds, media: prepared.media };
        turnMessage = prepared.message;
      } catch (error) {
        attachmentState.setError(error instanceof Error ? error.message : String(error));
        return;
      }
      if (!isCurrentRun(ownerEpoch)) return;
      setActiveView('conversation');
      setDraft('');
      assist.reset();
      attachmentState.setError(null);
      stickToBottomRef.current = true;
      toolFeedIdsRef.current.clear();
      pushFeed({
        id: nextAgentFeedId('user'), kind: 'message', role: 'user', text: message,
        attachments: mergeTurnMedia(attachments, extras.media).map(attachment => projectPendingAttachment(attachment)),
        createdAt: Date.now(),
      });
      const plan = selectedRuntimeId === 'builtin' && executionMode === 'manual' ? buildAgentPlanDraft(turnMessage) : null;
      if (plan) {
        pendingTurnExtrasRef.current = extras;
        pushFeed({ id: nextAgentFeedId('plan'), kind: 'plan', plan, createdAt: Date.now() });
        return;
      }
      await executeTurn(turnMessage, extras);
    } finally {
      preparingMessageRef.current = false;
    }
  };

  const handlePlanChange = (
    item: Extract<AgentFeedItem, { kind: 'plan' }>,
    plan: AgentPlanDraft,
  ) => updateFeedItem(item.id, { plan });

  const handlePlanConfirm = async (item: Extract<AgentFeedItem, { kind: 'plan' }>) => {
    if (item.plan.status !== 'pending' || isRunning || pendingCount > 0) return;
    const approved = { ...item.plan, status: 'approved' as const };
    updateFeedItem(item.id, { plan: approved });
    const extras = pendingTurnExtrasRef.current ?? undefined;
    pendingTurnExtrasRef.current = null;
    await executeTurn(compileAgentPlanMessage(approved), extras);
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
    if (item.runtimeId) return externalRuntime.resolveApproval(item, approve);
    if (item.status !== 'pending') return false;
    if (!selectedEntry) {
      pushFeed({ id: nextAgentFeedId('approval-model'), kind: 'status', status: 'error', text: t('rework.agent.selection.approvalNeedsModel'), createdAt: Date.now() });
      return false;
    }
    updateFeedItem(item.id, { status: approve ? 'approving' : 'rejecting' });
    const runStatus = useCanvasAgentPanelStore.getState().feed.find((candidate) => candidate.kind === 'status' && candidate.runId === item.runId && !candidate.withdrawnAt);
    if (runStatus) {
      activeStatusIdRef.current = runStatus.id;
      updateFeedItem(runStatus.id, { status: 'running', text: t('canvasAgent.thinking') });
    }
    const runEpoch = manageRunningState ? ++runEpochRef.current : runEpochRef.current;
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
        onRetry: (notice) => { if (isCurrentRun(runEpoch) && runStatus) updateFeedItem(runStatus.id, { text: t('ui.agent.retrying', { attempt: notice.attempt, total: notice.maxRetries }) }); },
        onToolEvent: (event) => { if (isCurrentRun(runEpoch)) handleToolEvent(event); },
        onTextDelta: (delta) => { if (isCurrentRun(runEpoch)) updateStreamingMessage(delta); },
        onReasoningDelta: (delta) => { if (isCurrentRun(runEpoch)) updateStreamingReasoning(delta); },
        onTurnStopped: handleTurnStopped,
      });
      if (!isCurrentRun(runEpoch)) return false;
      updateFeedItem(item.id, { status: approve ? 'approved' : 'rejected' });
      addResult(result);
      return true;
    } catch (error) {
      if (!isCurrentRun(runEpoch)) return false;
      const aborted = error instanceof DOMException && error.name === 'AbortError';
      const message = error instanceof Error ? error.message : String(error);
      const failure = classifyCanvasAgentFailure(error);
      const readableError = readableAgentFailure(error, t);
      const terminal = /\u5931\u6548|\u5df2\u5904\u7406|expired|conflict|\u4e0d\u4e00\u81f4|\u9879\u76ee\u5df2\u5207\u6362/i.test(message);
      updateFeedItem(item.id, { status: aborted ? 'pending' : terminal ? 'expired' : 'failed' });
      const failureStatus: Omit<Extract<AgentFeedItem, { kind: 'status' }>, 'id'> = {
        kind: 'status',
        status: aborted ? 'cancelled' : 'error',
        text: aborted
          ? t('canvasAgent.cancelled')
          : readableError,
        retryMessage: aborted ? undefined : item.summary,
        errorDetail: aborted ? undefined : failure.rawMessage,
        diagnosticMessage: aborted || !failure.canSelfDiagnose ? undefined : diagnosticPrompt(readableError, item.summary),
        createdAt: Date.now(),
      };
      if (runStatus) updateFeedItem(runStatus.id, failureStatus);
      else pushFeed({ id: nextAgentFeedId('approval-error'), ...failureStatus });
      finishStreaming();
      return false;
    } finally {
      if (manageRunningState && isCurrentRun(runEpoch)) {
        activeStatusIdRef.current = null;
        setRunning(false);
        if (abortRef.current === controller) abortRef.current = null;
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
    if (isRunning || !items.length) return;
    if (items.every(item => item.runtimeId)) {
      for (const item of items) {
        const latest = useCanvasAgentPanelStore.getState().feed.find(candidate => candidate.id === item.id);
        if (latest?.kind === 'approval' && latest.status === 'pending') await externalRuntime.resolveApproval(latest, approve);
      }
      return;
    }
    if (!selectedEntry) {
      pushFeed({ id: nextAgentFeedId('approval-model'), kind: 'status', status: 'error', text: t('rework.agent.selection.approvalNeedsModel'), createdAt: Date.now() });
      return;
    }
    const runEpoch = ++runEpochRef.current;
    setRunning(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      for (const item of items) {
        if (!isCurrentRun(runEpoch) || controller.signal.aborted) break;
        const latest = useCanvasAgentPanelStore.getState().feed.find((candidate) => candidate.id === item.id);
        if (latest?.kind !== 'approval' || latest.status !== 'pending') continue;
        await resolveApprovalItem(latest, approve, false);
      }
    } finally {
      if (isCurrentRun(runEpoch)) {
        activeStatusIdRef.current = null;
        setRunning(false);
        if (abortRef.current === controller) abortRef.current = null;
      }
    }
  };

  const loadSession = (sessionId: string) => {
    if (isRunning || executionGateRef.current.active || pendingCount > 0 || hasPendingPlan) return;
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
    if (isRunning || executionGateRef.current.active || pendingCount > 0 || hasPendingPlan || preparingMessageRef.current) return;
    externalRuntime.discardCurrentSession();
    setActiveSessionId(null);
    pendingTurnExtrasRef.current = null;
    assist.reset();
    clearFeed();
    setActiveView('conversation');
    setDraft('');
    attachmentState.reset();
    toolFeedIdsRef.current.clear();
    requestAnimationFrame(() => panelRef.current?.querySelector('textarea')?.focus());
  };

  const cancelCurrentTurn = () => {
    if (selectedRuntimeId === 'builtin') abortRef.current?.abort();
    else void externalRuntime.cancelTurn();
  };

  /** Switching to auto from the composer asks once per switch; saved or global auto is the user's prior choice. */
  const handleExecutionModeChange = (mode: typeof executionMode) => {
    if (mode === 'full' && executionMode !== 'full') {
      setAutoModeConfirmOpen(true);
      return;
    }
    selection.selectMode(mode);
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
    if (visibleProjectIdRef.current !== projectId || useCanvasAgentPanelStore.getState().projectId !== projectId) return;
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

  /**
   * 06 §6 turn withdrawal: one action restores every graph change of this run. Refused while the run is
   * live (more tool calls could follow) or when later manual edits exist; submitted paid jobs are kept.
   */
  const handleWithdrawTurn = (item: Extract<AgentFeedItem, { kind: 'status' }>) => {
    if (!item.runId || item.withdrawnAt) return;
    const live = isRunning || useCanvasAgentPanelStore.getState().feed.some((entry) => (
      entry.kind === 'approval' && entry.runId === item.runId && ['pending', 'approving', 'rejecting'].includes(entry.status)
    ));
    const result = live ? null : rollbackAgentTurn({ projectId, runId: item.runId });
    if (result?.ok) updateFeedItem(item.id, { withdrawnAt: Date.now() });
    pushFeed({
      id: nextAgentFeedId('withdraw'),
      kind: 'status',
      status: result?.ok ? 'completed' : 'error',
      text: !result
        ? t('canvasAgent.withdrawTurnLive')
        : result.ok
          ? t('canvasAgent.withdrawTurnSuccess', { count: result.undone })
          : t(`canvasAgent.withdrawTurnRefused.${result.reason}`),
      createdAt: Date.now(),
    });
  };

  const openModelSettings = () => openSettingsDialog({ category: 'providersChat' });

  const selectedImageEntry = usableImageModels.find((entry) => entry.id === resolveChannelCatalogModelId(selectedImageModelId ?? '')) ?? null;
  const selectedVideoEntry = usableVideoModels.find((entry) => entry.id === resolveChannelCatalogModelId(selectedVideoModelId ?? '')) ?? null;
  const desktopDockWidth = `${livePanelWidth}px`;

  const launcher = (
    <button
      ref={launcherRef}
      type="button"
      aria-label={t('canvasAgent.open')}
      aria-pressed={isOpen}
      title={t('canvasAgent.open')}
      className="canvas-agent-launcher inline-flex items-center justify-center"
      onClick={() => setOpen(!isOpen)}
    >
      <Bot aria-hidden="true" />
      <span>{t('rework.agent.home')}</span>
      {pendingCount ? (
        <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-warning/15 px-1 text-[10px] font-semibold leading-4 text-warning">
          {Math.min(99, pendingCount)}
        </span>
      ) : null}
    </button>
  );

  return (
    <>
      {topBarSlot ? createPortal(launcher, topBarSlot) : null}

      <div
        aria-hidden="true"
        data-agent-backdrop="true"
        className={`absolute inset-0 z-12020 bg-[var(--scrim)] transition-opacity duration-200 lg:hidden ${
          isOpen ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'
        }`}
        onClick={() => setOpen(false)}
      />

      <div
        data-agent-dock-slot="true"
        className={`agent-dock-slot pointer-events-none absolute inset-y-0 right-0 z-12025 w-full sm:w-[min(100vw,420px)] lg:relative lg:inset-auto lg:z-20 lg:h-full lg:flex-none lg:overflow-hidden ${
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
          className={`agent-dock-shell pointer-events-auto absolute inset-y-0 right-0 flex w-full min-w-0 flex-col overflow-hidden border-l border-[var(--line)] bg-surface shadow-[var(--shadow-float)] lg:translate-x-0 ${
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
          {!isCompactViewport && resizePanels ? (
            <button
              type="button"
              className="absolute inset-y-0 left-0 z-50 w-2 -translate-x-1/2 cursor-ew-resize touch-none transition-colors hover:bg-accent/10 active:bg-accent/20 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/70"
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
            modelIssue={selectedRuntimeId === 'builtin' ? selection.modelIssue : null}
            requestedModelLabel={selection.requestedModel?.modelLabel}
            runtimeLabel={externalRuntimeLabel}
            historyEnabled={selectedRuntimeId === 'builtin'}
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
          <CanvasAgentRuntimePicker value={selectedRuntimeId} externalSupported={externalSupported} diagnostics={externalRuntime.diagnostics} isRefreshing={externalRuntime.isRefreshing}
            disabled={isRunning || pendingCount > 0 || hasPendingPlan}
            onRefresh={() => void externalRuntime.refresh()}
            onChange={runtime => {
              if (isRunning || pendingCount > 0 || hasPendingPlan || preparingMessageRef.current || runtime === selectedRuntimeId) return;
              setSelectedRuntimeId(runtime);
              setActiveView('conversation');
              pushFeed({ id: nextAgentFeedId('runtime'), kind: 'status', status: 'completed', text: t('canvasAgent.runtime.changed', { runtime: t(`canvasAgent.runtime.${runtime}`) }), createdAt: Date.now() });
            }} />
          {selectedRuntimeId !== 'builtin' && externalRuntime.eventError && <p role="alert" className="shrink-0 px-3 py-2 text-[11px] text-danger">{t('canvasAgent.runtime.eventError', { error: externalRuntime.eventError })}</p>}

        <CanvasAgentFeedViewport
          projectId={projectId}
          activeView={activeView}
          nodes={canvasNodes}
          displayedFeed={displayedFeed}
          sessions={sessions}
          isRunning={isRunning}
          showCompletedTools={showCompletedTools}
          pendingCount={pendingCount}
          hasPendingPlan={hasPendingPlan}
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
          onWithdrawTurn={handleWithdrawTurn}
          onJumpToLatest={() => {
            stickToBottomRef.current = true;
            setShowNewItems(false);
            feedScrollRef.current?.scrollTo({
              top: feedScrollRef.current.scrollHeight,
              behavior: 'smooth',
            });
          }}
        />

        {activeView === 'conversation' ? (
        <div className="relative shrink-0">
          {attachmentState.isPickerOpen ? (
            <CanvasAgentAttachmentPicker
              assets={imageAssets}
              selectedAssetIds={attachments
                .filter((attachment) => attachment.origin === 'canvas-asset')
                .map((attachment) => attachment.assetId)}
              attachmentCount={attachments.length}
              selectedNodeId={selectedNodeId}
              maxAttachments={attachmentState.maxAttachments}
              isUploading={attachmentState.isUploading}
              error={attachmentState.error}
              onToggle={attachmentState.toggle}
              onAttachSelected={() => attachmentState.attachSelectedNode(selectedNodeId)}
              onUpload={(files) => { void attachmentState.upload(files); }}
              onClose={attachmentState.closePicker}
            />
          ) : null}
          <CanvasAgentComposer
            textModels={selection.models}
            imageModels={usableImageModels}
            videoModels={usableVideoModels}
            selectedTextModel={selectedEntry}
            requestedTextModel={selection.requestedModel}
            modelIssue={selection.modelIssue}
            modelSource={selection.modelSource}
            externalRuntime={externalRuntimeLabel ? { label: externalRuntimeLabel, ready: runtimeReady } : undefined}
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
            contextUsage={contextUsage}
            contextDraftTokens={estimateAgentTextTokens(draft) + attachments.length * 1000}
            contextWindow={selectedEntry?.contextWindow}
            onTextModelChange={selection.selectModel}
            onImageModelChange={setSelectedImageModelId}
            onVideoModelChange={setSelectedVideoModelId}
            onExecutionModeChange={handleExecutionModeChange}
            onDraftChange={setDraft}
            onAttach={attachmentState.openPicker}
            onAttachFiles={attachmentState.upload}
            onRemoveAttachment={attachmentState.remove}
            onSend={() => void send()}
            onCancel={() => { void cancelCurrentTurn(); }}
            onSettings={openModelSettings}
            assist={assist}
            textareaRef={composerTextareaRef}
          />
        </div>
        ) : null}

        {isAutoModeConfirmOpen ? (
          <div className="absolute inset-0 z-70 flex items-center justify-center bg-[var(--scrim)] p-4" role="presentation">
            <section className="agent-view-enter w-full max-w-sm rounded-[12px] border border-(--ui-border-soft) bg-(--ui-surface-panel) p-4 shadow-(--ui-shadow-panel)" role="dialog" aria-modal="true" aria-labelledby="canvas-agent-auto-title">
              <div className="flex items-start gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] bg-warning/10 text-warning">
                  <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                  <h2 id="canvas-agent-auto-title" className="text-sm font-semibold text-text-dark">{t('canvasAgent.autoModeConfirmTitle')}</h2>
                  <p className="mt-1.5 text-[11px] leading-5 text-text-muted">{t('canvasAgent.autoModeConfirmDescription')}</p>
                </div>
                <UiIconButton aria-label={t('common.close')} onClick={() => setAutoModeConfirmOpen(false)}>
                  <X className="h-4 w-4" />
                </UiIconButton>
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <UiButton variant="ghost" className="min-h-10 text-xs" onClick={() => setAutoModeConfirmOpen(false)}>{t('common.cancel')}</UiButton>
                <UiButton variant="primary" className="min-h-10 gap-2 text-xs" onClick={() => { selection.selectMode('full'); setAutoModeConfirmOpen(false); }}>
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  {t('canvasAgent.fullModeEnable')}
                </UiButton>
              </div>
            </section>
          </div>
        ) : null}
        {isExternalConnectionOpen ? (
          <div className="absolute inset-0 z-70 flex items-center justify-center bg-[var(--scrim)] p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setExternalConnectionOpen(false); }}>
            <section className="agent-view-enter flex max-h-[min(760px,calc(100vh-32px))] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-(--ui-border-soft) bg-(--ui-surface-panel) shadow-(--ui-shadow-panel)" role="dialog" aria-modal="true" aria-label={t('canvasAgent.externalConnection')}>
              <header className="flex min-h-14 items-center justify-between border-b border-[var(--line)] px-4">
                <div><h2 className="text-sm font-semibold text-text-dark">{t('canvasAgent.externalConnection')}</h2><p className="mt-0.5 text-[11px] text-text-muted">{t('canvasAgent.externalConnectionDescription')}</p></div>
                <UiIconButton size="lg" aria-label={t('common.close')} onClick={() => setExternalConnectionOpen(false)}><X className="h-4 w-4" /></UiIconButton>
              </header>
              <div className="ui-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
                <ExternalAgentConnectionPanel projectId={projectId} projectName={currentProjectName} tools={externalConnectionTools} className="border-0 bg-transparent p-0" />
                <UiButton variant="secondary" className="mt-3 min-h-10 w-full text-xs" onClick={() => openSettingsDialog({ category: 'externalAgents' })}>{t('canvasAgent.openConnectionSettings')}</UiButton>
              </div>
            </section>
          </div>
        ) : null}
        </aside>
      </div>
    </>
  );
}
