import {
  DEFAULT_NODE_WIDTH,
  type CanvasNode,
} from '../domain/canvasNodes';

type Point = { x: number; y: number };
type Size = { width: number; height: number };
type Rect = Point & Size;

export interface CanvasPlacementViewport {
  x: number;
  y: number;
  zoom: number;
  width: number;
  height: number;
}

export interface RelatedCanvasPlacementInput {
  nodes: readonly CanvasNode[];
  desired: Point;
  size: Size;
  count?: number;
  relatedNodeId?: string;
  viewport?: CanvasPlacementViewport | null;
}

const DEFAULT_NODE_HEIGHT = 200;
const COLLISION_MARGIN = 18;
const RELATION_GAP = 32;

function nodeRect(node: CanvasNode): Rect {
  const style = node.style as { width?: unknown; height?: unknown } | undefined;
  const width = node.measured?.width
    ?? node.width
    ?? (typeof style?.width === 'number' ? style.width : DEFAULT_NODE_WIDTH);
  const height = node.measured?.height
    ?? node.height
    ?? (typeof style?.height === 'number' ? style.height : DEFAULT_NODE_HEIGHT);
  return {
    x: node.position.x,
    y: node.position.y,
    width: Number.isFinite(width) && width > 0 ? width : DEFAULT_NODE_WIDTH,
    height: Number.isFinite(height) && height > 0 ? height : DEFAULT_NODE_HEIGHT,
  };
}

function overlaps(left: Rect, right: Rect, margin = COLLISION_MARGIN): boolean {
  return left.x < right.x + right.width + margin
    && left.x + left.width + margin > right.x
    && left.y < right.y + right.height + margin
    && left.y + left.height + margin > right.y;
}

function rectDistance(left: Rect, right: Rect): number {
  const dx = Math.max(right.x - (left.x + left.width), left.x - (right.x + right.width), 0);
  const dy = Math.max(right.y - (left.y + left.height), left.y - (right.y + right.height), 0);
  return Math.hypot(dx, dy);
}

function center(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function viewportOverflow(rect: Rect, viewport?: CanvasPlacementViewport | null): number {
  if (!viewport || viewport.width <= 0 || viewport.height <= 0) return 0;
  const zoom = Math.max(0.01, viewport.zoom || 1);
  const bounds = {
    left: -viewport.x / zoom,
    top: -viewport.y / zoom,
    right: -viewport.x / zoom + viewport.width / zoom,
    bottom: -viewport.y / zoom + viewport.height / zoom,
  };
  return Math.max(0, bounds.left - rect.x)
    + Math.max(0, bounds.top - rect.y)
    + Math.max(0, rect.x + rect.width - bounds.right)
    + Math.max(0, rect.y + rect.height - bounds.bottom);
}

function candidateKey(point: Point): string {
  return `${Math.round(point.x * 10)}:${Math.round(point.y * 10)}`;
}

function buildCandidates(anchor: Point, size: Size, relatedRect?: Rect): Point[] {
  const candidates: Point[] = [anchor];
  if (relatedRect) {
    candidates.push(
      { x: relatedRect.x + relatedRect.width + RELATION_GAP, y: relatedRect.y },
      { x: relatedRect.x, y: relatedRect.y + relatedRect.height + RELATION_GAP },
      { x: relatedRect.x - size.width - RELATION_GAP, y: relatedRect.y },
      { x: relatedRect.x, y: relatedRect.y - size.height - RELATION_GAP },
    );
  }

  const stepX = Math.max(104, Math.round(size.width * 0.48));
  const stepY = Math.max(88, Math.round(size.height * 0.48));
  for (let ring = 1; ring <= 7; ring += 1) {
    for (let x = -ring; x <= ring; x += 1) {
      candidates.push(
        { x: anchor.x + x * stepX, y: anchor.y - ring * stepY },
        { x: anchor.x + x * stepX, y: anchor.y + ring * stepY },
      );
    }
    for (let y = -ring + 1; y < ring; y += 1) {
      candidates.push(
        { x: anchor.x - ring * stepX, y: anchor.y + y * stepY },
        { x: anchor.x + ring * stepX, y: anchor.y + y * stepY },
      );
    }
  }
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = candidateKey(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Finds nearby positions with enough surrounding room for a readable result
 * cluster. Clearance improves the score, but a bounded relationship-distance
 * penalty prevents a generated result from jumping to a remote empty corner.
 */
export function findRelatedCanvasNodePositions(input: RelatedCanvasPlacementInput): Point[] {
  const total = Math.max(1, Math.floor(input.count ?? 1));
  const obstacles = input.nodes.map(nodeRect);
  const relatedNode = input.relatedNodeId
    ? input.nodes.find((node) => node.id === input.relatedNodeId)
    : undefined;
  const relatedRect = relatedNode ? nodeRect(relatedNode) : undefined;
  const anchor = relatedRect
    ? { x: relatedRect.x + relatedRect.width + RELATION_GAP, y: relatedRect.y }
    : input.desired;
  const anchorRect: Rect = { ...anchor, ...input.size };
  const anchorCenter = center(anchorRect);
  const reserved: Rect[] = [];
  const positions: Point[] = [];

  for (let index = 0; index < total; index += 1) {
    const candidates = buildCandidates(
      index === 0 ? anchor : { x: anchor.x, y: anchor.y + index * (input.size.height + RELATION_GAP) },
      input.size,
      relatedRect,
    );
    let best: { point: Point; score: number } | null = null;
    for (const point of candidates) {
      const rect: Rect = { ...point, ...input.size };
      if (obstacles.some((obstacle) => overlaps(rect, obstacle)) || reserved.some((item) => overlaps(rect, item))) {
        continue;
      }
      const clearance = [...obstacles, ...reserved].reduce(
        (nearest, obstacle) => Math.min(nearest, rectDistance(rect, obstacle)),
        560,
      );
      const rectCenter = center(rect);
      const relationshipDistance = Math.hypot(rectCenter.x - anchorCenter.x, rectCenter.y - anchorCenter.y);
      const overflow = viewportOverflow(rect, input.viewport);
      const upwardPenalty = point.y < anchor.y ? Math.abs(point.y - anchor.y) * 0.12 : 0;
      const score = relationshipDistance * 0.72
        + overflow * 7
        + upwardPenalty
        - Math.min(clearance, 360) * 0.45;
      if (!best || score < best.score) best = { point, score };
    }

    const point = best?.point ?? {
      x: anchor.x + (index + 2) * (input.size.width + RELATION_GAP),
      y: anchor.y,
    };
    positions.push(point);
    reserved.push({ ...point, ...input.size });
  }

  return positions;
}
