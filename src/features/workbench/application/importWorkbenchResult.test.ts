import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importWorkbenchResult } from './importWorkbenchResult';
import { getProjectRecord, listProjectSummaries, upsertProjectRecord } from '@/commands/projectState';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import type { WorkbenchTask } from '../domain/types';
import { persistAssetMedia } from '@/features/assets/application/assetMediaStorage';

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
afterEach(() => vi.unstubAllGlobals());

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
});
