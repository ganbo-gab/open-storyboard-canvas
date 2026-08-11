import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  cancelExternalAgentSession,
  diagnoseExternalAgentRuntimes,
  resolveExternalAgentToolCall,
  sendExternalAgentTurn,
  startExternalAgentSession,
} from '@/commands/externalAgent';
import { buildCanvasAssetCatalog } from '@/features/canvas/application/canvasAssetCatalog';
import { useCanvasStore } from '@/stores/canvasStore';
import { createAgentCanvasMediaInput } from '../application/agentMediaResolver';
import { buildSkillContext, resolveAgentToolPolicy } from '../application/agentSkills';
import {
  prepareExternalAgentToolRequest,
  resolveExternalAgentToolApproval,
} from '../application/externalAgentCanvasBridge';
import {
  listenNormalizedExternalAgentEvents,
  projectExternalAgentRuntimeDiagnostic,
} from '../application/externalAgentEventAdapter';
import { buildExternalAgentAttachments } from '../application/externalAgentMediaAdapter';
import { buildExternalCanvasMcpManifest } from '../application/externalAgentToolManifest';
import type { CanvasAgentToolEvent } from '../infrastructure/sdkRuntime';
import type {
  AgentTurnMediaInput,
  CanvasAgentRuntimeId,
  ExternalAgentEventV1,
  ExternalAgentRuntimeDiagnostic,
  ExternalAgentRuntimeId,
  ExternalAgentSessionReference,
  ExternalAgentToolRequest,
} from '../domain/agentModel';
import {
  nextAgentFeedId,
  useCanvasAgentPanelStore,
  type AgentFeedItem,
  type AgentProjectContext,
} from './agentPanelStore';

type Options = {
  projectId: string;
  selectedRuntimeId: CanvasAgentRuntimeId;
  selectedSession: ExternalAgentSessionReference | null;
  attachments: AgentTurnMediaInput[];
  projectContext: AgentProjectContext;
  isRunning: boolean;
  pendingCount: number;
  setRunning: Dispatch<SetStateAction<boolean>>;
  resetAttachments: () => void;
  pushFeed: (item: AgentFeedItem) => void;
  updateFeedItem: (id: string, patch: Partial<AgentFeedItem>) => void;
  updateStreamingMessage: (delta: string) => void;
  updateStreamingReasoning: (delta: string) => void;
  updateStreamingPlan: (delta: string) => void;
  resetStreaming: () => void;
  finishStreaming: (finalText?: string) => void;
  handleToolEvent: (event: CanvasAgentToolEvent) => void;
};

type ExternalAgentRuntimeState = {
  diagnostics: Partial<Record<ExternalAgentRuntimeId, ExternalAgentRuntimeDiagnostic>>;
  isRefreshing: boolean;
  refresh: () => Promise<void>;
  executeTurn: (message: string, runtime: ExternalAgentRuntimeId) => Promise<void>;
  resolveApproval: (
    item: Extract<AgentFeedItem, { kind: 'approval' }>,
    approve: boolean,
  ) => Promise<boolean>;
  cancelTurn: () => Promise<void>;
  discardCurrentSession: () => void;
};

export function useExternalAgentRuntime({
  projectId,
  selectedRuntimeId,
  selectedSession,
  attachments,
  projectContext,
  isRunning,
  pendingCount,
  setRunning,
  resetAttachments,
  pushFeed,
  updateFeedItem,
  updateStreamingMessage,
  updateStreamingReasoning,
  updateStreamingPlan,
  resetStreaming,
  finishStreaming,
  handleToolEvent,
}: Options): ExternalAgentRuntimeState {
  const { t } = useTranslation();
  const setExternalSession = useCanvasAgentPanelStore((state) => state.setExternalSession);
  const clearExternalSession = useCanvasAgentPanelStore((state) => state.clearExternalSession);
  const [diagnostics, setDiagnostics] = useState<Partial<Record<ExternalAgentRuntimeId, ExternalAgentRuntimeDiagnostic>>>({});
  const [isRefreshing, setRefreshing] = useState(false);
  const statusIdRef = useRef<string | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const cancelPendingRef = useRef(false);
  const cancelRequestedRef = useRef(false);
  const liveSessionsRef = useRef(new Set<string>());
  const sessionProjectsRef = useRef(new Map<string, string>());
  const toolRequestsRef = useRef(new Map<string, ExternalAgentToolRequest>());

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const runtimeDiagnostics = await diagnoseExternalAgentRuntimes();
      setDiagnostics(Object.fromEntries(
        runtimeDiagnostics.map((diagnostic) => {
          const projected = projectExternalAgentRuntimeDiagnostic(diagnostic);
          return [projected.runtime, projected];
        }),
      ));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setDiagnostics({
        codex: { runtime: 'codex', availability: 'unavailable', detail },
        claude: { runtime: 'claude', availability: 'unavailable', detail },
      });
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const expireToolRequests = (sessionId: string, message?: string) => {
    for (const [requestKey, request] of toolRequestsRef.current) {
      if (request.sessionId !== sessionId) continue;
      toolRequestsRef.current.delete(requestKey);
      const approval = useCanvasAgentPanelStore.getState().feed.find((item) => (
        item.kind === 'approval'
        && item.runtimeId === request.runtime
        && item.runId === request.turnId
        && item.approvalId === request.callId
      ));
      if (approval?.kind === 'approval' && ['pending', 'approving', 'rejecting'].includes(approval.status)) {
        updateFeedItem(approval.id, { status: 'expired' });
      }
      handleToolEvent({
        toolName: request.toolName,
        callId: request.callId,
        status: 'failed',
        error: message ?? t('canvasAgent.approvalStatus.expired'),
      });
    }
  };

  const closeSessionState = (sessionId: string, message?: string) => {
    liveSessionsRef.current.delete(sessionId);
    sessionProjectsRef.current.delete(sessionId);
    expireToolRequests(sessionId, message);
    if (activeSessionIdRef.current === sessionId) activeSessionIdRef.current = null;
    cancelPendingRef.current = false;
    cancelRequestedRef.current = false;
  };

  const handleEvent = async (event: ExternalAgentEventV1) => {
    if (event.runtime !== selectedRuntimeId) return;
    if (event.sessionId && sessionProjectsRef.current.get(event.sessionId) !== projectId) return;
    const statusId = statusIdRef.current;
    switch (event.kind) {
      case 'session':
        liveSessionsRef.current.add(event.sessionId);
        setExternalSession(projectId, {
          runtime: event.runtime,
          sessionId: event.sessionId,
          threadId: event.threadId,
        });
        return;
      case 'turn_started':
        setRunning(true);
        if (statusId) updateFeedItem(statusId, { status: 'running', text: t('canvasAgent.thinking') });
        return;
      case 'message_delta':
        updateStreamingMessage(event.delta);
        return;
      case 'reasoning_summary_delta':
        updateStreamingReasoning(event.delta);
        return;
      case 'plan':
        updateStreamingPlan(event.delta);
        return;
      case 'tool_requested': {
        const requestKey = `${event.turnId}:${event.request.callId}`;
        toolRequestsRef.current.set(requestKey, event.request);
        handleToolEvent({
          toolName: event.request.toolName,
          callId: event.request.callId,
          status: 'awaiting-approval',
          input: event.request.arguments,
        });
        try {
          const approval = await prepareExternalAgentToolRequest({ projectId, request: event.request });
          pushFeed({
            id: nextAgentFeedId('external-approval'),
            kind: 'approval',
            runId: event.turnId,
            approvalId: event.request.callId,
            runtimeId: event.runtime,
            toolName: approval.toolName,
            summary: approval.summary,
            arguments: approval.arguments,
            impact: approval.impact,
            expiresAt: approval.expiresAt,
            status: 'pending',
            createdAt: Date.now(),
          });
          setRunning(false);
          if (statusId) updateFeedItem(statusId, {
            status: 'completed',
            text: t('canvasAgent.awaitingApproval'),
          });
        } catch (error) {
          toolRequestsRef.current.delete(requestKey);
          await resolveExternalAgentToolCall({
            sessionId: event.sessionId,
            callId: event.request.callId,
            resolution: {
              outcome: 'error',
              errorCode: 'approval_prepare_failed',
              message: error instanceof Error ? error.message : String(error),
              revision: useCanvasStore.getState().revision,
            },
          }).catch(() => undefined);
          handleToolEvent({
            toolName: event.request.toolName,
            callId: event.request.callId,
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      case 'tool_completed':
        handleToolEvent({
          toolName: event.toolName,
          callId: event.callId,
          status: 'succeeded',
          output: event.output,
        });
        return;
      case 'tool_started':
        handleToolEvent({
          toolName: event.toolName,
          callId: event.callId,
          status: 'executing',
          input: event.input,
        });
        return;
      case 'tool_failed':
        handleToolEvent({
          toolName: event.toolName,
          callId: event.callId,
          status: 'failed',
          error: event.error,
        });
        return;
      case 'progress':
      case 'diagnostic':
        if (event.message && statusId) {
          updateFeedItem(statusId, { status: 'running', text: event.message });
        }
        return;
      case 'completed':
        finishStreaming(event.finalText);
        setRunning(false);
        if (activeSessionIdRef.current === event.sessionId) activeSessionIdRef.current = null;
        cancelPendingRef.current = false;
        cancelRequestedRef.current = false;
        if (statusId) updateFeedItem(statusId, { status: 'completed', text: t('canvasAgent.completed') });
        statusIdRef.current = null;
        return;
      case 'cancelled':
        finishStreaming();
        setRunning(false);
        closeSessionState(event.sessionId, t('canvasAgent.cancelled'));
        if (statusId) updateFeedItem(statusId, { status: 'cancelled', text: t('canvasAgent.cancelled') });
        statusIdRef.current = null;
        return;
      case 'error':
        finishStreaming();
        setRunning(false);
        if (event.sessionId) closeSessionState(event.sessionId, event.message);
        if (statusId) updateFeedItem(statusId, { status: 'error', text: event.message });
        else pushFeed({
          id: nextAgentFeedId('external-error'),
          kind: 'status',
          status: 'error',
          text: event.message,
          createdAt: Date.now(),
        });
        statusIdRef.current = null;
        return;
    }
  };

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenNormalizedExternalAgentEvents(
      (event) => { if (!disposed) void handleEvent(event); },
      (error) => {
        if (disposed) return;
        setRunning(false);
        finishStreaming();
        const statusId = statusIdRef.current;
        if (statusId) updateFeedItem(statusId, { status: 'error', text: error.message });
        else {
          pushFeed({
            id: nextAgentFeedId('external-protocol-error'),
            kind: 'status',
            status: 'error',
            text: error.message,
            createdAt: Date.now(),
          });
        }
        statusIdRef.current = null;
        const sessionId = activeSessionIdRef.current;
        if (sessionId) {
          closeSessionState(sessionId, error.message);
          void cancelExternalAgentSession(sessionId).catch(() => undefined);
        }
      },
    ).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    }).catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [projectId, selectedRuntimeId]);

  const executeTurn = async (message: string, runtime: ExternalAgentRuntimeId) => {
    if (!message.trim() || isRunning || pendingCount > 0 || diagnostics[runtime]?.availability !== 'ready') return;
    let sessionId: string | undefined;
    const statusId = nextAgentFeedId('external-status');
    statusIdRef.current = statusId;
    pushFeed({
      id: statusId,
      kind: 'status',
      status: 'running',
      text: t('canvasAgent.thinking'),
      createdAt: Date.now(),
    });
    setRunning(true);
    cancelRequestedRef.current = false;
    resetStreaming();

    try {
      const currentAssets = new Map(
        buildCanvasAssetCatalog(useCanvasStore.getState().nodes)
          .filter((asset) => asset.kind === 'image')
          .map((asset) => [asset.id, asset]),
      );
      const media = attachments.map((attachment) => {
        if (attachment.origin === 'upload') return attachment;
        const asset = currentAssets.get(attachment.assetId);
        if (!asset) throw new Error(t('canvasAgent.missingAttachmentBeforeSend'));
        return createAgentCanvasMediaInput(asset);
      });
      const skillContext = buildSkillContext({
        text: message,
        attachmentKinds: media.length ? ['image'] : [],
      });
      const toolPolicy = resolveAgentToolPolicy({
        skillContext,
        supportsVision: true,
        supportsToolSearch: false,
      });
      const externalToolKinds = toolPolicy.toolKinds.filter((kind) => kind !== 'asset-read');
      const manifest = buildExternalCanvasMcpManifest(externalToolKinds);
      if (skillContext.selections.length) {
        pushFeed({
          id: nextAgentFeedId('external-skill'),
          kind: 'skill',
          skillIds: skillContext.selections.map((selection) => selection.skill.id),
          reason: skillContext.selections.map((selection) => selection.reason).join(' '),
          estimatedTokens: skillContext.estimatedTokens,
          toolCount: manifest.tools.length,
          mode: toolPolicy.mode,
          deferredToolCount: 0,
          createdAt: Date.now(),
        });
      }
      const externalAttachments = media.length
        ? await buildExternalAgentAttachments(media)
        : undefined;
      if (cancelRequestedRef.current) throw new DOMException('Aborted', 'AbortError');

      sessionId = selectedSession?.sessionId;
      if (!sessionId || !liveSessionsRef.current.has(sessionId)) {
        const session = await startExternalAgentSession({
          runtime,
          tools: manifest.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            requiresApproval: true,
          })),
          resumeId: selectedSession?.threadId,
        });
        sessionId = session.sessionId;
        liveSessionsRef.current.add(sessionId);
        sessionProjectsRef.current.set(sessionId, projectId);
        setExternalSession(projectId, {
          runtime,
          sessionId,
          threadId: session.providerSessionId ?? undefined,
        });
      } else {
        sessionProjectsRef.current.set(sessionId, projectId);
      }
      activeSessionIdRef.current = sessionId;
      if (cancelRequestedRef.current) throw new DOMException('Aborted', 'AbortError');
      const prompt = [
        projectContext.brief.trim() ? `Project brief:\n${projectContext.brief.trim()}` : '',
        projectContext.pinnedNodeIds.length
          ? `Pinned canvas node ids: ${projectContext.pinnedNodeIds.join(', ')}`
          : '',
        skillContext.instructions ? `Selected Canvas skill instructions:\n${skillContext.instructions}` : '',
        `User request:\n${message}`,
      ].filter(Boolean).join('\n\n');
      await sendExternalAgentTurn({
        sessionId,
        prompt,
        attachments: externalAttachments,
      });
      resetAttachments();
    } catch (error) {
      const aborted = error instanceof DOMException && error.name === 'AbortError';
      setRunning(false);
      statusIdRef.current = null;
      if (!sessionId && selectedSession) {
        clearExternalSession(projectId, runtime);
      }
      if (sessionId) {
        const wasLive = liveSessionsRef.current.has(sessionId);
        closeSessionState(sessionId, error instanceof Error ? error.message : String(error));
        if (wasLive) void cancelExternalAgentSession(sessionId).catch(() => undefined);
      }
      cancelPendingRef.current = false;
      cancelRequestedRef.current = false;
      updateFeedItem(statusId, {
        status: aborted ? 'cancelled' : 'error',
        text: aborted
          ? t('canvasAgent.cancelled')
          : error instanceof Error ? error.message : String(error),
        retryMessage: aborted ? undefined : message,
      });
      finishStreaming();
    }
  };

  const resolveApproval = async (
    item: Extract<AgentFeedItem, { kind: 'approval' }>,
    approve: boolean,
  ): Promise<boolean> => {
    const requestKey = `${item.runId}:${item.approvalId}`;
    const request = toolRequestsRef.current.get(requestKey);
    if (request) {
      if (item.status !== 'pending' || isRunning) return true;
      updateFeedItem(item.id, { status: approve ? 'approving' : 'rejecting' });
      setRunning(true);
      handleToolEvent({
        toolName: request.toolName,
        callId: request.callId,
        status: 'executing',
        input: request.arguments,
      });
      try {
        const result = await resolveExternalAgentToolApproval({
          projectId,
          request,
          approve,
        });
        toolRequestsRef.current.delete(requestKey);
        updateFeedItem(item.id, {
          status: result.status === 'error'
            ? 'failed'
            : approve ? 'approved' : 'rejected',
        });
        handleToolEvent({
          toolName: request.toolName,
          callId: request.callId,
          status: result.status === 'approved' ? 'succeeded' : 'failed',
          output: result.output === undefined ? undefined : {
            output: result.output,
            execution: { receiptId: result.receiptId },
          },
          error: result.status === 'denied'
            ? t('canvasAgent.approvalStatus.rejected')
            : result.error,
        });
        const statusId = statusIdRef.current;
        if (statusId) updateFeedItem(statusId, { status: 'running', text: t('canvasAgent.thinking') });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        toolRequestsRef.current.delete(requestKey);
        setRunning(false);
        updateFeedItem(item.id, { status: 'failed' });
        handleToolEvent({
          toolName: request.toolName,
          callId: request.callId,
          status: 'failed',
          error: message,
        });
        closeSessionState(request.sessionId, message);
        clearExternalSession(projectId, request.runtime);
        void cancelExternalAgentSession(request.sessionId).catch(() => undefined);
        const statusId = statusIdRef.current;
        if (statusId) updateFeedItem(statusId, { status: 'error', text: message });
        else pushFeed({
          id: nextAgentFeedId('external-resolution-error'),
          kind: 'status',
          status: 'error',
          text: message,
          createdAt: Date.now(),
        });
        statusIdRef.current = null;
      }
      return true;
    }
    if (!item.runtimeId) return false;
    updateFeedItem(item.id, { status: 'expired' });
    pushFeed({
      id: nextAgentFeedId('external-approval-expired'),
      kind: 'status',
      status: 'error',
      text: t('canvasAgent.approvalStatus.expired'),
      createdAt: Date.now(),
    });
    return true;
  };

  const cancelTurn = async () => {
    if (cancelPendingRef.current) return;
    cancelPendingRef.current = true;
    cancelRequestedRef.current = true;
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) return;
    try {
      await cancelExternalAgentSession(sessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      closeSessionState(sessionId, message);
      setRunning(false);
      const statusId = statusIdRef.current;
      if (statusId) updateFeedItem(statusId, { status: 'error', text: message });
      else {
        pushFeed({
          id: nextAgentFeedId('external-cancel-error'),
          kind: 'status',
          status: 'error',
          text: message,
          createdAt: Date.now(),
        });
      }
      statusIdRef.current = null;
      finishStreaming();
    }
  };

  const discardCurrentSession = () => {
    if (selectedRuntimeId === 'builtin' || !selectedSession) return;
    const { sessionId, runtime } = selectedSession;
    const wasLive = liveSessionsRef.current.has(sessionId);
    closeSessionState(sessionId);
    clearExternalSession(projectId, runtime);
    if (wasLive) void cancelExternalAgentSession(sessionId).catch(() => undefined);
  };

  return {
    diagnostics,
    isRefreshing,
    refresh,
    executeTurn,
    resolveApproval,
    cancelTurn,
    discardCurrentSession,
  };
}
