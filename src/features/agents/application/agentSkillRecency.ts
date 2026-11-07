import { create, type StoreApi, type UseBoundStore } from 'zustand';
import { z } from 'zod';
import type { AgentScope } from '@/features/canvas/agent/domain/agentModel';
import { createWorkspaceDocument } from '@/features/workbench/application/workspaceDocument';
import type { LocalDocument, LocalStorageStatus } from '@/features/workbench/application/workbenchPersistence';

export type AgentSkillRecencyBySurface = Record<AgentScope, string[]>;

export interface AgentSkillRecencyData {
  recentBySurface: AgentSkillRecencyBySurface;
}

export interface AgentSkillRecencyState extends AgentSkillRecencyData {
  initialized: boolean;
  storageStatus: LocalStorageStatus;
  initialize(): Promise<void>;
  /** Record only skills actually sent/used. IDs in the same batch retain caller order. */
  recordUse(scope: AgentScope, ids: readonly string[]): Promise<void>;
}

const recentIdsSchema = z.array(z.string().min(1)).transform((ids) => [...new Set(ids)].slice(0, 8));
const dataSchema = z.object({
  recentBySurface: z.object({ home: recentIdsSchema, canvas: recentIdsSchema, stage: recentIdsSchema }),
});
const initialData = (): AgentSkillRecencyData => ({ recentBySurface: { home: [], canvas: [], stage: [] } });

export function createAgentSkillRecencyStore(storage: LocalDocument<AgentSkillRecencyData>): UseBoundStore<StoreApi<AgentSkillRecencyState>> {
  return create<AgentSkillRecencyState>((set, get) => {
    let initializing: Promise<void> | undefined;
    return {
      ...initialData(),
      initialized: false,
      storageStatus: storage.status(),
      initialize() {
        if (get().initialized) return Promise.resolve();
        if (!initializing) initializing = (async () => {
          await storage.initialize?.();
          set({ ...dataSchema.parse(storage.load()), initialized: true, storageStatus: storage.status() });
        })().finally(() => { initializing = undefined; });
        return initializing;
      },
      async recordUse(scope, ids) {
        if (!ids.length) return;
        await get().initialize();
        // Recency is metadata, not an availability registry: callers intersect these IDs with their current surface skills.
        const recentBySurface: AgentSkillRecencyBySurface = {
          ...get().recentBySurface,
          [scope]: recentIdsSchema.parse([...ids, ...get().recentBySurface[scope]]),
        };
        storage.save({ recentBySurface });
        set({ recentBySurface, storageStatus: storage.status() });
        try { await storage.flush?.(); }
        finally { set({ storageStatus: storage.status() }); }
      },
    };
  });
}

export const useAgentSkillRecencyStore = createAgentSkillRecencyStore(createWorkspaceDocument<AgentSkillRecencyData>(
  'storyboard-copilot:agent-skill-recency:v1', initialData, (input) => dataSchema.parse(input),
));
