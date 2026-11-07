import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectRecord } from '@/commands/projectState';

const storage = vi.hoisted(() => ({ records: new Map<string, ProjectRecord>() }));
vi.mock('@/commands/projectState', () => ({
  deleteProjectRecord: vi.fn(async (id: string) => { storage.records.delete(id); }),
  getProjectRecord: vi.fn(async (id: string) => storage.records.get(id) ?? null),
  listProjectSummaries: vi.fn(async () => []),
  renameProjectRecord: vi.fn(async () => {}),
  updateProjectViewportRecord: vi.fn(async () => {}),
  upsertProjectRecord: vi.fn(async (record: ProjectRecord) => { storage.records.set(record.id, record); }),
}));

import { useCanvasStore } from './canvasStore';
import { useProjectStore } from './projectStore';
import { CANVAS_NODE_TYPES, type BlueprintNodeData } from '@/features/canvas/domain/canvasNodes';
import { canvasCommandRegistry } from '@/features/canvas/application/canvasCommandService';
import { DEFAULT_DEPTH_RELIEF_PARAMETERS } from '@/features/stage/domain/depthRelief';
import { readWorkspaceRecord } from '@/features/assets/application/assetMediaStorage';

beforeEach(() => {
  storage.records.clear();
  useProjectStore.setState({ projects: [], currentProjectId: null, currentProject: null, isHydrated: true, isOpeningProject: false });
  useCanvasStore.setState({ nodes: [], edges: [], revision: 0, selectedNodeId: null, history: { past: [], future: [] }, dragHistorySnapshot: null });
});

async function reload(id: string) {
  useCanvasStore.getState().setCanvasData([], []);
  useProjectStore.getState().openProject(id);
  await vi.waitFor(() => expect(useProjectStore.getState().isOpeningProject).toBe(false));
  const project = useProjectStore.getState().currentProject!;
  useCanvasStore.getState().setCanvasData(project.nodes, project.edges, project.history);
}

async function saveAndClose(id: string) {
  const state = useCanvasStore.getState();
  useProjectStore.getState().saveCurrentProject(state.nodes, state.edges, state.currentViewport, state.history);
  useProjectStore.getState().closeProject();
  await useProjectStore.getState().waitForProjectPersistence(id);
}

describe('project patch history persistence', () => {
  it('persists the nearest 50 of 200 steps and round-trips them after reopening', async () => {
    const id = useProjectStore.getState().createProject('History');
    await useProjectStore.getState().waitForProjectPersistence(id);
    useCanvasStore.setState({ nodes: [{ id: 'note', type: CANVAS_NODE_TYPES.textAnnotation, position: { x: 0, y: 0 }, data: { content: '' } }] });
    for (let index = 1; index <= 200; index += 1) useCanvasStore.getState().updateNodeData('note', { content: `Edit ${index}` });
    await saveAndClose(id);
    expect(JSON.parse(storage.records.get(id)!.historyJson).past).toHaveLength(50);
    await reload(id);
    expect(useCanvasStore.getState().history.past).toHaveLength(50);
    for (let index = 0; index < 50; index += 1) expect(useCanvasStore.getState().undo()).toBe(true);
    expect(useCanvasStore.getState().nodes[0].data.content).toBe('Edit 150');
    expect(useCanvasStore.getState().undo()).toBe(false);
    for (let index = 0; index < 50; index += 1) expect(useCanvasStore.getState().redo()).toBe(true);
    expect(useCanvasStore.getState().nodes[0].data.content).toBe('Edit 200');
  });

  it('keeps a combined 50-step past/redo window across reload with large pooled media', async () => {
    const id = useProjectStore.getState().createProject('Heavy stage');
    await useProjectStore.getState().waitForProjectPersistence(id);
    const imageUrl = `data:image/png;base64,${'a'.repeat(2_000_000)}`;
    const data: BlueprintNodeData = { mode: 'flat', aspectRatio: '16:9', items: [], referenceImages: [], backgroundImageUrl: imageUrl };
    useCanvasStore.setState({ nodes: [{ id: 'stage', type: CANVAS_NODE_TYPES.blueprint, position: { x: 0, y: 0 }, data }] });
    for (let index = 1; index <= 60; index += 1) useCanvasStore.getState().updateNodeData('stage', { displayName: `Stage ${index}` });
    for (let index = 0; index < 40; index += 1) useCanvasStore.getState().undo();
    await saveAndClose(id);
    await reload(id);
    expect(useCanvasStore.getState().history.past).toHaveLength(20);
    expect(useCanvasStore.getState().history.future).toHaveLength(30);
    for (let index = 0; index < 30; index += 1) expect(useCanvasStore.getState().redo()).toBe(true);
    expect(useCanvasStore.getState().nodes[0].data.displayName).toBe('Stage 50');
    // Large media is pooled outside the history payload; the restored reference must still hold the original bytes.
    const restored = String(useCanvasStore.getState().nodes[0].data.backgroundImageUrl);
    const blob = restored.startsWith('asset-media:') ? await readWorkspaceRecord<Blob>('media', restored) : undefined;
    expect(restored === imageUrl || blob?.size === 1_500_000).toBe(true);
    expect(storage.records.get(id)!.historyJson).not.toContain('a'.repeat(1000));
  });

  it('continues the same approved Agent turn after persistence reload without splitting its undo step', async () => {
    const id = useProjectStore.getState().createProject('Continued Agent turn');
    await useProjectStore.getState().waitForProjectPersistence(id);
    useCanvasStore.getState().setCanvasData([{ id: 'note', type: CANVAS_NODE_TYPES.textAnnotation, position: { x: 0, y: 0 }, data: { content: 'User text', displayName: 'Original note' } }], []);
    const groupId = JSON.stringify([id, 'persisted-turn']);
    expect((await canvasCommandRegistry.executeApproved({ type: 'node.rename', version: 1, input: { nodeId: 'note', displayName: 'First' } },
      useCanvasStore.getState().revision, 'agent', groupId)).ok).toBe(true);
    await saveAndClose(id);
    await reload(id);
    expect((await canvasCommandRegistry.executeApproved({ type: 'node.rename', version: 1, input: { nodeId: 'note', displayName: 'Final' } },
      useCanvasStore.getState().revision, 'agent', groupId)).ok).toBe(true);
    expect(useCanvasStore.getState().history.past).toHaveLength(1);
    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(useCanvasStore.getState().nodes[0].data).toMatchObject({ content: 'User text', displayName: 'Original note' });
    expect(useCanvasStore.getState().redo()).toBe(true);
    expect(useCanvasStore.getState().nodes[0].data.displayName).toBe('Final');
  });

  it('retains imported models, reliefs and saved stages in both past and future after reopening', async () => {
    const id = useProjectStore.getState().createProject('Imported stage history');
    await useProjectStore.getState().waitForProjectPersistence(id);
    const relief = { ...DEFAULT_DEPTH_RELIEF_PARAMETERS, imageUrl: '/media/backdrop.png', depthUrl: '/media/backdrop-depth.png' };
    const data: BlueprintNodeData = {
      displayName: 'Imported stage', mode: 'flat', aspectRatio: '16:9', backgroundImageUrl: '/media/background.png', referenceImages: [],
      items: [
        { id: 'model', label: 'Imported prop', category: 'object', x: 1, y: 2, color: '#ffffff', importedModelId: 'model-library:chair', pos3d: { x: 1, y: 0, z: 2 }, scale3d: { x: 2, y: 2, z: 2 } },
        { id: 'relief', label: 'Backdrop', category: 'scene', x: 0, y: 0, color: '#ffffff', relief },
      ],
    };
    data.directorStudioProjects = [{ id: 'saved-stage', name: 'Saved stage', createdAt: 1, updatedAt: 2, snapshot: { mode: data.mode, aspectRatio: data.aspectRatio, items: structuredClone(data.items), referenceImages: [] } }];
    useCanvasStore.getState().setCanvasData([{ id: 'stage', type: CANVAS_NODE_TYPES.blueprint, position: { x: 0, y: 0 }, data }], []);
    const stage = useCanvasStore.getState().nodes[0].data as BlueprintNodeData;
    useCanvasStore.getState().updateNodeData('stage', {
      items: stage.items.map((item) => item.id === 'model' ? { ...item, importedModelId: 'model-library:table', pos3d: { x: 4, y: 0, z: 5 } } : { ...item, relief: { ...relief, depthM: 6 } }),
      directorStudioProjects: stage.directorStudioProjects!.map((project) => ({ ...project, updatedAt: 3, snapshot: { ...project.snapshot, items: project.snapshot.items.filter((item) => item.id === 'relief') } })),
    });
    useCanvasStore.getState().updateNodeData('stage', { displayName: 'Final title' });
    expect(useCanvasStore.getState().undo()).toBe(true);
    await saveAndClose(id);
    await reload(id);
    const expectStage = (modelId: string, position: { x: number; y: number; z: number }, depthM: number, savedItemIds: string[], title = 'Imported stage') => {
      const restored = useCanvasStore.getState().nodes.find((node) => node.id === 'stage')!.data as BlueprintNodeData;
      expect(restored.displayName).toBe(title);
      expect(restored.backgroundImageUrl).toBe('/media/background.png');
      expect(restored.mediaReferences).toMatchObject({
        backgroundImageUrl: { status: 'ready', source: '/media/background.png', assetId: expect.any(String) },
      });
      expect(restored.items.find((item) => item.id === 'model')).toMatchObject({
        importedModelId: modelId, pos3d: position, scale3d: { x: 2, y: 2, z: 2 },
      });
      expect(restored.items.find((item) => item.id === 'relief')?.relief).toEqual({ ...relief, depthM });
      const saved = restored.directorStudioProjects!.find((project) => project.id === 'saved-stage')!;
      expect(saved.name).toBe('Saved stage');
      expect(saved.snapshot.items.map((item) => item.id)).toEqual(savedItemIds);
      expect(saved.snapshot.items.find((item) => item.id === 'relief')?.relief).toEqual(relief);
      if (savedItemIds.includes('model')) {
        expect(saved.snapshot.items.find((item) => item.id === 'model')).toMatchObject({ importedModelId: 'model-library:chair', pos3d: { x: 1, y: 0, z: 2 } });
      }
    };
    expect(useCanvasStore.getState().history.past).toHaveLength(1);
    expect(useCanvasStore.getState().history.future).toHaveLength(1);
    expectStage('model-library:table', { x: 4, y: 0, z: 5 }, 6, ['relief']);
    expect(useCanvasStore.getState().undo()).toBe(true);
    expectStage('model-library:chair', { x: 1, y: 0, z: 2 }, 3, ['model', 'relief']);
    expect(useCanvasStore.getState().redo()).toBe(true);
    expectStage('model-library:table', { x: 4, y: 0, z: 5 }, 6, ['relief']);
    expect(useCanvasStore.getState().redo()).toBe(true);
    expectStage('model-library:table', { x: 4, y: 0, z: 5 }, 6, ['relief'], 'Final title');
  });

  it('loads and migrates persisted legacy snapshot past and future stacks', async () => {
    const current = { id: 'note', type: CANVAS_NODE_TYPES.textAnnotation, position: { x: 0, y: 0 }, data: { content: 'Current' } };
    storage.records.set('legacy', { id: 'legacy', name: 'Legacy', createdAt: 1, updatedAt: 1, nodeCount: 1, nodesJson: JSON.stringify([current]), edgesJson: '[]', viewportJson: '{"x":0,"y":0,"zoom":1}', historyJson: JSON.stringify({ past: [{ nodes: [{ ...current, data: { content: 'Before' } }], edges: [] }], future: [{ nodes: [{ ...current, data: { content: 'After' } }], edges: [] }], imagePool: [] }) });
    await reload('legacy');
    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(useCanvasStore.getState().nodes[0].data.content).toBe('Before');
    expect(useCanvasStore.getState().redo()).toBe(true);
    expect(useCanvasStore.getState().nodes[0].data.content).toBe('Current');
    expect(useCanvasStore.getState().redo()).toBe(true);
    expect(useCanvasStore.getState().nodes[0].data.content).toBe('After');
    await saveAndClose('legacy');
    const saved = JSON.parse(storage.records.get('legacy')!.historyJson);
    expect(saved.past.every((entry: { version: number; patches: unknown[] }) => entry.version === 1 && entry.patches.length > 0)).toBe(true);
  });

  it('migrates legacy tag links before diffing history, preserving media and avoiding duplicate edges', async () => {
    const source = { id: 'source', type: CANVAS_NODE_TYPES.upload, position: { x: 50, y: 0 }, data: { imageUrl: '__img_ref__:0', aspectRatio: '1:1' } };
    const tag = { id: 'tag', type: CANVAS_NODE_TYPES.tag, position: { x: 300, y: 0 }, data: { label: 'Reference', enabled: true, color: 'cyan', sourceId: 'source' } };
    storage.records.set('legacy-tag', { id: 'legacy-tag', name: 'Legacy tag', createdAt: 1, updatedAt: 1, nodeCount: 2, nodesJson: JSON.stringify([source, tag]), edgesJson: '[]', viewportJson: '{"x":0,"y":0,"zoom":1}', imagePoolJson: '["/media/original.png"]', historyJson: JSON.stringify({ past: [{ nodes: [{ ...source, position: { x: 0, y: 0 } }, tag], edges: [] }], future: [] }) });
    await reload('legacy-tag');
    expect(useCanvasStore.getState().edges).toHaveLength(1);
    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(useCanvasStore.getState().edges).toHaveLength(1);
    expect(useCanvasStore.getState().nodes[0].position.x).toBe(0);
    expect(useCanvasStore.getState().nodes[0].data.imageUrl).toBe('/media/original.png');
    expect(useCanvasStore.getState().nodes[1].data).not.toHaveProperty('sourceId');
    expect(useCanvasStore.getState().redo()).toBe(true);
    expect(useCanvasStore.getState().edges).toHaveLength(1);
    expect(useCanvasStore.getState().nodes[0].position.x).toBe(50);
  });
});
