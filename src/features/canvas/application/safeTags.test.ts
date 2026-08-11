import { beforeEach, describe, expect, it } from 'vitest';

import { useCanvasStore } from '@/stores/canvasStore';
import { CANVAS_COMMAND_VERSION } from '../domain/canvasCommands';
import {
  CANVAS_NODE_TYPES,
  type CanvasEdge,
  type CanvasNode,
} from '../domain/canvasNodes';
import { canvasCommandRegistry } from './canvasCommandService';
import { validateCanvasConnection } from './canvasConnectionRules';
import { collectInputReferences, inspectTagGraphState } from './graphReferenceResolver';
import { migrateLegacyTagGraph } from './tagPersistenceMigration';

function resetCanvas(): void {
  useCanvasStore.setState({
    nodes: [],
    edges: [],
    revision: 0,
    selectedNodeId: null,
    activeDirectorStudioNodeId: null,
    activeToolDialog: null,
    history: { past: [], future: [] },
    dragHistorySnapshot: null,
    currentViewport: { x: 0, y: 0, zoom: 1 },
    canvasViewportSize: { width: 1280, height: 720 },
  });
}

function sourceNode(id = 'source'): CanvasNode {
  return {
    id,
    type: CANVAS_NODE_TYPES.upload,
    position: { x: 0, y: 0 },
    data: {
      displayName: 'Source image',
      imageUrl: `https://example.invalid/${id}.png`,
      previewImageUrl: null,
      aspectRatio: '1:1',
    },
  };
}

function tagNode(id = 'tag', enabled = true): CanvasNode {
  return {
    id,
    type: CANVAS_NODE_TYPES.tag,
    position: { x: 300, y: 0 },
    data: {
      displayName: 'Hero reference',
      label: 'Hero reference',
      enabled,
      color: 'cyan',
    },
  };
}

function tagGroupNode(id = 'tag-group', enabled = true, memberTagIds = ['tag']): CanvasNode {
  return {
    id,
    type: CANVAS_NODE_TYPES.tagGroup,
    position: { x: 300, y: 220 },
    data: {
      displayName: 'Characters',
      label: 'Characters',
      enabled,
      memberTagIds,
    },
  };
}

function consumerNode(id = 'consumer'): CanvasNode {
  return {
    id,
    type: CANVAS_NODE_TYPES.imageEdit,
    position: { x: 650, y: 0 },
    data: {
      displayName: 'Consumer',
      imageUrl: null,
      previewImageUrl: null,
      aspectRatio: '1:1',
      requestAspectRatio: 'auto',
      prompt: '',
      model: 'gpt-image-2',
      size: '2K',
      extraParams: {},
    },
  };
}

function edge(id: string, source: string, target: string): CanvasEdge {
  return { id, source, target, sourceHandle: 'source', targetHandle: 'target', type: 'disconnectableEdge' };
}

describe('safe tag graph rules', () => {
  it('rejects a second source and a tag cycle while treating exact duplicates as no-ops', () => {
    const nodes = [sourceNode('source-a'), sourceNode('source-b'), tagNode('tag-a'), tagNode('tag-b')];
    const edges = [
      edge('source-a-tag-a', 'source-a', 'tag-a'),
      edge('tag-a-tag-b', 'tag-a', 'tag-b'),
    ];

    expect(validateCanvasConnection('source-a', 'tag-a', nodes, edges)).toMatchObject({
      valid: true,
      code: 'duplicate',
      existingEdgeId: 'source-a-tag-a',
    });
    expect(validateCanvasConnection('source-b', 'tag-a', nodes, edges)).toMatchObject({
      valid: false,
      code: 'tag-source-conflict',
    });
    expect(validateCanvasConnection('tag-b', 'tag-a', nodes, edges)).toMatchObject({
      valid: false,
      code: 'tag-cycle',
    });

    const consumer = consumerNode('loop-consumer');
    expect(validateCanvasConnection(
      'tag-a',
      consumer.id,
      [...nodes, consumer],
      [...edges, edge('consumer-tag-a', consumer.id, 'tag-a')],
    )).toMatchObject({
      valid: false,
      code: 'tag-cycle',
    });
  });

  it('resolves the real source through enabled tags and excludes disabled tags or groups', () => {
    const baseNodes = [sourceNode(), tagNode(), tagGroupNode(), consumerNode()];
    const edges = [edge('source-tag', 'source', 'tag'), edge('tag-consumer', 'tag', 'consumer')];

    expect(collectInputReferences('consumer', baseNodes, edges)).toMatchObject([{
      sourceNodeId: 'source',
      viaTagNodeId: 'tag',
      title: 'Hero reference',
      token: '@Hero reference',
    }]);
    expect(inspectTagGraphState('tag', baseNodes, edges)).toMatchObject({ status: 'ready', sourceNodeId: 'source' });
    expect(collectInputReferences('consumer', [sourceNode(), tagNode('tag', false), tagGroupNode(), consumerNode()], edges)).toEqual([]);
    expect(collectInputReferences('consumer', [sourceNode(), tagNode(), tagGroupNode('tag-group', false), consumerNode()], edges)).toEqual([]);
  });
});

describe('safe tag command transactions', () => {
  beforeEach(resetCanvas);

  it('lets Agent commands atomically create, connect, edit and undo tag state', async () => {
    useCanvasStore.getState().setCanvasData([sourceNode(), consumerNode()], []);
    const revisionBefore = canvasCommandRegistry.getRevision();
    const createResult = canvasCommandRegistry.executeTransaction({
      id: 'agent-create-tag-path',
      origin: 'agent',
      expectedRevision: canvasCommandRegistry.getRevision(),
      commands: [
        {
          type: 'node.create',
          version: CANVAS_COMMAND_VERSION,
          input: {
            nodeType: CANVAS_NODE_TYPES.tag,
            nodeId: 'tag',
            position: { x: 300, y: 0 },
            configuration: { displayName: 'Hero reference', tagColor: 'cyan' },
          },
        },
        {
          type: 'edge.connect',
          version: CANVAS_COMMAND_VERSION,
          input: { sourceNodeId: 'source', targetNodeId: 'tag' },
        },
        {
          type: 'edge.connect',
          version: CANVAS_COMMAND_VERSION,
          input: { sourceNodeId: 'tag', targetNodeId: 'consumer' },
        },
      ],
    });

    expect(createResult).toMatchObject({ ok: true, revisionAfter: revisionBefore + 1 });
    expect(useCanvasStore.getState().history.past).toHaveLength(1);
    expect(collectInputReferences('consumer', useCanvasStore.getState().nodes, useCanvasStore.getState().edges)).toHaveLength(1);

    const disableResult = await canvasCommandRegistry.execute({
      type: 'node.setEnabled',
      version: CANVAS_COMMAND_VERSION,
      input: { nodeIds: ['tag'], enabled: false },
    }, 'agent');
    expect(disableResult.ok).toBe(true);
    expect(collectInputReferences('consumer', useCanvasStore.getState().nodes, useCanvasStore.getState().edges)).toEqual([]);

    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(collectInputReferences('consumer', useCanvasStore.getState().nodes, useCanvasStore.getState().edges)).toHaveLength(1);
    expect(useCanvasStore.getState().redo()).toBe(true);
    expect(collectInputReferences('consumer', useCanvasStore.getState().nodes, useCanvasStore.getState().edges)).toEqual([]);
  });

  it('duplicates metadata without edges and cleans group membership and edges on delete', async () => {
    useCanvasStore.getState().setCanvasData(
      [sourceNode(), tagNode(), tagGroupNode(), consumerNode()],
      [edge('source-tag', 'source', 'tag'), edge('tag-consumer', 'tag', 'consumer')],
    );

    const duplicate = await canvasCommandRegistry.execute({
      type: 'node.duplicate',
      version: CANVAS_COMMAND_VERSION,
      input: { copies: [{ sourceNodeId: 'tag', nodeId: 'tag-copy' }] },
    }, 'agent');
    expect(duplicate.ok).toBe(true);
    expect(useCanvasStore.getState().nodes.find((node) => node.id === 'tag-copy')?.data).toMatchObject({
      label: 'Hero reference',
      enabled: true,
      color: 'cyan',
    });
    expect(useCanvasStore.getState().edges.some((item) => item.source === 'tag-copy' || item.target === 'tag-copy')).toBe(false);

    const remove = await canvasCommandRegistry.execute({
      type: 'node.delete',
      version: CANVAS_COMMAND_VERSION,
      input: { nodeIds: ['tag'] },
    }, 'agent');
    expect(remove.ok).toBe(true);
    expect(useCanvasStore.getState().edges).toEqual([]);
    expect(useCanvasStore.getState().nodes.find((node) => node.id === 'tag-group')?.data).toMatchObject({ memberTagIds: [] });
  });

  it('commits a relation-editor replacement as one undoable transaction', () => {
    useCanvasStore.getState().setCanvasData(
      [sourceNode(), tagNode(), consumerNode(), consumerNode('consumer-b')],
      [edge('source-tag', 'source', 'tag'), edge('tag-consumer', 'tag', 'consumer')],
    );
    const revisionBefore = canvasCommandRegistry.getRevision();
    const historyBefore = useCanvasStore.getState().history.past.length;

    const result = canvasCommandRegistry.executeTransaction({
      id: 'ui-replace-tag-target',
      origin: 'ui',
      expectedRevision: revisionBefore,
      commands: [
        {
          type: 'edge.disconnect',
          version: CANVAS_COMMAND_VERSION,
          input: { edgeIds: ['tag-consumer'] },
        },
        {
          type: 'edge.connect',
          version: CANVAS_COMMAND_VERSION,
          input: { sourceNodeId: 'tag', targetNodeId: 'consumer-b' },
        },
      ],
    });

    expect(result).toMatchObject({ ok: true, revisionAfter: revisionBefore + 1 });
    expect(useCanvasStore.getState().history.past).toHaveLength(historyBefore + 1);
    expect(useCanvasStore.getState().edges).toEqual(expect.arrayContaining([
      edge('source-tag', 'source', 'tag'),
      expect.objectContaining({ source: 'tag', target: 'consumer-b' }),
    ]));
    expect(useCanvasStore.getState().edges).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'tag', target: 'consumer' }),
    ]));

    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(useCanvasStore.getState().edges).toEqual(expect.arrayContaining([
      edge('source-tag', 'source', 'tag'),
      edge('tag-consumer', 'tag', 'consumer'),
    ]));
  });
});

describe('legacy tag persistence migration', () => {
  beforeEach(resetCanvas);

  it('converts sourceId before normalization for current graph and undo snapshots', () => {
    const legacyTag = {
      ...tagNode(),
      data: { ...tagNode().data, sourceId: 'source' },
    } as CanvasNode;
    const migrated = migrateLegacyTagGraph([sourceNode(), legacyTag], []);
    expect(migrated.edges).toMatchObject([{ source: 'source', target: 'tag' }]);
    expect(migrated.nodes.find((node) => node.id === 'tag')?.data).not.toHaveProperty('sourceId');

    useCanvasStore.getState().setCanvasData([sourceNode(), legacyTag], [], {
      past: [{ nodes: [sourceNode(), legacyTag], edges: [] }],
      future: [],
    });
    const state = useCanvasStore.getState();
    expect(state.edges).toMatchObject([{ source: 'source', target: 'tag' }]);
    expect(state.nodes.find((node) => node.id === 'tag')?.data).not.toHaveProperty('sourceId');
    expect(state.history.past[0].edges).toMatchObject([{ source: 'source', target: 'tag' }]);
  });

  it('preserves real edges on conflicting legacy input instead of guessing', () => {
    const legacyTag = {
      ...tagNode(),
      data: { ...tagNode().data, sourceId: 'source-b' },
    } as CanvasNode;
    const migrated = migrateLegacyTagGraph(
      [sourceNode('source-a'), sourceNode('source-b'), legacyTag],
      [edge('real-edge', 'source-a', 'tag')],
    );

    expect(migrated.edges).toEqual([edge('real-edge', 'source-a', 'tag')]);
    expect(migrated.diagnostics).toContainEqual(expect.objectContaining({ code: 'conflicting-source-id' }));
  });
});
