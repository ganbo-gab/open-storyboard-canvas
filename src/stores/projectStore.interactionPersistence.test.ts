import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectRecord } from '@/commands/projectState';
const storage = vi.hoisted(() => ({ records: new Map<string, ProjectRecord>(), upsert: vi.fn(), get: vi.fn(), remove: vi.fn(), viewport: vi.fn() }));
vi.mock('@/commands/projectState', () => ({
  upsertProjectRecord: storage.upsert, getProjectRecord: storage.get, deleteProjectRecord: storage.remove,
  listProjectSummaries: async () => [], renameProjectRecord: async () => {}, updateProjectViewportRecord: storage.viewport,
}));
import { useProjectStore, type Project } from './projectStore';
import { useCanvasStore, type CanvasNode } from './canvasStore';
import { registerCanvasViewportFlush } from '@/features/canvas/application/canvasViewportCommit';

let interaction = false;
let release: () => void;
let idleId = 0;
const idle = new Map<number, () => void>();
let project: Project;
function edit(content: string, serialized = () => {}) {
  const data = { content };
  Object.defineProperty(data, 'content', { enumerable: true, get: () => { serialized(); return content; } });
  const nodes: CanvasNode[] = [{ id: 'note', type: 'textAnnotationNode', position: { x: 0, y: 0 }, data }];
  useCanvasStore.setState({ nodes, edges: [], history: { past: [], future: [] } });
  useProjectStore.getState().saveCurrentProject(nodes, [], { x: 0, y: 0, zoom: 0.1 }, { past: [], future: [] });
}
function deliverIdle() {
  const callbacks = [...idle.values()]; idle.clear(); callbacks.forEach((callback) => callback());
}
async function checkpoint(id = project.id) {
  const pending = useProjectStore.getState().waitForProjectPersistence(id);
  await vi.advanceTimersByTimeAsync(24);
  await pending;
}
beforeEach(() => {
  vi.useFakeTimers(); interaction = false; idle.clear();
  vi.stubGlobal('requestIdleCallback', (callback: () => void) => { idle.set(++idleId, callback); return idleId; });
  vi.stubGlobal('cancelIdleCallback', (id: number) => idle.delete(id));
  release = registerCanvasViewportFlush(() => {}, () => false, () => interaction);
  storage.records.clear();
  storage.upsert.mockReset().mockImplementation(async (record: ProjectRecord) => { storage.records.set(record.id, record); });
  storage.get.mockReset().mockImplementation(async (id: string) => storage.records.get(id) ?? null);
  storage.remove.mockReset().mockImplementation(async (id: string) => { storage.records.delete(id); });
  storage.viewport.mockReset().mockImplementation(async (id: string, viewportJson: string) => {
    const current = storage.records.get(id);
    if (current) storage.records.set(id, { ...current, viewportJson });
  });
  project = { id: `interaction-${crypto.randomUUID()}`, name: 'Interaction fixture', createdAt: 1, updatedAt: 1, nodeCount: 0, nodes: [], edges: [],
    viewport: { x: 0, y: 0, zoom: 0.1 }, history: { past: [], future: [] } };
  useProjectStore.setState({ projects: [project], currentProjectId: project.id, currentProject: project, isOpeningProject: false, isHydrated: true });
  useCanvasStore.setState({ nodes: [], edges: [], currentViewport: project.viewport, history: { past: [], future: [] } });
});
afterEach(async () => {
  interaction = false; release();
  await checkpoint();
  idle.clear(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe('project serialization yields to viewport interaction', () => {
  it('keeps the latest committed viewport when its write precedes an idle graph save', async () => {
    edit('Saved baseline'); await checkpoint();
    edit('Pending edit'); await vi.advanceTimersByTimeAsync(260);
    const viewport = { x: 700, y: -450, zoom: 0.1 };
    useProjectStore.getState().saveCurrentProjectViewport(viewport);
    await vi.advanceTimersByTimeAsync(280);
    expect(JSON.parse(storage.records.get(project.id)!.viewportJson)).toEqual(viewport);
    deliverIdle(); await vi.advanceTimersByTimeAsync(0);
    expect(JSON.parse(storage.records.get(project.id)!.viewportJson)).toEqual(viewport);
    expect(JSON.parse(storage.records.get(project.id)!.nodesJson)[0].data.content).toBe('Pending edit');
  });
  it('persists a new viewport after an older graph write that is still in flight', async () => {
    edit('Saved baseline'); await checkpoint();
    const write = Promise.withResolvers<void>();
    storage.upsert.mockImplementationOnce(async (record: ProjectRecord) => {
      await write.promise; storage.records.set(record.id, record);
    });
    edit('In-flight edit'); await vi.advanceTimersByTimeAsync(260); deliverIdle(); await vi.advanceTimersByTimeAsync(0);
    const viewport = { x: -900, y: 250, zoom: 0.2 };
    useProjectStore.getState().saveCurrentProjectViewport(viewport);
    await vi.advanceTimersByTimeAsync(280);
    expect(storage.viewport).not.toHaveBeenCalled();
    write.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(JSON.parse(storage.records.get(project.id)!.viewportJson)).toEqual(viewport);
    expect(JSON.parse(storage.records.get(project.id)!.nodesJson)[0].data.content).toBe('In-flight edit');
  });
  it('does not encode a pending edit when a native hand/Space drag begins before idle work', async () => {
    const serialized = vi.fn(); edit('Edited before drag', serialized);
    await vi.advanceTimersByTimeAsync(260);
    interaction = true; deliverIdle(); await vi.advanceTimersByTimeAsync(240);
    deliverIdle();
    expect(serialized).not.toHaveBeenCalled(); expect(storage.upsert).not.toHaveBeenCalled();
    interaction = false; await vi.advanceTimersByTimeAsync(80); deliverIdle(); await vi.advanceTimersByTimeAsync(0);
    expect(storage.upsert).toHaveBeenCalledOnce(); expect(serialized).toHaveBeenCalled();
    expect(JSON.parse(storage.records.get(project.id)!.nodesJson)[0].data.content).toBe('Edited before drag');
  });
  it('supersedes an idle snapshot with the latest edit and ignores a canceled late host callback', async () => {
    const staleSerialization = vi.fn(); edit('Older', staleSerialization);
    await vi.advanceTimersByTimeAsync(260);
    const stale = [...idle.values()][0];
    interaction = true; edit('Latest');
    stale(); await vi.advanceTimersByTimeAsync(260); deliverIdle();
    expect(staleSerialization).not.toHaveBeenCalled(); expect(storage.upsert).not.toHaveBeenCalled();
    interaction = false; await vi.advanceTimersByTimeAsync(80); deliverIdle(); await vi.advanceTimersByTimeAsync(0);
    expect(storage.upsert).toHaveBeenCalledOnce();
    expect(JSON.parse(storage.records.get(project.id)!.nodesJson)[0].data.content).toBe('Latest');
  });
  it('close bypasses deferred interaction and persists the final graph exactly once', async () => {
    edit('Before close'); await vi.advanceTimersByTimeAsync(260); interaction = true; deliverIdle();
    edit('Final close state'); useProjectStore.getState().closeProject();
    await checkpoint();
    deliverIdle(); await vi.advanceTimersByTimeAsync(1000);
    expect(storage.upsert).toHaveBeenCalledOnce();
    expect(JSON.parse(storage.records.get(project.id)!.nodesJson)[0].data.content).toBe('Final close state');
    expect(useProjectStore.getState().currentProjectId).toBeNull();
  });
  it('explicit checkpoints bypass an already scheduled idle callback during a live drag', async () => {
    edit('Checkpoint'); await vi.advanceTimersByTimeAsync(260); interaction = true;
    const stale = [...idle.values()][0];
    await checkpoint(); stale(); await vi.advanceTimersByTimeAsync(0);
    expect(storage.upsert).toHaveBeenCalledOnce(); expect(idle.size).toBe(0);
  });
  it('keeps later queued data immediate while an earlier native write is still in flight', async () => {
    const write = Promise.withResolvers<void>();
    storage.upsert.mockImplementationOnce(async (record: ProjectRecord) => { await write.promise; storage.records.set(record.id, record); });
    edit('Writing'); await vi.advanceTimersByTimeAsync(260); deliverIdle(); await vi.advanceTimersByTimeAsync(0);
    interaction = true;
    const draining = useProjectStore.getState().waitForProjectPersistence(project.id);
    edit('Newest while waiting'); await vi.advanceTimersByTimeAsync(24);
    write.resolve(); await vi.advanceTimersByTimeAsync(24); await draining;
    expect(storage.upsert).toHaveBeenCalledTimes(2);
    expect(JSON.parse(storage.records.get(project.id)!.nodesJson)[0].data.content).toBe('Newest while waiting');
  });
  it('reopening a deferred project drains its latest graph before reading storage', async () => {
    edit('Latest before switch'); await vi.advanceTimersByTimeAsync(260); interaction = true; deliverIdle();
    useProjectStore.setState({ currentProjectId: 'other', currentProject: null });
    useProjectStore.getState().openProject(project.id);
    await vi.advanceTimersByTimeAsync(48);
    expect(storage.upsert).toHaveBeenCalledOnce(); expect(storage.get).toHaveBeenCalledExactlyOnceWith(project.id);
    expect(useProjectStore.getState().currentProject?.nodes[0].data.content).toBe('Latest before switch');
    expect(useProjectStore.getState().isOpeningProject).toBe(false);
  });
  it('deletes a deferred project without stale serialization or resurrection', async () => {
    const serialized = vi.fn(); edit('To delete', serialized); await vi.advanceTimersByTimeAsync(260);
    const stale = [...idle.values()][0]; interaction = true;
    useProjectStore.getState().deleteProject(project.id); stale(); await vi.advanceTimersByTimeAsync(6000);
    expect(serialized).not.toHaveBeenCalled(); expect(storage.upsert).not.toHaveBeenCalled();
    expect(storage.remove).toHaveBeenCalledExactlyOnceWith(project.id); expect(storage.records.has(project.id)).toBe(false);
  });
  it('bounds interaction deferral so a continuously held gesture cannot leave edits unsaved forever', async () => {
    interaction = true; edit('Bounded save'); await vi.advanceTimersByTimeAsync(260);
    for (let i = 0; i < 65; i++) { deliverIdle(); await vi.advanceTimersByTimeAsync(80); }
    expect(storage.upsert).toHaveBeenCalledOnce();
    expect(storage.records.has(project.id)).toBe(true);
  });
  it('also defers serialization on WebKit without requestIdleCallback', async () => {
    vi.stubGlobal('requestIdleCallback', undefined);
    interaction = true; const serialized = vi.fn(); edit('Fallback', serialized);
    await vi.advanceTimersByTimeAsync(1000);
    expect(serialized).not.toHaveBeenCalled();
    interaction = false; await vi.advanceTimersByTimeAsync(160);
    expect(storage.upsert).toHaveBeenCalledOnce();
  });
});
