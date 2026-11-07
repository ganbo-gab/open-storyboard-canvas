import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { listAgentMentionCandidates, resolveAgentMentions } from './agentMentions';
import type { AssetRecord } from '@/features/assets/application/assetCatalog';

const fixtures = vi.hoisted(() => ({ assets: [] as AssetRecord[], characters: [] as { id: string; name: string; mainImage: { assetId: string } | null; tags: string[]; description?: string }[], beforeList: undefined as (() => void) | undefined }));
vi.mock('@/features/assets/application/assetCatalog', () => ({
  listAssets: async () => { fixtures.beforeList?.(); return fixtures.assets; },
  getAssetPortableSource: async (source: string) => source.startsWith('asset-media:') ? 'data:image/png;base64,Y2F0' : source,
}));
vi.mock('@/features/characters', () => ({
  useCharacterLibraryStore: { getState: () => ({ initialize: async () => true, characters: fixtures.characters }) },
}));

beforeEach(() => {
  fixtures.assets = [];
  fixtures.characters = [];
  fixtures.beforeList = undefined;
  useProjectStore.setState({ currentProjectId: 'project' });
  useCanvasStore.setState({ nodes: [], edges: [], activeDirectorStudioNodeId: null, selectedNodeId: null });
});
afterEach(() => vi.restoreAllMocks());

describe('Agent scoped mention candidates and attachment resolution', () => {
  it('attaches durable image-node media and preserves text/stage ids as context', async () => {
    const nodes: CanvasNode[] = [
      { id: 'image', type: CANVAS_NODE_TYPES.upload, position: { x: 0, y: 0 }, data: { imageUrl: 'asset-media:image%2Fpng:cat', previewImageUrl: 'blob:temporary-preview', aspectRatio: '1:1', displayName: 'Cat image' } },
      { id: 'text', type: CANVAS_NODE_TYPES.textAnnotation, position: { x: 100, y: 0 }, data: { content: 'The cat waits at the crossing.', displayName: 'Script' } },
      { id: 'stage', type: CANVAS_NODE_TYPES.blueprint, position: { x: 200, y: 0 }, data: { mode: 'flat', aspectRatio: '16:9', items: [{ id: 'person', label: 'Alice', x: 1, y: 2, color: '#fff', category: 'person', pos3d: { x: 1, y: 0, z: 2 } }], referenceImages: [] } },
    ];
    useCanvasStore.setState({ nodes });
    const candidates = await listAgentMentionCandidates({ scope: 'stage', projectId: 'project' });
    const selected = candidates.filter((candidate) => candidate.kind === 'stage-object' || candidate.kind === 'node' && ['image', 'text'].includes(candidate.nodeId));
    expect(selected).toHaveLength(3);
    expect(JSON.stringify(candidates)).not.toContain('blob:');
    expect(selected.some((candidate) => candidate.thumbnail?.startsWith('blob:'))).toBe(false);
    const result = await resolveAgentMentions(selected.map((candidate) => candidate.token).join(' '), candidates);
    expect(result.media).toEqual([expect.objectContaining({ assetId: 'image:image', nodeId: 'image', source: 'data:image/png;base64,Y2F0' })]);
    expect(result.contextLines.join('\n')).toContain('Node text');
    expect(result.contextLines.join('\n')).toContain('The cat waits at the crossing.');
    expect(result.contextLines.join('\n')).toContain('Stage stage, object person');
    expect(result.contextLines.join('\n')).toContain('Alice');
    expect(await listAgentMentionCandidates({ scope: 'canvas', projectId: 'project' })).not.toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'stage-object' })]));
    expect(await listAgentMentionCandidates({ scope: 'home' })).not.toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'node' })]));
  });

  it('lists asset/character sources and deduplicates the same image bytes across mentions', async () => {
    fixtures.assets = [{ id: 'cat-image', kind: 'image', name: 'Cat', source: 'https://example.test/cat.png', origin: 'uploaded', createdAt: 1, favorite: false, metadata: {} }];
    fixtures.characters = [{ id: 'hero', name: 'Hero', mainImage: { assetId: 'cat-image' }, tags: ['cat'], description: 'White whiskers' }];
    const candidates = await listAgentMentionCandidates({ scope: 'home' });
    expect(candidates.map((candidate) => candidate.source)).toEqual(['asset-library', 'character-library']);
    expect(candidates.map((candidate) => candidate.thumbnail)).toEqual(['https://example.test/cat.png', 'https://example.test/cat.png']);
    const result = await resolveAgentMentions(candidates.map((candidate) => candidate.token).join(' '), candidates);
    expect(result.media).toHaveLength(1);
    expect(result.contextLines.join('\n')).toContain('Character hero');
    expect(result.contextLines.join('\n')).toContain('White whiskers');
  });

  it('uses stable ids for duplicate labels, ignores substring matches and resolves each once', async () => {
    useCanvasStore.setState({ nodes: ['one', 'two'].map((id): CanvasNode => ({ id, type: CANVAS_NODE_TYPES.textAnnotation, position: { x: 0, y: 0 }, data: { content: id, displayName: 'Duplicate' } })) });
    const candidates = await listAgentMentionCandidates({ scope: 'canvas' });
    expect((await resolveAgentMentions('@Duplicate', candidates)).contextLines).toEqual([]);
    const result = await resolveAgentMentions(`${candidates[0].token} ${candidates[0].token}`, candidates);
    expect(result.contextLines).toHaveLength(1);
    expect(result.contextLines[0]).toContain('Node one');
    expect((await resolveAgentMentions('@DuplicateSuffix', candidates)).contextLines).toEqual([]);
    expect((await resolveAgentMentions('@[renamed](agent-mention:node%3Aproject%3Atwo)', candidates)).contextLines[0]).toContain('Node two');
  });

  it('rejects a transient-only image rather than forwarding a raw blob URL', async () => {
    fixtures.assets = [{ id: 'stale', kind: 'image', name: 'Stale', source: 'blob:stale', origin: 'uploaded', createdAt: 1, favorite: false, metadata: {} }];
    const candidates = await listAgentMentionCandidates({ scope: 'home' });
    expect(candidates[0].thumbnail).toBeUndefined();
    await expect(resolveAgentMentions(candidates[0].token, candidates)).rejects.toThrow();
  });

  it('rejects cross-project canvas context instead of reading the wrong active canvas', async () => {
    await expect(listAgentMentionCandidates({ scope: 'canvas', projectId: 'different-project' })).rejects.toThrow();
  });

  it('does not relabel the next project canvas when navigation races asset hydration', async () => {
    fixtures.beforeList = () => useProjectStore.setState({ currentProjectId: 'next-project' });
    await expect(listAgentMentionCandidates({ scope: 'stage', projectId: 'project' })).rejects.toThrow();
  });
});
