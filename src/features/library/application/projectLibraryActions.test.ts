import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProjectRecord, listProjectSummaries, upsertProjectRecord, type ProjectRecord } from '@/commands/projectState';
import * as assets from '@/features/assets/application/assetCatalog';
import { canvasNodeFactory } from '@/features/canvas/application/canvasServices';
import type * as CanvasServices from '@/features/canvas/application/canvasServices';
import { collectInputReferences } from '@/features/canvas/application/graphReferenceResolver';
import { CANVAS_NODE_TYPES, type CanvasNode, type CanvasNodeData, type CanvasNodeType } from '@/features/canvas/domain/canvasNodes';
import type { Character } from '@/features/characters/domain/types';
import { importProjectMedia } from '@/features/workbench/application/importWorkbenchResult';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore, type Project } from '@/stores/projectStore';
import { reuseParams, type HistoryReuseDraft } from '../history/history';
import type { ToolboxTemplate } from '../toolbox/toolbox';
import { applyCharacterToProject, applyToolboxTemplateToProject, getCanvasHistoryReuseOptions, reuseCanvasHistoryInProject } from './projectLibraryActions';

const paid = vi.hoisted(() => ({ image: vi.fn(), video: vi.fn() }));
vi.mock('@/commands/projectState', () => ({ getProjectRecord: vi.fn(), upsertProjectRecord: vi.fn(), listProjectSummaries: vi.fn() }));
vi.mock('@/features/canvas/application/canvasServices', async importOriginal => {
  const original = await importOriginal<typeof CanvasServices>();
  return { ...original, canvasAiGateway: { ...original.canvasAiGateway, submitGenerateImageJob: paid.image },
    canvasVideoGateway: { ...original.canvasVideoGateway, submitGenerateVideoJob: paid.video } };
});

const originalCanvas = useCanvasStore.getState();
const originalProject = useProjectStore.getState();
const records = new Map<string, ProjectRecord>();
const character: Character = { id: 'actor', name: 'Actor', images: [{ assetId: 'portrait' }], mainImage: { assetId: 'portrait' }, tags: [], createdAt: 1, updatedAt: 1 };
const portrait: assets.AssetRecord = { id: 'portrait', kind: 'image', source: '/media/portrait.png', name: 'Portrait', origin: 'uploaded', favorite: false, createdAt: 1, metadata: {} };

function node(id: string, type: CanvasNodeType, data: Partial<CanvasNodeData> = {}, parentId?: string): CanvasNode {
  return { ...canvasNodeFactory.createNode(type, { x: 20, y: 30 }, data), id, ...(parentId ? { parentId } : {}) };
}
function template(): ToolboxTemplate {
  return { id: 'template', name: 'Shots', createdAt: 1, bounds: { x: 0, y: 0, width: 600, height: 400 },
    nodes: [
      { ...node('group', CANVAS_NODE_TYPES.group, { label: 'Shots' }), position: { x: 0, y: 0 } },
      node('a', CANVAS_NODE_TYPES.imageEdit, { prompt: 'Close-up', model: 'chosen-model', resultNodeId: 'b', sourceAiNodeId: 'b', generationJobId: 'old-image-job', isGenerating: true }, 'group'),
      node('b', CANVAS_NODE_TYPES.aiVideo, { prompt: 'Turn around', sourceAiNodeId: 'a', generationLastJobId: 'old-video-job' }, 'group'),
      node('tag', CANVAS_NODE_TYPES.tag, { label: 'Identity' }, 'group'),
      node('tag-group', CANVAS_NODE_TYPES.tagGroup, { label: 'References', memberNodeIds: ['a'], legacyMemberTagIds: ['tag'] }, 'group'),
    ], edges: [{ id: 'a-b', source: 'a', target: 'b' }, { id: 'a-tag', source: 'a', target: 'tag' }] };
}
function historyDraft(): Extract<HistoryReuseDraft, { surface: 'canvas' }> {
  const draft = reuseParams({ id: 'history', createdAt: 1, surface: 'canvas', projectId: 'old-project', nodeId: 'old-node',
    modelRef: 'chosen-model', prompt: 'COMPILED prompt with camera constraints', status: 'succeeded', outputs: [], jobIds: ['paid-old-job'],
    params: { nodeType: CANVAS_NODE_TYPES.imageEdit, nodeData: node('old-node', CANVAS_NODE_TYPES.imageEdit, {
      prompt: 'Original draft @Portrait', model: 'chosen-model', selectedPromptPresetId: 'preset',
      channelModeId: 'reference', referenceSlots: { identity: ['/media/portrait.png'] }, extraParams: { seed: 7 },
      generationJobId: 'paid-old-job', workbenchTaskId: 'old-task', resultNodeId: 'old-result', batchId: 'old-batch', isGenerating: true,
      lastPreparedPayload: { prompt: 'COMPILED prompt with camera constraints' },
    }).data, tool: { id: 'lighting', prompt: 'Original tool draft', params: { azimuth: 35, strength: 0.6 } }, count: 3 },
    references: [
      { id: 'old-portrait', kind: 'image', source: '/media/portrait.png', name: 'Portrait' },
      { id: 'old-video', kind: 'video', source: '/media/motion.mp4', name: 'Motion' },
      { id: 'old-audio', kind: 'audio', source: '/media/voice.wav', name: 'Voice' },
      { id: 'old-text', kind: 'text', source: 'The original scene description', name: 'Scene' },
    ] });
  if (draft.surface !== 'canvas') throw new Error('Expected a canvas fixture');
  return draft;
}
function projectRecord(): ProjectRecord {
  return { id: 'target', name: 'Target', createdAt: 1, updatedAt: 2, nodeCount: 1,
    nodesJson: JSON.stringify([node('original', CANVAS_NODE_TYPES.upload, { imageUrl: '/media/original.png' })]),
    edgesJson: '[]', historyJson: '{"past":[],"future":[]}', imagePoolJson: '[]', viewportJson: '{"x":10,"y":20,"zoom":2}' };
}
function savedProject(): Project {
  const record = records.get('target');
  if (!record) throw new Error('Missing target fixture');
  return assets.projectFromRecord(record);
}
type FixtureKind = 'character' | 'template' | 'history';
function applyFixture(kind: FixtureKind, projectId = 'target', position?: { x: number; y: number }): Promise<string[]> {
  if (kind === 'character') return applyCharacterToProject(character, projectId, position);
  if (kind === 'template') return applyToolboxTemplateToProject(template(), projectId, position);
  return reuseCanvasHistoryInProject(historyDraft(), projectId, position);
}
async function reopenTarget(): Promise<Project> {
  const { promise: opened, resolve } = Promise.withResolvers<Project>();
  const unsubscribe = useProjectStore.subscribe(state => {
    if (state.currentProjectId !== 'target' || !state.currentProject || state.isOpeningProject) return;
    unsubscribe();
    resolve(state.currentProject);
  });
  useProjectStore.getState().openProject('target');
  return await opened;
}

beforeEach(() => {
  vi.clearAllMocks();
  records.clear();
  records.set('target', projectRecord());
  vi.mocked(getProjectRecord).mockImplementation(async id => structuredClone(records.get(id) ?? null));
  vi.mocked(upsertProjectRecord).mockImplementation(async record => { records.set(record.id, structuredClone(record)); });
  vi.mocked(listProjectSummaries).mockImplementation(async () => [...records.values()].map(({ id, name, createdAt, updatedAt, nodeCount }) => ({ id, name, createdAt, updatedAt, nodeCount })));
  vi.spyOn(assets, 'resolveAsset').mockResolvedValue(portrait);
  useCanvasStore.setState({ nodes: [node('unrelated', CANVAS_NODE_TYPES.textAnnotation, { content: 'Other project' })], edges: [], revision: 0,
    selectedNodeId: null, history: { past: [], future: [] }, currentViewport: { x: 100, y: 40, zoom: 2 }, canvasViewportSize: { width: 1280, height: 720 } });
  useProjectStore.setState({ currentProjectId: 'other', currentProject: null, isOpeningProject: false,
    saveCurrentProject: vi.fn(), waitForProjectPersistence: vi.fn().mockResolvedValue(undefined) });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  useCanvasStore.setState(originalCanvas, true);
  useProjectStore.setState(originalProject, true);
});

describe('project-targeted library actions', () => {
  it.each<FixtureKind>(['character', 'template', 'history'])('applies %s to the active graph in one selected, persisted undo step', async kind => {
    const project = savedProject();
    useCanvasStore.setState({ nodes: project.nodes, edges: project.edges, history: project.history, selectedNodeId: null, revision: 0 });
    useProjectStore.setState({ currentProjectId: 'target', currentProject: project });
    const ids = await applyFixture(kind, 'target', { x: 111, y: 222 });
    const canvas = useCanvasStore.getState();
    expect(canvas.nodes.filter(item => item.selected).map(item => item.id)).toEqual(ids);
    expect(canvas.nodes.find(item => item.id === ids[0])?.position).toEqual({ x: 111, y: 222 });
    expect(canvas.history.past).toHaveLength(1);
    expect(useProjectStore.getState().saveCurrentProject).toHaveBeenCalledOnce();
    expect(useProjectStore.getState().currentProjectId).toBe('target');
    expect(canvas.undo()).toBe(true);
    expect(useCanvasStore.getState().nodes).toMatchObject(project.nodes);
    expect(useCanvasStore.getState().edges).toEqual(project.edges);
    expect(useCanvasStore.getState().redo()).toBe(true);
    expect(useCanvasStore.getState().nodes.map(item => item.id)).toEqual(['original', ...ids]);
  });

  it.each<FixtureKind>(['character', 'template', 'history'])('persists %s in an unopened project and reopens its complete graph', async kind => {
    const untouched = useCanvasStore.getState();
    const ids = await applyFixture(kind);
    expect(useCanvasStore.getState()).toBe(untouched);
    expect(useProjectStore.getState().currentProjectId).toBe('other');
    const saved = savedProject();
    expect(saved.nodes.map(item => item.id)).toEqual(['original', ...ids]);
    expect(saved.nodes.find(item => item.id === ids[0])?.position).toEqual({ x: 155, y: 50 });
    expect(saved.history.past).toHaveLength(1);
    const reopened = await reopenTarget();
    expect(reopened.nodes).toMatchObject(saved.nodes);
    expect(reopened.edges).toEqual(saved.edges);
    useCanvasStore.setState({ nodes: reopened.nodes, edges: reopened.edges, history: reopened.history, revision: 0 });
    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(useCanvasStore.getState().nodes.map(item => item.id)).toEqual(['original']);
  });

  it('preserves character image-node configuration and factory defaults rather than creating a material node', async () => {
    const [id] = await applyCharacterToProject(character, 'target');
    const applied = savedProject().nodes.find(item => item.id === id);
    const expected = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.imageEdit, { x: 155, y: 50 }, { displayName: character.name, imageUrl: portrait.source });
    expect(applied).toMatchObject({ type: CANVAS_NODE_TYPES.imageEdit, position: expected.position, style: expected.style, data: expected.data });
    expect(character.mainImage).toEqual({ assetId: 'portrait' });
  });

  it('remaps template parents, all internal node references and edge endpoints to fresh identities', async () => {
    const source = template();
    const snapshot = structuredClone(source);
    const ids = await applyToolboxTemplateToProject(source, 'target', { x: -300, y: 600 });
    const applied = savedProject();
    const [groupId, aId, bId, tagId, tagGroupId] = ids;
    expect(new Set(ids).size).toBe(source.nodes.length);
    expect(ids.some(id => source.nodes.some(item => item.id === id))).toBe(false);
    expect(applied.nodes.find(item => item.id === groupId)?.position).toEqual({ x: -300, y: 600 });
    expect(applied.nodes.filter(item => ids.includes(item.id) && item.id !== groupId).every(item => item.parentId === groupId)).toBe(true);
    expect(applied.nodes.find(item => item.id === aId)?.data).toMatchObject({ prompt: 'Close-up', model: 'chosen-model', resultNodeId: bId, sourceAiNodeId: bId, isGenerating: false });
    expect(applied.nodes.find(item => item.id === bId)?.data.sourceAiNodeId).toBe(aId);
    expect(applied.nodes.find(item => item.id === tagGroupId)?.data).toMatchObject({ memberNodeIds: [aId], legacyMemberTagIds: [tagId] });
    expect(applied.edges.map(edge => [edge.source, edge.target])).toEqual([[aId, bId], [aId, tagId]]);
    expect(applied.edges.some(edge => source.edges.some(original => original.id === edge.id))).toBe(false);
    for (const item of applied.nodes.filter(item => ids.includes(item.id))) {
      expect(item.data.generationJobId).toBeFalsy();
      expect(item.data.generationLastJobId).toBeFalsy();
      expect(item.data.isGenerating).not.toBe(true);
    }
    expect(source).toEqual(snapshot);
  });

  it('restores original history prompt, model, tool/count, slots and ordered reference content without paid submit', async () => {
    const draft = historyDraft();
    const snapshot = structuredClone(draft);
    const ids = await reuseCanvasHistoryInProject(draft, 'target');
    const project = savedProject();
    const restored = project.nodes.find(item => item.id === ids[0]);
    expect(restored?.data).toMatchObject({ prompt: 'Original draft @Portrait', model: 'chosen-model', selectedPromptPresetId: 'preset',
      channelModeId: 'reference', referenceSlots: { identity: ['/media/portrait.png'] }, extraParams: { seed: 7 }, isGenerating: false });
    expect(restored).toBeDefined();
    if (!restored) throw new Error('Missing restored node');
    expect(getCanvasHistoryReuseOptions(restored.data)).toEqual(snapshot.options);
    const options = getCanvasHistoryReuseOptions(restored.data);
    if (options?.tool?.params) options.tool.params.azimuth = 999;
    expect(getCanvasHistoryReuseOptions(restored.data)).toEqual(snapshot.options);
    for (const key of ['generationJobId', 'workbenchTaskId', 'resultNodeId', 'batchId', 'lastPreparedPayload']) expect(restored.data).not.toHaveProperty(key);
    const references = collectInputReferences(restored.id, project.nodes, project.edges);
    expect(references.map(reference => ({ kind: reference.kind, source: reference.imageUrl ?? reference.videoUrl ?? reference.audioUrl ?? reference.content, name: reference.title })))
      .toEqual(snapshot.references.map(({ kind, source, name }) => ({ kind, source, name })));
    expect(references.every(reference => !snapshot.references.some(original => original.id === reference.sourceNodeId))).toBe(true);
    expect(paid.image).not.toHaveBeenCalled();
    expect(paid.video).not.toHaveBeenCalled();
    expect(draft).toEqual(snapshot);
  });

  it('waits for active project persistence before resolving', async () => {
    const project = savedProject();
    useProjectStore.setState({ currentProjectId: 'target', currentProject: project });
    useCanvasStore.setState({ nodes: project.nodes, edges: project.edges, history: project.history, revision: 0 });
    const { promise: persistence, resolve: release } = Promise.withResolvers<void>();
    const { promise: waiting, resolve: markWaiting } = Promise.withResolvers<void>();
    const wait = vi.fn().mockResolvedValueOnce(undefined).mockImplementationOnce(() => { markWaiting(); return persistence; });
    useProjectStore.setState({ waitForProjectPersistence: wait });
    let complete = false;
    const pending = applyCharacterToProject(character, 'target').then(ids => { complete = true; return ids; });
    await waiting;
    expect(complete).toBe(false);
    release();
    await pending;
    expect(complete).toBe(true);
  });

  it.each<FixtureKind>(['character', 'template', 'history'])('rejects a missing %s destination before graph mutation or persistence', async kind => {
    const untouched = useCanvasStore.getState();
    const before = savedProject();
    await expect(applyFixture(kind, 'missing')).rejects.toThrow('目标项目已不存在');
    expect(useCanvasStore.getState()).toBe(untouched);
    expect(savedProject()).toEqual(before);
    expect(upsertProjectRecord).not.toHaveBeenCalled();
    expect(useProjectStore.getState().saveCurrentProject).not.toHaveBeenCalled();
  });

  it('rejects invalid input without a partial active or inactive import', async () => {
    const untouched = useCanvasStore.getState();
    const invalid = template();
    invalid.nodes[1].position.x = Number.NaN;
    const badReference = historyDraft();
    badReference.references[1].source = '';
    await expect(applyToolboxTemplateToProject(invalid, 'target')).rejects.toThrow();
    await expect(reuseCanvasHistoryInProject(badReference, 'target')).rejects.toThrow();
    await expect(reuseCanvasHistoryInProject({ ...historyDraft(), options: { count: 0 } }, 'target')).rejects.toThrow();
    await expect(applyCharacterToProject(character, 'target', { x: Infinity, y: 0 })).rejects.toThrow();
    vi.mocked(assets.resolveAsset).mockResolvedValue(null);
    await expect(applyCharacterToProject(character, 'target')).rejects.toThrow();
    expect(useCanvasStore.getState()).toBe(untouched);
    expect(upsertProjectRecord).not.toHaveBeenCalled();
    expect(useProjectStore.getState().saveCurrentProject).not.toHaveBeenCalled();
  });

  it('keeps concurrent media and library additions and both undo patches in an unopened project', async () => {
    vi.useFakeTimers();
    vi.mocked(upsertProjectRecord).mockImplementationOnce(async record => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 1);
      await promise;
      records.set(record.id, structuredClone(record));
    });
    const pending = Promise.all([
      importProjectMedia({ kind: 'text', source: 'Imported media content' }, { name: 'Imported text' }, 'target'),
      applyToolboxTemplateToProject(template(), 'target'),
    ]);
    await vi.advanceTimersByTimeAsync(1);
    const [mediaId, libraryIds] = await pending;
    const project = savedProject();
    expect(project.nodes.map(item => item.id)).toEqual(['original', mediaId, ...libraryIds]);
    expect(project.nodes.find(item => item.id === mediaId)?.data.content).toBe('Imported media content');
    expect(project.edges).toHaveLength(2);
    expect(project.history.past).toHaveLength(2);
    expect(useProjectStore.getState().currentProjectId).toBe('other');
    expect(paid.image).not.toHaveBeenCalled();
    expect(paid.video).not.toHaveBeenCalled();
  });
});
