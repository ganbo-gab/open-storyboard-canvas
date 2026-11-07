import { beforeEach, describe, expect, it } from 'vitest';
import { useCanvasStore } from '@/stores/canvasStore';
import { CANVAS_COMMAND_VERSION } from '../domain/canvasCommands';
import { CANVAS_NODE_TYPES, isStoryboardSplitNode, type CanvasNode } from '../domain/canvasNodes';
import { canvasCommandRegistry } from './canvasCommandService';

function resetCanvas(): void {
  useCanvasStore.setState({ nodes: [], edges: [], revision: 0, selectedNodeId: null,
    history: { past: [], future: [] }, dragHistorySnapshot: null });
}

function seedImageSelection(): void {
  const imageSource = `asset-media:image%2Fpng:${'a'.repeat(64)}`;
  const nodes: CanvasNode[] = [
    { id: 'image-parent', type: CANVAS_NODE_TYPES.group, position: { x: 300, y: 400 }, data: { label: 'Images' } },
    { id: 'image-a', type: CANVAS_NODE_TYPES.exportImage, parentId: 'image-parent', extent: 'parent',
      position: { x: 40, y: 60 }, data: {
        imageUrl: imageSource, previewImageUrl: '/durable/a-preview.png', aspectRatio: '16:9',
        displayName: 'A', assetId: 'durable-asset-a', width: 1920, height: 1080,
        mediaReferences: { imageUrl: { status: 'ready', assetId: 'durable-asset-a', source: imageSource } },
        generationLastJobId: 'existing-job', generationProviderId: 'provider-a',
        generationDebugContext: { requestModel: 'model-a', requestSize: '2K', authorization: 'not-copyable-secret' },
      } },
    { id: 'image-b', type: CANVAS_NODE_TYPES.upload, position: { x: 1000, y: 100 },
      data: { imageUrl: '/durable/b.png', previewImageUrl: 'blob:ephemeral', aspectRatio: '1:1', sourceFileName: 'b.png',
        assetMetadata: { model: 'imported:model', providerId: 'imported-provider', requestModel: 'provider-model',
          resolution: '4K', width: 4096, height: 4096 } } },
    { id: 'target', type: CANVAS_NODE_TYPES.imageEdit, position: { x: 1500, y: 100 }, data: { prompt: 'Combine references' } },
  ];
  useCanvasStore.setState({ nodes, edges: [{ id: 'existing-reference', source: 'image-a', target: 'target' }], revision: 1 });
}

describe('canvas selection-wide operations', () => {
  beforeEach(resetCanvas);

  it('merges images in caller order with durable media and provenance while retaining the original graph', async () => {
    seedImageSelection();
    const before = useCanvasStore.getState();
    const result = await canvasCommandRegistry.execute({ type: 'storyboard.merge', version: CANVAS_COMMAND_VERSION,
      input: { nodeIds: ['image-b', 'image-a'], nodeId: 'board', columns: 1 } }, 'agent');
    expect(result).toMatchObject({ ok: true, impact: { creates: { nodes: 1, edges: 0, groups: 0 },
      requiresExternalSideEffect: false }, output: { references: { nodeId: 'board', assetIds: ['image-b:image', 'image-a:image'] } } });
    const after = useCanvasStore.getState();
    const board = after.nodes.find((node) => node.id === 'board');
    if (!isStoryboardSplitNode(board)) throw new Error('Storyboard was not created');
    expect(board.data).toMatchObject({
      gridRows: 2, gridCols: 1,
      frames: [
        { order: 0, imageUrl: '/durable/b.png', sourceNodeId: 'image-b', sourceAssetId: 'image-b:image',
          sourceMetadata: { sourceFileName: 'b.png', modelId: 'imported:model', providerId: 'imported-provider',
            requestModel: 'provider-model', resolution: '4K', width: 4096, height: 4096 } },
        { order: 1, imageUrl: before.nodes[1].data.imageUrl, previewImageUrl: '/durable/a-preview.png',
          sourceNodeId: 'image-a', sourceAssetId: 'image-a:image',
          sourceMetadata: { requestModel: 'model-a', resolution: '2K', providerId: 'provider-a',
            generationJobId: 'existing-job', width: 1920, height: 1080 } },
      ],
      mediaReferences: { 'frames[1].imageUrl': { status: 'ready', assetId: 'durable-asset-a', source: before.nodes[1].data.imageUrl } },
    });
    expect(board.data.frames[0].previewImageUrl).toBeUndefined();
    expect(JSON.stringify(board.data)).not.toContain('not-copyable-secret');
    expect(after.nodes.slice(0, before.nodes.length)).toEqual(before.nodes);
    expect(after.edges).toEqual(before.edges);
    expect(after.history.past).toHaveLength(1);
    expect(after.undo()).toBe(true);
    expect(useCanvasStore.getState().nodes).toEqual(before.nodes);
    expect(useCanvasStore.getState().redo()).toBe(true);
    expect(useCanvasStore.getState().nodes).toEqual(after.nodes);
    useCanvasStore.getState().setCanvasData(after.nodes, after.edges);
    expect(useCanvasStore.getState().nodes.find((node) => node.id === 'board')?.data).toMatchObject({
      frames: board.data.frames, mediaReferences: board.data.mediaReferences,
    });
  });

  it('rejects non-image, temporary-media, duplicate-source and stale storyboard merges without mutation', async () => {
    seedImageSelection();
    const before = useCanvasStore.getState();
    const inputs = [
      { nodeIds: ['image-a', 'target'] },
      { nodeIds: ['image-a', 'image-a'] },
      { nodeIds: ['image-a', 'image-b'], columns: 3 },
      { nodeIds: ['image-a', 'image-b'], columns: 1.5 },
    ];
    for (const input of inputs) {
      expect(await canvasCommandRegistry.execute({ type: 'storyboard.merge', version: CANVAS_COMMAND_VERSION, input }, 'agent'))
        .toMatchObject({ ok: false, error: { code: 'invalid_command' } });
    }
    expect(await canvasCommandRegistry.executeApproved({ type: 'storyboard.merge', version: CANVAS_COMMAND_VERSION,
      input: { nodeIds: ['image-a', 'image-b'] } }, 0, 'agent'))
      .toMatchObject({ ok: false, error: { code: 'revision_conflict' } });
    expect(useCanvasStore.getState().nodes).toBe(before.nodes);
    expect(useCanvasStore.getState().history.past).toEqual([]);
    useCanvasStore.setState({ nodes: before.nodes.map((node) => node.id === 'image-b'
      ? { ...node, data: { ...node.data, imageUrl: 'blob:session-only' } } : node) });
    const temporary = useCanvasStore.getState();
    expect(await canvasCommandRegistry.execute({ type: 'storyboard.merge', version: CANVAS_COMMAND_VERSION,
      input: { nodeIds: ['image-a', 'image-b'] } }, 'agent')).toMatchObject({ ok: false });
    expect(useCanvasStore.getState().nodes).toBe(temporary.nodes);
    expect(useCanvasStore.getState().history.past).toEqual([]);
  });

  it('connects an entire selection atomically with idempotent existing references and one undo/redo', async () => {
    seedImageSelection();
    const before = useCanvasStore.getState();
    const command = { type: 'selection.connect' as const, version: CANVAS_COMMAND_VERSION,
      input: { sourceNodeIds: ['image-a', 'image-b', 'image-a'], targetNodeId: 'target' } };
    const result = await canvasCommandRegistry.execute(command, 'agent');
    expect(result).toMatchObject({ ok: true, impact: { creates: { nodes: 0, edges: 1, groups: 0 },
      affectedNodeIds: ['image-a', 'image-b', 'target'], requiresExternalSideEffect: false } });
    const after = useCanvasStore.getState();
    expect(after.edges.map((edge) => [edge.source, edge.target])).toEqual([['image-a', 'target'], ['image-b', 'target']]);
    expect(after.history.past).toHaveLength(1);
    expect((await canvasCommandRegistry.execute(command, 'agent')).ok).toBe(true);
    expect(useCanvasStore.getState().revision).toBe(after.revision);
    expect(useCanvasStore.getState().history.past).toHaveLength(1);
    expect(after.undo()).toBe(true);
    expect(useCanvasStore.getState().edges).toEqual(before.edges);
    expect(useCanvasStore.getState().redo()).toBe(true);
    expect(useCanvasStore.getState().edges).toEqual(after.edges);
  });

  it('rejects an invalid second source with its exact connection reason and no partial connection', async () => {
    seedImageSelection();
    const audio = useCanvasStore.getState().addNode(CANVAS_NODE_TYPES.audio, { x: 0, y: 0 });
    useCanvasStore.setState({ history: { past: [], future: [] } });
    const before = useCanvasStore.getState();
    const result = await canvasCommandRegistry.execute({ type: 'selection.connect', version: CANVAS_COMMAND_VERSION,
      input: { sourceNodeIds: ['image-b', audio], targetNodeId: 'target' } }, 'agent');
    expect(result).toMatchObject({ ok: false, error: { details: {
      sourceNodeId: audio, targetNodeId: 'target', connectionCode: 'kind-mismatch',
      reason: { type: 'kindMismatch', actual: 'audio', expected: ['image', 'text'] },
    } } });
    expect(useCanvasStore.getState().nodes).toBe(before.nodes);
    expect(useCanvasStore.getState().edges).toBe(before.edges);
    expect(useCanvasStore.getState().history.past).toEqual([]);
  });

  it('rejects stale selection connections and rolls back a later command after a valid merge', async () => {
    seedImageSelection();
    const before = useCanvasStore.getState();
    expect(await canvasCommandRegistry.executeApproved({ type: 'selection.connect', version: CANVAS_COMMAND_VERSION,
      input: { sourceNodeIds: ['image-b'], targetNodeId: 'target' } }, 0, 'agent'))
      .toMatchObject({ ok: false, error: { code: 'revision_conflict' } });
    const result = canvasCommandRegistry.executeTransaction({
      id: 'merge-then-reject', origin: 'agent', expectedRevision: before.revision,
      commands: [
        { type: 'storyboard.merge', version: CANVAS_COMMAND_VERSION, input: { nodeIds: ['image-b', 'image-a'], nodeId: 'rolled-back' } },
        { type: 'selection.connect', version: CANVAS_COMMAND_VERSION, input: { sourceNodeIds: ['image-b'], targetNodeId: 'image-a' } },
      ],
    });
    expect(result).toMatchObject({ ok: false, error: { commandIndex: 1,
      details: { reason: { type: 'targetIsMaterial' } } } });
    expect(useCanvasStore.getState().nodes).toBe(before.nodes);
    expect(useCanvasStore.getState().edges).toBe(before.edges);
    expect(useCanvasStore.getState().history.past).toEqual([]);
  });

  it('retains cycle and tag single-source conflict explanations for whole selections', async () => {
    const state = useCanvasStore.getState();
    const first = state.addNode(CANVAS_NODE_TYPES.aiText, { x: 0, y: 0 });
    const second = state.addNode(CANVAS_NODE_TYPES.aiText, { x: 500, y: 0 });
    const tag = state.addNode(CANVAS_NODE_TYPES.tag, { x: 1000, y: 0 });
    state.addEdge(first, second);
    state.addEdge(first, tag);
    useCanvasStore.setState({ history: { past: [], future: [] } });
    const before = useCanvasStore.getState();
    expect(await canvasCommandRegistry.execute({ type: 'selection.connect', version: CANVAS_COMMAND_VERSION,
      input: { sourceNodeIds: [second], targetNodeId: first } }, 'agent'))
      .toMatchObject({ ok: false, error: { details: { reason: { type: 'cycle' } } } });
    expect(await canvasCommandRegistry.execute({ type: 'selection.connect', version: CANVAS_COMMAND_VERSION,
      input: { sourceNodeIds: [second], targetNodeId: tag } }, 'agent'))
      .toMatchObject({ ok: false, error: { details: { reason: { type: 'tagSourceConflict' } } } });
    expect(useCanvasStore.getState().edges).toBe(before.edges);
    expect(useCanvasStore.getState().history.past).toEqual([]);
  });
});
