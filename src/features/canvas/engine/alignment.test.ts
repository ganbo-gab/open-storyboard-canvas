import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CANVAS_NODE_TYPES, type CanvasNode } from '../domain/canvasNodes';
import { useCanvasAlignmentStore } from '../state/canvasUiStore';
import { useCanvasStore } from '@/stores/canvasStore';
import { applyAlignmentToNodeChanges, beginAlignmentDrag, clearAlignmentSession, computeAlignment, createAlignmentIndex, MAX_ALIGNMENT_CANDIDATES, setAlignmentSnapDisabled } from './alignment';

const drag = { x: 3, y: 204, width: 100, height: 80 };
beforeEach(() => { clearAlignmentSession(); setAlignmentSnapDisabled(false); });
afterEach(clearAlignmentSession);

describe('alignment geometry', () => {
  it('snaps edges and centers independently to the nearest matching coordinates', () => {
    expect(computeAlignment(drag, [{ x: 0, y: 200, width: 100, height: 80 }], 5)).toMatchObject({
      dx: -3, dy: -4, guides: { x: [0, 50, 100], y: [200, 240, 280] },
    });
    const center = computeAlignment({ x: 102, y: 400, width: 100, height: 100 },
      [{ x: 130, y: 600, width: 40, height: 100 }], 3);
    expect(center.dx).toBe(-2);
    expect(center.guides.x).toEqual([150]);
    expect(center.guides.y).toEqual([]);
  });

  it('respects an inclusive flow threshold and never shifts a distant node', () => {
    expect(computeAlignment(drag, [{ x: 0, y: 0, width: 100, height: 80 }], 2)).toEqual({ dx: 0, dy: 0, guides: { x: [], y: [] } });
    expect(computeAlignment(drag, [{ x: 0, y: 0, width: 100, height: 80 }], 3).dx).toBe(-3);
    expect(computeAlignment(drag, [], 6)).toEqual({ dx: 0, dy: 0, guides: { x: [], y: [] } });
  });

  it('spatially culls far nodes and caps dense per-frame candidates', () => {
    let farReads = 0;
    const far = { get x() { farReads += 1; return 1_000_000; }, y: 1_000_000, width: 100, height: 100 };
    const nearby = Array.from({ length: 1000 }, (_, index) => ({ x: index % 20, y: Math.floor(index / 20), width: 100, height: 100 }));
    const index = createAlignmentIndex([...nearby, far]);
    farReads = 0;
    for (let frame = 0; frame < 100; frame += 1) {
      const candidates = index.query({ x: frame, y: 0, width: 100, height: 100 });
      expect(candidates.length).toBeLessThanOrEqual(MAX_ALIGNMENT_CANDIDATES);
      expect(candidates.some((candidate) => candidate === far)).toBe(false);
    }
    expect(farReads).toBe(0);
  });
});

function node(id: string, x: number, y: number): CanvasNode {
  return { id, type: CANVAS_NODE_TYPES.upload, position: { x, y }, width: 100, height: 80, data: { imageUrl: '/image.png', aspectRatio: '5:4' } };
}

describe('canonical drag snapping', () => {
  it('writes snapped canonical positions each frame, supports live Meta/Ctrl bypass, and clears guides on release', () => {
    useCanvasStore.setState({ nodes: [node('drag', 3, 204), node('target', 0, 0)], edges: [], revision: 0,
      selectedNodeId: null, history: { past: [], future: [] }, dragHistorySnapshot: null, currentViewport: { x: 0, y: 0, zoom: 1 } });
    beginAlignmentDrag(false);
    useCanvasStore.getState().onNodesChange([{ type: 'position', id: 'drag', position: { x: 3, y: 204 }, dragging: true }]);
    expect(useCanvasStore.getState().nodes[0].position.x).toBe(0);
    expect(useCanvasAlignmentStore.getState().alignmentGuides?.x).toContain(0);
    const revision = useCanvasStore.getState().revision;
    setAlignmentSnapDisabled(true);
    useCanvasStore.getState().onNodesChange([{ type: 'position', id: 'drag', position: { x: 3, y: 205 }, dragging: true }]);
    expect(useCanvasStore.getState().nodes[0].position.x).toBe(3);
    expect(useCanvasStore.getState().revision).toBe(revision + 1);
    expect(useCanvasAlignmentStore.getState().alignmentGuides).toBeNull();
    setAlignmentSnapDisabled(false);
    useCanvasStore.getState().onNodesChange([{ type: 'position', id: 'drag', position: { x: 4, y: 205 }, dragging: true }]);
    expect(useCanvasStore.getState().nodes[0].position.x).toBe(0);
    useCanvasStore.getState().onNodesChange([{ type: 'position', id: 'drag', position: { x: 4, y: 205 }, dragging: false }]);
    expect(useCanvasStore.getState().nodes[0].position.x).toBe(0);
    expect(useCanvasAlignmentStore.getState().alignmentGuides).toBeNull();
    expect(useCanvasStore.getState().history.past).toHaveLength(1);
  });

  it('keeps Alt-copy originals pinned while snapping only the moving copies', () => {
    const nodes = [node('original', 300, 300), node('copy', 304, 500), node('target', 0, 0)];
    beginAlignmentDrag(false, ['copy']);
    const changes = applyAlignmentToNodeChanges([
      { type: 'position', id: 'original', position: { x: 300, y: 300 }, dragging: true },
      { type: 'position', id: 'copy', position: { x: 304, y: 500 }, dragging: true },
    ], { nodes, currentViewport: { zoom: 1 } });
    expect(changes).toMatchObject([
      { id: 'original', position: { x: 300, y: 300 } }, { id: 'copy', position: { x: 300, y: 500 } },
    ]);
  });

  it.each([500, 1000])('excludes hidden candidates and never re-scans %i far nodes during sustained drag', (count) => {
    let farReads = 0;
    const farNodes = Array.from({ length: count }, (_, index) => {
      const far = node(`far-${index}`, 1_000_000 + index * 200, 1_000_000);
      Object.defineProperty(far, 'position', { get() { farReads += 1; return { x: 1_000_000 + index * 200, y: 1_000_000 }; } });
      return far;
    });
    const hidden = { ...node('hidden', 0, 0), hidden: true };
    const nodes = [node('drag', 3, 204), hidden, ...farNodes];
    beginAlignmentDrag(false);
    const state = { nodes, currentViewport: { zoom: 1 } };
    applyAlignmentToNodeChanges([{ type: 'position', id: 'drag', position: { x: 3, y: 204 }, dragging: true }], state);
    farReads = 0;
    for (let frame = 0; frame < 30; frame += 1) {
      const changes = applyAlignmentToNodeChanges([{ type: 'position', id: 'drag', position: { x: 3, y: 204 }, dragging: true }], state);
      expect(changes).toMatchObject([{ position: { x: 3, y: 204 } }]);
    }
    expect(farReads).toBe(0);
    expect(useCanvasAlignmentStore.getState().alignmentGuides).toBeNull();
  });
});
