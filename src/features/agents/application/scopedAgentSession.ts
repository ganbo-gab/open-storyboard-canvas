import type { ChatCatalogEntry } from '@/features/canvas/application/chatModelCatalog';
import type { AgentScope, AgentTurnMediaInput } from '@/features/canvas/agent/domain/agentModel';
import type { CanvasAgentToolEvent } from '@/features/canvas/agent/infrastructure/sdkRuntime';
import {
  runCanvasAgentTurn, resolveCanvasAgentApproval, cancelCanvasAgentRun,
  listCanvasAgentSessions, getCanvasAgentSession, getCanvasAgentSessionMessages,
  listPendingCanvasAgentApprovals,
  type AgentApprovalView, type CanvasAgentSessionMessage, type CanvasAgentTurnResult,
} from '@/features/canvas/agent/application/canvasAgentController';
import type { CanvasAgentExecutionMode } from '@/features/canvas/agent/application/agentAutoApprovalPolicy';
import { redactSensitiveValue } from '@/features/canvas/agent/application/agentRedaction';
import type { AgentSessionRecord } from '@/features/canvas/agent/infrastructure/agentSessionRepository';

export interface ScopedAgentSnapshot {
  scope: AgentScope;
  projectId: string;
  sessionId?: string;
  runId?: string;
  status: 'idle' | 'running' | 'awaiting-approval' | 'completed' | 'cancelled' | 'error';
  messages: CanvasAgentSessionMessage[];
  toolEvents: CanvasAgentToolEvent[];
  approvals: AgentApprovalView[];
  liveText: string;
  reasoningSummary: string;
  error?: string;
}
export interface ScopedAgentSendInput {
  message: string;
  model: ChatCatalogEntry;
  executionMode?: CanvasAgentExecutionMode;
  media?: AgentTurnMediaInput[];
  generationPreferences?: Parameters<typeof runCanvasAgentTurn>[0]['generationPreferences'];
}

export interface ScopedAgentSession {
  getSnapshot(): ScopedAgentSnapshot;
  subscribe(listener: () => void): () => void;
  listSessions(): AgentSessionRecord[];
  loadSession(sessionId: string): void;
  newSession(): void;
  send(input: ScopedAgentSendInput): Promise<CanvasAgentTurnResult | undefined>;
  resolveApproval(input: { approvalId: string; approve: boolean; model: ChatCatalogEntry }): Promise<CanvasAgentTurnResult | undefined>;
  stop(): void;
}

export interface ScopedAgentSessionOptions {
  scope: AgentScope;
  projectId?: string;
}

const scopedSessions = new Map<string, ScopedAgentSession>();

/** Application lifetime owner: navigation unsubscribes, never discards a run or approvals. */
export function getScopedAgentSession(options: ScopedAgentSessionOptions): ScopedAgentSession {
  const projectId = options.scope === 'home' ? options.projectId ?? 'home' : options.projectId;
  if (!projectId) throw new Error('画布和舞台会话必须指定 projectId。');
  const key = JSON.stringify([options.scope, projectId]);
  const existing = scopedSessions.get(key);
  if (existing) return existing;
  const session = createScopedAgentSession({ scope: options.scope, projectId });
  scopedSessions.set(key, session);
  return session;
}

/** One store per surface/project. Compatible with React useSyncExternalStore. */
export function createScopedAgentSession(options: ScopedAgentSessionOptions): ScopedAgentSession {
  const projectId = options.scope === 'home' ? options.projectId ?? 'home' : options.projectId;
  if (!projectId) throw new Error('画布和舞台会话必须指定 projectId。');
  let snapshot: ScopedAgentSnapshot = { scope: options.scope, projectId, status: 'idle', messages: [], toolEvents: [], approvals: [], liveText: '', reasoningSummary: '' };
  const listeners = new Set<() => void>();
  let controller: AbortController | undefined;
  let busy = false;
  const publish = (patch: Partial<ScopedAgentSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };
  const callbacks = {
    onTextDelta: (delta: string) => publish({ liveText: snapshot.liveText + delta }),
    onReasoningDelta: (delta: string) => publish({ reasoningSummary: snapshot.reasoningSummary + delta }),
    onToolEvent: (event: CanvasAgentToolEvent) => {
      const events = [...snapshot.toolEvents];
      const index = event.callId ? events.findIndex((item) => item.callId === event.callId && item.toolName === event.toolName) : -1;
      if (index < 0) events.push(event);
      else events[index] = { ...events[index], ...event };
      publish({ toolEvents: events });
    },
  };
  const finish = (result: CanvasAgentTurnResult) => {
    publish({ sessionId: result.sessionId, runId: result.runId, status: result.status,
      approvals: result.approvals, messages: getCanvasAgentSessionMessages(result.sessionId), liveText: '',
    });
  };
  const fail = (error: unknown) => {
    const cancelled = controller?.signal.aborted || (error instanceof Error && error.name === 'AbortError');
    publish({ status: cancelled ? 'cancelled' : 'error', approvals: [], liveText: '',
      error: cancelled ? undefined : redactSensitiveValue(error instanceof Error ? error.message : String(error)),
    });
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    listSessions: () => listCanvasAgentSessions(projectId, options.scope),
    loadSession(sessionId: string) {
      if (busy || snapshot.status === 'awaiting-approval') throw new Error('请先停止当前回合。');
      const session = getCanvasAgentSession(sessionId);
      if (!session || session.projectId !== projectId || (session.scope ?? 'canvas') !== options.scope) throw new Error('会话不属于此项目或作用域。');
      const approvals = listPendingCanvasAgentApprovals(projectId, sessionId);
      const runIds = new Set(approvals.map((approval) => approval.runId));
      if (runIds.size > 1) throw new Error('会话存在多个未处理回合；请先处理原会话审批。');
      controller = undefined;
      publish({ sessionId, runId: approvals[0]?.runId, status: approvals.length ? 'awaiting-approval' : 'idle',
        messages: getCanvasAgentSessionMessages(sessionId), approvals, toolEvents: [], error: undefined, liveText: '', reasoningSummary: '',
      });
    },
    newSession() {
      if (busy || snapshot.status === 'awaiting-approval') throw new Error('请先停止当前回合。');
      controller = undefined;
      publish({ sessionId: undefined, runId: undefined, status: 'idle', messages: [], toolEvents: [], approvals: [], error: undefined, liveText: '', reasoningSummary: '' });
    },
    async send(input: ScopedAgentSendInput) {
      if (busy || snapshot.status === 'awaiting-approval') throw new Error('当前回合尚未完成；请停止或处理审批。');
      if (!input.message.trim()) throw new Error('消息不能为空。');
      busy = true;
      controller = new AbortController();
      publish({ status: 'running', error: undefined, liveText: '', reasoningSummary: '', approvals: [],
        messages: [...snapshot.messages, { role: 'user', text: input.message, mediaReferences: [], createdAt: Date.now() }],
      });
      try {
        const result = await runCanvasAgentTurn({ ...input, projectId, scope: options.scope, sessionId: snapshot.sessionId, signal: controller.signal, ...callbacks });
        if (controller.signal.aborted) { cancelCanvasAgentRun(result.runId); publish({ status: 'cancelled', approvals: [], sessionId: result.sessionId, runId: result.runId }); return; }
        finish(result);
        return result;
      } catch (error) { fail(error); throw error; }
      finally { busy = false; }
    },
    async resolveApproval(input: { approvalId: string; approve: boolean; model: ChatCatalogEntry }) {
      if (busy || snapshot.status !== 'awaiting-approval' || !snapshot.runId || !snapshot.approvals.some((approval) => approval.id === input.approvalId)) throw new Error('审批已失效或正在处理。');
      if (controller?.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      busy = true;
      controller ??= new AbortController();
      publish({ status: 'running', error: undefined, liveText: '' });
      try {
        const result = await resolveCanvasAgentApproval({ ...input, runId: snapshot.runId, signal: controller.signal, ...callbacks });
        if (controller.signal.aborted) { cancelCanvasAgentRun(result.runId); publish({ status: 'cancelled', approvals: [] }); return; }
        finish(result);
        return result;
      } catch (error) { fail(error); throw error; }
      finally { busy = false; }
    },
    stop() {
      controller?.abort();
      if (snapshot.runId) cancelCanvasAgentRun(snapshot.runId);
      publish({ status: 'cancelled', approvals: [], liveText: '' });
    },
  };
}
