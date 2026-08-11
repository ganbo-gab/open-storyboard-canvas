import {
  CANVAS_NODE_TYPES,
  isAiTextNode,
  isAudioNode,
  isExportImageNode,
  isImageEditNode,
  isJsonCardNode,
  isTagGroupNode,
  isTagNode,
  isTextAnnotationNode,
  isUploadNode,
  isVideoNode,
  type CanvasEdge,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';

export type GraphReferenceKind = 'image' | 'video' | 'audio' | 'text';

export interface GraphReferenceItem {
  kind: GraphReferenceKind;
  /** The real upstream asset/content node. Tags never replace this identity. */
  sourceNodeId: string;
  /** The outer tag used by the consumer, when the reference traversed a tag. */
  viaTagNodeId?: string;
  label: string;
  token: string;
  content?: string;
  imageUrl?: string;
  previewImageUrl?: string | null;
  videoUrl?: string;
  thumbnailUrl?: string | null;
  audioUrl?: string;
  title: string;
  sourceTitle?: string;
}

export type TagGraphStatus =
  | 'ready'
  | 'disabled'
  | 'group-disabled'
  | 'missing-source'
  | 'conflicting-source'
  | 'cycle';

export interface TagGraphState {
  tagId: string;
  status: TagGraphStatus;
  sourceNodeId?: string;
  incomingEdgeIds: string[];
  disabledGroupIds: string[];
}

export interface GraphReferenceIndex {
  nodesById: Map<string, CanvasNode>;
  incomingEdgesByTarget: Map<string, CanvasEdge[]>;
  disabledGroupIdsByTagId: Map<string, string[]>;
}

const graphIndexCache = new WeakMap<
  CanvasNode[],
  WeakMap<CanvasEdge[], GraphReferenceIndex>
>();

function getNodeTitle(node: CanvasNode): string {
  return resolveNodeDisplayName(node.type, node.data) || node.id;
}

function getTextContentForNode(node: CanvasNode, nodesById: Map<string, CanvasNode>): string {
  if (isTextAnnotationNode(node)) {
    return typeof node.data.content === 'string' ? node.data.content.trim() : '';
  }

  if (isJsonCardNode(node)) {
    if (node.data.parsedJson !== null && node.data.parsedJson !== undefined) {
      try {
        return JSON.stringify(node.data.parsedJson, null, 2);
      } catch {
        return String(node.data.parsedJson);
      }
    }
    return typeof node.data.rawContent === 'string' ? node.data.rawContent.trim() : '';
  }

  if (isAiTextNode(node)) {
    const resultNodeId = typeof node.data.resultNodeId === 'string' ? node.data.resultNodeId : '';
    const resultNode = resultNodeId ? nodesById.get(resultNodeId) : null;
    if (resultNode && isTextAnnotationNode(resultNode)) {
      return typeof resultNode.data.content === 'string' ? resultNode.data.content.trim() : '';
    }
    const fallbackResult = Array.from(nodesById.values()).find((candidate) => (
      isTextAnnotationNode(candidate) && candidate.data.sourceAiNodeId === node.id
    ));
    return fallbackResult && isTextAnnotationNode(fallbackResult)
      ? (typeof fallbackResult.data.content === 'string' ? fallbackResult.data.content.trim() : '')
      : '';
  }

  return '';
}

function extractReferenceFromNode(
  node: CanvasNode | undefined,
  nodesById: Map<string, CanvasNode>,
): Omit<GraphReferenceItem, 'label' | 'token'> | null {
  if (!node) {
    return null;
  }

  const title = getNodeTitle(node);
  if (isUploadNode(node) || isImageEditNode(node) || isExportImageNode(node)) {
    const imageUrl = node.data.imageUrl || node.data.previewImageUrl || '';
    if (!imageUrl) {
      return null;
    }
    return {
      kind: 'image',
      sourceNodeId: node.id,
      imageUrl,
      previewImageUrl: node.data.previewImageUrl ?? null,
      title,
    };
  }

  if (isVideoNode(node)) {
    const videoUrl = node.data.localVideoUrl || node.data.videoUrl || '';
    if (!videoUrl) {
      return null;
    }
    return {
      kind: 'video',
      sourceNodeId: node.id,
      videoUrl,
      thumbnailUrl: node.data.thumbnailUrl ?? null,
      title,
    };
  }

  if (isAudioNode(node)) {
    const audioUrl = node.data.localAudioUrl || node.data.audioUrl || '';
    if (!audioUrl) {
      return null;
    }
    return {
      kind: 'audio',
      sourceNodeId: node.id,
      audioUrl,
      title,
    };
  }

  if (
    node.type === CANVAS_NODE_TYPES.textAnnotation
    || node.type === CANVAS_NODE_TYPES.jsonCard
    || node.type === CANVAS_NODE_TYPES.aiText
  ) {
    const content = getTextContentForNode(node, nodesById);
    if (!content) {
      return null;
    }
    return {
      kind: 'text',
      sourceNodeId: node.id,
      content,
      title,
    };
  }

  return null;
}

function labelPrefixForKind(kind: GraphReferenceKind): string {
  switch (kind) {
    case 'video':
      return '视频';
    case 'audio':
      return '音频';
    case 'text':
      return '文本';
    case 'image':
    default:
      return '图';
  }
}

function normalizedTagLabel(node: CanvasNode): string {
  const label = getNodeTitle(node).replace(/[\r\n\t]+/g, ' ').trim();
  return (label || node.id).slice(0, 120);
}

export function createGraphReferenceIndex(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
): GraphReferenceIndex {
  const nodesById = new Map(nodes.map((node) => [node.id, node] as const));
  const incomingEdgesByTarget = new Map<string, CanvasEdge[]>();
  edges.forEach((edge) => {
    const incoming = incomingEdgesByTarget.get(edge.target);
    if (incoming) incoming.push(edge);
    else incomingEdgesByTarget.set(edge.target, [edge]);
  });

  const disabledGroupIdsByTagId = new Map<string, string[]>();
  nodes.forEach((node) => {
    if (!isTagGroupNode(node) || node.data.enabled !== false) return;
    node.data.memberTagIds.forEach((tagId) => {
      const groupIds = disabledGroupIdsByTagId.get(tagId);
      if (groupIds) groupIds.push(node.id);
      else disabledGroupIdsByTagId.set(tagId, [node.id]);
    });
  });

  return { nodesById, incomingEdgesByTarget, disabledGroupIdsByTagId };
}

function getCachedGraphReferenceIndex(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
): GraphReferenceIndex {
  let byEdges = graphIndexCache.get(nodes);
  if (!byEdges) {
    byEdges = new WeakMap<CanvasEdge[], GraphReferenceIndex>();
    graphIndexCache.set(nodes, byEdges);
  }
  const cached = byEdges.get(edges);
  if (cached) return cached;
  const created = createGraphReferenceIndex(nodes, edges);
  byEdges.set(edges, created);
  return created;
}

export function inspectTagGraphState(
  tagId: string,
  nodes: CanvasNode[],
  edges: CanvasEdge[],
): TagGraphState {
  const index = getCachedGraphReferenceIndex(nodes, edges);
  const visited = new Set<string>();
  let currentTagId = tagId;

  while (true) {
    const node = index.nodesById.get(currentTagId);
    const incomingEdges = index.incomingEdgesByTarget.get(currentTagId) ?? [];
    const disabledGroupIds = index.disabledGroupIdsByTagId.get(currentTagId) ?? [];
    const base = {
      tagId,
      incomingEdgeIds: incomingEdges.map((edge) => edge.id),
      disabledGroupIds,
    };

    if (!node || !isTagNode(node)) return { ...base, status: 'missing-source' };
    if (node.data.enabled === false) return { ...base, status: 'disabled' };
    if (disabledGroupIds.length > 0) return { ...base, status: 'group-disabled' };
    if (incomingEdges.length === 0) return { ...base, status: 'missing-source' };
    if (incomingEdges.length > 1) return { ...base, status: 'conflicting-source' };
    if (visited.has(currentTagId)) return { ...base, status: 'cycle' };
    visited.add(currentTagId);

    const sourceNodeId = incomingEdges[0].source;
    const sourceNode = index.nodesById.get(sourceNodeId);
    if (!sourceNode) return { ...base, status: 'missing-source' };
    if (!isTagNode(sourceNode)) {
      return { ...base, status: 'ready', sourceNodeId };
    }
    currentTagId = sourceNode.id;
  }
}

function resolveReferenceFromNode(
  node: CanvasNode | undefined,
  index: GraphReferenceIndex,
  visitedTagIds: Set<string>,
  outerTag?: CanvasNode,
): Omit<GraphReferenceItem, 'label' | 'token'> | null {
  if (!node) return null;
  if (!isTagNode(node)) {
    const extracted = extractReferenceFromNode(node, index.nodesById);
    if (!extracted || !outerTag) return extracted;
    return {
      ...extracted,
      viaTagNodeId: outerTag.id,
      sourceTitle: extracted.title,
      title: normalizedTagLabel(outerTag),
    };
  }

  if (
    node.data.enabled === false
    || (index.disabledGroupIdsByTagId.get(node.id)?.length ?? 0) > 0
    || visitedTagIds.has(node.id)
  ) {
    return null;
  }

  const incomingEdges = index.incomingEdgesByTarget.get(node.id) ?? [];
  if (incomingEdges.length !== 1) return null;
  const nextVisited = new Set(visitedTagIds);
  nextVisited.add(node.id);
  return resolveReferenceFromNode(
    index.nodesById.get(incomingEdges[0].source),
    index,
    nextVisited,
    outerTag ?? node,
  );
}

export function collectInputReferences(
  nodeId: string,
  nodes: CanvasNode[],
  edges: CanvasEdge[],
): GraphReferenceItem[] {
  const index = getCachedGraphReferenceIndex(nodes, edges);
  const counts: Record<GraphReferenceKind, number> = {
    image: 0,
    video: 0,
    audio: 0,
    text: 0,
  };
  const tagLabelCounts = new Map<string, number>();
  const seen = new Set<string>();
  const references: GraphReferenceItem[] = [];

  (index.incomingEdgesByTarget.get(nodeId) ?? []).forEach((edge) => {
    const extracted = resolveReferenceFromNode(
      index.nodesById.get(edge.source),
      index,
      new Set<string>(),
    );
    if (!extracted) return;

    const dedupeKey = extracted.viaTagNodeId
      ? `tag:${extracted.viaTagNodeId}:${extracted.kind}:${extracted.sourceNodeId}`
      : `${extracted.kind}:${extracted.sourceNodeId}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);

    let label: string;
    if (extracted.viaTagNodeId) {
      const baseLabel = extracted.title;
      const occurrence = (tagLabelCounts.get(baseLabel) ?? 0) + 1;
      tagLabelCounts.set(baseLabel, occurrence);
      label = occurrence === 1 ? baseLabel : `${baseLabel} ${occurrence}`;
    } else {
      counts[extracted.kind] += 1;
      label = `${labelPrefixForKind(extracted.kind)}${counts[extracted.kind]}`;
    }

    references.push({
      ...extracted,
      label,
      token: `@${label}`,
    });
  });

  return references;
}

export function collectInputImageUrls(
  nodeId: string,
  nodes: CanvasNode[],
  edges: CanvasEdge[],
): string[] {
  return collectInputReferences(nodeId, nodes, edges)
    .filter((reference) => reference.kind === 'image' && reference.imageUrl)
    .map((reference) => reference.imageUrl as string);
}

export function buildReferenceContextPrompt(references: GraphReferenceItem[]): string {
  const contextual = references.filter((reference) => reference.kind !== 'image');
  if (contextual.length === 0) return '';

  const lines = contextual.map((reference) => {
    if (reference.kind === 'video') {
      return `- ${reference.token}：视频参考「${reference.title}」。请将它作为动作、节奏、镜头或场景连续性参考；支持视频引用的模型会收到对应视频 URL。`;
    }
    if (reference.kind === 'audio') {
      return `- ${reference.token}：音频参考「${reference.title}」。请将它作为对白、旁白、音乐、音色或节奏参考；支持音频引用的模型会收到对应音频 URL。`;
    }
    const content = (reference.content ?? '').trim();
    const excerpt = content.length > 1200 ? `${content.slice(0, 1200)}...` : content;
    return `- ${reference.token}：文本参考「${reference.title}」\n${excerpt}`;
  });

  return `## 连接参考说明\n${lines.join('\n')}`;
}
