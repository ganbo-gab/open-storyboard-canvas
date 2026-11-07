import { getProjectRecord, upsertProjectRecord } from '@/commands/projectState';
import { appendCanvasHistory, useCanvasStore } from '@/stores/canvasStore';
import { encodeProject, useProjectStore } from '@/stores/projectStore';
import { CANVAS_NODE_TYPES, type CanvasNodeData } from '@/features/canvas/domain/canvasNodes';
import { canvasNodeFactory } from '@/features/canvas/application/canvasServices';
import { projectFromRecord } from '@/features/assets/application/assetCatalog';
import type { WorkbenchResult, WorkbenchTask } from '../domain/types';
import { getAssetPortableSource, persistAssetMedia } from '@/features/assets/application/assetMediaStorage';
import { getImportedModel } from '@/features/stage/application/importedModelLibrary';
import { enqueueProjectEdit } from '@/features/library/application/projectEditQueue';
import { normalizeAssetMetadata } from '@/features/assets/application/assetMetadata';

export interface ProjectMediaMetadata {
  name: string;
  prompt?: string;
  model?: string;
  jobId?: string;
  aspectRatio?: string;
  seconds?: number;
  workbenchTaskId?: string;
  assetMetadata?: Record<string, unknown>;
  assetId?: string;
  origin?: 'generated' | 'uploaded' | 'canvas';
}
export interface ProjectMediaPosition { x: number; y: number }
/** Explicit import, serialized per project. Flow coordinates apply equally to active and inactive projects. */
export async function importProjectMedia(result: WorkbenchResult, metadata: ProjectMediaMetadata, projectId: string, flowPosition?: ProjectMediaPosition): Promise<string> {
  if (flowPosition && (!Number.isFinite(flowPosition.x) || !Number.isFinite(flowPosition.y))) throw new Error('Canvas position must be finite');
  return await enqueueProjectEdit(projectId, async () => {
    const durableSource = result.kind === 'text' || result.kind === 'model' ? result.source : await persistAssetMedia(result.source, true, result.kind);
    result = { ...result, source: result.kind === 'text' || result.kind === 'model' ? durableSource : await getAssetPortableSource(durableSource) };
    if (result.kind === 'model' && !await getImportedModel(result.importedModelId ?? result.source)) throw new Error('模型库条目已不存在，请重新关联模型。');
    await useProjectStore.getState().waitForProjectPersistence(projectId);
    const record = await getProjectRecord(projectId);
    if (!record) throw new Error('目标项目已不存在');
    const project = projectFromRecord(record);
    const active = useProjectStore.getState().currentProjectId === projectId;
    const canvas = useCanvasStore.getState();
    const viewport = active ? canvas.currentViewport : project.viewport;
    const screen = canvas.canvasViewportSize;
    const position = flowPosition ? { ...flowPosition } : {
      x: ((screen.width || 1200) / 2 - viewport.x) / viewport.zoom - 160,
      y: ((screen.height || 800) / 2 - viewport.y) / viewport.zoom - 120 };
    const type = result.kind === 'image' ? CANVAS_NODE_TYPES.exportImage : result.kind === 'video' ? CANVAS_NODE_TYPES.video
      : result.kind === 'audio' ? CANVAS_NODE_TYPES.audio : result.kind === 'model' ? CANVAS_NODE_TYPES.blueprint : CANVAS_NODE_TYPES.textAnnotation;
    const assetMetadata = normalizeAssetMetadata(metadata.assetMetadata ?? {});
    const data: Partial<CanvasNodeData> = {
      ...(metadata.assetId ? { assetId: metadata.assetId } : {}),
      assetMetadata,
      ...(metadata.origin ? { assetOrigin: metadata.origin } : {}),
      ...(assetMetadata.width !== undefined ? { width: assetMetadata.width } : {}),
      ...(assetMetadata.height !== undefined ? { height: assetMetadata.height } : {}),
      ...(assetMetadata.resolution !== undefined ? { resolution: assetMetadata.resolution } : {}),
      displayName: metadata.name, sourcePrompt: metadata.prompt,
      sourceModelId: metadata.model, generationLastJobId: metadata.jobId,
      ...(metadata.workbenchTaskId ? { generationJobState: 'succeeded', workbenchTaskId: metadata.workbenchTaskId } : {}),
      aspectRatio: assetMetadata.aspectRatio ?? metadata.aspectRatio ?? 'auto',
      ...(result.kind === 'image' ? { imageUrl: result.source, previewImageUrl: result.source } : {}),
      ...(result.kind === 'video' ? { videoUrl: result.source, localVideoUrl: result.source, durationSeconds: assetMetadata.durationSeconds ?? metadata.seconds } : {}),
      ...(result.kind === 'audio' ? { audioUrl: result.source, localAudioUrl: result.source } : {}),
      ...(result.kind === 'text' ? { content: result.source } : {}),
      ...(result.kind === 'model' ? { items: [{ id: crypto.randomUUID(), label: metadata.name || '模型', x: 0, y: 0, color: '#b8b8b8', importedModelId: result.importedModelId ?? result.source }] } : {}),
    };
    if (active) {
      const ids = canvas.addNodesBatch([{ type, position, data }]);
      useCanvasStore.getState().setSelectedNode(ids[0]);
      const updated = useCanvasStore.getState();
      useProjectStore.getState().saveCurrentProject(updated.nodes, updated.edges, updated.currentViewport, updated.history);
      await useProjectStore.getState().waitForProjectPersistence(projectId);
      return ids[0];
    }
    const node = canvasNodeFactory.createNode(type, position, data);
    const encoded = encodeProject({ ...project, nodes: [...project.nodes, node], nodeCount: project.nodes.length + 1,
      updatedAt: Date.now(), history: appendCanvasHistory(project.history, project, { nodes: [...project.nodes, node], edges: project.edges }) });
    await upsertProjectRecord({ ...record, updatedAt: encoded.updatedAt, nodeCount: encoded.nodeCount,
      nodesJson: JSON.stringify(encoded.nodes), edgesJson: JSON.stringify(encoded.edges),
      historyJson: JSON.stringify(encoded.history), imagePoolJson: JSON.stringify(encoded.imagePool) });
    await useProjectStore.getState().refreshProjects();
    return node.id;
  });
}

/** Workbench provenance adapter; importing never changes tasks or submits generation. */
export async function importWorkbenchResult(result: WorkbenchResult, task: WorkbenchTask, projectId: string, position?: ProjectMediaPosition): Promise<string> {
  return await importProjectMedia(result, { name: task.input.prompt.slice(0, 80), prompt: task.input.prompt,
    model: task.input.model, jobId: task.jobId, aspectRatio: task.input.config?.aspectRatio,
    seconds: task.input.config?.seconds, workbenchTaskId: task.id, assetId: result.assetId, origin: 'generated',
    assetMetadata: { prompt: task.input.prompt, model: task.input.model, config: task.input.config ?? {},
      references: task.input.references ?? [], channelModeId: task.input.channelModeId, jobId: task.jobId } }, projectId, position);
}
