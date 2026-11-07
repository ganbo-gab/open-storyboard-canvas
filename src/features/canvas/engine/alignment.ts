import type { NodeChange, XYPosition } from '@xyflow/react';
import type { CanvasNode } from '../domain/canvasNodes';
import { getNodeSize, resolveAbsoluteNodePosition } from '../clipboard/clipboardIO';
import { useCanvasAlignmentStore } from '../state/canvasUiStore';

export interface AlignmentRect { x: number; y: number; width: number; height: number }
export interface AlignmentGuides { x: number[]; y: number[] }
export interface AlignmentResult { dx: number; dy: number; guides: AlignmentGuides }
export const MAX_ALIGNMENT_CANDIDATES = 96;
const CELL_SIZE = 512;
const MAX_QUERY_CELLS = 256;

/** Align any edge or center to the nearest candidate edge/center, independently per axis. */
export function computeAlignment(dragRect: AlignmentRect, candidateRects: readonly AlignmentRect[], thresholdFlow: number): AlignmentResult {
  let dx = 0; let dy = 0;
  let bestX = Number.POSITIVE_INFINITY; let bestY = Number.POSITIVE_INFINITY;
  const guides: AlignmentGuides = { x: [], y: [] };
  if (!Number.isFinite(thresholdFlow) || thresholdFlow < 0) return { dx, dy, guides };
  const xs = [dragRect.x, dragRect.x + dragRect.width / 2, dragRect.x + dragRect.width];
  const ys = [dragRect.y, dragRect.y + dragRect.height / 2, dragRect.y + dragRect.height];
  for (const candidate of candidateRects) {
    for (const x of [candidate.x, candidate.x + candidate.width / 2, candidate.x + candidate.width]) {
      for (const own of xs) {
        const delta = x - own; const distance = Math.abs(delta);
        if (distance > thresholdFlow) continue;
        if (distance < bestX) { bestX = distance; dx = delta; guides.x = [x]; }
        else if (delta === dx && !guides.x.includes(x)) guides.x.push(x);
      }
    }
    for (const y of [candidate.y, candidate.y + candidate.height / 2, candidate.y + candidate.height]) {
      for (const own of ys) {
        const delta = y - own; const distance = Math.abs(delta);
        if (distance > thresholdFlow) continue;
        if (distance < bestY) { bestY = distance; dy = delta; guides.y = [y]; }
        else if (delta === dy && !guides.y.includes(y)) guides.y.push(y);
      }
    }
  }
  return { dx, dy, guides };
}

/** Built once per drag. Per-frame queries visit at most 256 nearby cells and return at most 96 nodes. */
export function createAlignmentIndex(rects: readonly AlignmentRect[]): { query(rect: AlignmentRect): AlignmentRect[] } {
  const cells = new Map<string, AlignmentRect[]>();
  for (const rect of rects) {
    const minX = Math.floor(rect.x / CELL_SIZE); const minY = Math.floor(rect.y / CELL_SIZE);
    const maxX = Math.floor((rect.x + rect.width) / CELL_SIZE); const maxY = Math.floor((rect.y + rect.height) / CELL_SIZE);
    for (let x = minX; x <= maxX; x += 1) for (let y = minY; y <= maxY; y += 1) {
      const key = `${x},${y}`; const bucket = cells.get(key);
      if (bucket) bucket.push(rect); else cells.set(key, [rect]);
    }
  }
  return { query(rect) {
    const found = new Set<AlignmentRect>();
    const cx = Math.floor((rect.x + rect.width / 2) / CELL_SIZE);
    const cy = Math.floor((rect.y + rect.height / 2) / CELL_SIZE);
    const radiusX = Math.ceil(rect.width / CELL_SIZE / 2) + 1;
    const radiusY = Math.ceil(rect.height / CELL_SIZE / 2) + 1;
    let visited = 0;
    const visit = (x: number, y: number) => {
      visited += 1;
      for (const candidate of cells.get(`${x},${y}`) ?? []) {
        if (candidate.x > rect.x + rect.width + CELL_SIZE || candidate.x + candidate.width < rect.x - CELL_SIZE
          || candidate.y > rect.y + rect.height + CELL_SIZE || candidate.y + candidate.height < rect.y - CELL_SIZE) continue;
        found.add(candidate);
        if (found.size >= MAX_ALIGNMENT_CANDIDATES) break;
      }
    };
    for (let radius = 0; radius <= Math.max(radiusX, radiusY); radius += 1) {
      for (let x = -radius; x <= radius; x += 1) for (let y = -radius; y <= radius; y += 1) {
        if (Math.max(Math.abs(x), Math.abs(y)) !== radius || Math.abs(x) > radiusX || Math.abs(y) > radiusY) continue;
        visit(cx + x, cy + y);
        if (found.size >= MAX_ALIGNMENT_CANDIDATES || visited >= MAX_QUERY_CELLS) return [...found];
      }
    }
    return [...found];
  } };
}

interface DragAlignmentSession {
  nodesById: Map<string, CanvasNode>;
  movingIds: Set<string>;
  index: { query(rect: AlignmentRect): AlignmentRect[] };
}
let session: DragAlignmentSession | null = null;
let draggingActive = false;
export function beginAlignmentDrag(disabled: boolean, nodeIds?: Iterable<string>): void {
  clearAlignmentSession();
  draggingActive = true;
  snapDisabled = disabled;
  dragNodeIds = nodeIds ? new Set(nodeIds) : null;
}
let snapDisabled = false;
let dragNodeIds: Set<string> | null = null;
export function setAlignmentSnapDisabled(disabled: boolean): void {
  snapDisabled = disabled;
  if (disabled) useCanvasAlignmentStore.getState().setAlignmentGuides(null);
}
export function clearAlignmentSession(): void {
  session = null;
  draggingActive = false;
  dragNodeIds = null;
  useCanvasAlignmentStore.getState().setAlignmentGuides(null);
}

export function applyAlignmentToNodeChanges(
  changes: NodeChange<CanvasNode>[], state: { nodes: CanvasNode[]; currentViewport: { zoom: number } },
): NodeChange<CanvasNode>[] {
  if (!draggingActive) return changes;
  const finishing = changes.some((change) => change.type === 'position' && change.dragging === false);
  const moves = changes.filter((change) => change.type === 'position' && change.position
    && (change.dragging === true || (change.dragging === false && session !== null)));
  if (!moves.length) {
    if (finishing) clearAlignmentSession();
    return changes;
  }
  if (snapDisabled) {
    if (finishing) clearAlignmentSession();
    else useCanvasAlignmentStore.getState().setAlignmentGuides(null);
    return changes;
  }
  if (!session) {
    const nodesById = new Map(state.nodes.map((node) => [node.id, node]));
    const movingIds = dragNodeIds ?? new Set(moves.flatMap((change) => 'id' in change ? [change.id] : []));
    const rects: AlignmentRect[] = [];
    for (const node of state.nodes) {
      if (node.hidden || movingIds.has(node.id) || (node.parentId && movingIds.has(node.parentId))) continue;
      rects.push({ ...resolveAbsoluteNodePosition(node, nodesById), ...getNodeSize(node) });
    }
    session = { nodesById, movingIds, index: createAlignmentIndex(rects) };
  }
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  const roots = new Set<string>();
  for (const move of moves) {
    if (move.type !== 'position' || !move.position || (dragNodeIds && !dragNodeIds.has(move.id))) continue;
    const node = session.nodesById.get(move.id);
    if (!node || (node.parentId && session.movingIds.has(node.parentId))) continue;
    roots.add(node.id);
    const parent = node.parentId ? session.nodesById.get(node.parentId) : undefined;
    const origin: XYPosition = parent ? resolveAbsoluteNodePosition(parent, session.nodesById) : { x: 0, y: 0 };
    const x = move.position.x + origin.x; const y = move.position.y + origin.y; const size = getNodeSize(node);
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x + size.width); maxY = Math.max(maxY, y + size.height);
  }
  if (!roots.size) return changes;
  const rect = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  const result = computeAlignment(rect, session.index.query(rect), 6 / Math.max(0.1, state.currentViewport.zoom));
  useCanvasAlignmentStore.getState().setAlignmentGuides(!finishing && (result.guides.x.length || result.guides.y.length) ? result.guides : null);
  if (finishing) { session = null; draggingActive = false; dragNodeIds = null; }
  if (!result.dx && !result.dy) return changes;
  return changes.map((change) => change.type === 'position' && change.position && roots.has(change.id)
    ? { ...change, position: { x: change.position.x + result.dx, y: change.position.y + result.dy } }
    : change);
}
