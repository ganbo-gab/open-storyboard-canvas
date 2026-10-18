import type { z } from 'zod';
import { useCanvasStore } from '@/stores/canvasStore';
import { CANVAS_NODE_TYPES, isBlueprintNode } from '@/features/canvas/domain/canvasNodes';
import { canvasNodeFactory } from '@/features/canvas/application/canvasServices';
import { canvasCommandRegistry } from '@/features/canvas/application/canvasCommandService';
import { buildCanvasAssetCatalog } from '@/features/canvas/application/canvasAssetCatalog';
import { resolveAsset } from '@/features/assets/application/assetCatalog';
import type { StageCommand, StageMutationResult, StageSceneDraft, StageSnapshot, StageWorkspace } from '../domain/stage';
import { stageCommandSchema, stageCreateInputSchema } from '../domain/stageSchemas';
import { prepareStageCommands } from './stageOperations';
import { draftStageScene } from './stageDrafting';
export { stageCommandSchema, stageCreateInputSchema, stageDraftInputSchema, stageSceneDraftSchema } from '../domain/stageSchemas';
export type { StageCommand, StageSnapshot, StageWorkspace, StageDraftRequest, StageSceneDraft } from '../domain/stage';

export interface StageViewportBridge {
  /** Must create/persist a real image asset using the existing screenshot workflow. */
  capture: () => Promise<{ assetId: string }>;
  setWorkspace?: (workspace: StageWorkspace) => void;
}
const viewports = new Map<string, StageViewportBridge>();
const requestedWorkspaces = new Map<string, StageWorkspace>();
export function registerStageViewport(nodeId: string, bridge: StageViewportBridge): () => void {
  viewports.set(nodeId, bridge);
  const workspace = requestedWorkspaces.get(nodeId);
  if (workspace) { bridge.setWorkspace?.(workspace); requestedWorkspaces.delete(nodeId); }
  return () => { if (viewports.get(nodeId) === bridge) viewports.delete(nodeId); };
}
export const stageCommandEffects: Record<StageCommand['type'], { effect: 'graph'; destructive: boolean }> = {
  'object.add': { effect: 'graph', destructive: false }, 'object.update': { effect: 'graph', destructive: false }, 'object.remove': { effect: 'graph', destructive: true },
  'camera.lookAt': { effect: 'graph', destructive: false }, 'trajectory.set': { effect: 'graph', destructive: true },
  'clip.add': { effect: 'graph', destructive: false }, 'clip.update': { effect: 'graph', destructive: false }, 'clip.split': { effect: 'graph', destructive: false }, 'clip.delete': { effect: 'graph', destructive: true },
  'keyframe.add': { effect: 'graph', destructive: false }, 'keyframe.update': { effect: 'graph', destructive: false }, 'keyframe.remove': { effect: 'graph', destructive: true },
  'draft.apply': { effect: 'graph', destructive: false }, 'playback.update': { effect: 'graph', destructive: false },
};

export function createStageCommands() {
  const query = (nodeId?: string): StageSnapshot => {
    const state = useCanvasStore.getState();
    const id = nodeId ?? state.activeDirectorStudioNodeId ?? state.activeToolDialog?.nodeId ?? state.selectedNodeId;
    const node = state.nodes.find((entry) => entry.id === id);
    if (!isBlueprintNode(node)) throw new Error('Select or supply an existing stage node.');
    // Never expose mutable references to persisted objects outside the store.
    return { nodeId: node.id, revision: state.revision, data: structuredClone(node.data) };
  };
  const execute = (nodeId: string, input: StageCommand | StageCommand[], expectedRevision?: number): StageMutationResult => {
    const commands = Array.isArray(input) ? input : [input];
    if (!commands.length || commands.length > 100) throw new Error('A stage transaction accepts 1–100 commands.');
    const parsed = commands.map((command) => stageCommandSchema.parse(command)) as StageCommand[];
    const state = useCanvasStore.getState();
    const node = state.nodes.find((entry) => entry.id === nodeId);
    if (!isBlueprintNode(node)) throw new Error(`Stage ${nodeId} does not exist.`);
    const revision = expectedRevision ?? state.revision;
    if (revision !== state.revision) throw new Error('Stage revision conflict. Refresh the stage before applying.');
    const prepared = prepareStageCommands(node.data, parsed);
    const committed = state.commitGraphTransaction({ expectedRevision: revision, nodes: state.nodes.map((entry) => entry.id === nodeId ? { ...entry, data: prepared.data } : entry), edges: state.edges, selectedNodeId: state.selectedNodeId });
    if (committed === null) throw new Error('Stage revision conflict. Nothing was applied.');
    return { ...query(nodeId), createdIds: prepared.createdIds };
  };
  return {
    query,
    create(input: z.input<typeof stageCreateInputSchema> = {}): StageSnapshot {
      const config = stageCreateInputSchema.parse(input), state = useCanvasStore.getState();
      const node = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.blueprint, config.position ?? { x: 120, y: 120 }, { mode: config.mode ?? 'flat', ...(config.name ? { displayName: config.name } : {}) });
      const revision = state.commitGraphTransaction({ expectedRevision: state.revision, nodes: [...state.nodes, node], edges: state.edges, selectedNodeId: node.id });
      if (revision === null) throw new Error('Canvas revision conflict; no stage was created.');
      if (config.workspace) requestedWorkspaces.set(node.id, config.workspace);
      return query(node.id);
    },
    async open(nodeId: string, workspace?: StageWorkspace) {
      query(nodeId);
      if (workspace) {
        const viewport = viewports.get(nodeId);
        if (viewport?.setWorkspace) viewport.setWorkspace(workspace);
        else requestedWorkspaces.set(nodeId, workspace);
      }
      const result = await canvasCommandRegistry.execute({ type: 'director.open', version: 1, input: { nodeId } }, 'ui');
      if (!result.ok) throw new Error(result.error.message);
      return result;
    },
    execute,
    draftScene: draftStageScene,
    applyDraft(nodeId: string, draft: StageSceneDraft, include?: Array<'objects' | 'people' | 'camera'>) {
      return execute(nodeId, { type: 'draft.apply', draft, include });
    },
    async capture(nodeId: string): Promise<{ nodeId: string; assetId: string }> {
      query(nodeId);
      const viewport = viewports.get(nodeId);
      if (!viewport) throw new Error('Open the stage viewport before capturing.');
      const { assetId } = await viewport.capture();
      const globalAsset = await resolveAsset(assetId);
      const canvasAsset = globalAsset ? undefined : buildCanvasAssetCatalog(useCanvasStore.getState().nodes).find((entry) => entry.id === assetId && entry.kind === 'image');
      if (globalAsset?.kind !== 'image' && !canvasAsset) throw new Error('Stage capture did not produce a persisted image asset.');
      return { nodeId, assetId };
    },
    async record(nodeId: string, options: { resolution: '720p' | '1080p'; fps: 24 | 30; addToCanvas?: boolean }) {
      query(nodeId);
      const result = await canvasCommandRegistry.execute({ type: 'director.record', version: 1, input: { nodeId, ...options } }, 'ui');
      if (!result.ok) throw new Error(result.error.message);
      return result;
    },
    undo: () => useCanvasStore.getState().undo(),
    redo: () => useCanvasStore.getState().redo(),
  };
}
export const stageCommands = createStageCommands();
