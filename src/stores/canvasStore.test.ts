import { beforeEach, describe, expect, it } from 'vitest';

import {
  CANVAS_NODE_TYPES,
  type BlueprintNodeData,
  type CanvasNode,
  type DirectorMotionProjectV1,
} from '@/features/canvas/domain/canvasNodes';
import { MAX_CANVAS_BATCH_ADD_NODES, useCanvasStore } from './canvasStore';

function resetCanvasStore(): void {
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
    canvasViewportSize: { width: 1_280, height: 720 },
  });
}

function createDirectorNode(data: Partial<BlueprintNodeData> = {}): CanvasNode {
  return {
    id: 'director-node',
    type: CANVAS_NODE_TYPES.blueprint,
    position: { x: 0, y: 0 },
    data: {
      mode: 'flat',
      items: [],
      referenceImages: [],
      aspectRatio: '16:9',
      ...data,
    },
  } as CanvasNode;
}

describe('canvasStore.addNodesBatch', () => {
  beforeEach(resetCanvasStore);

  it('adds 500 editable idle nodes in one mutation and removes all of them with one undo', () => {
    let mutationCount = 0;
    const unsubscribe = useCanvasStore.subscribe(() => {
      mutationCount += 1;
    });

    const ids = useCanvasStore.getState().addNodesBatch(Array.from(
      { length: MAX_CANVAS_BATCH_ADD_NODES },
      (_, index) => ({
        type: CANVAS_NODE_TYPES.imageEdit,
        position: { x: (index % 20) * 728, y: Math.floor(index / 20) * 420 },
        dimensions: { width: 680, height: 380 },
        data: {
          displayName: `Prompt ${index + 1}`,
          prompt: `Imported prompt ${index + 1}`,
        },
      }),
    ));
    unsubscribe();

    const importedState = useCanvasStore.getState();
    expect(ids).toHaveLength(500);
    expect(new Set(ids).size).toBe(500);
    expect(importedState.nodes).toHaveLength(500);
    expect(importedState.nodes.every((node) => (
      node.type === CANVAS_NODE_TYPES.imageEdit
      && node.data.isGenerating === false
      && typeof node.data.prompt === 'string'
      && node.measured?.width === 680
      && node.measured?.height === 380
    ))).toBe(true);
    expect(importedState.history.past).toHaveLength(1);
    expect(mutationCount).toBe(1);

    expect(importedState.undo()).toBe(true);
    expect(useCanvasStore.getState().nodes).toHaveLength(0);
    expect(useCanvasStore.getState().undo()).toBe(false);
  });

  it('preserves imported custom names when another node is deleted', () => {
    const [, secondId] = useCanvasStore.getState().addNodesBatch([
      {
        type: CANVAS_NODE_TYPES.imageEdit,
        position: { x: 0, y: 0 },
        data: { displayName: 'Opening shot', prompt: 'Prompt one' },
      },
      {
        type: CANVAS_NODE_TYPES.imageEdit,
        position: { x: 728, y: 0 },
        data: { displayName: 'Final shot', prompt: 'Prompt two' },
      },
    ]);
    const firstId = useCanvasStore.getState().nodes[0].id;

    useCanvasStore.getState().deleteNode(firstId);

    expect(useCanvasStore.getState().nodes).toHaveLength(1);
    expect(useCanvasStore.getState().nodes[0]).toMatchObject({
      id: secondId,
      data: { displayName: 'Final shot' },
    });
  });

  it('rejects batches above the safety limit without changing state', () => {
    expect(() => useCanvasStore.getState().addNodesBatch(Array.from(
      { length: MAX_CANVAS_BATCH_ADD_NODES + 1 },
      () => ({ type: CANVAS_NODE_TYPES.imageEdit, position: { x: 0, y: 0 } }),
    ))).toThrowError(RangeError);
    expect(useCanvasStore.getState().nodes).toEqual([]);
    expect(useCanvasStore.getState().history.past).toEqual([]);
  });

  it('rejects invalid initial dimensions without partially adding the batch', () => {
    expect(() => useCanvasStore.getState().addNodesBatch([
      {
        type: CANVAS_NODE_TYPES.imageEdit,
        position: { x: 0, y: 0 },
        dimensions: { width: 680, height: 380 },
      },
      {
        type: CANVAS_NODE_TYPES.imageEdit,
        position: { x: 728, y: 0 },
        dimensions: { width: 0, height: 380 },
      },
    ])).toThrowError(RangeError);
    expect(useCanvasStore.getState().nodes).toEqual([]);
    expect(useCanvasStore.getState().history.past).toEqual([]);
  });
});

describe('canvasStore related-node placement', () => {
  beforeEach(resetCanvasStore);

  it('keeps a generated result near its input while avoiding occupied lanes', () => {
    const source = {
      id: 'generation-input',
      type: CANVAS_NODE_TYPES.imageEdit,
      position: { x: 0, y: 0 },
      measured: { width: 460, height: 520 },
      data: {},
    } as CanvasNode;
    useCanvasStore.setState({
      nodes: [
        source,
        { ...source, id: 'right-top', position: { x: 500, y: 0 }, measured: { width: 420, height: 300 } },
        { ...source, id: 'right-bottom', position: { x: 500, y: 330 }, measured: { width: 420, height: 300 } },
        { ...source, id: 'below', position: { x: 0, y: 560 }, measured: { width: 360, height: 300 } },
      ],
    });

    const position = useCanvasStore.getState().findNodePosition('generation-input', 384, 288);

    expect(Math.hypot(position.x - 488, position.y)).toBeLessThan(1_500);
    expect(position.y).toBeLessThan(1_800);
  });
});

describe('canvasStore revision contract', () => {
  beforeEach(resetCanvasStore);

  it('advances for persistent graph mutations but not selection or viewport changes', () => {
    const nodeId = useCanvasStore.getState().addNode(CANVAS_NODE_TYPES.imageEdit, { x: 0, y: 0 });
    expect(useCanvasStore.getState().revision).toBe(1);

    useCanvasStore.getState().setViewportState({ x: 20, y: 30, zoom: 1.2 });
    useCanvasStore.getState().setSelectedNode(nodeId);
    useCanvasStore.getState().onNodesChange([{ id: nodeId, type: 'select', selected: true }]);
    expect(useCanvasStore.getState().revision).toBe(1);

    useCanvasStore.getState().updateNodeData(nodeId, { prompt: 'Updated prompt' });
    expect(useCanvasStore.getState().revision).toBe(2);

    useCanvasStore.getState().updateNodePosition(nodeId, { x: 100, y: 120 });
    expect(useCanvasStore.getState().revision).toBe(3);

    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(useCanvasStore.getState().revision).toBe(4);
  });
});

describe('canvasStore graph transaction CAS', () => {
  beforeEach(resetCanvasStore);

  it('does not notify subscribers when the expected revision is stale', () => {
    useCanvasStore.getState().addNode(CANVAS_NODE_TYPES.upload, { x: 0, y: 0 });
    let mutationCount = 0;
    const unsubscribe = useCanvasStore.subscribe(() => {
      mutationCount += 1;
    });
    const state = useCanvasStore.getState();

    const result = state.commitGraphTransaction({
      expectedRevision: 0,
      nodes: [],
      edges: [],
      selectedNodeId: null,
    });
    unsubscribe();

    expect(result).toBeNull();
    expect(mutationCount).toBe(0);
    expect(useCanvasStore.getState()).toBe(state);
  });
});

describe('canvasStore Director Studio persistence', () => {
  beforeEach(resetCanvasStore);

  it('restores V1 motion for the workspace and saved Director projects', () => {
    const motionProject: DirectorMotionProjectV1 = {
      schemaVersion: 1,
      durationSeconds: 6,
      loop: true,
      cameraTrack: [
        {
          id: 'camera',
          time: 2,
          easing: 'smooth',
          position: { x: 1, y: 2, z: 3 },
          target: { x: 0, y: 1, z: 0 },
          fov: 50,
          trackTargetId: null,
          trackTargetBodyPart: null,
        },
      ],
      objectTracks: {},
      actionTracks: {},
      customClips: [],
    };
    const node = createDirectorNode({
      motionProject,
      directorStudioProjects: [{
        id: 'saved-project',
        name: 'Saved project',
        createdAt: 1,
        updatedAt: 2,
        snapshot: {
          mode: 'flat',
          items: [],
          referenceImages: [],
          aspectRatio: '16:9',
          motionProject,
        },
      }],
    });

    useCanvasStore.getState().setCanvasData([node], []);

    const data = useCanvasStore.getState().nodes[0].data as BlueprintNodeData;
    expect(data.motionProject).toEqual(motionProject);
    expect(data.directorStudioProjects?.[0].snapshot.motionProject).toEqual(motionProject);
  });

  it('keeps legacy missing motion absent until an edit creates it', () => {
    useCanvasStore.getState().setCanvasData([createDirectorNode()], []);

    const data = useCanvasStore.getState().nodes[0].data as BlueprintNodeData;
    expect(data.motionProject).toBeUndefined();
  });

  it('resets ephemeral Studio mount state without adding canvas history', () => {
    useCanvasStore.getState().setCanvasData([createDirectorNode()], []);
    const historyBeforeOpen = useCanvasStore.getState().history;

    useCanvasStore.getState().setActiveDirectorStudioNode('director-node');
    expect(useCanvasStore.getState().activeDirectorStudioNodeId).toBe('director-node');
    expect(useCanvasStore.getState().history).toBe(historyBeforeOpen);

    useCanvasStore.getState().setCanvasData([createDirectorNode()], []);
    expect(useCanvasStore.getState().activeDirectorStudioNodeId).toBeNull();
  });
});
