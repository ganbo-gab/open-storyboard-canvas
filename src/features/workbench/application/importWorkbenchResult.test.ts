import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importWorkbenchResult } from './importWorkbenchResult';
import { getProjectRecord, listProjectSummaries, upsertProjectRecord } from '@/commands/projectState';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import type { WorkbenchTask } from '../domain/types';
import { persistAssetMedia } from '@/features/assets/application/assetMediaStorage';
import { importAssetToProject, listAssets, projectFromRecord, saveAsset } from '@/features/assets/application/assetCatalog';
import { applyCanvasHistoryEntry } from '@/stores/canvasHistory';

// Node supplies Blob/IndexedDB cloning, but not FileReader. Exercise the browser
// boundary with a binary-reading adapter rather than changing production behavior.
class TestFileReader {
  result: string | null = null;
  error: unknown;
  onload?: () => void;
  onerror?: () => void;
  readAsDataURL(blob: Blob): void {
    void blob.arrayBuffer().then((buffer) => {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      this.result = `data:${blob.type};base64,${btoa(binary)}`;
      this.onload?.();
    }, (error: unknown) => { this.error = error; this.onerror?.(); });
  }
}
const originalProjectActions = { saveCurrentProject: useProjectStore.getState().saveCurrentProject, waitForProjectPersistence: useProjectStore.getState().waitForProjectPersistence };
afterEach(() => { vi.unstubAllGlobals(); useProjectStore.setState(originalProjectActions); });

vi.mock('@/commands/projectState', () => ({ getProjectRecord: vi.fn(), upsertProjectRecord: vi.fn(), listProjectSummaries: vi.fn() }));
const task: WorkbenchTask = { id: 'task', conversationId: 'conversation', input: { kind: 'image', prompt: 'Cat', model: 'model', config: { aspectRatio: '1:1' } }, status: 'succeeded', results: [{ kind: 'image', source: '/media/cat.png' }], waitingCanceled: false, createdAt: 1, updatedAt: 2 };
beforeEach(() => {
  vi.stubGlobal('FileReader', TestFileReader);
  vi.mocked(getProjectRecord).mockResolvedValue({ id: 'target', name: 'Target', createdAt: 1, updatedAt: 2, nodeCount: 1,
    nodesJson: JSON.stringify([{ id: 'original', type: 'uploadNode', position: { x: 0, y: 0 }, data: { imageUrl: '__img_ref__:0', aspectRatio: '1:1' } }]),
    imagePoolJson: '["/media/original.png"]', edgesJson: '[]', viewportJson: '{"x":10,"y":20,"zoom":1}', historyJson: '{"past":[],"future":[]}',
  });
  vi.mocked(listProjectSummaries).mockResolvedValue([{ id: 'target', name: 'Target', createdAt: 1, updatedAt: 3, nodeCount: 2 }]);
  vi.mocked(upsertProjectRecord).mockResolvedValue();
  useProjectStore.setState({ currentProjectId: 'other', currentProject: null });
});
describe('explicit workbench import', () => {
  it('writes only the chosen inactive project through existing node/image-pool paths', async () => {
    const canvasBefore = useCanvasStore.getState();
    const id = await importWorkbenchResult(task.results[0], task, 'target');
    const saved = vi.mocked(upsertProjectRecord).mock.calls.at(-1)![0];
    expect(saved.id).toBe('target');
    expect(saved.nodeCount).toBe(2);
    expect(JSON.parse(saved.nodesJson)).toEqual(expect.arrayContaining([expect.objectContaining({ id, type: 'exportImageNode', data: expect.objectContaining({ sourcePrompt: 'Cat', workbenchTaskId: 'task' }) })]));
    expect(JSON.parse(saved.imagePoolJson!)).toEqual(expect.arrayContaining(['/media/original.png', '/media/cat.png']));
    expect(JSON.parse(saved.historyJson).past).toHaveLength(1);
    expect(useCanvasStore.getState()).toBe(canvasBefore);
    expect(useProjectStore.getState().currentProjectId).toBe('other');
  });
  it('persists imported inactive-project results as one reversible patch transaction', async () => {
    const importedId = await importWorkbenchResult(task.results[0], task, 'target');
    const saved = vi.mocked(upsertProjectRecord).mock.calls.at(-1)![0];
    const project = projectFromRecord(saved);
    expect(project.history.past).toHaveLength(1);
    const undone = applyCanvasHistoryEntry(project, project.history.past[0], 'undo');
    expect(undone.nodes.map((node) => node.id)).toEqual(['original']);
    expect(undone.nodes[0].data.imageUrl).toBe('/media/original.png');
    const redone = applyCanvasHistoryEntry(undone, project.history.past[0], 'redo');
    expect(redone.nodes.find((node) => node.id === importedId)?.data.imageUrl).toBe('/media/cat.png');
    expect(redone.nodes).toEqual(project.nodes);
  });
  it('materializes stable binary references into durable project image-pool bytes', async () => {
    const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=';
    const reference = await persistAssetMedia(image);
    expect(reference).toMatch(/^asset-media:/);
    const canvasBefore = useCanvasStore.getState();
    await importWorkbenchResult({ kind: 'image', source: reference }, task, 'target');
    const saved = vi.mocked(upsertProjectRecord).mock.calls.at(-1)![0];
    expect(JSON.parse(saved.imagePoolJson!)).toContain(image);
    expect(saved.nodesJson).not.toContain('blob:');
    expect(saved.nodesJson).not.toContain('asset-media:');
    expect(useCanvasStore.getState()).toBe(canvasBefore);
  });
  it('places both workbench results and asset imports at explicit flow coordinates in an inactive project', async () => {
    const position = { x: -345, y: 678 };
    const firstId = await importWorkbenchResult(task.results[0], task, 'target', position);
    const first = projectFromRecord(vi.mocked(upsertProjectRecord).mock.calls.at(-1)![0]);
    expect(first.nodes.find((node) => node.id === firstId)?.position).toEqual(position);
    const asset = await saveAsset({ id: 'drop-asset', kind: 'video', source: '/media/asset.mp4', name: 'Dropped asset', origin: 'uploaded',
      metadata: { prompt: 'Original prompt', model: 'Original model', config: { aspectRatio: '16:9', seconds: 8 } } });
    const imported = await importAssetToProject(asset.id, 'target', { x: 432, y: -123 });
    const saved = projectFromRecord(vi.mocked(upsertProjectRecord).mock.calls.at(-1)![0]);
    expect(saved.nodes.find((node) => node.id === imported)).toMatchObject({ type: 'videoNode', position: { x: 432, y: -123 },
      data: { sourcePrompt: 'Original prompt', sourceModelId: 'Original model', aspectRatio: '16:9', durationSeconds: 8 } });
    expect(saved.history.past).toHaveLength(1);
    expect(useProjectStore.getState().currentProjectId).toBe('other');
  });
  it('selects an active-project drop as one history step and resolves only after project persistence', async () => {
    const record = await getProjectRecord('target');
    const project = projectFromRecord(record!);
    useCanvasStore.setState({ nodes: project.nodes, edges: project.edges, history: { past: [], future: [] }, selectedNodeId: null });
    const { promise: persistence, resolve: release } = Promise.withResolvers<void>();
    const { promise: waiting, resolve: markWaiting } = Promise.withResolvers<void>();
    const wait = vi.fn().mockResolvedValueOnce(undefined).mockImplementationOnce(() => { markWaiting(); return persistence; });
    const save = vi.fn();
    useProjectStore.setState({ currentProjectId: 'target', currentProject: project, saveCurrentProject: save, waitForProjectPersistence: wait });
    let completed = false;
    const pending = importWorkbenchResult(task.results[0], task, 'target', { x: 111, y: 222 }).then((id) => { completed = true; return id; });
    await waiting;
    expect(completed).toBe(false);
    release();
    const id = await pending;
    const canvas = useCanvasStore.getState();
    expect(canvas.nodes.find((node) => node.id === id)).toMatchObject({ selected: true, position: { x: 111, y: 222 } });
    expect(canvas.selectedNodeId).toBe(id);
    expect(canvas.history.past).toHaveLength(1);
    expect(save).toHaveBeenCalledOnce();
    expect(useProjectStore.getState().currentProjectId).toBe('target');
    const undone = applyCanvasHistoryEntry(canvas, canvas.history.past[0], 'undo');
    expect(undone.nodes.map((node) => node.id)).toEqual(['original']);
  });
  it('imports text literally without resolving media-looking content as an asset handle', async () => {
    const text = 'asset-media:literal screenplay text, not a binary reference';
    const id = await importWorkbenchResult({ kind: 'text', source: text }, task, 'target');
    const saved = projectFromRecord(vi.mocked(upsertProjectRecord).mock.calls.at(-1)![0]);
    expect(saved.nodes.find((node) => node.id === id)).toMatchObject({ type: 'textAnnotationNode', data: { content: text } });
    expect(saved.history.past).toHaveLength(1);
    expect(useProjectStore.getState().currentProjectId).toBe('other');
  });
  it('preserves dimensions, requested resolution and original generation provenance through project save and reopen', async () => {
    const asset = await saveAsset({ id: 'provenance-import', kind: 'image', source: '/media/original-output.png', name: 'Output',
      origin: 'generated', taskId: 'original-task', metadata: {
        width: 2048, height: 1152, resolution: '2K', model: 'custom:original:model', prompt: 'Exact source prompt', jobId: 'original-job',
        channelModeId: 'image-reference', references: [{ kind: 'image', source: '/media/reference.png' }], config: { size: '2K', aspectRatio: '16:9' },
      } });
    const id = await importAssetToProject(asset.id, 'target');
    const persisted = vi.mocked(upsertProjectRecord).mock.calls.at(-1)![0];
    const reopened = projectFromRecord(persisted);
    expect(reopened.nodes.find((node) => node.id === id)).toMatchObject({ data: {
      assetId: asset.id, width: 2048, height: 1152, resolution: '2K', sourceModelId: 'custom:original:model',
      sourcePrompt: 'Exact source prompt', generationLastJobId: 'original-job', workbenchTaskId: 'original-task',
    } });
    vi.mocked(getProjectRecord).mockResolvedValue(persisted);
    const projected = (await listAssets()).find((candidate) => candidate.nodeId === id);
    expect(projected).toMatchObject({ origin: 'generated', taskId: 'original-task', metadata: {
      width: 2048, height: 1152, resolution: '2K', model: 'custom:original:model', jobId: 'original-job',
      channelModeId: 'image-reference', references: [{ kind: 'image', source: '/media/reference.png' }], config: { size: '2K', aspectRatio: '16:9' },
    } });
    expect(reopened.history.past).toHaveLength(1);
    expect(useProjectStore.getState().currentProjectId).toBe('other');
  });
});
