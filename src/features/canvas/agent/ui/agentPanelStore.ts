import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import { redactSensitiveValue } from '../application/agentRedaction';
import type { AgentImpactSummary } from '../application/agentApproval';
import type { AgentPlanDraft } from '../application/agentPlan';
import type { AgentSessionMediaReferenceView } from '../domain/agentModel';

export interface AgentProjectContext {
  brief: string;
  pinnedNodeIds: string[];
  updatedAt: number;
}

export type AgentFeedItem =
  | { id: string; kind: 'message'; role: 'user' | 'assistant'; text: string; attachments?: AgentSessionMediaReferenceView[]; streaming?: boolean; createdAt: number }
  | { id: string; kind: 'reasoning'; summary: string; detail?: string; createdAt: number }
  | { id: string; kind: 'tool'; toolName: string; status: 'executing' | 'succeeded' | 'failed' | 'unknown'; input?: unknown; output?: unknown; error?: string; nodeIds?: string[]; receiptId?: string; rollbackToken?: string; rolledBackAt?: number; startedAt?: number; durationMs?: number; createdAt: number }
  | { id: string; kind: 'approval'; runId: string; approvalId: string; toolName: string; summary: string; arguments: unknown; impact: AgentImpactSummary; expiresAt: number; status: 'pending' | 'approving' | 'rejecting' | 'approved' | 'rejected' | 'expired'; createdAt: number }
  | { id: string; kind: 'plan'; plan: AgentPlanDraft; createdAt: number }
  | { id: string; kind: 'skill'; skillIds: string[]; reason: string; estimatedTokens: number; toolCount: number; mode: 'minimal' | 'local-router' | 'tool-search'; deferredToolCount: number; createdAt: number }
  | { id: string; kind: 'status'; status: 'running' | 'completed' | 'cancelled' | 'error'; text: string; retryMessage?: string; createdAt: number };

interface CanvasAgentPanelState {
  isOpen: boolean;
  projectId: string | null;
  activeView: 'conversation' | 'history' | 'activity';
  selectedModelId: string | null;
  activeSessionId: string | null;
  feed: AgentFeedItem[];
  projectContexts: Record<string, AgentProjectContext>;
  unread: number;
  setOpen: (open: boolean) => void;
  setProject: (projectId: string) => void;
  setActiveView: (view: CanvasAgentPanelState['activeView']) => void;
  setSelectedModelId: (id: string | null) => void;
  setActiveSessionId: (id: string | null) => void;
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
    if (item.kind === 'approval' && (item.status === 'approving' || item.status === 'rejecting')) {
      return [{ ...item, status: 'pending' }];
    }
    return [item];
  });
}

export const useCanvasAgentPanelStore = create<CanvasAgentPanelState>()(persist((set, get) => ({
  isOpen: false,
  projectId: null,
  activeView: 'conversation',
  selectedModelId: null,
  activeSessionId: null,
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
  setActiveSessionId: (activeSessionId) => set({ activeSessionId }),
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
    activeSessionId: state.activeSessionId,
    feed: persistableFeed(state.feed),
    projectContexts: redactSensitiveValue(state.projectContexts),
  }),
}));

export function nextAgentFeedId(prefix: string): string {
  return globalThis.crypto?.randomUUID?.() ?? `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
