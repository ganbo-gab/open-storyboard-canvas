import { importAssetToProject } from '@/features/assets/application/assetCatalog';
import { useWorkbenchStore } from '@/features/workbench/store/workbenchStore';
import type { StudioMediaDrag } from './mediaDrag';

/**
 * Import dragged library media into a project. Never opens/switches projects or starts generation;
 * the owning stores re-read their records, so stale drag payloads fail instead of importing guesses.
 * `position` is a flow coordinate on the target canvas; omitted means its viewport centre.
 */
export async function importStudioMedia(payload: StudioMediaDrag, projectId: string, position?: { x: number; y: number }): Promise<string[]> {
  if (payload.kind === 'workbench-result') {
    const store = useWorkbenchStore.getState();
    await store.initialize();
    return [await store.importResult(payload.taskId, projectId, payload.resultIndex, position)];
  }
  const nodeIds: string[] = [];
  // Sequential: the importer serializes per project, and staggering keeps several drops from stacking exactly.
  for (const [index, assetId] of payload.assetIds.entries()) {
    nodeIds.push(await importAssetToProject(assetId, projectId, position ? { x: position.x + index * 40, y: position.y + index * 40 } : undefined));
  }
  return nodeIds;
}
