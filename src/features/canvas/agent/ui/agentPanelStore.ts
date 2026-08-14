import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import { redactSensitiveValue } from '../application/agentRedaction';
import type { AgentImpactSummary } from '../application/agentApproval';
import type { AgentPlanDraft } from '../application/agentPlan';
import type {
  AgentSessionMediaReferenceView,
  ExternalAgentRuntimeId,
  ExternalAgentSessionReference,
} from '../domain/agentModel';

export const CANVAS_AGENT_PANEL_DEFAULT_WIDTH = 420;
export const CANVAS_AGENT_PANEL_MIN_WIDTH = 340;
export const CANVAS_AGENT_PANEL_MAX_WIDTH = 620;

export type CanvasAgentView = 'conversation' | 'history' | 'tasks';
export type AgentExecutionMode = 'manual' | 'auto';

export interface AgentGenerationPreferences {
  imageModelId: string | null;
  videoModelId: string | null;
}

/**
 * Compatibility-only input for the retired in-panel external runtime hook.
 * It is deliberately not part of the persisted panel state.
 */
export interface AgentProjectContext {
  brief: string;
  pinnedNodeIds: string[];
  updatedAt: number;
}

export type AgentFeedItem =
  | { id: string; kind: 'message'; role: 'user' | 'assistant'; text: string; attachments?: AgentSessionMediaReferenceView[]; streaming?: boolean; createdAt: number }
  | { id: string; kind: 'reasoning'; summary: string; detail?: string; createdAt: number }
  | { id: string; kind: 'tool'; toolName: string; status: 'executing' | 'succeeded' | 'failed' | 'warning' | 'unknown'; input?: unknown; output?: unknown; error?: string; nodeIds?: string[]; generationInputNodeIds?: string[]; generationResultNodeIds?: string[]; receiptId?: string; rollbackToken?: string; rolledBackAt?: number; startedAt?: number; durationMs?: number; createdAt: number }
  | { id: string; kind: 'approval'; runId: string; approvalId: string; runtimeId?: ExternalAgentRuntimeId; toolName: string; summary: string; arguments: unknown; impact: AgentImpactSummary; expiresAt: number; status: 'pending' | 'approving' | 'rejecting' | 'approved' | 'rejected' | 'failed' | 'expired'; createdAt: number }
  | { id: string; kind: 'plan'; plan: AgentPlanDraft; createdAt: number }
  | { id: string; kind: 'skill'; skillIds: string[]; reason: string; estimatedTokens: number; toolCount: number; mode: 'minimal' | 'local-router' | 'tool-search'; deferredToolCount: number; createdAt: number }
  | { id: string; kind: 'status'; status: 'running' | 'completed' | 'cancelled' | 'error'; text: string; retryMessage?: string; diagnosticMessage?: string; createdAt: number };

interface CanvasAgentPanelState {
  isOpen: boolean;
  projectId: string | null;
  activeView: CanvasAgentView;
  selectedModelId: string | null;
  selectedImageModelId: string | null;
  selectedVideoModelId: string | null;
  executionMode: AgentExecutionMode;
  autoModeAcknowledged: boolean;
  showCompletedTools: boolean;
  panelWidth: number;
  activeSessionId: string | null;
  externalSessions: Record<string, Partial<Record<ExternalAgentRuntimeId, ExternalAgentSessionReference>>>;
  feed: AgentFeedItem[];
  unread: number;
  setOpen: (open: boolean) => void;
  setProject: (projectId: string) => void;
  setActiveView: (view: CanvasAgentView) => void;
  setSelectedModelId: (id: string | null) => void;
  setSelectedImageModelId: (id: string | null) => void;
  setSelectedVideoModelId: (id: string | null) => void;
  setExecutionMode: (mode: AgentExecutionMode) => void;
  acknowledgeAutoMode: () => void;
  setShowCompletedTools: (show: boolean) => void;
  setPanelWidth: (width: number) => void;
  resetPanelWidth: () => void;
  setActiveSessionId: (id: string | null) => void;
  setExternalSession: (projectId: string, reference: ExternalAgentSessionReference | null) => void;
  clearExternalSession: (projectId: string, runtime: ExternalAgentRuntimeId) => void;
  addFeedItem: (item: AgentFeedItem) => void;
  updateFeedItem: (id: string, patch: Partial<AgentFeedItem>) => void;
  clearFeed: () => void;
  replaceFeed: (items: AgentFeedItem[]) => void;
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

export function clampCanvasAgentPanelWidth(width: number): number {
  if (!Number.isFinite(width)) return CANVAS_AGENT_PANEL_DEFAULT_WIDTH;
  return Math.round(Math.min(CANVAS_AGENT_PANEL_MAX_WIDTH, Math.max(CANVAS_AGENT_PANEL_MIN_WIDTH, width)));
}

const LEGACY_INFERRED_PROVIDER_FAILURE_PREFIXES = [
  '当前 Agent 文本模型的账号配额已用尽。',
  '当前 Agent 文本模型正在限流。',
  'The account for the current Agent text model has exhausted its quota.',
  'The current Agent text model is being rate-limited.',
] as const;

export function isLegacyInferredAgentFailure(item: AgentFeedItem): boolean {
  return item.kind === 'status'
    && item.status === 'error'
    && LEGACY_INFERRED_PROVIDER_FAILURE_PREFIXES.some((prefix) => item.text.startsWith(prefix));
}

function persistableFeed(feed: AgentFeedItem[]): AgentFeedItem[] {
  return feed.slice(-500).flatMap((item) => {
    if (isLegacyInferredAgentFailure(item)) return [];
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

type PersistedPanelState = Partial<Pick<CanvasAgentPanelState,
  | 'projectId'
  | 'activeView'
  | 'selectedModelId'
  | 'selectedImageModelId'
  | 'selectedVideoModelId'
  | 'executionMode'
  | 'autoModeAcknowledged'
  | 'showCompletedTools'
  | 'panelWidth'
  | 'activeSessionId'
  | 'feed'
>> & { activeView?: CanvasAgentView | 'activity' };

export function migrateCanvasAgentPanelState(value: unknown): PersistedPanelState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const legacy = value as PersistedPanelState;
  const autoModeAcknowledged = legacy.autoModeAcknowledged === true;
  return {
    projectId: typeof legacy.projectId === 'string' ? legacy.projectId : null,
    activeView: legacy.activeView === 'history' || legacy.activeView === 'tasks'
      ? legacy.activeView
      : 'conversation',
    selectedModelId: typeof legacy.selectedModelId === 'string' ? legacy.selectedModelId : null,
    selectedImageModelId: typeof legacy.selectedImageModelId === 'string' ? legacy.selectedImageModelId : null,
    selectedVideoModelId: typeof legacy.selectedVideoModelId === 'string' ? legacy.selectedVideoModelId : null,
    executionMode: legacy.executionMode === 'auto' && autoModeAcknowledged ? 'auto' : 'manual',
    autoModeAcknowledged,
    showCompletedTools: legacy.showCompletedTools === true,
    panelWidth: clampCanvasAgentPanelWidth(Number(legacy.panelWidth ?? CANVAS_AGENT_PANEL_DEFAULT_WIDTH)),
    activeSessionId: typeof legacy.activeSessionId === 'string' ? legacy.activeSessionId : null,
    feed: Array.isArray(legacy.feed) ? legacy.feed.filter((item) => !isLegacyInferredAgentFailure(item)) : [],
  };
}

export const useCanvasAgentPanelStore = create<CanvasAgentPanelState>()(persist((set, get) => ({
  isOpen: false,
  projectId: null,
  activeView: 'conversation',
  selectedModelId: null,
  selectedImageModelId: null,
  selectedVideoModelId: null,
  executionMode: 'manual',
  autoModeAcknowledged: false,
  showCompletedTools: false,
  panelWidth: CANVAS_AGENT_PANEL_DEFAULT_WIDTH,
  activeSessionId: null,
  externalSessions: {},
  feed: [],
  unread: 0,
  setOpen: (isOpen) => set({ isOpen, unread: isOpen ? 0 : get().unread }),
  setProject: (projectId) => set((state) => state.projectId === projectId ? state : {
    projectId,
    activeSessionId: null,
    activeView: 'conversation',
    feed: [],
    unread: 0,
  }),
  setActiveView: (activeView) => set({ activeView }),
  setSelectedModelId: (selectedModelId) => set({ selectedModelId }),
  setSelectedImageModelId: (selectedImageModelId) => set({ selectedImageModelId }),
  setSelectedVideoModelId: (selectedVideoModelId) => set({ selectedVideoModelId }),
  setExecutionMode: (executionMode) => set((state) => executionMode === 'manual'
    ? { executionMode, autoModeAcknowledged: false }
    : state.autoModeAcknowledged ? { executionMode } : state),
  acknowledgeAutoMode: () => set({ autoModeAcknowledged: true, executionMode: 'auto' }),
  setShowCompletedTools: (showCompletedTools) => set({ showCompletedTools }),
  setPanelWidth: (panelWidth) => set({ panelWidth: clampCanvasAgentPanelWidth(panelWidth) }),
  resetPanelWidth: () => set({ panelWidth: CANVAS_AGENT_PANEL_DEFAULT_WIDTH }),
  setActiveSessionId: (activeSessionId) => set({ activeSessionId }),
  setExternalSession: (projectId, reference) => set((state) => {
    const projectSessions = { ...(state.externalSessions[projectId] ?? {}) };
    if (reference) {
      projectSessions[reference.runtime] = {
        runtime: reference.runtime,
        sessionId: reference.sessionId.trim().slice(0, 256),
        threadId: reference.threadId?.trim().slice(0, 256) || undefined,
      };
    } else {
      delete projectSessions.codex;
      delete projectSessions.claude;
    }
    const externalSessions = { ...state.externalSessions };
    if (Object.keys(projectSessions).length) externalSessions[projectId] = projectSessions;
    else delete externalSessions[projectId];
    return { externalSessions };
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
}), {
  name: 'storyboard-copilot:canvas-agent-panel:v1',
  version: 3,
  storage: createJSONStorage(panelStorage),
  migrate: migrateCanvasAgentPanelState,
  partialize: (state) => ({
    projectId: state.projectId,
    activeView: state.activeView,
    selectedModelId: state.selectedModelId,
    selectedImageModelId: state.selectedImageModelId,
    selectedVideoModelId: state.selectedVideoModelId,
    executionMode: state.executionMode,
    autoModeAcknowledged: state.autoModeAcknowledged,
    showCompletedTools: state.showCompletedTools,
    panelWidth: state.panelWidth,
    activeSessionId: state.activeSessionId,
    feed: persistableFeed(state.feed),
  }),
}));

export function nextAgentFeedId(prefix: string): string {
  return globalThis.crypto?.randomUUID?.() ?? `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
