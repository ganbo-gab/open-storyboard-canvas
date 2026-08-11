import {
  DEFAULT_NODE_WIDTH,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';

export interface CanvasGeometryObstacle {
  id: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface CanvasGeometryIndex {
  obstacles: readonly CanvasGeometryObstacle[];
  bucketSize: number;
  xBuckets: ReadonlyMap<number, readonly number[]>;
}

const DEFAULT_NODE_HEIGHT = 200;
const EXPANDED_NODE_PADDING = 14;
const DEFAULT_GEOMETRY_BUCKET_SIZE = 320;

function resolveDimension(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function resolveNodeWidth(node: CanvasNode): number {
  return resolveDimension(
    node.measured?.width
      ?? node.width
      ?? (typeof node.style?.width === 'number' ? node.style.width : undefined),
    DEFAULT_NODE_WIDTH,
  );
}

function resolveNodeHeight(node: CanvasNode): number {
  return resolveDimension(
    node.measured?.height
      ?? node.height
      ?? (typeof node.style?.height === 'number' ? node.style.height : undefined),
    DEFAULT_NODE_HEIGHT,
  );
}

function hasSameGeometry(left: CanvasNode[], right: CanvasNode[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;

  for (let index = 0; index < left.length; index += 1) {
    const leftNode = left[index];
    const rightNode = right[index];
    if (
      leftNode.id !== rightNode.id
      || leftNode.position.x !== rightNode.position.x
      || leftNode.position.y !== rightNode.position.y
      || resolveNodeWidth(leftNode) !== resolveNodeWidth(rightNode)
      || resolveNodeHeight(leftNode) !== resolveNodeHeight(rightNode)
    ) {
      return false;
    }
  }

  return true;
}

export function buildCanvasGeometryIndex(
  nodes: CanvasNode[],
  bucketSize = DEFAULT_GEOMETRY_BUCKET_SIZE,
): CanvasGeometryIndex {
  const normalizedBucketSize = resolveDimension(bucketSize, DEFAULT_GEOMETRY_BUCKET_SIZE);
  const obstacles = nodes.map<CanvasGeometryObstacle>((node) => {
    const width = resolveNodeWidth(node);
    const height = resolveNodeHeight(node);
    return {
      id: node.id,
      left: node.position.x - EXPANDED_NODE_PADDING,
      top: node.position.y - EXPANDED_NODE_PADDING,
      right: node.position.x + width + EXPANDED_NODE_PADDING,
      bottom: node.position.y + height + EXPANDED_NODE_PADDING,
    };
  });
  const mutableBuckets = new Map<number, number[]>();

  obstacles.forEach((obstacle, obstacleIndex) => {
    const firstBucket = Math.floor(obstacle.left / normalizedBucketSize);
    const lastBucket = Math.floor(obstacle.right / normalizedBucketSize);
    for (let bucket = firstBucket; bucket <= lastBucket; bucket += 1) {
      const current = mutableBuckets.get(bucket);
      if (current) {
        current.push(obstacleIndex);
      } else {
        mutableBuckets.set(bucket, [obstacleIndex]);
      }
    }
  });

  return {
    obstacles,
    bucketSize: normalizedBucketSize,
    xBuckets: mutableBuckets,
  };
}

export const EMPTY_CANVAS_GEOMETRY_INDEX = buildCanvasGeometryIndex([]);

let latestGeometryCache: { nodes: CanvasNode[]; index: CanvasGeometryIndex } | null = null;
const geometryIndexByNodes = new WeakMap<CanvasNode[], CanvasGeometryIndex>();
const nodeIndexByNodes = new WeakMap<CanvasNode[], ReadonlyMap<string, CanvasNode>>();

/**
 * All smart edges ask for the same derived geometry object. Data-only node
 * updates reuse the previous object so they do not invalidate every route.
 */
export function getSharedCanvasGeometryIndex(nodes: CanvasNode[]): CanvasGeometryIndex {
  const cached = geometryIndexByNodes.get(nodes);
  if (cached) return cached;

  if (latestGeometryCache && hasSameGeometry(latestGeometryCache.nodes, nodes)) {
    geometryIndexByNodes.set(nodes, latestGeometryCache.index);
    latestGeometryCache = { nodes, index: latestGeometryCache.index };
    return latestGeometryCache.index;
  }

  const index = buildCanvasGeometryIndex(nodes);
  geometryIndexByNodes.set(nodes, index);
  latestGeometryCache = { nodes, index };
  return index;
}

/** Build at most one id map for a given nodes array, shared by every edge selector. */
export function getSharedCanvasNodeIndex(nodes: CanvasNode[]): ReadonlyMap<string, CanvasNode> {
  const cached = nodeIndexByNodes.get(nodes);
  if (cached) return cached;

  const index = new Map(nodes.map((node) => [node.id, node]));
  nodeIndexByNodes.set(nodes, index);
  return index;
}

export function queryCanvasGeometryByXRange(
  index: CanvasGeometryIndex,
  minX: number,
  maxX: number,
  sourceId?: string,
  targetId?: string,
): CanvasGeometryObstacle[] {
  const left = Math.min(minX, maxX);
  const right = Math.max(minX, maxX);
  if (!Number.isFinite(left) || !Number.isFinite(right) || index.obstacles.length === 0) {
    return [];
  }

  const firstBucket = Math.floor(left / index.bucketSize);
  const lastBucket = Math.floor(right / index.bucketSize);
  const bucketSpan = lastBucket - firstBucket + 1;
  const candidateIndexes = new Set<number>();

  if (bucketSpan > Math.max(64, index.obstacles.length * 4)) {
    index.obstacles.forEach((_, obstacleIndex) => candidateIndexes.add(obstacleIndex));
  } else {
    for (let bucket = firstBucket; bucket <= lastBucket; bucket += 1) {
      index.xBuckets.get(bucket)?.forEach((obstacleIndex) => candidateIndexes.add(obstacleIndex));
    }
  }

  return Array.from(candidateIndexes)
    .sort((a, b) => a - b)
    .reduce<CanvasGeometryObstacle[]>((result, obstacleIndex) => {
      const obstacle = index.obstacles[obstacleIndex];
      if (
        obstacle.id !== sourceId
        && obstacle.id !== targetId
        && obstacle.right >= left
        && obstacle.left <= right
      ) {
        result.push(obstacle);
      }
      return result;
    }, []);
}
