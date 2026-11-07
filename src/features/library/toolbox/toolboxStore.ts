import { create } from 'zustand';
import { z } from 'zod';
import { createWorkspaceDocument } from '@/features/workbench/application/workspaceDocument';
import type { LocalDocument, LocalStorageStatus } from '@/features/workbench/application/workbenchPersistence';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import type { CanvasNode, CanvasEdge } from '@/features/canvas/domain/canvasNodes';
import { instantiateTemplate, saveGroupAsTemplate, ToolboxError, type ToolboxTemplate } from './toolbox';

export interface ToolboxData { templates: ToolboxTemplate[] }
const templateSchema = z.object({ id: z.string().min(1), name: z.string().trim().min(1), color: z.string().optional(), createdAt: z.number().finite(), nodes: z.array(z.object({ id: z.string(), type: z.string(), position: z.object({ x: z.number().finite(), y: z.number().finite() }), data: z.record(z.string(), z.unknown()) }).passthrough()), edges: z.array(z.object({ id: z.string(), source: z.string(), target: z.string() }).passthrough()), bounds: z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().nonnegative(), height: z.number().nonnegative() }) });
export function normalizeToolboxData(value: unknown): ToolboxData {
  const parsed = z.object({ templates: z.array(templateSchema) }).parse(value);
  if (new Set(parsed.templates.map(template => template.id)).size !== parsed.templates.length) throw new ToolboxError('invalid-template', 'Duplicate template ids');
  return parsed as ToolboxData;
}
export interface ToolboxState extends ToolboxData {
  initialized: boolean;
  storageStatus: LocalStorageStatus;
  initialize(): Promise<void>;
  saveGroup(groupNodeId: string, nodes: CanvasNode[], edges: CanvasEdge[], options?: { name?: string; color?: string }): Promise<ToolboxTemplate>;
  rename(id: string, name: string): void;
  setColor(id: string, color?: string): void;
  remove(id: string): void;
}
export function createToolboxStore(document: LocalDocument<ToolboxData>) {
  return create<ToolboxState>((set, get) => {
    const persist = (templates: ToolboxTemplate[]) => {
      if (!get().initialized) throw new ToolboxError('invalid-template', 'Initialize the toolbox before editing');
      document.save({ templates }); set({ templates, storageStatus: document.status() });
      const flush = document.flush?.();
      if (flush) void flush.then(
        () => set({ storageStatus: document.status() }),
        () => set({ storageStatus: document.status() }),
      );
    };
    return {
      templates: [], initialized: false, storageStatus: document.status(),
      async initialize() { if (get().initialized) return; await document.initialize?.(); set({ ...document.load(), initialized: true, storageStatus: document.status() }); },
      async saveGroup(groupNodeId, nodes, edges, options) {
        await get().initialize();
        const template = await saveGroupAsTemplate(groupNodeId, nodes, edges, options);
        persist([...get().templates, template]); return template;
      },
      rename(id, name) {
        if (!name.trim()) throw new ToolboxError('invalid-template', 'Template name is required');
        if (!get().templates.some(template => template.id === id)) throw new ToolboxError('invalid-template', 'Unknown template');
        persist(get().templates.map(template => template.id === id ? { ...template, name: name.trim() } : template));
      },
      setColor(id, color) { persist(get().templates.map(template => template.id === id ? { ...template, color } : template)); },
      remove(id) { persist(get().templates.filter(template => template.id !== id)); },
    };
  });
}
export const useToolboxStore = createToolboxStore(createWorkspaceDocument<ToolboxData>('storyboard-copilot:toolbox:v1', () => ({ templates: [] }), normalizeToolboxData));
/** Exactly the same optimistic graph transaction used by internal paste: one edit / one undo step. */
export function applyTemplateToCanvas(template: ToolboxTemplate, position: { x: number; y: number }): { nodeIds: string[]; revision: number } {
  const state = useCanvasStore.getState();
  const graph = instantiateTemplate(template, position, { existingNodes: state.nodes, existingEdges: state.edges });
  const revision = state.commitGraphTransaction({ expectedRevision: state.revision,
    nodes: [...state.nodes.map(node => node.selected ? { ...node, selected: false } : node), ...graph.nodes.map(node => ({ ...node, selected: true }))],
    edges: [...state.edges, ...graph.edges], selectedNodeId: graph.nodes[0]?.id ?? null });
  if (revision === null) throw new ToolboxError('revision-conflict', 'Canvas changed before applying the template');
  const next = useCanvasStore.getState();
  const project = useProjectStore.getState();
  if (project.currentProject) project.saveCurrentProject(next.nodes, next.edges, project.currentProject.viewport, next.history);
  return { nodeIds: graph.nodes.map(node => node.id), revision };
}
