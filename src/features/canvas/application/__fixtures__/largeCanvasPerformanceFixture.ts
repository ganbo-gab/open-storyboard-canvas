import {
  CANVAS_NODE_TYPES,
  type CanvasEdge,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';

export interface LargeCanvasPerformanceFixture {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  consumerNodeIds: string[];
  tagNodeIds: string[];
  tagGroupNodeIds: string[];
}

const SOURCE_COUNT = 160;
const TAG_COUNT = 44;
const TAG_GROUP_COUNT = 4;
const CONSUMER_COUNT = 40;

function positionFor(index: number, columns: number, columnGap: number, rowGap: number) {
  return {
    x: (index % columns) * columnGap,
    y: Math.floor(index / columns) * rowGap,
  };
}

/**
 * Stable 200+ node / 40+ tag fixture used for before/after canvas profiling.
 *
 * The raw string node types intentionally allow the fixture to run against the
 * pre-tag baseline. Production code must never rely on these casts; once the
 * registry owns the types the same fixture exercises their real contracts.
 */
export function createLargeCanvasPerformanceFixture(): LargeCanvasPerformanceFixture {
  const sourceNodes = Array.from({ length: SOURCE_COUNT }, (_, index): CanvasNode => ({
    id: `perf-source-${index}`,
    type: CANVAS_NODE_TYPES.upload,
    position: positionFor(index, 20, 260, 220),
    data: {
      displayName: `Performance source ${index + 1}`,
      imageUrl: `https://example.invalid/perf/source-${index}.png`,
      previewImageUrl: null,
      aspectRatio: '1:1',
      sourceFileName: `source-${index}.png`,
    },
  }));

  const tagNodeIds = Array.from({ length: TAG_COUNT }, (_, index) => `perf-tag-${index}`);
  const tagNodes = tagNodeIds.map((id, index): CanvasNode => ({
    id,
    type: 'tagNode' as CanvasNode['type'],
    position: positionFor(index, 11, 260, 180),
    data: {
      displayName: `Performance tag ${index + 1}`,
      label: `Performance tag ${index + 1}`,
      enabled: index % 7 !== 0,
      color: ['amber', 'cyan', 'violet', 'rose'][index % 4],
    },
  }));

  const tagGroupNodeIds = Array.from(
    { length: TAG_GROUP_COUNT },
    (_, index) => `perf-tag-group-${index}`,
  );
  const tagGroupNodes = tagGroupNodeIds.map((id, index): CanvasNode => ({
    id,
    type: 'tagGroupNode' as CanvasNode['type'],
    position: { x: index * 880, y: 1_100 },
    data: {
      displayName: `Performance tag group ${index + 1}`,
      label: `Performance tag group ${index + 1}`,
      enabled: index !== TAG_GROUP_COUNT - 1,
      schemaVersion: 2,
      color: 'neutral',
      shape: 'rounded',
      memberNodeIds: [],
      legacyMemberTagIds: tagNodeIds.filter((_, tagIndex) => tagIndex % TAG_GROUP_COUNT === index),
    },
  }));

  const consumerNodeIds = Array.from(
    { length: CONSUMER_COUNT },
    (_, index) => `perf-consumer-${index}`,
  );
  const consumerNodes = consumerNodeIds.map((id, index): CanvasNode => ({
    id,
    type: CANVAS_NODE_TYPES.imageEdit,
    position: positionFor(index, 10, 300, 260),
    data: {
      displayName: `Performance consumer ${index + 1}`,
      imageUrl: null,
      previewImageUrl: null,
      aspectRatio: '1:1',
      requestAspectRatio: 'auto',
      prompt: `Generate consumer ${index + 1}`,
      model: 'gpt-image-2',
      size: '2K',
      extraParams: {},
    },
  }));

  const sourceToTagEdges = tagNodeIds.map((tagNodeId, index): CanvasEdge => ({
    id: `perf-edge-source-tag-${index}`,
    source: sourceNodes[index].id,
    target: tagNodeId,
  }));

  const tagToConsumerEdges = tagNodeIds.flatMap((tagNodeId, index): CanvasEdge[] => (
    [0, 1].map((offset) => ({
      id: `perf-edge-tag-consumer-${index}-${offset}`,
      source: tagNodeId,
      target: consumerNodeIds[(index + offset * 11) % CONSUMER_COUNT],
    }))
  ));

  const directEdges = sourceNodes.slice(TAG_COUNT).map((sourceNode, index): CanvasEdge => ({
    id: `perf-edge-direct-${index}`,
    source: sourceNode.id,
    target: consumerNodeIds[index % CONSUMER_COUNT],
  }));

  return {
    nodes: [...sourceNodes, ...tagNodes, ...tagGroupNodes, ...consumerNodes],
    edges: [...sourceToTagEdges, ...tagToConsumerEdges, ...directEdges],
    consumerNodeIds,
    tagNodeIds,
    tagGroupNodeIds,
  };
}
