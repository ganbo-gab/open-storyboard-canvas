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
import { mergeTurnMedia } from '@/features/agents/ui/useAgentComposerAssist';
import { createAgentCanvasMediaInput } from '../application/agentMediaResolver';
import { buildSkillContext, isLikelyTaskContinuation, resolveAgentToolPolicy } from '../application/agentSkills';
import {
  cancelExternalAgentToolRequest,
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
  enabled: boolean;
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

interface ExternalAgentTurnExtras {
  explicitSkillIds: string[];
  media: AgentTurnMediaInput[];
}

type ExternalAgentRuntimeState = {
  diagnostics: Partial<Record<ExternalAgentRuntimeId, ExternalAgentRuntimeDiagnostic>>;
  isRefreshing: boolean;
  isListening: boolean;
  eventError: string | null;
  refresh: () => Promise<void>;
  executeTurn: (message: string, runtime: ExternalAgentRuntimeId, extras: ExternalAgentTurnExtras) => Promise<string[] | null>;
  resolveApproval: (
    item: Extract<AgentFeedItem, { kind: 'approval' }>,
    approve: boolean,
  ) => Promise<boolean>;
  cancelTurn: () => Promise<void>;
  discardCurrentSession: () => void;
};

interface ExternalTurnOwner {
  generation: number;
  statusId: string;
  sessionId?: string;
  localExecutionController: AbortController;
  turnId?: string;
  cancelled: boolean;
  terminal: boolean;
}

interface ExternalConversationContext {
  sessionId?: string;
  messages: string[];
}

export function useExternalAgentRuntime({
  enabled,
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
  const [isListening, setListening] = useState(false);
  const [eventError, setEventError] = useState<string | null>(null);
  const statusIdRef = useRef<string | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const cancelPendingRef = useRef(false);
  const liveSessionsRef = useRef(new Set<string>());
  const sessionProjectsRef = useRef(new Map<string, string>());
  const toolRequestsRef = useRef(new Map<string, ExternalAgentToolRequest>());
  const grantedToolsRef = useRef(new Map<string, string[]>());
  const generationRef = useRef(0);
  const activeTurnRef = useRef<ExternalTurnOwner | null>(null);
  const preparingTurnRef = useRef<ExternalTurnOwner | null>(null);
  const resolvingRequestsRef = useRef(new Set<ExternalAgentToolRequest>());
  const conversationContextsRef = useRef(new Map<string, ExternalConversationContext>());

  const ownsTurn = (turn: ExternalTurnOwner) => (
    generationRef.current === turn.generation && activeTurnRef.current === turn
  );

  const syncTurnRunning = (turn: ExternalTurnOwner) => {
    if (!ownsTurn(turn) || turn.terminal || turn.cancelled) return;
    const awaitingApproval = Array.from(toolRequestsRef.current.values()).some((request) => (
      request.sessionId === turn.sessionId && !resolvingRequestsRef.current.has(request)
    ));
    setRunning(!awaitingApproval);
    updateFeedItem(turn.statusId, {
      status: awaitingApproval ? 'completed' : 'running',
      text: t(awaitingApproval ? 'canvasAgent.awaitingApproval' : 'canvasAgent.thinking'),
    });
  };

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
    if (enabled) void refresh();
  }, [enabled, refresh]);

  const expireToolRequests = (sessionId: string, message?: string) => {
    for (const [requestKey, request] of toolRequestsRef.current) {
      if (request.sessionId !== sessionId) continue;
      // A synchronously claimed resolution owns its durable result, even before execution starts.
      if (resolvingRequestsRef.current.has(request)) continue;
      const approval = useCanvasAgentPanelStore.getState().feed.find((item) => (
        item.kind === 'approval'
        && item.runtimeId === request.runtime
        && item.runId === request.turnId
        && item.approvalId === request.callId
      ));
      cancelExternalAgentToolRequest({ projectId, request });
      toolRequestsRef.current.delete(requestKey);
      if (approval?.kind === 'approval' && approval.status === 'pending') {
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
    grantedToolsRef.current.delete(sessionId);
    expireToolRequests(sessionId, message);
    if (activeSessionIdRef.current === sessionId) activeSessionIdRef.current = null;
    if (activeTurnRef.current?.sessionId === sessionId) {
      activeTurnRef.current.terminal = true;
      activeTurnRef.current.localExecutionController.abort();
      cancelPendingRef.current = false;
    }
  };

  const handleEvent = async (event: ExternalAgentEventV1, generation: number) => {
    if (generation !== generationRef.current || event.runtime !== selectedRuntimeId) return;
    if (event.sessionId && sessionProjectsRef.current.get(event.sessionId) !== projectId) return;
    const turn = activeTurnRef.current;
    if (event.kind !== 'session') {
      if (!turn || turn.terminal || !ownsTurn(turn) || (event.sessionId && event.sessionId !== turn.sessionId)) return;
      if (event.turnId && turn.turnId && event.turnId !== turn.turnId) return;
      if (event.turnId) turn.turnId = event.turnId;
    }
    const statusId = turn?.statusId ?? null;
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
        if (turn) syncTurnRunning(turn);
        if (statusId) updateFeedItem(statusId, { status: 'running', runId: event.turnId, text: t('canvasAgent.thinking') });
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
        if (toolRequestsRef.current.has(requestKey)) return;
        toolRequestsRef.current.set(requestKey, event.request);
        handleToolEvent({
          toolName: event.request.toolName,
          callId: event.request.callId,
          status: 'awaiting-approval',
          input: event.request.arguments,
        });
        try {
          const allowedToolNames = grantedToolsRef.current.get(event.sessionId);
          if (activeSessionIdRef.current !== event.sessionId || !allowedToolNames) throw new Error(t('canvasAgent.runtime.noTurnAuthority'));
          const approval = await prepareExternalAgentToolRequest({ projectId, request: event.request, allowedToolNames });
          if (generation !== generationRef.current || !turn || !ownsTurn(turn) || turn.terminal
            || toolRequestsRef.current.get(requestKey) !== event.request) {
            cancelExternalAgentToolRequest({ projectId, request: event.request });
            return;
          }
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
          syncTurnRunning(turn);
        } catch (error) {
          if (generation !== generationRef.current || !turn || !ownsTurn(turn) || turn.terminal
            || toolRequestsRef.current.get(requestKey) !== event.request) return;
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
          if (generation !== generationRef.current || !ownsTurn(turn) || turn.terminal) return;
          syncTurnRunning(turn);
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
        if (turn) turn.terminal = true;
        expireToolRequests(event.sessionId);
        finishStreaming(event.finalText);
        setRunning(false);
        if (activeSessionIdRef.current === event.sessionId) activeSessionIdRef.current = null;
        cancelPendingRef.current = false;
        if (statusId) updateFeedItem(statusId, { status: 'completed', runId: event.turnId, text: t('canvasAgent.completed') });
        statusIdRef.current = null;
        return;
      case 'cancelled':
        if (turn) turn.terminal = true;
        finishStreaming();
        setRunning(false);
        closeSessionState(event.sessionId, t('canvasAgent.cancelled'));
        if (statusId) updateFeedItem(statusId, { status: 'cancelled', runId: event.turnId, text: t('canvasAgent.cancelled') });
        statusIdRef.current = null;
        return;
      case 'error':
        if (turn) turn.terminal = true;
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
    if (!enabled || selectedRuntimeId === 'builtin') return;
    const generation = ++generationRef.current;
    setListening(false);
    setEventError(null);
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenNormalizedExternalAgentEvents(
      (event) => { if (!disposed) void handleEvent(event, generation); },
      (error) => {
        if (disposed) return;
        const turn = activeTurnRef.current;
        if (turn) turn.terminal = true;
        preparingTurnRef.current = null;
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
      else { unlisten = dispose; setListening(true); }
    }).catch((error: unknown) => {
      if (!disposed) setEventError(error instanceof Error ? error.message : String(error));
    });
    return () => {
      disposed = true;
      generationRef.current += 1;
      const turn = activeTurnRef.current;
      if (turn) { turn.cancelled = true; turn.terminal = true; turn.localExecutionController.abort(); }
      activeTurnRef.current = null;
      preparingTurnRef.current = null;
      activeSessionIdRef.current = null;
      statusIdRef.current = null;
      cancelPendingRef.current = false;
      setRunning(false);
      setListening(false);
      for (const sessionId of new Set(Array.from(toolRequestsRef.current.values(), (request) => request.sessionId))) {
        expireToolRequests(sessionId);
      }
      for (const [sessionId, ownerProjectId] of sessionProjectsRef.current) {
        if (ownerProjectId !== projectId) continue;
        const wasLive = liveSessionsRef.current.has(sessionId);
        closeSessionState(sessionId);
        if (wasLive) void cancelExternalAgentSession(sessionId).catch(() => undefined);
      }
      unlisten?.();
    };
  }, [enabled, projectId, selectedRuntimeId]);

  const executeTurn = async (message: string, runtime: ExternalAgentRuntimeId, extras: ExternalAgentTurnExtras): Promise<string[] | null> => {
    if (!enabled || !isListening || runtime !== selectedRuntimeId || !message.trim() || isRunning || pendingCount > 0 || preparingTurnRef.current || activeSessionIdRef.current || diagnostics[runtime]?.availability !== 'ready') return null;
    let sessionId: string | undefined;
    const statusId = nextAgentFeedId('external-status');
    const turn: ExternalTurnOwner = {
      generation: generationRef.current,
      statusId,
      cancelled: false,
      terminal: false,
      localExecutionController: new AbortController(),
    };
    activeTurnRef.current = turn;
    preparingTurnRef.current = turn;
    statusIdRef.current = statusId;
    const conversationKey = JSON.stringify([projectId, runtime]);
    let conversation = conversationContextsRef.current.get(conversationKey);
    if (!conversation || conversation.sessionId !== selectedSession?.sessionId) {
      conversation = { sessionId: selectedSession?.sessionId, messages: [] };
      conversationContextsRef.current.set(conversationKey, conversation);
    }
    pushFeed({
      id: statusId,
      kind: 'status',
      status: 'running',
      text: t('canvasAgent.thinking'),
      createdAt: Date.now(),
    });
    setRunning(true);
    resetStreaming();

    try {
      const currentAssets = new Map(
        buildCanvasAssetCatalog(useCanvasStore.getState().nodes)
          .filter((asset) => asset.kind === 'image')
          .map((asset) => [asset.id, asset]),
      );
      const media = mergeTurnMedia(attachments.map((attachment) => {
        if (attachment.origin === 'upload') return attachment;
        const asset = currentAssets.get(attachment.assetId);
        if (!asset) throw new Error(t('canvasAgent.missingAttachmentBeforeSend'));
        return createAgentCanvasMediaInput(asset);
      }), extras.media);
      const skillContext = buildSkillContext({
        text: message,
        recentUserText: conversation.messages.join('\n'),
        attachmentKinds: media.length ? ['image'] : [],
        surface: 'canvas',
        explicitSkillIds: extras.explicitSkillIds,
      });
      const toolPolicy = resolveAgentToolPolicy({
        skillContext,
        supportsVision: true,
        supportsToolSearch: false,
      });
      const externalToolKinds = toolPolicy.toolKinds.filter((kind) => kind !== 'asset-read');
      const manifest = buildExternalCanvasMcpManifest(externalToolKinds);
      const allowedToolNames = [...new Set(manifest.tools.map(tool => tool.name === 'diagnostics' || tool.name === 'config_patch' || tool.name === 'asset_read' ? tool.name : 'canvas_command'))];
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
      if (!ownsTurn(turn)) return null;
      if (turn.cancelled || turn.terminal) throw new DOMException('Aborted', 'AbortError');

      sessionId = selectedSession?.sessionId;
      if (sessionId && liveSessionsRef.current.has(sessionId)
        && JSON.stringify(grantedToolsRef.current.get(sessionId)) !== JSON.stringify(allowedToolNames)) {
        closeSessionState(sessionId);
        await cancelExternalAgentSession(sessionId);
        sessionId = undefined;
      }
      if (!ownsTurn(turn)) return null;
      if (turn.cancelled || turn.terminal) throw new DOMException('Aborted', 'AbortError');
      if (!sessionId || !liveSessionsRef.current.has(sessionId)) {
        const session = await startExternalAgentSession({
          runtime,
          tools: manifest.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            annotations: tool.annotations,
            requiresApproval: true,
          })),
          resumeId: selectedSession?.threadId,
        });
        sessionId = session.sessionId;
        if (!ownsTurn(turn) || turn.cancelled || turn.terminal) {
          void cancelExternalAgentSession(sessionId).catch(() => undefined);
          if (!ownsTurn(turn) || turn.terminal) return null;
          throw new DOMException('Aborted', 'AbortError');
        }
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
      turn.sessionId = sessionId;
      conversation.sessionId = sessionId;
      activeSessionIdRef.current = sessionId;
      grantedToolsRef.current.set(sessionId, allowedToolNames);
      if (turn.cancelled) throw new DOMException('Aborted', 'AbortError');
      const prompt = [
        projectContext.brief.trim() ? `Project brief:\n${projectContext.brief.trim()}` : '',
        projectContext.pinnedNodeIds.length
          ? `Pinned canvas node ids: ${projectContext.pinnedNodeIds.join(', ')}`
          : '',
        skillContext.instructions ? `Selected Canvas skill instructions:\n${skillContext.instructions}` : '',
        `User request:\n${message}`,
      ].filter(Boolean).join('\n\n');
      const receipt = await sendExternalAgentTurn({
        sessionId,
        prompt,
        attachments: externalAttachments,
      });
      if (!ownsTurn(turn) || turn.cancelled) return null;
      turn.turnId ??= receipt.turnId;
      // An accepted new task replaces the routing seed; failed sends leave the prior task intact.
      if (receipt.accepted) {
        const recentMessages = isLikelyTaskContinuation(message) ? conversation.messages.slice(-5) : [];
        conversation.messages = [...recentMessages, message.trim().slice(0, 2_000)];
      }
      resetAttachments();
      return skillContext.selections.map(selection => selection.skill.id);
    } catch (error) {
      if (!ownsTurn(turn) || turn.terminal) return null;
      turn.terminal = true;
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
      updateFeedItem(statusId, {
        status: aborted ? 'cancelled' : 'error',
        text: aborted
          ? t('canvasAgent.cancelled')
          : error instanceof Error ? error.message : String(error),
        retryMessage: aborted ? undefined : message,
      });
      finishStreaming();
      return null;
    } finally {
      if (preparingTurnRef.current === turn) preparingTurnRef.current = null;
    }
  };

  const resolveApproval = async (
    item: Extract<AgentFeedItem, { kind: 'approval' }>,
    approve: boolean,
  ): Promise<boolean> => {
    const requestKey = `${item.runId}:${item.approvalId}`;
    const request = toolRequestsRef.current.get(requestKey);
    if (request) {
      const current = useCanvasAgentPanelStore.getState().feed.find((entry) => entry.id === item.id);
      const turn = activeTurnRef.current;
      if (current?.kind !== 'approval' || current.status !== 'pending'
        || resolvingRequestsRef.current.has(request) || !turn || !ownsTurn(turn)
        || turn.terminal || turn.sessionId !== request.sessionId) return true;
      const generation = turn.generation;
      resolvingRequestsRef.current.add(request);
      updateFeedItem(item.id, { status: approve ? 'approving' : 'rejecting' });
      syncTurnRunning(turn);
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
          signal: turn.localExecutionController.signal,
        });
        if (toolRequestsRef.current.get(requestKey) === request) toolRequestsRef.current.delete(requestKey);
        if (generation !== generationRef.current) return true;
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
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (toolRequestsRef.current.get(requestKey) === request) toolRequestsRef.current.delete(requestKey);
        if (generation !== generationRef.current) return true;
        updateFeedItem(item.id, { status: 'failed' });
        handleToolEvent({
          toolName: request.toolName,
          callId: request.callId,
          status: 'failed',
          error: message,
        });
        // Delivery failure terminates only the turn that owned this resolution.
        if (!ownsTurn(turn) || turn.terminal) return true;
        closeSessionState(request.sessionId, message);
        clearExternalSession(projectId, request.runtime);
        void cancelExternalAgentSession(request.sessionId).catch(() => undefined);
        setRunning(false);
        const statusId = turn.statusId;
        updateFeedItem(statusId, { status: 'error', text: message });
        statusIdRef.current = null;
      } finally {
        resolvingRequestsRef.current.delete(request);
        syncTurnRunning(turn);
      }
      return true;
    }
    if (!item.runtimeId) return false;
    const current = useCanvasAgentPanelStore.getState().feed.find((entry) => entry.id === item.id);
    if (current?.kind !== 'approval' || current.status !== 'pending') return true;
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
    const turn = activeTurnRef.current;
    if (!turn || turn.terminal || !ownsTurn(turn)) return;
    turn.cancelled = true;
    turn.localExecutionController.abort();
    cancelPendingRef.current = true;
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) return;
    try {
      await cancelExternalAgentSession(sessionId);
    } catch (error) {
      if (!ownsTurn(turn) || turn.terminal) return;
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
    if (selectedRuntimeId === 'builtin') return;
    conversationContextsRef.current.delete(JSON.stringify([projectId, selectedRuntimeId]));
    const turn = activeTurnRef.current;
    if (turn) {
      turn.cancelled = true;
      turn.terminal = true;
      turn.localExecutionController.abort();
      activeTurnRef.current = null;
      preparingTurnRef.current = null;
      statusIdRef.current = null;
      setRunning(false);
    }
    if (!selectedSession) return;
    const { sessionId, runtime } = selectedSession;
    const wasLive = liveSessionsRef.current.has(sessionId);
    closeSessionState(sessionId);
    clearExternalSession(projectId, runtime);
    if (wasLive) void cancelExternalAgentSession(sessionId).catch(() => undefined);
  };

  return {
    diagnostics,
    isRefreshing,
    isListening,
    eventError,
    refresh,
    executeTurn,
    resolveApproval,
    cancelTurn,
    discardCurrentSession,
  };
}
