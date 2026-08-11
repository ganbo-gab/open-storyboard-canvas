import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import { redactSensitiveValue } from '../application/agentRedaction';
import type { AgentImpactSummary } from '../application/agentApproval';
import type { AgentPlanDraft } from '../application/agentPlan';
import type {
  AgentSessionMediaReferenceView,
  CanvasAgentRuntimeId,
  ExternalAgentRuntimeId,
  ExternalAgentSessionReference,
} from '../domain/agentModel';

export interface AgentProjectContext {
  brief: string;
  pinnedNodeIds: string[];
  updatedAt: number;
}

export type AgentFeedItem =
  | { id: string; kind: 'message'; role: 'user' | 'assistant'; text: string; attachments?: AgentSessionMediaReferenceView[]; streaming?: boolean; createdAt: number }
  | { id: string; kind: 'reasoning'; summary: string; detail?: string; createdAt: number }
  | { id: string; kind: 'tool'; toolName: string; status: 'executing' | 'succeeded' | 'failed' | 'unknown'; input?: unknown; output?: unknown; error?: string; nodeIds?: string[]; receiptId?: string; rollbackToken?: string; rolledBackAt?: number; startedAt?: number; durationMs?: number; createdAt: number }
  | { id: string; kind: 'approval'; runId: string; approvalId: string; runtimeId?: ExternalAgentRuntimeId; toolName: string; summary: string; arguments: unknown; impact: AgentImpactSummary; expiresAt: number; status: 'pending' | 'approving' | 'rejecting' | 'approved' | 'rejected' | 'failed' | 'expired'; createdAt: number }
  | { id: string; kind: 'plan'; plan: AgentPlanDraft; createdAt: number }
  | { id: string; kind: 'skill'; skillIds: string[]; reason: string; estimatedTokens: number; toolCount: number; mode: 'minimal' | 'local-router' | 'tool-search'; deferredToolCount: number; createdAt: number }
  | { id: string; kind: 'status'; status: 'running' | 'completed' | 'cancelled' | 'error'; text: string; retryMessage?: string; createdAt: number };

interface CanvasAgentPanelState {
  isOpen: boolean;
  projectId: string | null;
  activeView: 'conversation' | 'history' | 'activity' | 'tasks';
  selectedModelId: string | null;
  selectedRuntimeId: CanvasAgentRuntimeId;
  activeSessionId: string | null;
  externalSessions: Record<string, Partial<Record<ExternalAgentRuntimeId, ExternalAgentSessionReference>>>;
  feed: AgentFeedItem[];
  projectContexts: Record<string, AgentProjectContext>;
  unread: number;
  setOpen: (open: boolean) => void;
  setProject: (projectId: string) => void;
  setActiveView: (view: CanvasAgentPanelState['activeView']) => void;
  setSelectedModelId: (id: string | null) => void;
  setSelectedRuntimeId: (id: CanvasAgentRuntimeId) => void;
  setActiveSessionId: (id: string | null) => void;
  setExternalSession: (projectId: string, reference: ExternalAgentSessionReference | null) => void;
  clearExternalSession: (projectId: string, runtime: ExternalAgentRuntimeId) => void;
  addFeedItem: (item: AgentFeedItem) => void;
  updateFeedItem: (id: string, patch: Partial<AgentFeedItem>) => void;
  clearFeed: () => void;
  replaceFeed: (items: AgentFeedItem[]) => void;
  setProjectBrief: (projectId: string, brief: string) => void;
  togglePinnedNode: (projectId: string, nodeId: string) => void;
  clearProjectContext: (projectId: string) => void;
}

const memoryStorageItems = new Map<string, string>();
const memoryStorage: StateStorage = {
  getItem: (name) => memoryStorageItems.get(name) ?? null,
  setItem: (name, value) => { memoryStorageItems.set(name, value); },
  removeItem: (name) => { memoryStorageItems.delete(name); },
};

function panelStorage(): StateStorage {
  try {
    return typeof window !== 'undefined' && window.localStorage
      ? window.localStorage
      : memoryStorage;
  } catch {
    return memoryStorage;
  }
}

function persistableFeed(feed: AgentFeedItem[]): AgentFeedItem[] {
  return feed.slice(-500).flatMap((item) => {
    if (item.kind === 'status' && item.status === 'running') return [];
    if (item.kind === 'message' && item.streaming) return [{ ...item, streaming: false }];
    if (item.kind === 'approval' && item.runtimeId && ['pending', 'approving', 'rejecting'].includes(item.status)) {
      return [{ ...item, status: 'expired' }];
    }
    if (item.kind === 'approval' && (item.status === 'approving' || item.status === 'rejecting')) {
      return [{ ...item, status: 'pending' }];
    }
    return [item];
  });
}

function boundedExternalSessionReference(
  reference: ExternalAgentSessionReference,
): ExternalAgentSessionReference {
  return {
    runtime: reference.runtime,
    sessionId: reference.sessionId.trim().slice(0, 256),
    threadId: reference.threadId?.trim().slice(0, 256) || undefined,
  };
}

export const useCanvasAgentPanelStore = create<CanvasAgentPanelState>()(persist((set, get) => ({
  isOpen: false,
  projectId: null,
  activeView: 'conversation',
  selectedModelId: null,
  selectedRuntimeId: 'builtin',
  activeSessionId: null,
  externalSessions: {},
  feed: [],
  projectContexts: {},
  unread: 0,
  setOpen: (isOpen) => set({ isOpen, unread: isOpen ? 0 : get().unread }),
  setProject: (projectId) => set((state) => state.projectId === projectId ? state : {
    projectId,
    activeSessionId: null,
    feed: [],
    unread: 0,
  }),
  setActiveView: (activeView) => set({ activeView }),
  setSelectedModelId: (selectedModelId) => set({ selectedModelId }),
  setSelectedRuntimeId: (selectedRuntimeId) => set({ selectedRuntimeId }),
  setActiveSessionId: (activeSessionId) => set({ activeSessionId }),
  setExternalSession: (projectId, reference) => set((state) => {
    const projectSessions = { ...(state.externalSessions[projectId] ?? {}) };
    if (reference) projectSessions[reference.runtime] = boundedExternalSessionReference(reference);
    else {
      delete projectSessions.codex;
      delete projectSessions.claude;
    }
    return {
      externalSessions: {
        ...state.externalSessions,
        [projectId]: projectSessions,
      },
    };
  }),
  clearExternalSession: (projectId, runtime) => set((state) => {
    const projectSessions = { ...(state.externalSessions[projectId] ?? {}) };
    delete projectSessions[runtime];
    const externalSessions = { ...state.externalSessions };
    if (Object.keys(projectSessions).length) externalSessions[projectId] = projectSessions;
    else delete externalSessions[projectId];
    return { externalSessions };
  }),
  addFeedItem: (item) => set((state) => ({ feed: [...state.feed.slice(-499), redactSensitiveValue(item)], unread: state.isOpen ? state.unread : state.unread + 1 })),
  updateFeedItem: (id, patch) => set((state) => ({ feed: state.feed.map((item) => item.id === id ? redactSensitiveValue({ ...item, ...patch }) as AgentFeedItem : item) })),
  clearFeed: () => set({ feed: [], activeSessionId: null }),
  replaceFeed: (feed) => set({ feed: redactSensitiveValue(feed.slice(-500)), unread: 0 }),
  setProjectBrief: (projectId, brief) => set((state) => ({
    projectContexts: {
      ...state.projectContexts,
      [projectId]: {
        brief: brief.slice(0, 8_000),
        pinnedNodeIds: state.projectContexts[projectId]?.pinnedNodeIds ?? [],
        updatedAt: Date.now(),
      },
    },
  })),
  togglePinnedNode: (projectId, nodeId) => set((state) => {
    const current = state.projectContexts[projectId] ?? { brief: '', pinnedNodeIds: [], updatedAt: 0 };
    const hasNode = current.pinnedNodeIds.includes(nodeId);
    return {
      projectContexts: {
        ...state.projectContexts,
        [projectId]: {
          ...current,
          pinnedNodeIds: hasNode
            ? current.pinnedNodeIds.filter((id) => id !== nodeId)
            : [...current.pinnedNodeIds, nodeId].slice(-12),
          updatedAt: Date.now(),
        },
      },
    };
  }),
  clearProjectContext: (projectId) => set((state) => {
    const projectContexts = { ...state.projectContexts };
    delete projectContexts[projectId];
    return { projectContexts };
  }),
}), {
  name: 'storyboard-copilot:canvas-agent-panel:v1',
  storage: createJSONStorage(panelStorage),
  partialize: (state) => ({
    projectId: state.projectId,
    selectedModelId: state.selectedModelId,
    selectedRuntimeId: state.selectedRuntimeId,
    activeSessionId: state.activeSessionId,
    externalSessions: redactSensitiveValue(state.externalSessions),
    feed: persistableFeed(state.feed),
    projectContexts: redactSensitiveValue(state.projectContexts),
  }),
}));

export function nextAgentFeedId(prefix: string): string {
  return globalThis.crypto?.randomUUID?.() ?? `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
