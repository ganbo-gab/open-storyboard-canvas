import { getProjectRecord, upsertProjectRecord } from '@/commands/projectState';
import { useCanvasStore } from '@/stores/canvasStore';
import { encodeProject, useProjectStore } from '@/stores/projectStore';
import { CANVAS_NODE_TYPES, type CanvasNodeData } from '@/features/canvas/domain/canvasNodes';
import { canvasNodeFactory } from '@/features/canvas/application/canvasServices';
import { projectFromRecord } from '@/features/assets/application/assetCatalog';
import type { WorkbenchResult, WorkbenchTask } from '../domain/types';
import { getAssetPortableSource, persistAssetMedia } from '@/features/assets/application/assetMediaStorage';

const imports = new Map<string, Promise<string>>();
/** Explicit cross-project import. Does not open/switch projects or submit generation. */
export async function importWorkbenchResult(result: WorkbenchResult, task: WorkbenchTask, projectId: string): Promise<string> {
  const previous = imports.get(projectId);
  const pending = (async () => {
    if (previous) await previous.catch(() => undefined);
    const durableSource = result.kind === 'text' ? result.source : await persistAssetMedia(result.source, true, result.kind);
    result = { ...result, source: await getAssetPortableSource(durableSource) };
    await useProjectStore.getState().waitForProjectPersistence(projectId);
    const record = await getProjectRecord(projectId);
    if (!record) throw new Error('目标项目已不存在');
    const project = projectFromRecord(record);
    const active = useProjectStore.getState().currentProjectId === projectId;
    const canvas = useCanvasStore.getState();
    const viewport = active ? canvas.currentViewport : project.viewport;
    const screen = canvas.canvasViewportSize;
    const position = { x: ((screen.width || 1200) / 2 - viewport.x) / viewport.zoom - 160,
      y: ((screen.height || 800) / 2 - viewport.y) / viewport.zoom - 120 };
    const type = result.kind === 'image' ? CANVAS_NODE_TYPES.exportImage : result.kind === 'video' ? CANVAS_NODE_TYPES.video
      : result.kind === 'audio' ? CANVAS_NODE_TYPES.audio : CANVAS_NODE_TYPES.textAnnotation;
    const data: Partial<CanvasNodeData> = {
      displayName: task.input.prompt.slice(0, 80), sourcePrompt: task.input.prompt,
      sourceModelId: task.input.model, generationLastJobId: task.jobId, generationJobState: 'succeeded',
      aspectRatio: task.input.config?.aspectRatio ?? 'auto', workbenchTaskId: task.id,
      ...(result.kind === 'image' ? { imageUrl: result.source, previewImageUrl: result.source } : {}),
      ...(result.kind === 'video' ? { videoUrl: result.source, localVideoUrl: result.source, durationSeconds: task.input.config?.seconds } : {}),
      ...(result.kind === 'audio' ? { audioUrl: result.source, localAudioUrl: result.source } : {}),
      ...(result.kind === 'text' ? { content: result.source } : {}),
    };
    if (active) {
      const ids = canvas.addNodesBatch([{ type, position, data }]);
      const updated = useCanvasStore.getState();
      useProjectStore.getState().saveCurrentProject(updated.nodes, updated.edges, updated.currentViewport, updated.history);
      await useProjectStore.getState().waitForProjectPersistence(projectId);
      return ids[0];
    }
    const node = canvasNodeFactory.createNode(type, position, data);
    const encoded = encodeProject({ ...project, nodes: [...project.nodes, node], nodeCount: project.nodes.length + 1,
      updatedAt: Date.now(), history: { past: [...project.history.past, structuredClone({ nodes: project.nodes, edges: project.edges })].slice(-12), future: [] } });
    await upsertProjectRecord({ ...record, updatedAt: encoded.updatedAt, nodeCount: encoded.nodeCount,
      nodesJson: JSON.stringify(encoded.nodes), edgesJson: JSON.stringify(encoded.edges),
      historyJson: JSON.stringify({ ...encoded.history, imagePool: encoded.imagePool }), imagePoolJson: JSON.stringify(encoded.imagePool) });
    await useProjectStore.getState().refreshProjects();
    return node.id;
  })();
  imports.set(projectId, pending);
  try { return await pending; }
  finally { if (imports.get(projectId) === pending) imports.delete(projectId); }
}
