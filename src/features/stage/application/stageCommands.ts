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
import { compileStoryPlan } from './storyCompiler';
import type { StoryPlan } from './storyPlan';
import { assertStageCaptureActive, stageCapturedImageSchema, stageFourViewImagesSchema, type StageViewportBridge, type StageFourViewImage } from './stageCapture';
import { parseStageSelectionTargets, stageSelectionOperationSchema, type StageSelectionOperation } from './stageSelection';
export { createStageCaptureBridge, STAGE_FOUR_VIEWS } from './stageCapture';
export type { StageViewportBridge, StageCaptureAdapter, StageCaptureRequest, StageFourViewImage } from './stageCapture';
export { resolveStageSelection } from './stageSelection';
export type { StageSelection, StageSelectionChange, StageSelectionOperation } from './stageSelection';
export { stageCommandSchema, stageCreateInputSchema, stageDraftInputSchema, stageSceneDraftSchema } from '../domain/stageSchemas';
export type { StageCommand, StageSnapshot, StageWorkspace, StageDraftRequest, StageSceneDraft } from '../domain/stage';

interface RegisteredStageViewport {
  bridge: StageViewportBridge;
  captureController?: AbortController;
}
const viewports = new Map<string, RegisteredStageViewport>();
// A replacement registration cannot race its predecessor's uncancellable cleanup.
const captures = new Map<string, AbortController>();
const requestedWorkspaces = new Map<string, StageWorkspace>();
export function registerStageViewport(nodeId: string, bridge: StageViewportBridge): () => void {
  const previous = viewports.get(nodeId);
  previous?.captureController?.abort();
  // Each registration, even with the same bridge object, owns a new generation.
  const registration: RegisteredStageViewport = { bridge };
  viewports.set(nodeId, registration);
  const workspace = requestedWorkspaces.get(nodeId);
  if (workspace) { bridge.setWorkspace?.(workspace); requestedWorkspaces.delete(nodeId); }
  return () => {
    registration.captureController?.abort();
    if (viewports.get(nodeId) === registration) viewports.delete(nodeId);
  };
}

async function withStageViewportCapture<T>(nodeId: string, signal: AbortSignal | undefined, capture: (bridge: StageViewportBridge, signal: AbortSignal) => Promise<T>): Promise<T> {
  assertStageCaptureActive(signal);
  const registration = viewports.get(nodeId);
  if (!registration) throw new Error('Open the stage viewport before capturing.');
  if (captures.has(nodeId)) throw new Error('A stage capture is already in progress.');
  const controller = new AbortController();
  registration.captureController = controller;
  captures.set(nodeId, controller);
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const result = await capture(registration.bridge, controller.signal);
    assertStageCaptureActive(controller.signal);
    if (viewports.get(nodeId) !== registration) throw new Error('The stage capture viewport was replaced.');
    return result;
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (registration.captureController === controller) registration.captureController = undefined;
    if (captures.get(nodeId) === controller) captures.delete(nodeId);
  }
}
export const stageCommandEffects: Record<StageCommand['type'], { effect: 'graph'; destructive: boolean }> = {
  'object.add': { effect: 'graph', destructive: false }, 'object.update': { effect: 'graph', destructive: false }, 'object.remove': { effect: 'graph', destructive: true },
  'camera.lookAt': { effect: 'graph', destructive: false }, 'trajectory.set': { effect: 'graph', destructive: true },
  'person.pose': { effect: 'graph', destructive: false }, 'person.action': { effect: 'graph', destructive: true }, 'camera.preset': { effect: 'graph', destructive: true },
  'clip.add': { effect: 'graph', destructive: false }, 'clip.update': { effect: 'graph', destructive: false }, 'clip.split': { effect: 'graph', destructive: false }, 'clip.delete': { effect: 'graph', destructive: true },
  'keyframe.add': { effect: 'graph', destructive: false }, 'keyframe.update': { effect: 'graph', destructive: false }, 'keyframe.remove': { effect: 'graph', destructive: true },
  'draft.apply': { effect: 'graph', destructive: false }, 'playback.update': { effect: 'graph', destructive: false },
};
export function isDestructiveStageCommand(command: StageCommand): boolean {
  return stageCommandEffects[command.type].destructive || (command.type === 'person.pose' && command.duration !== undefined);
}

export function createStageCommands() {
  const query = (nodeId?: string): StageSnapshot => {
    const state = useCanvasStore.getState();
    const id = nodeId ?? state.activeDirectorStudioNodeId ?? state.activeToolDialog?.nodeId ?? state.selectedNodeId;
    const node = state.nodes.find((entry) => entry.id === id);
    if (!isBlueprintNode(node)) throw new Error('Select or supply an existing stage node.');
    // Never expose mutable references to persisted objects outside the store.
    return { nodeId: node.id, revision: state.revision, data: structuredClone(node.data) };
  };
  const commit = (nodeId: string, parsed: StageCommand[], expectedRevision?: number): StageMutationResult => {
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
  const execute = (nodeId: string, input: StageCommand | StageCommand[], expectedRevision?: number): StageMutationResult => {
    const commands = Array.isArray(input) ? input : [input];
    if (!commands.length || commands.length > 100) throw new Error('A stage transaction accepts 1–100 commands.');
    return commit(nodeId, commands.map((command) => stageCommandSchema.parse(command)), expectedRevision);
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
        const viewport = viewports.get(nodeId)?.bridge;
        if (viewport?.setWorkspace) viewport.setWorkspace(workspace);
        else requestedWorkspaces.set(nodeId, workspace);
      }
      const result = await canvasCommandRegistry.execute({ type: 'director.open', version: 1, input: { nodeId } }, 'ui');
      if (!result.ok) throw new Error(result.error.message);
      return result;
    },
    execute,
    executeSelection(nodeId: string, itemIds: readonly string[], input: StageSelectionOperation, expectedRevision?: number) {
      const targets = parseStageSelectionTargets(itemIds);
      const operation = stageSelectionOperationSchema.parse(input);
      const commands: StageCommand[] = targets.map((itemId) => operation.type === 'remove'
        ? { type: 'object.remove', itemId }
        : { type: 'object.update', itemId, patch: operation.patch });
      const result = execute(nodeId, commands, expectedRevision);
      return { ...result, selection: { itemIds: operation.type === 'remove' ? [] : targets, primaryItemId: operation.type === 'remove' ? null : targets[targets.length - 1] ?? null } };
    },
    direct(nodeId: string, plan: StoryPlan, options: { dryRun: boolean; expectedRevision?: number }) {
      const snapshot = query(nodeId);
      if (options.expectedRevision !== undefined && options.expectedRevision !== snapshot.revision) throw new Error('Stage revision conflict. Refresh the stage before directing.');
      const preview = compileStoryPlan(plan, snapshot);
      if (options.dryRun) return { ...preview, nodeId, revision: snapshot.revision, dryRun: true as const };
      // The compiler already validated the entire batch. Large stories still commit once, never in chunks.
      const result = commit(nodeId, preview.commands, snapshot.revision);
      return { ...preview, ...result, dryRun: false as const };
    },
    draftScene: draftStageScene,
    applyDraft(nodeId: string, draft: StageSceneDraft, include?: Array<'objects' | 'people' | 'camera'>) {
      return execute(nodeId, { type: 'draft.apply', draft, include });
    },
    async capture(nodeId: string, timeSeconds?: number, signal?: AbortSignal): Promise<{ nodeId: string; assetId: string; timeSeconds?: number }> {
      const snapshot = query(nodeId);
      if (timeSeconds !== undefined && (!Number.isFinite(timeSeconds) || timeSeconds < 0 || timeSeconds > (snapshot.data.motionProject?.durationSeconds ?? 0))) throw new Error('Capture time is outside the stage timeline.');
      return withStageViewportCapture(nodeId, signal, async (viewport, captureSignal) => {
        if (timeSeconds !== undefined && !viewport.captureAt) throw new Error('This viewport has not registered exact-time capture support.');
        const { assetId } = stageCapturedImageSchema.parse(timeSeconds === undefined ? await viewport.capture(captureSignal) : await viewport.captureAt!(timeSeconds, captureSignal));
        assertStageCaptureActive(captureSignal);
        const globalAsset = await resolveAsset(assetId);
        const canvasAsset = globalAsset ? undefined : buildCanvasAssetCatalog(useCanvasStore.getState().nodes).find((entry) => entry.id === assetId && entry.kind === 'image');
        if (globalAsset?.kind !== 'image' && !canvasAsset) throw new Error('Stage capture did not produce a persisted image asset.');
        assertStageCaptureActive(captureSignal);
        query(nodeId);
        return { nodeId, assetId, ...(timeSeconds !== undefined ? { timeSeconds } : {}) };
      });
    },
    async captureFourViews(nodeId: string, timeSeconds?: number, signal?: AbortSignal): Promise<{ nodeId: string; images: StageFourViewImage[]; timeSeconds?: number }> {
      const snapshot = query(nodeId);
      if (timeSeconds !== undefined && (!Number.isFinite(timeSeconds) || timeSeconds < 0 || timeSeconds > (snapshot.data.motionProject?.durationSeconds ?? 0))) throw new Error('Capture time is outside the stage timeline.');
      return withStageViewportCapture(nodeId, signal, async (viewport, captureSignal) => {
        if (!viewport.captureFourViews) throw new Error('This viewport has not registered four-view capture support.');
        const images = stageFourViewImagesSchema.parse(await viewport.captureFourViews(timeSeconds, captureSignal));
        for (const { assetId } of images) {
          assertStageCaptureActive(captureSignal);
          const globalAsset = await resolveAsset(assetId);
          const canvasAsset = globalAsset ? undefined : buildCanvasAssetCatalog(useCanvasStore.getState().nodes).find((entry) => entry.id === assetId && entry.kind === 'image');
          if (globalAsset?.kind !== 'image' && !canvasAsset) throw new Error('Stage capture did not produce a persisted image asset.');
        }
        assertStageCaptureActive(captureSignal);
        query(nodeId);
        return { nodeId, images, ...(timeSeconds !== undefined ? { timeSeconds } : {}) };
      });
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
