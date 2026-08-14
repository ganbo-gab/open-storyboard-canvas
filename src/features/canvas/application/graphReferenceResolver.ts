import {
  CANVAS_NODE_TYPES,
  isAiTextNode,
  isAudioNode,
  isExportImageNode,
  isImageEditNode,
  isJsonCardNode,
  isPanoramaNode,
  isStoryboardGenNode,
  isStoryboardSplitNode,
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
  /** Stable identity for one media item when a canvas node contains several. */
  sourceItemId?: string;
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
  groupNodeId?: string;
  groupToken?: string;
  groupTitle?: string;
}

export interface GraphReferenceGroup {
  groupNodeId: string;
  token: string;
  title: string;
  memberCount: number;
}

export function collapseTagGroupReferenceOptions<T extends GraphReferenceItem>(
  references: T[],
): T[] {
  // A tag group is only a visual, space-saving wrapper. Consumers must see
  // and select the same member references they would see if every member was
  // connected directly; the group itself is never a prompt/reference item.
  return references.slice();
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

function extractReferencesFromNode(
  node: CanvasNode | undefined,
  nodesById: Map<string, CanvasNode>,
): Array<Omit<GraphReferenceItem, 'label' | 'token'>> {
  if (!node) {
    return [];
  }

  const title = getNodeTitle(node);
  if (
    isUploadNode(node)
    || isImageEditNode(node)
    || isExportImageNode(node)
    || isStoryboardGenNode(node)
    || isPanoramaNode(node)
  ) {
    const imageUrl = node.data.imageUrl || node.data.previewImageUrl || '';
    if (!imageUrl) {
      return [];
    }
    return [{
      kind: 'image',
      sourceNodeId: node.id,
      imageUrl,
      previewImageUrl: node.data.previewImageUrl ?? null,
      title,
    }];
  }

  if (isStoryboardSplitNode(node)) {
    return node.data.frames.flatMap((frame, index) => {
      const imageUrl = frame.imageUrl || frame.previewImageUrl || '';
      if (!imageUrl) return [];
      const frameTitle = frame.note?.trim() || `第 ${index + 1} 帧`;
      return [{
        kind: 'image' as const,
        sourceNodeId: node.id,
        sourceItemId: frame.id || String(index),
        imageUrl,
        previewImageUrl: frame.previewImageUrl ?? null,
        title: `${title} · ${frameTitle}`,
      }];
    });
  }

  if (isVideoNode(node)) {
    const videoUrl = node.data.localVideoUrl || node.data.videoUrl || '';
    if (!videoUrl) {
      return [];
    }
    return [{
      kind: 'video',
      sourceNodeId: node.id,
      videoUrl,
      thumbnailUrl: node.data.thumbnailUrl ?? null,
      title,
    }];
  }

  if (isAudioNode(node)) {
    const audioUrl = node.data.localAudioUrl || node.data.audioUrl || '';
    if (!audioUrl) {
      return [];
    }
    return [{
      kind: 'audio',
      sourceNodeId: node.id,
      audioUrl,
      title,
    }];
  }

  if (
    node.type === CANVAS_NODE_TYPES.textAnnotation
    || node.type === CANVAS_NODE_TYPES.jsonCard
    || node.type === CANVAS_NODE_TYPES.aiText
  ) {
    const content = getTextContentForNode(node, nodesById);
    if (!content) {
      return [];
    }
    return [{
      kind: 'text',
      sourceNodeId: node.id,
      content,
      title,
    }];
  }

  return [];
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
    [...(node.data.legacyMemberTagIds ?? []), ...(node.data.memberTagIds ?? [])].forEach((tagId) => {
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
): Array<Omit<GraphReferenceItem, 'label' | 'token'>> {
  if (!node) return [];
  if (!isTagNode(node)) {
    const extracted = extractReferencesFromNode(node, index.nodesById);
    if (!outerTag) return extracted;
    return extracted.map((reference) => ({
      ...reference,
      viaTagNodeId: outerTag.id,
      sourceTitle: reference.title,
      title: normalizedTagLabel(outerTag),
    }));
  }

  if (
    node.data.enabled === false
    || (index.disabledGroupIdsByTagId.get(node.id)?.length ?? 0) > 0
    || visitedTagIds.has(node.id)
  ) {
    return [];
  }

  const incomingEdges = index.incomingEdgesByTarget.get(node.id) ?? [];
  if (incomingEdges.length !== 1) return [];
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
  const groupTokenCounts = new Map<string, number>();
  const seen = new Set<string>();
  const references: GraphReferenceItem[] = [];

  const appendReference = (extracted: Omit<GraphReferenceItem, 'label' | 'token'> | null) => {
    if (!extracted) return;

    const sourceIdentity = extracted.sourceItemId
      ? `${extracted.sourceNodeId}:${extracted.sourceItemId}`
      : extracted.sourceNodeId;
    const dedupeKey = extracted.viaTagNodeId
      ? `tag:${extracted.viaTagNodeId}:${extracted.kind}:${sourceIdentity}`
      : `${extracted.kind}:${sourceIdentity}`;
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
  };

  (index.incomingEdgesByTarget.get(nodeId) ?? []).forEach((edge) => {
    const source = index.nodesById.get(edge.source);
    if (source && isTagGroupNode(source)) {
      if (source.data.enabled === false) return;
      const groupTitle = normalizedTagLabel(source);
      const groupOccurrence = (groupTokenCounts.get(groupTitle) ?? 0) + 1;
      groupTokenCounts.set(groupTitle, groupOccurrence);
      const groupToken = `@${groupOccurrence === 1 ? groupTitle : `${groupTitle} ${groupOccurrence}`}`;
      source.data.memberNodeIds.forEach((memberId) => {
        extractReferencesFromNode(index.nodesById.get(memberId), index.nodesById)
          .forEach((extracted) => appendReference({
            ...extracted,
            sourceTitle: extracted.title,
            groupNodeId: source.id,
            groupToken,
            groupTitle,
          }));
      });
      return;
    }
    resolveReferenceFromNode(source, index, new Set<string>()).forEach(appendReference);
  });

  return references;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Expands connected tag-group tokens in one regex pass. A single pass matters
 * when one group name is a prefix of another (for example `@Hero` and
 * `@Hero 2`): replacements must never be re-expanded by a later group.
 */
export function expandTagGroupTokensInPrompt(
  prompt: string,
  references: GraphReferenceItem[],
): string {
  const membersByToken = new Map<string, string[]>();
  references.forEach((reference) => {
    if (!reference.groupToken) return;
    const members = membersByToken.get(reference.groupToken) ?? [];
    members.push(reference.token);
    membersByToken.set(reference.groupToken, members);
  });
  const tokens = Array.from(membersByToken.keys()).sort((left, right) => right.length - left.length);
  if (tokens.length === 0) return prompt;
  const matcher = new RegExp(`(${tokens.map(escapeRegExp).join('|')})(?![\\p{L}\\p{N}_])`, 'gu');
  return prompt.replace(matcher, (token) => {
    const members = membersByToken.get(token) ?? [];
    return members.length > 0 ? members.join('、') : token;
  });
}

/**
 * Applies the same submit-time token cleanup for direct references and the
 * legacy compact `@group` authoring token. Group expansion happens first so
 * no group name or marker can survive into a provider prompt.
 */
export function normalizeReferenceTokensForSubmission(
  prompt: string,
  references: GraphReferenceItem[],
): string {
  return expandTagGroupTokensInPrompt(prompt, references)
    .replace(/@(?=(?:图|视频|音频|文本)\d+)/g, '')
    .trim();
}

export function collectInputReferenceGroups(
  nodeId: string,
  nodes: CanvasNode[],
  edges: CanvasEdge[],
): GraphReferenceGroup[] {
  const groups = new Map<string, GraphReferenceGroup>();
  collectInputReferences(nodeId, nodes, edges).forEach((reference) => {
    if (!reference.groupNodeId || !reference.groupToken || !reference.groupTitle) return;
    const existing = groups.get(reference.groupNodeId);
    if (existing) {
      existing.memberCount += 1;
      return;
    }
    groups.set(reference.groupNodeId, {
      groupNodeId: reference.groupNodeId,
      token: reference.groupToken,
      title: reference.groupTitle,
      memberCount: 1,
    });
  });
  return Array.from(groups.values());
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
