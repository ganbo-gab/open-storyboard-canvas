import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectRecord } from '@/commands/projectState';
import type { AssetRecord } from '@/features/assets/application/assetCatalog';
import type { CanvasNode, BlueprintNodeData } from '@/features/canvas/domain/canvasNodes';
import type { ProjectMediaResolver } from '@/features/canvas/domain/projectMedia';
import { applyCanvasHistoryEntry, createCanvasHistoryEntry } from './canvasHistory';
import { directorFixture, expectedPose, legacyProjectFixtures, mediaFixture, releaseFixture, tagsFixture, type LegacyProjectFixture } from './__fixtures__/legacy/legacyProjects';

const storage = vi.hoisted(() => ({ records: new Map<string, ProjectRecord>(), assets: new Map<string, AssetRecord>() }));
vi.mock('@/commands/projectState', () => ({
  getProjectRecord: vi.fn(async (id: string) => storage.records.get(id) ?? null),
  listProjectSummaries: vi.fn(async () => []),
  upsertProjectRecord: vi.fn(async (record: ProjectRecord) => { storage.records.set(record.id, structuredClone(record)); }),
  deleteProjectRecord: vi.fn(async () => {}), renameProjectRecord: vi.fn(async () => {}), updateProjectViewportRecord: vi.fn(async () => {}),
}));
vi.mock('@/features/assets/application/assetCatalog', () => ({
  listAssets: vi.fn(async () => [...storage.assets.values()]),
  saveAsset: vi.fn(async (input: Omit<AssetRecord, 'id' | 'createdAt' | 'favorite'>) => {
    if (input.source.endsWith('/gone')) throw new Error('Legacy blob bytes are unavailable');
    const source = /^(blob|data):/.test(input.source) ? `asset-media:${input.kind}:fixture-${storage.assets.size}` : input.source;
    const asset: AssetRecord = { ...input, id: `asset-${storage.assets.size}`, source, createdAt: 1, favorite: false };
    storage.assets.set(asset.id, asset);
    return asset;
  }),
}));
import { decodeProject, encodeProject, migrateProjectMedia, useProjectStore, type Project } from './projectStore';
import { useCanvasStore } from './canvasStore';

function decodeFixture(fixture: LegacyProjectFixture): Project {
  const record = fixture.record;
  const history = JSON.parse(record.historyJson) as Project['history'] & { imagePool?: string[] };
  return decodeProject({ id: record.id, name: record.name, createdAt: record.createdAt, updatedAt: record.updatedAt,
    nodeCount: record.nodeCount, nodes: JSON.parse(record.nodesJson), edges: JSON.parse(record.edgesJson),
    viewport: JSON.parse(record.viewportJson), history,
    imagePool: record.imagePoolJson ? JSON.parse(record.imagePoolJson) : record.imagePool ?? history.imagePool });
}
function nodeData(project: Project, id: string): Record<string, unknown> {
  const node = project.nodes.find((item) => item.id === id);
  expect(node, `node ${id} exists`).toBeDefined();
  return node!.data;
}
function assertFields(project: Project, fixture: LegacyProjectFixture) {
  for (const [id, key, value] of fixture.expected) expect(nodeData(project, id)[key], `${fixture.name}: ${id}.${key}`).toEqual(value);
}
function stage(project: Project): BlueprintNodeData {
  return nodeData(project, 'stage') as unknown as BlueprintNodeData;
}
async function openRecord(record: ProjectRecord): Promise<Project> {
  storage.records.set(record.id, structuredClone(record));
  useProjectStore.getState().openProject(record.id);
  await vi.waitFor(() => expect(useProjectStore.getState().isOpeningProject).toBe(false));
  const project = useProjectStore.getState().currentProject;
  expect(project?.id).toBe(record.id);
  return project!;
}

beforeEach(() => {
  storage.records.clear(); storage.assets.clear();
  useProjectStore.setState({ currentProjectId: null, currentProject: null, projects: [], isHydrated: true, isOpeningProject: false });
  useCanvasStore.getState().setCanvasData([], []);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('P1 legacy project migration consistency fixtures', () => {
  it.each(legacyProjectFixtures)('$name preserves explicit user-visible field expectations', (fixture) => {
    const project = decodeFixture(fixture);
    assertFields(project, fixture);
    expect(project.name).toBe('旧工程 · 夜雨追逐');
    expect(project.createdAt).toBe(1710000000000);
    expect(project.updatedAt).toBe(1720000000000);
    expect(project.viewport).toEqual({ x: -120, y: 80, zoom: 0.75 });
    expect(project.nodeCount).toBe(JSON.parse(fixture.record.nodesJson).length);
    expect(project.nodes.map((node) => [node.id, node.position])).toEqual(
      (JSON.parse(fixture.record.nodesJson) as CanvasNode[]).map((node) => [node.id, { x: 120, y: -40 }]),
    );
  });

  it.each(legacyProjectFixtures)('$name normalizes idempotently and round-trips JSON persistence', (fixture) => {
    const project = decodeFixture(fixture);
    expect(decodeProject(project)).toEqual(project);
    const saved = JSON.parse(JSON.stringify(encodeProject(project))) as Parameters<typeof decodeProject>[0];
    expect(decodeProject(saved)).toEqual(project);
    assertFields(decodeProject(saved), fixture);
  });

  it('keeps every released node type, grouping geometry, valid edge metadata and migrates missing handles', () => {
    const project = decodeFixture(releaseFixture);
    expect(project.nodes.map((node) => node.type)).toEqual(['groupNode', 'uploadNode', 'imageNode', 'exportImageNode', 'textAnnotationNode', 'storyboardNode', 'storyboardGenNode', 'panoramaNode', 'aiVideoNode', 'videoNode', 'aiTextNode', 'jsonCardNode', 'aiAudioNode', 'audioNode']);
    expect(project.nodes[0].style).toEqual({ width: 900, height: 700 });
    expect(project.nodes[1]).toMatchObject({ parentId: 'group', extent: 'parent', width: 300, height: 400 });
    expect(project.edges).toEqual([{ id: 'reference', source: 'upload', target: 'edit', label: '角色', animated: true, sourceHandle: 'source', targetHandle: 'target', type: 'disconnectableEdge' }]);
  });

  it.each(['tag', 'tag-node'])('migrates %s and all tag-group aliases without duplicate sources or unresolved-member loss', (type) => {
    for (const groupType of ['tagGroup', 'tag-group']) {
      const nodes = JSON.parse(tagsFixture.record.nodesJson) as CanvasNode[];
      nodes[1].type = type as CanvasNode['type']; nodes[2].type = groupType as CanvasNode['type'];
      const fixture = { ...tagsFixture, record: { ...tagsFixture.record, nodesJson: JSON.stringify(nodes), historyJson: '{"past":[],"future":[]}' } };
      const project = decodeFixture(fixture);
      assertFields(project, tagsFixture);
      expect(project.nodes.map((node) => node.type)).toEqual(['uploadNode', 'tagNode', 'tagGroupNode']);
      expect(nodeData(project, 'tag')).not.toHaveProperty('sourceId');
      expect(nodeData(project, 'group')).not.toHaveProperty('memberTagIds');
      expect(project.edges.map((edge) => [edge.source, edge.target])).toEqual([['source', 'tag']]);
      expect(decodeProject(project)).toEqual(project);
    }
  });

  it('migrates static director scenes, every item/pose field and saved project snapshots without negative-height loss', () => {
    const project = decodeFixture(directorFixture);
    const data = stage(project);
    expect(data.items[0]).toEqual({ id: 'actor', label: '女主', x: 22, y: 68, color: '#12abcd', showLabel: false, refImageUrl: 'file:///media/actor.png', refImageName: '女主.png', note: '红色雨伞', pos3d: { x: 1, y: 0, z: -2 }, rotation3d: { x: 0.1, y: 0.2, z: 0.3 }, scale3d: { x: 0.8, y: 1.2, z: 1 }, category: 'person', presetId: 'woman', relation: '面向 @警察', action: '旧自定义动作', pose: expectedPose, directorStudioRole: 'pedestrian', directorStudioNumber: 3, bodyControls: { style: 'slim', showControls: false, core: { height: 1.72, torsoWidth: 0.9, headScale: 1.1, torsoLeanDeg: 5 }, arms: { length: 1.1, thickness: 0.8, spreadDeg: 8 }, legs: { length: 1.2, thickness: 0.9, spreadDeg: 3 } }, relief: undefined, importedModelId: undefined });
    expect(data.customActionPoses).toEqual({ 旧自定义动作: expectedPose });
    const saved = data.directorStudioProjects![0];
    expect({ id: saved.id, name: saved.name, createdAt: saved.createdAt, updatedAt: saved.updatedAt, coverUrl: saved.coverUrl }).toEqual({ id: 'saved', name: '备用机位', createdAt: 1710000000001, updatedAt: 1710000000099, coverUrl: 'file:///media/street.jpg' });
    expect(saved.snapshot.items).toEqual(data.items);
    expect(saved.snapshot.customActionPoses).toEqual({ 旧自定义动作: expectedPose });
    for (const [id, key, value] of directorFixture.expected.filter(([id, key]) => id === 'stage' && !['displayName', 'activeDirectorStudioProjectId'].includes(key))) expect(saved.snapshot[key as keyof typeof saved.snapshot], `saved snapshot ${id}.${key}`).toEqual(value);
    expect(nodeData(project, 'static').motionProject).toBeUndefined();
    expect((nodeData(project, 'static').items as unknown[])[0]).toMatchObject({ id: 'box', label: '木箱', x: 10, y: 20, color: '#776655', category: 'object', presetId: 'box', note: '静态旧场景' });
  });

  it('normalizes director motion v0/v1 camera, transform, action and custom-clip tracks with exact authored values', () => {
    const data = stage(decodeFixture(directorFixture));
    const motion = data.motionProject!;
    expect({ schemaVersion: motion.schemaVersion, durationSeconds: motion.durationSeconds, loop: motion.loop }).toEqual({ schemaVersion: 1, durationSeconds: 8, loop: true });
    expect(motion.cameraTrack).toEqual([{ id: 'cam', time: 3, easing: 'smooth', position: { x: 3, y: 2, z: 6 }, target: { x: 1, y: 1, z: -2 }, fov: 52, trackTargetId: 'actor', trackTargetBodyPart: 'head' }]);
    expect(motion.objectTracks).toEqual({ actor: [{ id: 'move', time: 2, easing: 'linear', position: { x: 1, y: 0, z: -2 }, rotation: { x: 0, y: 0.4, z: 0 }, scale: { x: 1, y: 1.2, z: 1 }, orientToPath: true }] });
    expect(motion.actionTracks.actor[0]).toMatchObject({ id: 'act', time: 1, easing: 'smooth', poseId: 'saved-pose', actionId: 'walk', clipId: 'clip', pose: expectedPose, bodyControls: { style: 'slim', core: { height: 1.72 } } });
    expect(motion.customClips[0]).toMatchObject({ id: 'clip', name: '撑伞起步', durationSeconds: 2, loop: false, keyframes: [{ id: 'clip-frame', time: 0.5, easing: 'linear', pose: expectedPose, actionId: 'walk' }] });
    expect(data.directorStudioProjects![0].snapshot.motionProject).toEqual(motion);
  });

  it('migrates snapshot past/future before diffing and keeps tag history reversible after reload', () => {
    const project = decodeFixture(tagsFixture);
    const undo = applyCanvasHistoryEntry(project, project.history.past[0], 'undo');
    expect(undo.nodes[0].position).toEqual({ x: 0, y: 0 });
    expect(undo.nodes[0].data.imageUrl).toBe('/media/character.png');
    expect(undo.edges).toHaveLength(1);
    expect(undo.nodes[1].data).not.toHaveProperty('sourceId');
    expect(applyCanvasHistoryEntry(undo, project.history.past[0], 'redo')).toMatchObject({ nodes: project.nodes, edges: project.edges });
    const redo = applyCanvasHistoryEntry(project, project.history.future[0], 'redo');
    expect(redo.nodes[1].data.label).toBe('角色B');
    expect(redo.edges).toHaveLength(1);
  });

  it('migrates director patch-era history as well as snapshots, preserving old pose values through undo/redo', () => {
    const current = decodeFixture(directorFixture);
    const undo = applyCanvasHistoryEntry(current, current.history.past[0], 'undo');
    expect(undo.nodes[0].data.basePrompt).toBe('历史雨夜');
    expect((undo.nodes[0].data as BlueprintNodeData).motionProject!.actionTracks.actor[0].pose).toEqual(expectedPose);
    const oldNodes = JSON.parse(directorFixture.record.nodesJson) as CanvasNode[];
    const prior = structuredClone(oldNodes);
    (prior[0].data.items as Record<string, unknown>[])[0].pose = { leftShoulder: { x: -0.9 }, groupY: -0.5 };
    const entry = createCanvasHistoryEntry({ nodes: prior, edges: [] }, { nodes: oldNodes, edges: [] })!;
    const patched = decodeFixture({ ...directorFixture, record: { ...directorFixture.record, historyJson: JSON.stringify({ past: [entry], future: [] }) } });
    const old = applyCanvasHistoryEntry(patched, patched.history.past[0], 'undo');
    expect((old.nodes[0].data as BlueprintNodeData).items[0].pose).toEqual({ rightUpperArm: { x: 0.9 }, groupY: -0.5 });
    expect(applyCanvasHistoryEntry(old, patched.history.past[0], 'redo')).toMatchObject({ nodes: patched.nodes, edges: patched.edges });
  });

  it.each(['history', 'column', 'array'] as const)('opens %s image-pool records then saves and reloads equal normalized graphs', async (location) => {
    const record = structuredClone(releaseFixture.record);
    const history = JSON.parse(record.historyJson) as { imagePool?: string[] };
    if (location === 'column') { record.imagePoolJson = JSON.stringify(history.imagePool); delete history.imagePool; }
    if (location === 'array') { record.imagePool = history.imagePool; delete history.imagePool; }
    record.historyJson = JSON.stringify(history);
    const loaded = await openRecord(record);
    expect(nodeData(loaded, 'upload').imageUrl).toBe('file:///Users/artist/character.png');
    useCanvasStore.getState().setCanvasData(loaded.nodes, loaded.edges, loaded.history);
    useCanvasStore.setState({ currentViewport: loaded.viewport });
    useProjectStore.getState().saveCurrentProject(loaded.nodes, loaded.edges, loaded.viewport, loaded.history);
    useProjectStore.getState().closeProject();
    await useProjectStore.getState().waitForProjectPersistence(record.id);
    const saved = storage.records.get(record.id)!;
    expect(JSON.parse(saved.historyJson)).not.toHaveProperty('imagePool');
    expect(JSON.parse(saved.imagePoolJson!)).toContain('file:///Users/artist/character.png');
    const reopened = await openRecord(saved);
    expect({ nodes: reopened.nodes, edges: reopened.edges, history: reopened.history, viewport: reopened.viewport }).toEqual({ nodes: loaded.nodes, edges: loaded.edges, history: loaded.history, viewport: loaded.viewport });
  });

  it('resolves URL media to durable asset ids, reports unavailable blobs and corrupt pool refs, and migrates historical media', async () => {
    const project = await openRecord(mediaFixture.record);
    for (const id of ['blob', 'data', 'http', 'file', 'asset']) {
      const data = nodeData(project, id);
      expect(typeof data.assetId).toBe('string');
      expect(storage.assets.get(data.assetId as string)?.source).toBe(data.imageUrl ?? data.videoUrl ?? data.audioUrl);
      const refs = data.mediaReferences as Record<string, { status: string; assetId: string; source: string }>;
      for (const reference of Object.values(refs)) { expect(reference.status).toBe('ready'); expect(reference.source).not.toMatch(/^(blob|data):/); }
    }
    expect(nodeData(project, 'missing').imageUrl).toBe('blob:https://legacy.example.test/gone');
    expect(nodeData(project, 'missing').mediaReferences).toMatchObject({ imageUrl: { status: 'missing', reason: 'unavailable-blob', source: 'blob:https://legacy.example.test/gone' } });
    expect(nodeData(project, 'bad-pool').mediaReferences).toEqual({ imageUrl: { status: 'missing', reason: 'unresolved-image-pool', source: '__img_ref__:99' }, previewImageUrl: { status: 'missing', reason: 'unresolved-image-pool', source: '__img_ref__:0garbage' } });
    const old = applyCanvasHistoryEntry(project, project.history.past[0], 'undo');
    expect(old.nodes[0].data.displayName).toBe('撤销中的原图');
    expect(old.nodes[0].data.mediaReferences).toMatchObject({ imageUrl: { status: 'ready' } });
    expect(old.nodes[0].data.imageUrl).toMatch(/^asset-media:/);
    expect(decodeProject(JSON.parse(JSON.stringify(encodeProject(project))))).toEqual(project);
    expect(await migrateProjectMedia(project)).toEqual(project);
  });

  it('deduplicates resolver work across current/history roles and leaves prompt/JSON URLs untouched', async () => {
    const project = decodeFixture(directorFixture);
    project.nodes.push({ id: 'prose', type: 'textAnnotationNode', position: { x: 0, y: 0 }, data: { content: 'blob:keep', rawContent: '{"imageUrl":"data:keep"}', parsedJson: { imageUrl: 'data:keep' }, metadata: { url: 'http://keep.test' } } });
    const resolve = vi.fn<ProjectMediaResolver>(async ({ source }) => ({ assetId: source.endsWith('actor.png') ? 'actor-asset' : 'street-asset', source }));
    const migrated = await migrateProjectMedia(project, resolve);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(nodeData(migrated, 'prose')).toEqual(nodeData(project, 'prose'));
    expect(nodeData(migrated, 'stage').mediaReferences).toMatchObject({ 'items[0].refImageUrl': { status: 'ready', assetId: 'actor-asset' }, 'directorStudioProjects[0].snapshot.referenceImages[0].url': { status: 'ready', assetId: 'actor-asset' }, 'snapshotHistory[1]': { status: 'ready', assetId: 'street-asset' } });
    expect(await migrateProjectMedia(migrated, resolve)).toEqual(migrated);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('preserves and reports replaced blob originals while recovering resolvable originals instead of discarding them', async () => {
    const fixture = legacyProjectFixtures.find((item) => item.record.id === 'legacy-fallback')!;
    const decoded = decodeFixture(fixture);
    expect(nodeData(decoded, 'preview').mediaReferences).toEqual({ previewImageUrl: { status: 'missing', source: 'blob:https://legacy.example.test/gone', reason: 'unavailable-blob' } });
    const project = await migrateProjectMedia(decoded);
    expect(nodeData(project, 'preview').mediaReferences).toMatchObject({ previewImageUrl: { status: 'ready', source: 'https://media.example.test/full.png', legacyMissing: { status: 'missing', source: 'blob:https://legacy.example.test/gone', reason: 'unavailable-blob' } } });
    expect(nodeData(project, 'full').imageUrl).toMatch(/^asset-media:/);
    expect(nodeData(project, 'full').mediaReferences).toMatchObject({ imageUrl: { status: 'ready' } });
    expect(await migrateProjectMedia(project)).toEqual(project);
    expect(decodeProject(JSON.parse(JSON.stringify(encodeProject(project))))).toEqual(project);
  });

  it('resolves assetId-only media without replacing valid ids and marks unresolved ids without deleting them', async () => {
    storage.assets.set('saved-image', { id: 'saved-image', kind: 'image', source: 'asset-media:image%2Fpng:already-stored', name: '已存图片', origin: 'uploaded', createdAt: 1, favorite: true, metadata: {} });
    const fixture = legacyProjectFixtures.find((item) => item.record.id === 'asset-only')!;
    const project = await openRecord(fixture.record);
    assertFields(project, fixture);
    expect(nodeData(project, 'image-id').imageUrl).toBe('asset-media:image%2Fpng:already-stored');
    expect(nodeData(project, 'image-id').mediaReferences).toEqual({ imageUrl: { status: 'ready', assetId: 'saved-image', source: 'asset-media:image%2Fpng:already-stored' } });
    expect(nodeData(project, 'missing-id').mediaReferences).toEqual({ audioUrl: { status: 'missing', source: 'asset-id:gone-audio', reason: 'unresolved-asset-id' } });
    expect(storage.assets.size).toBe(1);
    expect(await migrateProjectMedia(project)).toEqual(project);
    expect(decodeProject(JSON.parse(JSON.stringify(encodeProject(project))))).toEqual(project);
  });

  it.each([undefined, 0, 1])('normalizes unversioned/zero/v1 motion schema %s without changing authored tracks', (version) => {
    const nodes = JSON.parse(directorFixture.record.nodesJson) as CanvasNode[];
    const data = nodes[0].data as Record<string, unknown>;
    const motion = data.motionProject as Record<string, unknown>;
    if (version === undefined) delete motion.schemaVersion; else motion.schemaVersion = version;
    const project = decodeFixture({ ...directorFixture, record: { ...directorFixture.record, nodesJson: JSON.stringify(nodes) } });
    expect(stage(project).motionProject).toEqual(stage(decodeFixture(directorFixture)).motionProject);
  });

  it('preserves anatomical joints in mixed legacy poses and explicit whole-body rest overlays across persistence', () => {
    const nodes = JSON.parse(directorFixture.record.nodesJson) as CanvasNode[];
    const data = nodes[0].data as Record<string, unknown>;
    const items = data.items as Record<string, unknown>[];
    items[0].pose = {
      leftShoulder: { x: -0.4 }, rightUpperArm: {}, rightElbow: { x: -0.7 }, leftForearm: { x: 0.2 },
      leftHip: { x: -0.8 }, rightThigh: { x: 0.3 }, rightKnee: { x: 0.9 }, leftShin: {},
      torso: { x: -0.25 }, spine: { x: 0.1 }, scaleY: 1, groupY: 0, groupRotX: 0, groupRotZ: 0,
    };
    const project = decodeFixture({ ...directorFixture, record: { ...directorFixture.record, nodesJson: JSON.stringify(nodes) } });
    expect(stage(project).items[0].pose).toEqual({ rightUpperArm: {}, leftForearm: { x: 0.2 }, rightThigh: { x: 0.3 }, leftShin: {}, spine: { x: 0.1 }, scaleY: 1, groupY: 0, groupRotX: 0, groupRotZ: 0 });
    expect(decodeProject(project)).toEqual(project);
    expect(decodeProject(JSON.parse(JSON.stringify(encodeProject(project))))).toEqual(project);
  });
});
