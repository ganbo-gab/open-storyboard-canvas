import {
  CANVAS_NODE_TYPES,
  isAiTextNode,
  isExportImageNode,
  isImageEditNode,
  isJsonCardNode,
  isTextAnnotationNode,
  isUploadNode,
  isVideoNode,
  type CanvasEdge,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';

export type GraphReferenceKind = 'image' | 'video' | 'text';

export interface GraphReferenceItem {
  kind: GraphReferenceKind;
  sourceNodeId: string;
  label: string;
  token: string;
  content?: string;
  imageUrl?: string;
  previewImageUrl?: string | null;
  videoUrl?: string;
  thumbnailUrl?: string | null;
  title: string;
}

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
  nodesById: Map<string, CanvasNode>
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

  if (
    node.type === CANVAS_NODE_TYPES.textAnnotation ||
    node.type === CANVAS_NODE_TYPES.jsonCard ||
    node.type === CANVAS_NODE_TYPES.aiText
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
    case 'text':
      return '文本';
    case 'image':
    default:
      return '图';
  }
}

export function collectInputReferences(
  nodeId: string,
  nodes: CanvasNode[],
  edges: CanvasEdge[]
): GraphReferenceItem[] {
  const nodesById = new Map(nodes.map((node) => [node.id, node] as const));
  const counts: Record<GraphReferenceKind, number> = {
    image: 0,
    video: 0,
    text: 0,
  };
  const seen = new Set<string>();
  const references: GraphReferenceItem[] = [];

  edges
    .filter((edge) => edge.target === nodeId)
    .forEach((edge) => {
      const extracted = extractReferenceFromNode(nodesById.get(edge.source), nodesById);
      if (!extracted) {
        return;
      }

      // Deduplicate repeated edges from the same source node, not by payload.
      // Multiple connected text/image/video nodes can legitimately have the
      // same content or URL and still need separate @ tokens in downstream
      // prompt pickers and payload assembly.
      const dedupeKey = `${extracted.kind}:${extracted.sourceNodeId}`;
      if (seen.has(dedupeKey)) {
        return;
      }
      seen.add(dedupeKey);

      counts[extracted.kind] += 1;
      const label = `${labelPrefixForKind(extracted.kind)}${counts[extracted.kind]}`;
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
  edges: CanvasEdge[]
): string[] {
  return collectInputReferences(nodeId, nodes, edges)
    .filter((reference) => reference.kind === 'image' && reference.imageUrl)
    .map((reference) => reference.imageUrl as string);
}

export function buildReferenceContextPrompt(references: GraphReferenceItem[]): string {
  const contextual = references.filter((reference) => reference.kind !== 'image');
  if (contextual.length === 0) {
    return '';
  }

  const lines = contextual.map((reference) => {
    if (reference.kind === 'video') {
      return `- ${reference.token}：视频参考「${reference.title}」。请将它作为动作、节奏、镜头或场景连续性参考；支持视频引用的模型会收到对应视频 URL。`;
    }
    const content = (reference.content ?? '').trim();
    const excerpt = content.length > 1200 ? `${content.slice(0, 1200)}...` : content;
    return `- ${reference.token}：文本参考「${reference.title}」\n${excerpt}`;
  });

  return `## 连接参考说明\n${lines.join('\n')}`;
}
