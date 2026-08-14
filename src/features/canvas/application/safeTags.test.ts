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
import {
  buildReferenceContextPrompt,
  collapseTagGroupReferenceOptions,
  collectInputReferenceGroups,
  collectInputReferences,
  expandTagGroupTokensInPrompt,
  inspectTagGraphState,
  normalizeReferenceTokensForSubmission,
} from './graphReferenceResolver';
import { getMenuNodeDefinitions, nodeCanStartManualConnection } from '../domain/nodeRegistry';
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

function textNode(id = 'text', content = 'Keep the character costume consistent.'): CanvasNode {
  return {
    id,
    type: CANVAS_NODE_TYPES.textAnnotation,
    position: { x: 0, y: 220 },
    data: {
      displayName: 'Direction note',
      content,
      fontSize: 16,
      color: '#111827',
      backgroundColor: '#ffffff',
      textAlign: 'left',
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

function tagGroupNode(id = 'tag-group', enabled = true, memberNodeIds = ['source']): CanvasNode {
  return {
    id,
    type: CANVAS_NODE_TYPES.tagGroup,
    position: { x: 300, y: 220 },
    data: {
      displayName: 'Characters',
      label: 'Characters',
      schemaVersion: 2,
      enabled,
      color: 'neutral',
      shape: 'rounded',
      memberNodeIds,
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
  it('exposes tag groups as independent blank-canvas nodes while keeping generic groups separate', () => {
    const menuTypes = getMenuNodeDefinitions().map((definition) => definition.type);
    expect(menuTypes).toContain(CANVAS_NODE_TYPES.tagGroup);
    expect(menuTypes).not.toContain(CANVAS_NODE_TYPES.group);
  });

  it('allows a tag group to start the same manual connection flow as normal material nodes', () => {
    expect(nodeCanStartManualConnection(CANVAS_NODE_TYPES.tagGroup)).toBe(true);
    expect(nodeCanStartManualConnection(CANVAS_NODE_TYPES.upload)).toBe(true);
    expect(nodeCanStartManualConnection(CANVAS_NODE_TYPES.group)).toBe(false);
    expect(validateCanvasConnection(
      'tag-group',
      'consumer',
      [tagGroupNode(), consumerNode()],
      [],
    )).toMatchObject({ valid: true });
  });

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
    expect(collectInputReferences('consumer', [sourceNode(), tagNode(), {
      ...tagGroupNode('tag-group', false),
      data: { ...tagGroupNode('tag-group', false).data, legacyMemberTagIds: ['tag'] },
    }, consumerNode()], edges)).toEqual([]);
  });

  it('shows every connected tag-group member as an ordinary @ reference option', () => {
    const sourceA = sourceNode('portrait');
    const sourceB = sourceNode('costume');
    sourceA.data.displayName = 'Portrait';
    sourceB.data.displayName = 'Costume';
    const group = tagGroupNode('characters', true, ['portrait', 'costume']);
    group.data.displayName = 'Hero references';
    const references = collectInputReferences(
      'consumer',
      [sourceA, sourceB, group, consumerNode()],
      [edge('group-consumer', 'characters', 'consumer')],
    );

    expect(references).toHaveLength(2);
    expect(references.map((reference) => reference.label)).toEqual([
      '图1',
      '图2',
    ]);
    expect(collectInputReferenceGroups(
      'consumer',
      [sourceA, sourceB, group, consumerNode()],
      [edge('group-consumer', 'characters', 'consumer')],
    )).toEqual([{ groupNodeId: 'characters', token: '@Hero references', title: 'Hero references', memberCount: 2 }]);
    expect(collapseTagGroupReferenceOptions(references).map(({ token, label }) => ({ token, label }))).toEqual([
      { token: '@图1', label: '图1' },
      { token: '@图2', label: '图2' },
    ]);
    expect(buildReferenceContextPrompt(references)).toBe('');
  });

  it('keeps generation references and prompt context identical to connecting members individually', () => {
    const portrait = sourceNode('portrait');
    const costume = sourceNode('costume');
    const note = textNode();
    portrait.data.displayName = 'Portrait';
    costume.data.displayName = 'Costume';
    const group = tagGroupNode('characters', true, [portrait.id, costume.id, note.id]);
    group.data.displayName = 'Hero references';
    const nodes = [portrait, costume, note, group, consumerNode()];
    const groupedReferences = collectInputReferences(
      'consumer',
      nodes,
      [edge('group-consumer', group.id, 'consumer')],
    );
    const directReferences = collectInputReferences(
      'consumer',
      nodes,
      [
        edge('portrait-consumer', portrait.id, 'consumer'),
        edge('costume-consumer', costume.id, 'consumer'),
        edge('note-consumer', note.id, 'consumer'),
      ],
    );
    const outboundProjection = (references: typeof groupedReferences) => ({
      media: references.map(({ kind, sourceNodeId, sourceItemId, imageUrl, videoUrl, audioUrl, content }) => ({
        kind,
        sourceNodeId,
        sourceItemId,
        imageUrl,
        videoUrl,
        audioUrl,
        content,
      })),
      options: collapseTagGroupReferenceOptions(references).map(({ kind, sourceNodeId, label, token }) => ({
        kind,
        sourceNodeId,
        label,
        token,
      })),
      promptContext: buildReferenceContextPrompt(references),
    });

    expect(outboundProjection(groupedReferences)).toEqual(outboundProjection(directReferences));
    expect(buildReferenceContextPrompt(groupedReferences)).not.toContain('标签组');
    expect(normalizeReferenceTokensForSubmission('@Hero references', groupedReferences)).toBe(
      normalizeReferenceTokensForSubmission('@图1、@图2、@文本1', directReferences),
    );
    expect(normalizeReferenceTokensForSubmission('@Hero references', groupedReferences)).toBe(
      '图1、图2、文本1',
    );
  });

  it('expands overlapping group names once without corrupting the longer token', () => {
    const portrait = sourceNode('portrait');
    const costume = sourceNode('costume');
    portrait.data.displayName = 'Portrait';
    costume.data.displayName = 'Costume';
    const hero = tagGroupNode('hero', true, ['portrait']);
    const heroTwo = tagGroupNode('hero-two', true, ['costume']);
    hero.data.displayName = 'Hero';
    heroTwo.data.displayName = 'Hero 2';
    const references = collectInputReferences(
      'consumer',
      [portrait, costume, hero, heroTwo, consumerNode()],
      [edge('hero-consumer', hero.id, 'consumer'), edge('hero-two-consumer', heroTwo.id, 'consumer')],
    );

    expect(expandTagGroupTokensInPrompt('@Hero 2 then @Hero; keep @Heroic unchanged', references)).toBe(
      '@图2 then @图1; keep @Heroic unchanged',
    );
  });

  it('projects every populated storyboard frame through one tag-group token', () => {
    const storyboard: CanvasNode = {
      id: 'sequence',
      type: CANVAS_NODE_TYPES.storyboardSplit,
      position: { x: 0, y: 0 },
      data: {
        displayName: 'Sequence',
        aspectRatio: '16:9',
        gridRows: 1,
        gridCols: 3,
        frames: [
          { id: 'frame-a', imageUrl: 'https://example.invalid/a.png', note: 'Opening', order: 0 },
          { id: 'frame-b', imageUrl: null, note: 'Missing', order: 1 },
          { id: 'frame-c', imageUrl: 'https://example.invalid/c.png', note: 'Closing', order: 2 },
        ],
      },
    };
    const group = tagGroupNode('sequence-group', true, [storyboard.id]);
    group.data.displayName = 'Shot sequence';
    const references = collectInputReferences(
      'consumer',
      [storyboard, group, consumerNode()],
      [edge('sequence-consumer', group.id, 'consumer')],
    );

    expect(references).toHaveLength(2);
    expect(references.map((reference) => reference.sourceItemId)).toEqual(['frame-a', 'frame-c']);
    expect(references.map((reference) => reference.imageUrl)).toEqual([
      'https://example.invalid/a.png',
      'https://example.invalid/c.png',
    ]);
    expect(expandTagGroupTokensInPrompt('Use @Shot sequence', references)).toBe(
      'Use @图1、@图2',
    );
  });

  it('only lets a tag group feed generation-capable nodes', () => {
    const group = tagGroupNode();
    expect(validateCanvasConnection(
      group.id,
      'consumer',
      [group, consumerNode()],
      [],
    )).toMatchObject({ valid: true });
    expect(validateCanvasConnection(
      group.id,
      'tag',
      [group, tagNode()],
      [],
    )).toMatchObject({ valid: false, code: 'tag-group-target' });
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
    expect(useCanvasStore.getState().nodes.find((node) => node.id === 'tag-group')?.data).toMatchObject({ memberNodeIds: ['source'] });
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

  it('migrates legacy tag-group members to direct sources and preserves ambiguous ids', () => {
    const legacyGroup = {
      ...tagGroupNode(),
      data: { displayName: 'Legacy group', label: 'Legacy group', enabled: true, memberTagIds: ['tag', 'missing-tag'] },
    } as CanvasNode;
    const migrated = migrateLegacyTagGraph(
      [sourceNode(), tagNode(), legacyGroup],
      [edge('source-tag', 'source', 'tag')],
    );

    expect(migrated.nodes.find((node) => node.id === 'tag-group')?.data).toMatchObject({
      schemaVersion: 2,
      memberNodeIds: ['source'],
      unresolvedMemberIds: ['missing-tag'],
    });
    expect(migrated.diagnostics).toContainEqual(expect.objectContaining({ code: 'unresolved-group-member', sourceNodeId: 'missing-tag' }));
  });
});
