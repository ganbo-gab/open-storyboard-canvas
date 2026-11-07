import 'fake-indexeddb/auto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectRecord } from '@/commands/projectState';
import { listAssets, saveAsset } from '@/features/assets/application/assetCatalog';
import { readWorkspaceRecord, writeWorkspaceRecord } from '@/features/assets/application/assetMediaStorage';
import { CANVAS_NODE_TYPES, type BlueprintNodeData, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { normalizePersonPose } from '@/features/canvas/domain/personPose';
import { normalizeDirectorMotionProject } from '@/features/canvas/application/directorMotion';
import type { ProjectMediaReference } from '@/features/canvas/domain/projectMedia';
import { createCanvasHistoryEntry } from './canvasHistory';
import { useCanvasStore } from './canvasStore';
import { useProjectStore } from './projectStore';
import { directorFixture, expectedPose, legacyProjectFixtures, releaseFixture, type LegacyProjectFixture, type LegacyNodeFixture } from './__fixtures__/legacy/legacyProjects';

const storage = vi.hoisted(() => ({ records: new Map<string, ProjectRecord>() }));
vi.mock('@/commands/projectState', () => ({
  getProjectRecord: vi.fn(async (id: string) => structuredClone(storage.records.get(id) ?? null)),
  listProjectSummaries: vi.fn(async () => []),
  upsertProjectRecord: vi.fn(async (record: ProjectRecord) => { storage.records.set(record.id, structuredClone(record)); }),
  deleteProjectRecord: vi.fn(async (id: string) => { storage.records.delete(id); }),
  renameProjectRecord: vi.fn(async () => {}),
  updateProjectViewportRecord: vi.fn(async () => {}),
}));

const mediaNames: Record<string, true | undefined> = {
  imageUrl: true, previewImageUrl: true, thumbnailUrl: true, sourceImageUrl: true,
  snapshotUrl: true, backgroundImageUrl: true, backgroundPanoramaUrl: true,
  videoUrl: true, localVideoUrl: true, audioUrl: true, localAudioUrl: true,
  refImageUrl: true, coverUrl: true,
};
function mediaPaths(value: unknown, path = '', parent = ''): string[] {
  if (typeof value === 'string') {
    const key = path.split('.').at(-1) ?? '';
    return value && (mediaNames[key] || /(?:^|\.)referenceImages\[\d+\]\.url$/.test(path)
      || /(?:^|\.)snapshotHistory\[\d+\]$/.test(path)) ? [path] : [];
  }
  if (Array.isArray(value)) return value.flatMap((item, index) => mediaPaths(item, `${path}[${index}]`, path));
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, item]) => mediaPaths(item, path ? `${path}.${key}` : key, parent));
}
function data(id: string): CanvasNode['data'] {
  const node = useCanvasStore.getState().nodes.find((entry) => entry.id === id);
  expect(node, `node ${id} is still available`).toBeDefined();
  return node!.data;
}
function graph() {
  const { nodes, edges } = useCanvasStore.getState();
  return structuredClone({ nodes, edges });
}
async function open(id: string): Promise<void> {
  useCanvasStore.getState().setCanvasData([], []);
  useProjectStore.getState().openProject(id);
  await vi.waitFor(() => expect(useProjectStore.getState().isOpeningProject).toBe(false));
  const project = useProjectStore.getState().currentProject;
  expect(project?.id).toBe(id);
  useCanvasStore.getState().setCanvasData(project!.nodes, project!.edges, project!.history);
  useCanvasStore.setState({ currentViewport: project!.viewport });
}
async function saveAndClose(id: string): Promise<ProjectRecord> {
  const state = useCanvasStore.getState();
  useProjectStore.getState().saveCurrentProject(state.nodes, state.edges, state.currentViewport, state.history);
  useProjectStore.getState().closeProject();
  await useProjectStore.getState().waitForProjectPersistence(id);
  return structuredClone(storage.records.get(id)!);
}
async function expectMediaAvailable(original: LegacyNodeFixture[]): Promise<void> {
  const assets = await listAssets();
  for (const node of original) {
    const references = data(node.id).mediaReferences as Record<string, ProjectMediaReference> | undefined;
    for (const path of mediaPaths(node.data)) {
      const reference = references?.[path];
      expect(reference, `${node.id}.${path} must be resolvable or explicitly missing`).toBeDefined();
      if (reference?.status === 'ready') {
        expect(reference.source).not.toMatch(/^(?:blob:|data:|__img_ref__:)/);
        expect(assets.find((asset) => asset.id === reference.assetId)?.source).toBe(reference.source);
        if (reference.source.startsWith('asset-media:')) {
          const bytes = await readWorkspaceRecord<Blob>('media', reference.source);
          expect(bytes?.size, `${node.id}.${path} durable bytes`).toBeGreaterThan(0);
        }
      } else {
        expect(reference).toMatchObject({ status: 'missing', source: expect.any(String), reason: expect.any(String) });
      }
    }
  }
}
function expectDirectorNormalized(original: LegacyNodeFixture[]): void {
  if (!original.some((node) => node.id === 'stage')) return;
  const stage = data('stage') as BlueprintNodeData;
  const raw = original.find((node) => node.id === 'stage')!.data;
  const actor = (raw.items as Array<{ pose: unknown }>)[0];
  expect(stage.items[0].pose).toEqual(expectedPose);
  expect(stage.items[0].pose).toEqual(normalizePersonPose(actor.pose));
  expect(stage.items[0].pose?.groupY).toBe(-0.35);
  expect(stage.customActionPoses?.旧自定义动作).toEqual(expectedPose);
  expect(stage.motionProject).toEqual(normalizeDirectorMotionProject(raw.motionProject));
  expect(stage.motionProject).toMatchObject({ schemaVersion: 1, durationSeconds: 8, loop: true,
    cameraTrack: [{ id: 'cam', time: 3, position: { x: 3, y: 2, z: 6 }, trackTargetId: 'actor' }],
    objectTracks: { actor: [{ id: 'move', time: 2, orientToPath: true }] },
    actionTracks: { actor: [{ id: 'act', pose: expectedPose, clipId: 'clip' }] },
    customClips: [{ id: 'clip', keyframes: [{ id: 'clip-frame', pose: expectedPose }] }],
  });
  expect(stage.directorStudioProjects?.[0].snapshot.items[0].pose).toEqual(expectedPose);
  expect(stage.directorStudioProjects?.[0].snapshot.motionProject).toEqual(stage.motionProject);
  expect(data('static').motionProject).toBeUndefined();
}

function poolVariant(location: 'column' | 'array'): LegacyProjectFixture {
  const record = structuredClone(releaseFixture.record);
  const history = JSON.parse(record.historyJson) as { imagePool?: string[] };
  if (location === 'column') record.imagePoolJson = JSON.stringify(history.imagePool);
  else record.imagePool = history.imagePool;
  delete history.imagePool;
  record.historyJson = JSON.stringify(history);
  record.id += `-${location}`;
  return { ...releaseFixture, name: `release nodes with ${location} image pool`, record };
}
function directorVariant(version: undefined | 1, patchHistory = false): LegacyProjectFixture {
  const record = structuredClone(directorFixture.record);
  const nodes = JSON.parse(record.nodesJson) as LegacyNodeFixture[];
  const motion = nodes[0].data.motionProject as Record<string, unknown>;
  if (version === undefined) delete motion.schemaVersion;
  else motion.schemaVersion = version;
  if (patchHistory) {
    const prior = structuredClone(nodes);
    prior[0].data.basePrompt = '历史雨夜';
    const entry = createCanvasHistoryEntry({ nodes: prior as CanvasNode[], edges: [] }, { nodes: nodes as CanvasNode[], edges: [] });
    record.historyJson = JSON.stringify({ past: [entry], future: [] });
  }
  record.nodesJson = JSON.stringify(nodes);
  record.id += `-${version ?? 'unversioned'}${patchHistory ? '-patches' : ''}`;
  return { ...directorFixture, name: `director ${version ?? 'unversioned'} with ${patchHistory ? 'patch' : 'snapshot'} history`, record };
}
const cases = [...legacyProjectFixtures, poolVariant('column'), poolVariant('array'),
  directorVariant(undefined), directorVariant(1), directorVariant(1, true)];

const nativeFetch = globalThis.fetch;
beforeAll(async () => {
  for (const [id, source] of [['existing-asset', 'asset-media:image%2Fpng:already-stored'],
    ['saved-image', 'asset-media:image%2Fpng:already-stored']] as const) {
    await writeWorkspaceRecord('media', source, new Blob(['stored original'], { type: 'image/png' }));
    await saveAsset({ id, kind: 'image', source, name: id, origin: 'uploaded', metadata: {} });
  }
});
beforeEach(() => {
  storage.records.clear();
  useProjectStore.setState({ projects: [], currentProjectId: null, currentProject: null, isHydrated: true, isOpeningProject: false });
  useCanvasStore.getState().setCanvasData([], []);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const source = String(input);
    if (source === 'blob:https://legacy.example.test/recoverable') return new Response('recovered original', { headers: { 'content-type': 'image/png' } });
    if (source.startsWith('data:')) return nativeFetch(input, init);
    throw new TypeError('Fixture media is unavailable');
  }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('legacy project open/edit/save/reopen acceptance', () => {
  it.each(cases)('$name keeps the graph, media, viewport and undo history stable', async (fixture) => {
    const record = structuredClone(fixture.record);
    const original = JSON.parse(record.nodesJson) as LegacyNodeFixture[];
    storage.records.set(record.id, record);
    await open(record.id);
    expect(useCanvasStore.getState().nodes.map((node) => node.id)).toEqual(original.map((node) => node.id));
    const expectedEdges = record.id.startsWith('legacy-release') || record.id === 'legacy-tags' ? 1 : 0;
    expect(useCanvasStore.getState().edges).toHaveLength(expectedEdges);
    expect(useCanvasStore.getState().currentViewport).toEqual({ x: -120, y: 80, zoom: 0.75 });
    expect(useProjectStore.getState().currentProject?.nodeCount).toBe(original.length);
    await expectMediaAvailable(original);
    expectDirectorNormalized(original);
    if (record.id.startsWith('legacy-release')) {
      expect(data('upload').imageUrl).toBe('file:///Users/artist/character.png');
      expect(data('note').content).toBe('# 开场\n主角说：“别回头。”');
      expect(data('aitext')).toMatchObject({ agentId: 'script-agent', model: 'saved-text-model', resultNodeId: 'json' });
      expect(data('json').isStreaming).toBe(false);
      expect(useCanvasStore.getState().edges[0]).toMatchObject({ source: 'upload', target: 'edit', label: '角色', sourceHandle: 'source', targetHandle: 'target' });
    }
    if (record.id === 'legacy-tags') {
      expect(useCanvasStore.getState().nodes.map((node) => node.type)).toEqual([CANVAS_NODE_TYPES.upload, CANVAS_NODE_TYPES.tag, CANVAS_NODE_TYPES.tagGroup]);
      expect(data('group')).toMatchObject({ memberNodeIds: ['source'], unresolvedMemberIds: ['missing'] });
    }
    if (record.id === 'legacy-media') {
      expect(data('data').imageUrl).toMatch(/^asset-media:/);
      expect(data('missing')).toMatchObject({ imageUrl: 'blob:https://legacy.example.test/gone', mediaReferences: {
        imageUrl: { status: 'missing', source: 'blob:https://legacy.example.test/gone', reason: 'unavailable-blob' },
      } });
      expect(data('bad-pool').mediaReferences).toMatchObject({
        imageUrl: { status: 'missing', source: '__img_ref__:99', reason: 'unresolved-image-pool' },
        previewImageUrl: { status: 'missing', source: '__img_ref__:0garbage', reason: 'unresolved-image-pool' },
      });
    }
    if (record.id === 'legacy-fallback') {
      expect(data('preview').mediaReferences).toMatchObject({ previewImageUrl: { status: 'ready', source: 'https://media.example.test/full.png',
        legacyMissing: { source: 'blob:https://legacy.example.test/gone', reason: 'unavailable-blob' } } });
      expect(data('full').imageUrl).toMatch(/^asset-media:/);
    }
    if (record.id === 'asset-only') {
      expect(data('image-id')).toMatchObject({ assetId: 'saved-image', imageUrl: 'asset-media:image%2Fpng:already-stored' });
      expect(data('missing-id')).toMatchObject({ assetId: 'gone-audio', mediaReferences: {
        audioUrl: { status: 'missing', source: 'asset-id:gone-audio', reason: 'unresolved-asset-id' },
      } });
    }

    const loaded = graph();
    const { history } = useCanvasStore.getState();
    if (history.past.length) {
      expect(useCanvasStore.getState().undo()).toBe(true);
      expect(graph()).not.toEqual(loaded);
      if (record.id.startsWith('legacy-director')) {
        expect(data('stage').basePrompt).toBe('历史雨夜');
        expect((data('stage') as BlueprintNodeData).motionProject?.actionTracks.actor[0].pose).toEqual(expectedPose);
      }
      if (record.id === 'legacy-media') {
        expect(data('old-media')).toMatchObject({ displayName: '撤销中的原图', imageUrl: expect.stringMatching(/^asset-media:/) });
        const bytes = await readWorkspaceRecord<Blob>('media', String(data('old-media').imageUrl));
        expect(await bytes?.text()).toBe('old');
      }
      expect(useCanvasStore.getState().redo()).toBe(true);
      expect(graph()).toEqual(loaded);
    }
    if (history.future.length) {
      expect(useCanvasStore.getState().redo()).toBe(true);
      expect(data('tag').label).toBe('角色B');
      expect(useCanvasStore.getState().undo()).toBe(true);
      expect(graph()).toEqual(loaded);
    }

    const first = original[0].id;
    useCanvasStore.getState().updateNodeData(first, { displayName: '迁移后用户修改' });
    expect(useCanvasStore.getState().history.past).toHaveLength(history.past.length + 1);
    expect(useCanvasStore.getState().history.future).toHaveLength(0);
    const edited = graph();
    // Hold only the bookkeeping clock fixed so the entire record, not merely parsed JSON, can be compared.
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const saved = await saveAndClose(record.id);
    await open(record.id);
    expect(graph()).toEqual(edited);
    expect(useCanvasStore.getState().currentViewport).toEqual({ x: -120, y: 80, zoom: 0.75 });
    await expectMediaAvailable(original);
    expectDirectorNormalized(original);
    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(graph()).toEqual(loaded);
    expect(useCanvasStore.getState().redo()).toBe(true);
    expect(graph()).toEqual(edited);
    const savedAgain = await saveAndClose(record.id);
    expect(JSON.stringify(savedAgain)).toBe(JSON.stringify(saved));
  });
});
