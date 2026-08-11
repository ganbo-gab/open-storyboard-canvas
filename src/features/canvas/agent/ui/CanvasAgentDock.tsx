import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useChatModelCatalog } from '@/features/canvas/application/chatModelCatalog';
import { buildCanvasAssetCatalog } from '@/features/canvas/application/canvasAssetCatalog';
import { prepareNodeImageFromFile } from '@/features/canvas/application/imageData';
import { canvasNavigationFacade } from '@/features/canvas/application/canvasNavigationFacade';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { openSettingsDialog } from '@/features/settings/settingsEvents';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import {
  createAgentCanvasMediaInput,
  MAX_AGENT_MEDIA_ATTACHMENTS,
  validateAgentImageFile,
} from '../application/agentMediaResolver';
import { buildAgentPlanDraft, compileAgentPlanMessage, type AgentPlanDraft } from '../application/agentPlan';
import { canvasAgentBudgetLedger } from '../application/agentBudget';
import { rollbackAgentCanvasReceipt } from '../application/agentCanvasRollback';
import {
  getCanvasAgentSessionMessages,
  listPendingCanvasAgentApprovals,
  listCanvasAgentSessions,
  resolveCanvasAgentApproval,
  runCanvasAgentTurn,
} from '../application/canvasAgentController';
import type { CanvasAgentToolEvent } from '../infrastructure/sdkRuntime';
import type { AgentSessionMediaReferenceView, AgentTurnMediaInput } from '../domain/agentModel';
import { AgentFeedCard } from './AgentFeedCard';
import { CanvasAgentAttachmentPicker } from './CanvasAgentAttachmentPicker';
import { CanvasAgentComposer } from './CanvasAgentComposer';
import { CanvasAgentContextPanel } from './CanvasAgentContextPanel';
import { CanvasAgentHeader } from './CanvasAgentHeader';
import { nextAgentFeedId, useCanvasAgentPanelStore, type AgentFeedItem } from './agentPanelStore';

type Props = { projectId: string };

function nodeIdsFromOutput(output: unknown): string[] {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return [];
  const record = output as Record<string, unknown>;
  const nested = record.output && typeof record.output === 'object' && !Array.isArray(record.output)
    ? record.output as Record<string, unknown>
    : record;
  const refs = nested.references && typeof nested.references === 'object' && !Array.isArray(nested.references)
    ? nested.references as Record<string, unknown>
    : undefined;
  if (!refs) return [];
  const ids = [
    ...(Array.isArray(refs.nodeIds) ? refs.nodeIds : []),
    ...(typeof refs.nodeId === 'string' ? [refs.nodeId] : []),
  ];
  return Array.from(new Set(ids.filter(
    (id): id is string => typeof id === 'string' && id.trim().length > 0,
  )));
}

function executionReceiptFromOutput(output: unknown): { receiptId?: string; rollbackToken?: string } {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return {};
  const record = output as Record<string, unknown>;
  const execution = record.execution && typeof record.execution === 'object' && !Array.isArray(record.execution)
    ? record.execution as Record<string, unknown>
    : undefined;
  return {
    receiptId: typeof execution?.receiptId === 'string' ? execution.receiptId : undefined,
    rollbackToken: typeof record.rollbackToken === 'string' ? record.rollbackToken : undefined,
  };
}

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
  const {
    isOpen,
    projectId: storedProjectId,
    activeView,
    selectedModelId,
    activeSessionId,
    feed,
    projectContexts,
    setOpen,
    setProject,
    setActiveView,
    setSelectedModelId,
    setActiveSessionId,
    addFeedItem,
    updateFeedItem,
    clearFeed,
    replaceFeed,
    setProjectBrief,
    togglePinnedNode,
    clearProjectContext,
  } = useCanvasAgentPanelStore();
  const catalog = useChatModelCatalog();
  const modelEntries = useMemo(
    () => catalog.filter((entry) => entry.usable && entry.supportsTools),
    [catalog],
  );
  const selectedEntry = modelEntries.find((entry) => entry.id === selectedModelId)
    ?? modelEntries[0]
    ?? null;
  const visibleFeed = storedProjectId === projectId ? feed : [];
  const projectSessionId = storedProjectId === projectId ? activeSessionId : null;
  const projectContext = projectContexts[projectId] ?? { brief: '', pinnedNodeIds: [], updatedAt: 0 };
  const displayedFeed = useMemo(
    () => activeView === 'activity'
      ? visibleFeed.filter((item) => item.kind !== 'message')
      : visibleFeed,
    [activeView, visibleFeed],
  );
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

  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<AgentTurnMediaInput[]>([]);
  const [attachmentPickerOpen, setAttachmentPickerOpen] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [isUploadingAttachment, setUploadingAttachment] = useState(false);
  const [isRunning, setRunning] = useState(false);
  const [showNewItems, setShowNewItems] = useState(false);
  const [budgetVersion, setBudgetVersion] = useState(0);
  const [isCompactViewport, setCompactViewport] = useState(() => (
    typeof window !== 'undefined' && window.matchMedia('(max-width: 1023px)').matches
  ));
  const abortRef = useRef<AbortController | null>(null);
  const launcherRef = useRef<HTMLButtonElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const feedScrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const scrollFrameRef = useRef<number | null>(null);
  const streamTextRef = useRef('');
  const streamReasoningRef = useRef('');
  const streamMessageIdRef = useRef<string | null>(null);
  const streamReasoningIdRef = useRef<string | null>(null);
  const toolFeedIdsRef = useRef(new Map<string, string>());

  const selectedNode = useCanvasStore((canvas) => (
    canvas.selectedNodeId
      ? canvas.nodes.find((node) => node.id === canvas.selectedNodeId) ?? null
      : null
  ));
  const canvasNodes = useCanvasStore((canvas) => canvas.nodes);
  const imageAssets = useMemo(
    () => buildCanvasAssetCatalog(canvasNodes).filter((asset) => asset.kind === 'image'),
    [canvasNodes],
  );
  const imageAssetIds = useMemo(() => new Set(imageAssets.map((asset) => asset.id)), [imageAssets]);
  const hasMissingAttachments = attachments.some((attachment) => (
    attachment.origin === 'canvas-asset' && !imageAssetIds.has(attachment.assetId)
  ));
  const nodeLabel = (node: typeof selectedNode) => {
    if (!node) return '';
    const data = node.data as Record<string, unknown>;
    const label = [data.displayName, data.name, data.title]
      .find((value): value is string => typeof value === 'string' && Boolean(value.trim()));
    return label ?? node.id;
  };
  const pinnedNodes = projectContext.pinnedNodeIds.flatMap((id) => {
    const node = canvasNodes.find((candidate) => candidate.id === id);
    return node ? [{ id: node.id, label: nodeLabel(node) }] : [];
  });
  const projectBudget = useMemo(
    () => canvasAgentBudgetLedger.get(projectId),
    [budgetVersion, projectId],
  );
  const reservedBudget = Object.values(projectBudget.reservations).reduce((total, amount) => total + amount, 0);

  useEffect(() => canvasAgentBudgetLedger.subscribe(() => {
    setBudgetVersion((version) => version + 1);
  }), []);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 1023px)');
    const updateViewportMode = () => setCompactViewport(mediaQuery.matches);
    updateViewportMode();
    mediaQuery.addEventListener('change', updateViewportMode);
    return () => mediaQuery.removeEventListener('change', updateViewportMode);
  }, []);

  useEffect(() => {
    setProject(projectId);
    setAttachments([]);
    setAttachmentPickerOpen(false);
    setAttachmentError(null);
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
      : event.status === 'failed'
      ? 'failed' as const
      : event.status === 'succeeded'
        ? 'succeeded' as const
        : 'executing' as const;

    if (!toolFeedIdsRef.current.has(key)) {
      toolFeedIdsRef.current.set(key, id);
      const execution = executionReceiptFromOutput(event.output);
      pushFeed({
        id,
        kind: 'tool',
        toolName: event.toolName,
        status,
        input: event.input,
        output: event.output,
        error: event.error,
        nodeIds: nodeIdsFromOutput(event.output),
        ...execution,
        startedAt: Date.now(),
        createdAt: Date.now(),
      });
      return;
    }

    const existing = useCanvasAgentPanelStore.getState().feed.find((item) => item.id === id);
    const startedAt = existing?.kind === 'tool' ? existing.startedAt : undefined;
    const execution = executionReceiptFromOutput(event.output);
    updateFeedItem(id, {
      status,
      input: event.input,
      output: event.output,
      error: event.error,
      nodeIds: nodeIdsFromOutput(event.output),
      ...execution,
      durationMs: startedAt ? Date.now() - startedAt : undefined,
    });
  };

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
    result.approvals.forEach((approval) => pushFeed({
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
    }));
    finishStreaming(result.finalText);
  };

  const executeTurn = async (message: string) => {
    if (!message.trim() || !selectedEntry || isRunning || pendingCount > 0) return;
    const statusId = nextAgentFeedId('status');
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
        message,
        media: media.length ? media : undefined,
        projectContext: {
          brief: projectContext.brief,
          pinnedNodeIds: projectContext.pinnedNodeIds,
        },
        signal: abortRef.current.signal,
        onTextDelta: updateStreamingMessage,
        onReasoningDelta: updateStreamingReasoning,
        onToolEvent: handleToolEvent,
      });
      setAttachments([]);
      setAttachmentPickerOpen(false);
      setAttachmentError(null);
      updateFeedItem(statusId, {
        status: 'completed',
        text: result.status === 'awaiting-approval'
          ? t('canvasAgent.awaitingApproval')
          : t('canvasAgent.completed'),
      });
      addResult(result);
    } catch (error) {
      const aborted = error instanceof DOMException && error.name === 'AbortError';
      updateFeedItem(statusId, {
        status: aborted ? 'cancelled' : 'error',
        text: aborted
          ? t('canvasAgent.cancelled')
          : error instanceof Error ? error.message : String(error),
        retryMessage: aborted ? undefined : message,
      });
      finishStreaming();
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const send = async () => {
    const message = draft.trim();
    if (!message || !selectedEntry || isRunning || pendingCount > 0 || hasPendingPlan) return;
    if (attachments.length && !selectedEntry.supportsMultimodal) {
      setAttachmentError(t('canvasAgent.switchToVisionModelHint'));
      return;
    }
    if (hasMissingAttachments) {
      setAttachmentError(t('canvasAgent.missingAttachmentBeforeSend'));
      return;
    }

    setDraft('');
    setAttachmentError(null);
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
    const plan = buildAgentPlanDraft(message);
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

  const handleApproval = async (
    item: Extract<AgentFeedItem, { kind: 'approval' }>,
    approve: boolean,
  ) => {
    if (!selectedEntry || item.status !== 'pending' || isRunning) return;
    updateFeedItem(item.id, { status: approve ? 'approving' : 'rejecting' });
    setRunning(true);
    abortRef.current = new AbortController();

    try {
      const result = await resolveCanvasAgentApproval({
        runId: item.runId,
        approvalId: item.approvalId,
        approve,
        model: selectedEntry,
        signal: abortRef.current.signal,
        onToolEvent: handleToolEvent,
        onTextDelta: updateStreamingMessage,
        onReasoningDelta: updateStreamingReasoning,
      });
      updateFeedItem(item.id, { status: approve ? 'approved' : 'rejected' });
      addResult(result);
    } catch (error) {
      updateFeedItem(item.id, { status: 'pending' });
      const aborted = error instanceof DOMException && error.name === 'AbortError';
      pushFeed({
        id: nextAgentFeedId('approval-error'),
        kind: 'status',
        status: aborted ? 'cancelled' : 'error',
        text: aborted
          ? t('canvasAgent.cancelled')
          : error instanceof Error ? error.message : String(error),
        createdAt: Date.now(),
      });
      finishStreaming();
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const loadSession = (sessionId: string) => {
    const messages = getCanvasAgentSessionMessages(sessionId);
    replaceFeed(messages.map((message) => ({
      id: nextAgentFeedId('history'),
      kind: 'message',
      role: message.role,
      text: message.text,
      attachments: message.mediaReferences,
      createdAt: message.createdAt,
    })));
    setAttachments([]);
    setAttachmentPickerOpen(false);
    setAttachmentError(null);
    setActiveSessionId(sessionId);
    setActiveView('conversation');
    stickToBottomRef.current = true;
  };

  const startConversation = () => {
    if (isRunning) return;
    clearFeed();
    setActiveView('conversation');
    setDraft('');
    setAttachments([]);
    setAttachmentPickerOpen(false);
    setAttachmentError(null);
    toolFeedIdsRef.current.clear();
    requestAnimationFrame(() => panelRef.current?.querySelector('textarea')?.focus());
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

  const toggleAttachment = (asset: (typeof imageAssets)[number]) => {
    setAttachmentError(null);
    setAttachments((current) => {
      const exists = current.some((attachment) => attachment.assetId === asset.id);
      if (exists) return current.filter((attachment) => attachment.assetId !== asset.id);
      if (current.length >= MAX_AGENT_MEDIA_ATTACHMENTS) return current;
      return [...current, createAgentCanvasMediaInput(asset)];
    });
  };

  const attachSelectedNode = () => {
    if (!selectedNode) return;
    const asset = imageAssets
      .filter((candidate) => candidate.nodeId === selectedNode.id)
      .sort((left, right) => right.order - left.order)
      .find((candidate) => !attachments.some((attachment) => attachment.assetId === candidate.id));
    if (!asset) {
      setAttachmentError(t('canvasAgent.noImageOnSelection'));
      return;
    }
    toggleAttachment(asset);
  };

  const uploadAttachments = async (files: File[]) => {
    const remaining = MAX_AGENT_MEDIA_ATTACHMENTS - attachments.length;
    if (files.length > remaining) {
      setAttachmentError(t('canvasAgent.tooManyAttachmentsSelected', { count: files.length, remaining }));
      return;
    }
    setUploadingAttachment(true);
    setAttachmentError(null);
    try {
      for (const [index, file] of files.entries()) {
        await validateAgentImageFile(file);
        const prepared = await prepareNodeImageFromFile(file);
        const canvas = useCanvasStore.getState();
        const zoom = Math.max(0.01, canvas.currentViewport.zoom);
        const position = {
          x: (canvas.canvasViewportSize.width / 2 - canvas.currentViewport.x) / zoom + index * 28,
          y: (canvas.canvasViewportSize.height / 2 - canvas.currentViewport.y) / zoom + index * 28,
        };
        const nodeId = canvas.addNode(CANVAS_NODE_TYPES.upload, position, {
          imageUrl: prepared.imageUrl,
          previewImageUrl: prepared.previewImageUrl,
          aspectRatio: prepared.aspectRatio || '1:1',
          sourceFileName: file.name,
          displayName: file.name,
        });
        const latestCanvas = useCanvasStore.getState();
        const projectStore = useProjectStore.getState();
        if (projectStore.currentProjectId === projectId) {
          projectStore.saveCurrentProject(
            latestCanvas.nodes,
            latestCanvas.edges,
            latestCanvas.currentViewport,
            latestCanvas.history,
          );
        }
        const asset = buildCanvasAssetCatalog(useCanvasStore.getState().nodes)
          .find((candidate) => candidate.id === `${nodeId}:image`);
        if (!asset) throw new Error(t('canvasAgent.uploadAttachmentFailed'));
        const attachment = createAgentCanvasMediaInput(asset);
        setAttachments((current) => current.some((item) => item.assetId === attachment.assetId)
          ? current
          : [...current, attachment].slice(0, MAX_AGENT_MEDIA_ATTACHMENTS));
      }
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : String(error));
    } finally {
      setUploadingAttachment(false);
    }
  };

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
        className={`agent-dock-slot pointer-events-none absolute inset-y-0 right-0 z-[12025] w-full sm:w-[410px] lg:relative lg:inset-auto lg:z-20 lg:h-full lg:flex-none lg:overflow-hidden ${
          isOpen ? 'lg:w-[410px]' : 'lg:w-0'
        }`}
      >
        <aside
          ref={panelRef}
          className={`agent-dock-shell pointer-events-auto absolute inset-y-0 right-0 flex w-full min-w-0 flex-col overflow-hidden border-l border-border-dark bg-bg-dark shadow-2xl sm:w-[410px] lg:w-[410px] lg:translate-x-0 lg:shadow-xl ${
            isOpen
              ? 'translate-x-0 opacity-100'
              : 'pointer-events-none translate-x-full opacity-0 lg:translate-x-0'
          }`}
          role={isCompactViewport ? 'dialog' : 'complementary'}
          aria-modal={isCompactViewport || undefined}
          aria-label={t('canvasAgent.panel')}
          aria-hidden={!isOpen}
        >
        <CanvasAgentHeader
          selectedEntry={selectedEntry}
          activeView={activeView}
          pendingCount={pendingCount}
          isRunning={isRunning}
          onViewChange={setActiveView}
          onClose={() => setOpen(false)}
          closeRef={closeRef}
        />

        <CanvasAgentContextPanel
          brief={projectContext.brief}
          pinnedNodes={pinnedNodes}
          selectedNode={selectedNode ? { id: selectedNode.id, label: nodeLabel(selectedNode) } : null}
          budgetLimit={projectBudget.limit}
          budgetSpent={projectBudget.spent}
          budgetReserved={reservedBudget}
          onBriefChange={(brief) => setProjectBrief(projectId, brief)}
          onTogglePinnedNode={(nodeId) => togglePinnedNode(projectId, nodeId)}
          onClear={() => clearProjectContext(projectId)}
          onBudgetLimitChange={(limit) => { canvasAgentBudgetLedger.setLimit(projectId, limit); }}
          onBudgetReset={() => { canvasAgentBudgetLedger.reset(projectId); }}
        />

        <div
          ref={feedScrollRef}
          className="ui-scrollbar relative min-h-0 flex-1 overflow-y-auto p-3"
          onScroll={onFeedScroll}
        >
          <div key={activeView} className="agent-view-enter">
            {activeView === 'history' ? (
              <div className="space-y-2">
                <button
                  type="button"
                  disabled={isRunning}
                  className="flex min-h-11 w-full items-center gap-2 rounded-[5px] border border-border-dark px-3 text-xs text-text-dark transition-[background-color,transform] duration-150 hover:bg-text-dark/[0.05] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                  onClick={startConversation}
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  {t('canvasAgent.newConversation')}
                </button>
                {sessions.length ? sessions.map((session) => (
                  <button
                    key={session.id}
                    type="button"
                    className="w-full rounded-[5px] border border-border-dark/60 px-3 py-2.5 text-left transition-[background-color,border-color,transform] duration-150 hover:border-border-dark hover:bg-text-dark/[0.04] active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                    onClick={() => loadSession(session.id)}
                  >
                    <div className="truncate text-xs text-text-dark">{session.title}</div>
                    <div className="mt-1 text-[10px] text-text-muted">
                      {new Date(session.updatedAt).toLocaleString()}
                    </div>
                  </button>
                )) : (
                  <div className="px-3 py-8 text-center text-xs text-text-muted">
                    {t('canvasAgent.noHistory')}
                  </div>
                )}
              </div>
            ) : displayedFeed.length ? (
              <div className="space-y-3">
                {displayedFeed.map((item) => (
                  <AgentFeedCard
                    key={item.id}
                    item={item}
                    onApproval={handleApproval}
                    onLocate={handleLocate}
                    onRestoreDraft={restoreDraft}
                    onPlanChange={handlePlanChange}
                    onPlanConfirm={(item) => void handlePlanConfirm(item)}
                    onPlanCancel={handlePlanCancel}
                    budgetDecision={item.kind === 'approval'
                      ? canvasAgentBudgetLedger.evaluate(projectId, item.impact)
                      : undefined}
                    onBudgetLimitChange={(limit) => { canvasAgentBudgetLedger.setLimit(projectId, limit); }}
                    onRollback={(tool) => { void handleRollback(tool); }}
                  />
                ))}
              </div>
            ) : (
              <div className="flex min-h-56 flex-col items-center justify-center px-8 text-center">
                <Bot className="mb-3 h-7 w-7 text-accent" aria-hidden="true" />
                <div className="text-sm font-medium text-text-dark">{t('canvasAgent.emptyTitle')}</div>
                <div className="mt-2 text-xs leading-5 text-text-muted">{t('canvasAgent.emptyDescription')}</div>
              </div>
            )}
          </div>

          {showNewItems ? (
            <button
              type="button"
              className="sticky bottom-2 left-1/2 z-10 mx-auto flex min-h-11 -translate-x-1/2 items-center rounded-full border border-accent/[0.35] bg-bg-dark px-3 text-xs text-accent shadow-lg transition-[background-color,transform] duration-150 hover:bg-accent/[0.10] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 sm:min-h-10"
              onClick={() => {
                stickToBottomRef.current = true;
                setShowNewItems(false);
                feedScrollRef.current?.scrollTo({
                  top: feedScrollRef.current.scrollHeight,
                  behavior: 'smooth',
                });
              }}
            >
              {t('canvasAgent.newItems')}
            </button>
          ) : null}
        </div>

        <div className="relative shrink-0">
          {attachmentPickerOpen ? (
            <CanvasAgentAttachmentPicker
              assets={imageAssets}
              selectedAssetIds={attachments
                .filter((attachment) => attachment.origin === 'canvas-asset')
                .map((attachment) => attachment.assetId)}
              attachmentCount={attachments.length}
              selectedNodeId={selectedNode?.id ?? null}
              maxAttachments={MAX_AGENT_MEDIA_ATTACHMENTS}
              isUploading={isUploadingAttachment}
              error={attachmentError}
              onToggle={toggleAttachment}
              onAttachSelected={attachSelectedNode}
              onUpload={(files) => { void uploadAttachments(files); }}
              onClose={() => {
                setAttachmentPickerOpen(false);
                setAttachmentError(null);
              }}
            />
          ) : null}
          <CanvasAgentComposer
            entries={modelEntries}
            selectedEntry={selectedEntry}
            draft={draft}
            attachments={attachments}
            maxAttachments={MAX_AGENT_MEDIA_ATTACHMENTS}
            hasMissingAttachments={hasMissingAttachments}
            isRunning={isRunning}
            hasPendingApproval={pendingCount > 0}
            hasPendingPlan={hasPendingPlan}
            onModelChange={setSelectedModelId}
            onDraftChange={setDraft}
            onAttach={() => {
              setAttachmentError(null);
              setAttachmentPickerOpen((open) => !open);
            }}
            onRemoveAttachment={(assetId) => {
              setAttachments((current) => current.filter((attachment) => attachment.assetId !== assetId));
              setAttachmentError(null);
            }}
            onSend={() => void send()}
            onCancel={() => abortRef.current?.abort()}
            onSettings={openModelSettings}
          />
        </div>
        </aside>
      </div>
    </>
  );
}
