import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectRecord } from '@/commands/projectState';
import type { Viewport } from '../engine/viewportMath';
import { createCanvasViewportGesture } from '../engine/canvasViewportGesture';
import { registerCanvasViewportFlush } from './canvasViewportCommit';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';

const storage = vi.hoisted(() => ({ records: new Map<string, ProjectRecord>() }));
vi.mock('@/commands/projectState', () => ({
  deleteProjectRecord: vi.fn(), listProjectSummaries: vi.fn(async () => []), renameProjectRecord: vi.fn(),
  getProjectRecord: vi.fn(async (id: string) => storage.records.get(id) ?? null),
  upsertProjectRecord: vi.fn(async (record: ProjectRecord) => { storage.records.set(record.id, record); }),
  updateProjectViewportRecord: vi.fn(async (id: string, viewportJson: string) => {
    const record = storage.records.get(id); if (record) storage.records.set(id, { ...record, viewportJson });
  }),
}));
let releaseOwner: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers(); storage.records.clear();
  useProjectStore.setState({ currentProjectId: null, currentProject: null, projects: [], isOpeningProject: false });
  useCanvasStore.setState({ nodes: [], edges: [], history: { past: [], future: [] }, currentViewport: { x: 0, y: 0, zoom: 1 } });
});
afterEach(async () => { releaseOwner?.(); releaseOwner = undefined; await vi.runAllTimersAsync(); vi.useRealTimers(); });

function owner() {
  const projectId = useProjectStore.getState().currentProjectId;
  let viewport: Viewport = { x: 0, y: 0, zoom: 1 };
  const commit = vi.fn((next: Viewport) => {
    if (useProjectStore.getState().currentProjectId !== projectId) return;
    useCanvasStore.getState().setViewportState(next);
    useProjectStore.getState().saveCurrentProjectViewport(next);
  });
  const gesture = createCanvasViewportGesture({ readViewport: () => viewport, applyViewport: (next) => { viewport = next; }, onStart: vi.fn(), onCommit: commit,
    requestFrame: (callback) => Number(setTimeout(callback, 16)), cancelFrame: clearTimeout,
    setTimer: (callback, delay) => Number(setTimeout(callback, delay)), clearTimer: clearTimeout });
  const unregister = registerCanvasViewportFlush(gesture.finish);
  releaseOwner = () => { unregister(); gesture.dispose(); };
  return { gesture, commit };
}

describe('final gesture viewport at project boundaries', () => {
  it('keeps release followed by immediate close in the synchronous close snapshot', async () => {
    const id = useProjectStore.getState().createProject('Old');
    await vi.runAllTimersAsync();
    const view = owner();
    view.gesture.schedule({ x: 51, y: 74, zoom: 1.4 });
    view.gesture.finish();
    useProjectStore.getState().closeProject();
    await vi.runAllTimersAsync();
    expect(JSON.parse(storage.records.get(id)!.viewportJson)).toEqual({ x: 51, y: 74, zoom: 1.4 });
    expect(view.commit).toHaveBeenCalledOnce();
  });

  it('flushes a wheel frame before its idle deadline when a project closes', async () => {
    const id = useProjectStore.getState().createProject('Old');
    await vi.runAllTimersAsync();
    const view = owner();
    view.gesture.schedule({ x: 90, y: 100, zoom: 2 }, true);
    useProjectStore.getState().closeProject();
    expect(view.commit).toHaveBeenCalledOnce();
    expect(useCanvasStore.getState().currentViewport).toEqual({ x: 90, y: 100, zoom: 2 });
    await vi.runAllTimersAsync();
    expect(JSON.parse(storage.records.get(id)!.viewportJson)).toEqual({ x: 90, y: 100, zoom: 2 });
  });

  it.each(['open', 'create'] as const)('flushes wheel before %s replaces the current project and never writes that viewport into the destination', async (action) => {
    const id = useProjectStore.getState().createProject('Old');
    await vi.runAllTimersAsync();
    storage.records.set('destination', { id: 'destination', name: 'Destination', createdAt: 1, updatedAt: 1, nodeCount: 0,
      nodesJson: '[]', edgesJson: '[]', viewportJson: '{"x":7,"y":8,"zoom":1}', historyJson: '{"past":[],"future":[]}', imagePoolJson: '[]' });
    const view = owner();
    view.gesture.schedule({ x: 90, y: 100, zoom: 2 }, true);
    if (action === 'open') useProjectStore.getState().openProject('destination');
    else useProjectStore.getState().createProject('New');
    expect(view.commit).toHaveBeenCalledOnce();
    await vi.runAllTimersAsync();
    expect(JSON.parse(storage.records.get(id)!.viewportJson)).toEqual({ x: 90, y: 100, zoom: 2 });
    const current = useProjectStore.getState().currentProject;
    expect(current?.id).not.toBe(id);
    expect(current?.viewport).toEqual(action === 'open' ? { x: 7, y: 8, zoom: 1 } : { x: 0, y: 0, zoom: 1 });
  });
});
